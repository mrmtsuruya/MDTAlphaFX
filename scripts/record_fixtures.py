"""Record replay fixtures from MT5. **Run this on Windows.**

§9 Stage 0 requires "recorded fixtures covering trending, ranging and
high-volatility periods". This records them, one self-contained Parquet store
per period, each holding every analysis timeframe **plus M1** (§11.1 sub-bar
resolution) with **per-bar recorded spread** (§11.2), and the resolved
`SymbolSpec` and swap rates alongside.

Those last two are not polish. §9: "Sub-bar resolution and cost modelling belong
here, not in a later polish pass. Retrofitting them changes every number the
harness has ever produced."

Where the dates come from
-------------------------
`config/backtest.yaml`, under `fixtures.periods`. They ship as
`<OPERATOR DECISION>` and `Config.get()` raises on that sentinel, so this script
refuses to run until a human has chosen them. **The spec names no historical
windows** — it states which market conditions the fixture set must contain and
stops there. A window chosen by an agent would be chosen from a recollection of
what markets did, which is the confident guess that compiles.

    python scripts/record_fixtures.py --auto-classify --timeframe H1 --window-bars 500

scans the history the broker exposes and *proposes* candidates ranked by ADX and
by ATR percentile. It prints them and writes them to a JSON file. It never edits
config. Proposing is fine; choosing is the operator's.

    python scripts/record_fixtures.py                 # record every period
    python scripts/record_fixtures.py --period ranging
    python scripts/record_fixtures.py --dry-run

A note on the indicators below
------------------------------
`--auto-classify` computes ADX and ATR. That is *not* the Tier 1 classifier —
§3 is Stage 1 and is deliberately not implemented anywhere in `backend/`. This
lives in a script, is never imported by the engine, and exists only to rank
windows for a human. The periods and the percentile lookback are quoted from
§3.1 ("ADX(14)", "ATR(14) as percentile of trailing 100 bars") rather than
chosen, and no threshold is applied: candidates are *ranked*, not classified,
because the ADX bands are Appendix B #1/#2 operator decisions that do not exist
yet.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Sequence

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.contracts import Candle, Timeframe  # noqa: E402
from backend.core.config import Config  # noqa: E402
from backend.core.errors import ConfigError  # noqa: E402
from backend.core.timeutil import bar_close_time, ensure_utc, utc_now  # noqa: E402
from backend.data.mt5_connector import MT5Connector, ResolvedSymbol  # noqa: E402
from backend.data.store import ParquetBarStore, iter_store_timeframes  # noqa: E402

DEFAULT_CONFIG_DIR = REPO_ROOT / "config"
DEFAULT_CANDIDATES_OUT = REPO_ROOT / "data" / "fixture_candidates.json"

_RULE = "-" * 78
# Report shaping only: how many proposals to print per class.
_DEFAULT_TOP = 5


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Record Stage 0 replay fixtures, or propose candidate windows."
    )
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_DIR))
    parser.add_argument("--terminal-path", default=None)
    parser.add_argument("--login", type=int, default=None)
    parser.add_argument("--password", default=None)
    parser.add_argument("--server", default=None)
    parser.add_argument(
        "--period",
        action="append",
        default=None,
        help="Record only these periods. Repeatable. Default: all.",
    )
    parser.add_argument(
        "--symbol",
        action="append",
        default=None,
        help="Record only these base names. Repeatable. Default: the watchlist.",
    )
    parser.add_argument("--dry-run", action="store_true")

    parser.add_argument(
        "--auto-classify",
        action="store_true",
        help="Propose candidate windows by ADX/ATR percentile. Records nothing.",
    )
    parser.add_argument("--timeframe", default=None, help="--auto-classify series.")
    parser.add_argument("--window-bars", type=int, default=None)
    parser.add_argument("--scan-bars", type=int, default=None)
    parser.add_argument("--top", type=int, default=_DEFAULT_TOP)
    parser.add_argument("--candidates-out", default=str(DEFAULT_CANDIDATES_OUT))
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    config = Config.load(args.config)

    connector = MT5Connector(
        config,
        terminal_path=args.terminal_path,
        login=args.login,
        password=args.password,
        server=args.server,
    )

    with connector:
        base_names = args.symbol or connector.watchlist_from_config()
        resolved = {name: connector.resolve_symbol(name) for name in base_names}
        clock = connector.measure_server_clock()
        print(f"{_RULE}\nMDTAlphaFX — fixture recorder\n{_RULE}")
        print(f"  account : {connector.account.login} @ {connector.account.server}")
        print(f"  mode    : {connector.account.trade_mode_name} (rule 5 passed)")
        print(
            f"  §10.1   : server offset {clock.offset_minutes:+d} min "
            f"({clock.server_timezone_hint})"
        )

        if args.auto_classify:
            return _auto_classify(args, config, connector, resolved)

        return _record(args, config, connector, resolved)


# ------------------------------------------------------------------ recording


def _record(
    args: argparse.Namespace,
    config: Config,
    connector: MT5Connector,
    resolved: dict[str, ResolvedSymbol],
) -> int:
    periods = config.section("backtest.fixtures.periods")
    wanted = args.period or list(periods)
    unknown = [name for name in wanted if name not in periods]
    if unknown:
        raise SystemExit(
            f"unknown fixture period(s) {unknown}. Defined: {sorted(periods)}"
        )

    fixtures_root = _fixtures_root(config)
    timeframes = iter_store_timeframes(config)
    print(f"  fixtures: {fixtures_root}")
    print(f"  frames  : {', '.join(tf.value for tf in timeframes)}")

    for period_name in wanted:
        start = _period_bound(config, period_name, "start")
        end = _period_bound(config, period_name, "end")
        if end <= start:
            raise SystemExit(
                f"fixture period '{period_name}': end {end} is not after start {start}"
            )

        period_symbols = periods[period_name].get("symbols") or list(resolved)
        missing = [name for name in period_symbols if name not in resolved]
        if missing:
            raise SystemExit(
                f"fixture period '{period_name}' names symbols that were not "
                f"resolved: {missing}"
            )

        print(f"\n{_RULE}\n{period_name}: {start.isoformat()} -> {end.isoformat()}")
        print(f"  symbols : {', '.join(period_symbols)}")
        if args.dry_run:
            print("  (dry run — nothing written)")
            continue

        store = ParquetBarStore.from_config(
            config, root=fixtures_root / period_name
        )
        for base_name in period_symbols:
            symbol = resolved[base_name]
            store.write_symbol_meta(
                symbol.spec,
                requested_name=symbol.requested_name,
                swap_long=symbol.swap_long,
                swap_short=symbol.swap_short,
                server_offset_minutes=connector.server_clock.offset_minutes,
                account_server=connector.account.server,
            )
            for timeframe in timeframes:
                written = _record_series(
                    connector, store, symbol.name, timeframe, start, end
                )
                coverage = store.coverage(symbol.name, timeframe)
                span = (
                    f"{coverage[0].isoformat()} .. {coverage[1].isoformat()}"
                    if coverage
                    else "empty"
                )
                print(f"  {symbol.name:<14} {timeframe.value:<4} {written:>7} bars  {span}")

            _report_m1_coverage(store, symbol.name, start, end)

    return 0


def _record_series(
    connector: MT5Connector,
    store: ParquetBarStore,
    symbol: str,
    timeframe: Timeframe,
    start: datetime,
    end: datetime,
) -> int:
    """Fetch and upsert one series, month by month.

    Chunked because a terminal caps how many bars one request returns, and M1
    over a multi-month window comfortably exceeds it. Month chunks also line up
    with the store's partitions, so a re-run rewrites whole files.
    """
    written = 0
    for chunk_start, chunk_end in _month_chunks(start, end):
        bars: list[Candle] = connector.bars(symbol, timeframe, chunk_start, chunk_end)
        if bars:
            written += store.write_bars(symbol, timeframe, bars)
    return written


def _month_chunks(
    start: datetime, end: datetime
) -> Iterable[tuple[datetime, datetime]]:
    cursor = start
    while cursor < end:
        year, month = cursor.year, cursor.month + 1
        if month > 12:
            year, month = year + 1, 1
        boundary = cursor.replace(
            year=year, month=month, day=1, hour=0, minute=0, second=0, microsecond=0
        )
        chunk_end = min(boundary, end)
        yield cursor, chunk_end
        cursor = chunk_end


def _report_m1_coverage(
    store: ParquetBarStore, symbol: str, start: datetime, end: datetime
) -> None:
    """§11.1. Say plainly whether the sub-bar walk will be available."""
    complete = store.has_m1(symbol, start, end)
    if complete:
        print(f"  {symbol:<14} M1 coverage COMPLETE — §11.1 sub-bar walk available")
        return
    gaps = store.m1_gaps(symbol, start, end)
    print(
        f"  {symbol:<14} M1 coverage INCOMPLETE — {len(gaps)} gap(s). Every "
        f"ambiguous candle inside them takes the §11.1 conservative fallback "
        f"and is counted in the ambiguity rate."
    )
    for gap_start, gap_end in gaps[:10]:
        print(f"      {gap_start.isoformat()} .. {gap_end.isoformat()}")
    if len(gaps) > 10:
        print(f"      ... and {len(gaps) - 10} more")


def _fixtures_root(config: Config) -> Path:
    root = Path(config.get("engine.paths.fixtures"))
    if not root.is_absolute():
        root = (config.source_dir.parent / root).resolve()
    return root


def _period_bound(config: Config, period: str, edge: str) -> datetime:
    key = f"backtest.fixtures.periods.{period}.{edge}"
    try:
        raw = config.get(key)
    except ConfigError as exc:
        raise SystemExit(
            f"{exc}\n\n"
            f"The spec names no historical windows — §9 states only which market\n"
            f"conditions the fixture set must contain. Choose the dates, or run\n"
            f"--auto-classify for ranked proposals."
        ) from exc
    return _parse_utc(str(raw), key)


def _parse_utc(raw: str, key: str) -> datetime:
    text = raw.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(text)
    except ValueError as exc:
        raise SystemExit(
            f"{key}: '{raw}' is not ISO-8601. Use e.g. 2025-03-01T00:00:00Z."
        ) from exc
    if moment.tzinfo is None:
        raise SystemExit(
            f"{key}: '{raw}' has no timezone. §10.1 — all times are UTC "
            f"internally and are never assumed. Write the offset explicitly."
        )
    return ensure_utc(moment)


# ------------------------------------------------------------ auto-classify


def _auto_classify(
    args: argparse.Namespace,
    config: Config,
    connector: MT5Connector,
    resolved: dict[str, ResolvedSymbol],
) -> int:
    section = "backtest.fixtures.auto_classify"
    timeframe = Timeframe(
        _resolve_param(config, f"{section}.timeframe", args.timeframe, "--timeframe")
    )
    window_bars = int(
        _resolve_param(config, f"{section}.window_bars", args.window_bars, "--window-bars")
    )
    scan_bars = int(
        _resolve_param(config, f"{section}.scan_bars", args.scan_bars, "--scan-bars")
    )
    adx_period = int(config.get(f"{section}.adx_period"))
    atr_period = int(config.get(f"{section}.atr_period"))
    percentile_lookback = int(config.get(f"{section}.atr_percentile_lookback_bars"))

    print(f"\n{_RULE}\nCandidate windows — PROPOSALS ONLY\n{_RULE}")
    print(
        f"  scanning {scan_bars} {timeframe.value} bars, windows of {window_bars}\n"
        f"  ADX({adx_period}) · ATR({atr_period}) percentile over "
        f"{percentile_lookback} trailing bars (§3.1)\n"
        f"  Ranked, not classified: the ADX bands are Appendix B #1/#2 and are\n"
        f"  not settled, so nothing here applies a threshold."
    )

    report: dict[str, Any] = {
        "generated_at_utc": utc_now().isoformat(),
        "config_version": config.version,
        "timeframe": timeframe.value,
        "window_bars": window_bars,
        "scan_bars": scan_bars,
        "adx_period": adx_period,
        "atr_period": atr_period,
        "atr_percentile_lookback_bars": percentile_lookback,
        "note": "PROPOSALS. Not written to config. The operator chooses.",
        "symbols": {},
    }

    for base_name, symbol in resolved.items():
        bars = connector.bars_from_pos(symbol.name, timeframe, scan_bars)
        if len(bars) < window_bars + percentile_lookback + adx_period:
            print(
                f"\n{base_name}: only {len(bars)} bars available — too short to "
                f"score windows of {window_bars}. Skipped."
            )
            continue

        adx = _wilder_adx(bars, adx_period)
        atr = _wilder_atr(bars, atr_period)
        atr_rank = _rolling_percentile(atr, percentile_lookback)
        windows = _score_windows(bars, adx, atr_rank, window_bars, timeframe)

        by_adx = sorted(
            (w for w in windows if w["mean_adx"] is not None),
            key=lambda w: w["mean_adx"],
            reverse=True,
        )
        by_atr = sorted(
            (w for w in windows if w["mean_atr_percentile"] is not None),
            key=lambda w: w["mean_atr_percentile"],
            reverse=True,
        )
        proposals = {
            "trending": by_adx[: args.top],
            "ranging": list(reversed(by_adx))[: args.top],
            "high_volatility": by_atr[: args.top],
        }
        report["symbols"][base_name] = {
            "broker_name": symbol.name,
            "bars_scanned": len(bars),
            "proposals": proposals,
        }
        _print_proposals(base_name, proposals)

    out_path = Path(args.candidates_out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(report, indent=2, sort_keys=True, default=str) + "\n",
        encoding="utf-8",
    )
    print(f"\nProposals written to {out_path}")
    print(
        "\nCopy the start/end of the windows you accept into\n"
        "config/backtest.yaml -> fixtures.periods.*.start / .end.\n"
        "This script will not write them for you."
    )
    return 0


def _resolve_param(config: Config, key: str, cli_value: Any, flag: str) -> Any:
    if cli_value is not None:
        return cli_value
    try:
        return config.get(key)
    except ConfigError as exc:
        raise SystemExit(
            f"{exc}\n\nPass {flag} on the command line, or settle {key} in "
            f"config/backtest.yaml."
        ) from exc


def _score_windows(
    bars: Sequence[Candle],
    adx: Sequence[float | None],
    atr_rank: Sequence[float | None],
    window_bars: int,
    timeframe: Timeframe,
) -> list[dict[str, Any]]:
    """Non-overlapping windows, each scored by mean ADX and mean ATR percentile.

    Non-overlapping on purpose: overlapping windows would make the top-N a set
    of near-duplicates of one moment, which is a worse menu for the operator.
    """
    windows: list[dict[str, Any]] = []
    for start_index in range(0, len(bars) - window_bars + 1, window_bars):
        end_index = start_index + window_bars
        adx_slice = [v for v in adx[start_index:end_index] if v is not None]
        atr_slice = [v for v in atr_rank[start_index:end_index] if v is not None]
        windows.append(
            {
                "start": bars[start_index].time.isoformat(),
                # Exclusive bound. The recorder fetches `open < end`, so using
                # the final bar's open here would silently drop that bar.
                "end": bar_close_time(
                    bars[end_index - 1].time, timeframe
                ).isoformat(),
                "bars": window_bars,
                "mean_adx": (sum(adx_slice) / len(adx_slice)) if adx_slice else None,
                "mean_atr_percentile": (
                    (sum(atr_slice) / len(atr_slice)) if atr_slice else None
                ),
            }
        )
    return windows


def _print_proposals(base_name: str, proposals: dict[str, list[dict[str, Any]]]) -> None:
    print(f"\n{base_name}")
    labels = {
        "trending": "highest mean ADX  (trending candidates)",
        "ranging": "lowest mean ADX   (ranging candidates)",
        "high_volatility": "highest ATR pctl  (high-volatility candidates)",
    }
    for key, label in labels.items():
        print(f"  {label}")
        for window in proposals[key]:
            adx = window["mean_adx"]
            atr = window["mean_atr_percentile"]
            span = f"    {window['start']} .. {window['end']}"
            if adx is None or atr is None:
                print(span)
            else:
                print(f"{span}  ADX {adx:6.2f}  ATRpctl {atr:6.2f}")


# --- indicators: proposal aid only, NOT the §3 Tier 1 classifier -----------


def _true_ranges(bars: Sequence[Candle]) -> list[float | None]:
    values: list[float | None] = [None]
    for index in range(1, len(bars)):
        current, previous = bars[index], bars[index - 1]
        values.append(
            max(
                current.high - current.low,
                abs(current.high - previous.close),
                abs(current.low - previous.close),
            )
        )
    return values


def _wilder_smooth(values: Sequence[float | None], period: int) -> list[float | None]:
    """Wilder's smoothing: seed with the mean of the first `period`, then
    `prev - prev/period + value`/period form. Standard definition, not a tunable."""
    out: list[float | None] = [None] * len(values)
    buffer: list[float] = []
    running: float | None = None
    for index, value in enumerate(values):
        if value is None:
            continue
        if running is None:
            buffer.append(value)
            if len(buffer) == period:
                running = sum(buffer) / period
                out[index] = running
            continue
        running = running + (value - running) / period
        out[index] = running
    return out


def _wilder_atr(bars: Sequence[Candle], period: int) -> list[float | None]:
    return _wilder_smooth(_true_ranges(bars), period)


def _wilder_adx(bars: Sequence[Candle], period: int) -> list[float | None]:
    plus_dm: list[float | None] = [None]
    minus_dm: list[float | None] = [None]
    for index in range(1, len(bars)):
        up = bars[index].high - bars[index - 1].high
        down = bars[index - 1].low - bars[index].low
        plus_dm.append(up if (up > down and up > 0) else 0.0)
        minus_dm.append(down if (down > up and down > 0) else 0.0)

    atr = _wilder_smooth(_true_ranges(bars), period)
    plus_smooth = _wilder_smooth(plus_dm, period)
    minus_smooth = _wilder_smooth(minus_dm, period)

    dx: list[float | None] = []
    for index in range(len(bars)):
        tr_value = atr[index]
        plus_value = plus_smooth[index]
        minus_value = minus_smooth[index]
        if not tr_value or plus_value is None or minus_value is None:
            dx.append(None)
            continue
        plus_di = 100.0 * plus_value / tr_value
        minus_di = 100.0 * minus_value / tr_value
        denominator = plus_di + minus_di
        dx.append(0.0 if denominator == 0 else 100.0 * abs(plus_di - minus_di) / denominator)
    return _wilder_smooth(dx, period)


def _rolling_percentile(
    values: Sequence[float | None], lookback: int
) -> list[float | None]:
    """§3.1's "percentile of trailing N bars", by nearest-rank."""
    out: list[float | None] = [None] * len(values)
    for index, value in enumerate(values):
        if value is None:
            continue
        window = [v for v in values[max(0, index - lookback + 1) : index + 1] if v is not None]
        if len(window) < lookback:
            continue
        out[index] = 100.0 * sum(1 for v in window if v <= value) / len(window)
    return out


if __name__ == "__main__":
    raise SystemExit(main())
