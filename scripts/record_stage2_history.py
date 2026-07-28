"""Record the approved Stage 2 analysis-only H1/M15 DEMO cohort.

This is not a trade replay and intentionally does not record M1. It exists for
module co-firing, where frozen ``Candle`` inputs still require OHLC, tick volume,
spread, and the contemporaneous ``SymbolSpec``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections.abc import Iterable, Sequence
from datetime import datetime, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.contracts import Candle, Timeframe  # noqa: E402
from backend.core.config import Config  # noqa: E402
from backend.core.timeutil import (  # noqa: E402
    ensure_utc,
    timeframe_delta,
    utc_now,
)
from backend.data.mt5_connector import MT5Connector  # noqa: E402
from backend.data.stage2_analysis_store import (  # noqa: E402
    ANALYSIS_ONLY_SUBDIRECTORY,
    Stage2AnalysisParquetStore,
)
from backend.strategies.configuration import validate_strategy_config  # noqa: E402


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Record the approved Stage 2 raw-history DEMO cohort."
    )
    parser.add_argument("--config", default=str(REPO_ROOT / "config"))
    parser.add_argument("--terminal-path", default=None)
    parser.add_argument("--login", type=int, default=None)
    parser.add_argument("--password", default=None)
    parser.add_argument("--server", default=None)
    parser.add_argument("--dry-run", action="store_true")
    return parser


def _parse_utc(value: str, key: str) -> datetime:
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        moment = datetime.fromisoformat(text)
    except ValueError as exc:
        raise SystemExit(f"{key} must be ISO-8601 UTC, got {value!r}") from exc
    if moment.tzinfo is None:
        raise SystemExit(f"{key} must carry an explicit UTC offset")
    return ensure_utc(moment)


def _month_chunks(
    start: datetime, end: datetime
) -> Iterable[tuple[datetime, datetime]]:
    cursor = start
    while cursor < end:
        year, month = cursor.year, cursor.month + 1
        if month > 12:
            year, month = year + 1, 1
        boundary = cursor.replace(
            year=year,
            month=month,
            day=1,
            hour=0,
            minute=0,
            second=0,
            microsecond=0,
        )
        chunk_end = min(boundary, end)
        yield cursor, chunk_end
        cursor = chunk_end


def _record_series(
    connector: MT5Connector,
    store: Stage2AnalysisParquetStore,
    symbol: str,
    timeframe: Timeframe,
    start: datetime,
    end: datetime,
) -> int:
    written = 0
    for chunk_start, chunk_end in _month_chunks(start, end):
        bars: list[Candle] = connector.bars(
            symbol, timeframe, chunk_start, chunk_end
        )
        if bars:
            written += store.write_bars(symbol, timeframe, bars)
    return written


def _analysis_store_root(approved_destination: Path) -> Path:
    """Return the isolated recovery root without reinterpreting strict data."""

    return approved_destination / ANALYSIS_ONLY_SUBDIRECTORY


def _missing_slot_count(duration: timedelta, step: timedelta) -> int:
    """Count expected bar-open slots in a positive availability interval."""

    complete, remainder = divmod(duration, step)
    return int(complete) + int(remainder > timedelta(0))


def _availability_gaps(
    bars: Sequence[Candle],
    timeframe: Timeframe,
    start: datetime,
    end: datetime,
) -> list[dict[str, str | int]]:
    """Raw no-bar intervals, without classifying why a bar was unavailable."""

    start_utc = ensure_utc(start)
    end_utc = ensure_utc(end)
    if end_utc <= start_utc:
        raise ValueError("availability range must be a non-empty half-open interval")
    step = timeframe_delta(timeframe)
    times = sorted(
        {
            ensure_utc(bar.time)
            for bar in bars
            if start_utc <= ensure_utc(bar.time) < end_utc
        }
    )

    intervals: list[tuple[datetime, datetime]] = []
    if not times:
        intervals.append((start_utc, end_utc))
    else:
        if times[0] > start_utc:
            intervals.append((start_utc, times[0]))
        for previous, current in zip(times, times[1:]):
            expected_next = previous + step
            if current > expected_next:
                intervals.append((expected_next, current))
        trailing_start = times[-1] + step
        if trailing_start < end_utc:
            intervals.append((trailing_start, end_utc))

    return [
        {
            "start_utc": gap_start.isoformat(),
            "end_utc": gap_end.isoformat(),
            "missing_slot_count": _missing_slot_count(
                gap_end - gap_start, step
            ),
        }
        for gap_start, gap_end in intervals
    ]


def _canonical_gap_rows(
    rows: Sequence[dict[str, str | int]],
) -> list[dict[str, str | int]]:
    canonical = [
        {
            "start_utc": str(row["start_utc"]),
            "end_utc": str(row["end_utc"]),
            "missing_slot_count": int(row["missing_slot_count"]),
        }
        for row in rows
    ]
    return sorted(
        canonical,
        key=lambda row: (
            row["start_utc"],
            row["end_utc"],
            row["missing_slot_count"],
        ),
    )


def _gap_rows_sha256(rows: Sequence[dict[str, str | int]]) -> str:
    canonical_json = json.dumps(
        _canonical_gap_rows(rows),
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(canonical_json).hexdigest()


def _series_manifest_entry(
    *,
    bars_written: int,
    coverage: tuple[datetime, datetime],
    bars: Sequence[Candle],
    timeframe: Timeframe,
    start: datetime,
    end: datetime,
) -> dict[str, object]:
    gaps = _canonical_gap_rows(
        _availability_gaps(bars, timeframe, start, end)
    )
    return {
        "bars_written": bars_written,
        "coverage_first": ensure_utc(coverage[0]).isoformat(),
        "coverage_last": ensure_utc(coverage[1]).isoformat(),
        "availability_gaps": gaps,
        "gap_count": len(gaps),
        "gap_rows_sha256": _gap_rows_sha256(gaps),
    }


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    config = Config.load(args.config)
    validate_strategy_config(config)
    history = config.section("strategies.history")
    if history.get("account_mode") != "DEMO":
        raise SystemExit("strategies.history.account_mode must remain DEMO")
    start = _parse_utc(str(history["start"]), "strategies.history.start")
    end = _parse_utc(str(history["end"]), "strategies.history.end")
    if end <= start:
        raise SystemExit("Stage 2 history end must be after start")
    symbols = tuple(str(value) for value in history["symbols"])
    timeframes = tuple(Timeframe(value) for value in history["raw_timeframes"])
    approved_destination = Path(str(history["destination"]))
    if not approved_destination.is_absolute():
        approved_destination = (REPO_ROOT / approved_destination).resolve()
    destination = _analysis_store_root(approved_destination)

    connector = MT5Connector(
        config,
        terminal_path=args.terminal_path,
        login=args.login,
        password=args.password,
        server=args.server,
    )
    with connector:
        if not connector.account.is_demo:
            raise SystemExit(
                "the Stage 2 analysis-only recorder refuses non-DEMO accounts "
                "even when the general live-account override is enabled"
            )
        approved_server = str(history["server"])
        if connector.account.server != approved_server:
            raise SystemExit(
                f"connected server {connector.account.server!r} does not match "
                f"approved Stage 2 server {approved_server!r}"
            )
        resolved = {
            requested: connector.resolve_symbol(requested) for requested in symbols
        }
        clock = connector.measure_server_clock()
        print("MDTAlphaFX — Stage 2 raw-history recorder")
        print(f"account: {connector.account.login} @ {connector.account.server}")
        print(f"mode: {connector.account.trade_mode_name}")
        print(f"range: [{start.isoformat()}, {end.isoformat()})")
        print(f"approved destination: {approved_destination}")
        print(f"analysis-only store: {destination}")
        print(f"timeframes: {', '.join(value.value for value in timeframes)}")
        if args.dry_run:
            print("dry run — nothing written")
            return 0

        manifest: dict[str, object] = {
            "generated_at_utc": utc_now().isoformat(),
            "config_version": config.version,
            "analysis_only": True,
            "cost_valid": False,
            "account_login": connector.account.login,
            "account_server": connector.account.server,
            "account_mode": connector.account.trade_mode_name,
            "server_offset_minutes": clock.offset_minutes,
            "requested_start": start.isoformat(),
            "requested_end_exclusive": end.isoformat(),
            "availability_gap_semantics": (
                "NO_BAR_OBSERVED; NOT CLASSIFIED AS MARKET_CLOSED_OR_MISSING"
            ),
            "timeframes": [value.value for value in timeframes],
            "symbols": {},
        }
        store = Stage2AnalysisParquetStore.create(destination)
        # This atomic state transition is deliberately before symbol metadata or
        # any Parquet mutation. A crash from here onward leaves a store that all
        # readers and co-firing paths refuse until a rerun repairs and finalizes it.
        store.begin_capture(manifest)
        symbol_manifest: dict[str, object] = {}
        for requested, resolved_symbol in resolved.items():
            store.write_symbol_meta(
                resolved_symbol.spec,
                requested_name=requested,
                swap_long=resolved_symbol.swap_long,
                swap_short=resolved_symbol.swap_short,
                server_offset_minutes=clock.offset_minutes,
                account_server=connector.account.server,
            )
            series_manifest: dict[str, object] = {}
            for timeframe in timeframes:
                written = _record_series(
                    connector,
                    store,
                    resolved_symbol.name,
                    timeframe,
                    start,
                    end,
                )
                coverage = store.coverage(resolved_symbol.name, timeframe)
                if written == 0 or coverage is None:
                    raise SystemExit(
                        f"required series unavailable: {resolved_symbol.name} "
                        f"{timeframe.value} in approved range"
                    )
                recorded = store.bars(
                    resolved_symbol.name,
                    timeframe,
                    start,
                    end,
                )
                entry = _series_manifest_entry(
                    bars_written=len(recorded),
                    coverage=coverage,
                    bars=recorded,
                    timeframe=timeframe,
                    start=start,
                    end=end,
                )
                series_manifest[timeframe.value] = entry
                print(
                    f"{resolved_symbol.name:<14} {timeframe.value:<4} "
                    f"{written:>7} bars  "
                    f"{coverage[0].isoformat()} .. {coverage[1].isoformat()}  "
                    f"{entry['gap_count']} availability gap(s)"
                )
            symbol_manifest[requested] = {
                "resolved_symbol": resolved_symbol.name,
                "series": series_manifest,
            }
        manifest["symbols"] = symbol_manifest
        content_sha256 = store.finalize_capture(manifest)
        print(f"manifest: {store.manifest_path}")
        print(f"content SHA-256: {content_sha256}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
