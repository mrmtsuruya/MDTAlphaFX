"""Parquet historical store — the Stage 0 `BarSource` (§9, §11.1, §11.2).

Implements `backend.data.source.BarSource`. Knows nothing about MetaTrader5, by
construction: the replay engine (§11) reads through this and must stay runnable
off Windows.

Disk layout
-----------

    <engine.paths.historical_store>/
        <symbol-dir>/
            meta.json                       resolved SymbolSpec + swap rates
            bars/
                H4/2026-01.parquet
                H1/2026-01.parquet
                M15/2026-01.parquet
                M5/2026-01.parquet
                M1/2026-01.parquet          §11.1 sub-bar resolution

Partitioned by symbol, then timeframe, then calendar month of the bar's **UTC**
open time. Three reasons for that shape:

- *Symbol first* because `meta.json` is per symbol and must sit next to the bars
  it describes. A replay is only interpretable against the `SymbolSpec` that was
  live when the bars were recorded — `stops_level` and `volume_step` change, and
  a backtest that fills against today's constraints is measuring a different
  instrument (§11.2, §7.3).
- *Timeframe second* because every read is for exactly one timeframe.
- *Month third* because M1 is the dominant volume — roughly 31k rows a month per
  symbol — and §11.1's sub-bar walk reads short windows. A yearly file would
  make every ambiguous-candle lookup scan twelve times more data than it needs.

`<symbol-dir>` is the broker-resolved name with characters that are unsafe in a
Windows path percent-escaped as `~XX`. The authoritative names — both the
requested base name and the broker-resolved one — live in `meta.json`, and both
resolve to the same directory, so callers may use either.

Integrity boundary
------------------
The connector is a faithful adapter; **this** is where data is refused. A bar
without a positive spread never enters or leaves the store (§11.2), and
`has_m1` never claims coverage it cannot demonstrate (§11.1).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Sequence

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from ..contracts import Candle, SymbolSpec, Timeframe
from ..core.config import Config
from ..core.errors import ConfigError, DataIntegrityError
from ..core.timeutil import UTC, ensure_utc, timeframe_delta, timeframe_minutes, utc_now

# Bumped whenever the on-disk schema changes in a way that makes an older store
# unreadable. Recorded in meta.json so a stale store fails loudly instead of
# being read with the wrong column meanings.
STORE_FORMAT_VERSION = 1

_META_FILENAME = "meta.json"
_BARS_DIRNAME = "bars"

# Explicit Parquet schema. Written rather than inferred so a round trip cannot
# change a dtype — an int64 spread that reads back as float is a silent change
# to a cost model.
_BAR_SCHEMA = pa.schema(
    [
        pa.field("time_utc", pa.timestamp("us", tz="UTC"), nullable=False),
        pa.field("open", pa.float64(), nullable=False),
        pa.field("high", pa.float64(), nullable=False),
        pa.field("low", pa.float64(), nullable=False),
        pa.field("close", pa.float64(), nullable=False),
        pa.field("tick_volume", pa.int64(), nullable=False),
        # Nullable on purpose. A null here is the one shape that proves spread
        # was never recorded, and `bars()` must be able to tell that apart from
        # a legitimately small spread.
        pa.field("spread", pa.int32(), nullable=True),
    ]
)

_BAR_COLUMNS = [field.name for field in _BAR_SCHEMA]

# Characters allowed verbatim in a symbol directory name. Everything else is
# escaped: broker suffixes include '.', and Windows silently strips a trailing
# dot from a directory name, which would collide "XAUUSD." with "XAUUSD".
_SAFE_DIR_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
)


@dataclass(frozen=True)
class SymbolRecord:
    """What the store holds about a symbol, beside its bars."""

    requested_name: str
    resolved_name: str
    spec: SymbolSpec
    swap_long: float
    swap_short: float
    recorded_at: datetime
    server_offset_minutes: int | None
    account_server: str | None
    store_format_version: int


class ParquetBarStore:
    """`BarSource` over Parquet. Read and write.

    `m1_reference_timeframe` has no default on purpose. It selects the series
    used as evidence of market opening hours in `has_m1`, which is a judgement
    with a real cost attached, and CLAUDE.md's "config, never constants" says
    that judgement belongs in `config/engine.yaml` rather than in a keyword
    default here. `from_config()` derives it.
    """

    def __init__(self, root: str | Path, *, m1_reference_timeframe: Timeframe) -> None:
        self._root = Path(root)
        if m1_reference_timeframe is Timeframe.M1:
            raise ConfigError(
                "m1_reference_timeframe must not be M1: the reference series is "
                "the independent evidence that the market was open, and M1 "
                "cannot be evidence for its own completeness."
            )
        self._reference_tf = m1_reference_timeframe
        self._alias_cache: dict[str, str] | None = None

    # ------------------------------------------------------- construction

    @classmethod
    def from_config(
        cls,
        config: Config,
        *,
        base_dir: str | Path | None = None,
        root: str | Path | None = None,
    ) -> "ParquetBarStore":
        """Build from `engine.yaml`.

        `root` overrides `engine.paths.historical_store` — that is how a fixture
        directory becomes a store without a second implementation. Relative
        paths resolve against `base_dir`, defaulting to the parent of the config
        directory (the repo root).
        """
        base = Path(base_dir) if base_dir is not None else config.source_dir.parent

        sub_bar = Timeframe(config.get("engine.timeframes.sub_bar"))
        if sub_bar is not Timeframe.M1:
            raise ConfigError(
                f"engine.timeframes.sub_bar is {sub_bar.value}, but §11.1 "
                f"specifies the sub-bar walk against M1 and the BarSource "
                f"protocol names its accessor m1_bars/has_m1. Reconcile the "
                f"config with the spec before recording anything."
            )

        analysis = config.get("engine.timeframes.analysis")
        if not isinstance(analysis, list) or not analysis:
            raise ConfigError("engine.timeframes.analysis must be a non-empty list")
        reference = min(
            (Timeframe(name) for name in analysis), key=timeframe_minutes
        )

        resolved_root = (
            Path(root)
            if root is not None
            else Path(config.get("engine.paths.historical_store"))
        )
        if not resolved_root.is_absolute():
            # Resolved, not left relative: a store path that moves with the
            # process's working directory is a store that silently splits in two.
            resolved_root = (base / resolved_root).resolve()

        return cls(resolved_root, m1_reference_timeframe=reference)

    @property
    def root(self) -> Path:
        return self._root

    @property
    def m1_reference_timeframe(self) -> Timeframe:
        return self._reference_tf

    # ------------------------------------------------------------- layout

    @staticmethod
    def _safe_dirname(symbol: str) -> str:
        escaped = "".join(
            char if char in _SAFE_DIR_CHARS else f"~{ord(char):02X}" for char in symbol
        )
        if not escaped:
            raise DataIntegrityError("symbol name is empty")
        return escaped

    def _symbol_dir(self, symbol: str, *, create: bool = False) -> Path:
        directory = self._root / self._safe_dirname(symbol)
        if create:
            directory.mkdir(parents=True, exist_ok=True)
            return directory
        if directory.is_dir():
            return directory
        alias = self._aliases().get(symbol)
        if alias is None:
            raise DataIntegrityError(
                f"store holds no symbol '{symbol}'. Known symbols: "
                f"{self.available_symbols()}. Record it before reading it — the "
                f"store never reconstructs a SymbolSpec from assumptions."
            )
        return self._root / alias

    def _aliases(self) -> dict[str, str]:
        """Both the requested and resolved names -> the on-disk directory name.

        Which of the two is canonical is not settled by the spec, so both work.
        """
        if self._alias_cache is not None:
            return self._alias_cache

        aliases: dict[str, str] = {}
        if self._root.is_dir():
            for directory in sorted(self._root.iterdir()):
                meta_path = directory / _META_FILENAME
                if not meta_path.is_file():
                    continue
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                for key in ("resolved_name", "requested_name"):
                    name = meta.get(key)
                    if isinstance(name, str) and name:
                        aliases.setdefault(name, directory.name)
        self._alias_cache = aliases
        return aliases

    def _bars_dir(self, symbol: str, timeframe: Timeframe, *, create: bool = False) -> Path:
        directory = self._symbol_dir(symbol, create=create) / _BARS_DIRNAME / timeframe.value
        if create:
            directory.mkdir(parents=True, exist_ok=True)
        return directory

    @staticmethod
    def _partition_key(moment: datetime) -> str:
        return f"{moment.year:04d}-{moment.month:02d}"

    @classmethod
    def _partition_keys(cls, start: datetime, end: datetime) -> list[str]:
        """Every monthly partition that can contain a bar in `[start, end)`."""
        keys: list[str] = []
        year, month = start.year, start.month
        while (year, month) <= (end.year, end.month):
            keys.append(f"{year:04d}-{month:02d}")
            month += 1
            if month > 12:
                month = 1
                year += 1
        return keys

    # -------------------------------------------------------------- meta

    def write_symbol_meta(
        self,
        spec: SymbolSpec,
        *,
        requested_name: str,
        swap_long: float,
        swap_short: float,
        server_offset_minutes: int | None = None,
        account_server: str | None = None,
        recorded_at: datetime | None = None,
    ) -> SymbolRecord:
        """Persist the §7.1 resolution beside the bars.

        Rewriting this is how a re-record refreshes the spec. It is deliberately
        a whole-record replace rather than a merge — a half-updated spec, where
        `stops_level` is new and `tick_value` is old, is worse than either.
        """
        record = SymbolRecord(
            requested_name=requested_name,
            resolved_name=spec.name,
            spec=spec,
            swap_long=float(swap_long),
            swap_short=float(swap_short),
            recorded_at=ensure_utc(recorded_at) if recorded_at else utc_now(),
            server_offset_minutes=server_offset_minutes,
            account_server=account_server,
            store_format_version=STORE_FORMAT_VERSION,
        )
        directory = self._symbol_dir(spec.name, create=True)
        payload = {
            "store_format_version": record.store_format_version,
            "requested_name": record.requested_name,
            "resolved_name": record.resolved_name,
            "spec": record.spec.model_dump(),
            "swap_long": record.swap_long,
            "swap_short": record.swap_short,
            "recorded_at_utc": record.recorded_at.isoformat(),
            "server_offset_minutes": record.server_offset_minutes,
            "account_server": record.account_server,
        }
        _atomic_write_text(
            directory / _META_FILENAME,
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
        )
        self._alias_cache = None
        return record

    def symbol_record(self, symbol: str) -> SymbolRecord:
        directory = self._symbol_dir(symbol)
        meta_path = directory / _META_FILENAME
        if not meta_path.is_file():
            raise DataIntegrityError(
                f"'{symbol}' has bars but no {_META_FILENAME}. The SymbolSpec "
                f"that was live when they were recorded is unknown, so §7.3 "
                f"constraints and §7.2 sizing cannot be reproduced. Re-record."
            )
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise DataIntegrityError(f"unreadable {meta_path}: {exc}") from exc

        version = meta.get("store_format_version")
        if version != STORE_FORMAT_VERSION:
            raise DataIntegrityError(
                f"{meta_path} was written by store format {version!r}; this "
                f"build reads {STORE_FORMAT_VERSION}. Re-record rather than "
                f"reinterpreting columns."
            )
        for key in ("spec", "swap_long", "swap_short"):
            if meta.get(key) is None:
                raise DataIntegrityError(
                    f"{meta_path} is missing '{key}'. costs.yaml declares "
                    f"swap.source: SYMBOL_INFO — a missing swap rate is a cost "
                    f"§11.2 would silently not charge."
                )
        return SymbolRecord(
            requested_name=str(meta.get("requested_name", meta["resolved_name"])),
            resolved_name=str(meta["resolved_name"]),
            spec=SymbolSpec(**meta["spec"]),
            swap_long=float(meta["swap_long"]),
            swap_short=float(meta["swap_short"]),
            recorded_at=datetime.fromisoformat(meta["recorded_at_utc"]),
            server_offset_minutes=meta.get("server_offset_minutes"),
            account_server=meta.get("account_server"),
            store_format_version=int(version),
        )

    # ------------------------------------------------------------ writing

    def write_bars(
        self, symbol: str, timeframe: Timeframe, bars: Sequence[Candle]
    ) -> int:
        """Append or upsert `bars`. Returns the number of rows written.

        Upsert, not append. Re-recording an overlapping window replaces the
        overlapping bars rather than duplicating them: within a partition,
        incoming rows win on a tied `time_utc`. This makes a re-record after a
        gap safe to run repeatedly, which matters because the operator will.

        Every bar is validated first (§11.2 spread, OHLC consistency) and a
        failure writes nothing — a partial write leaves a store that looks
        complete and is not.
        """
        if not bars:
            return 0

        frame = self._validate_and_frame(symbol, timeframe, bars)
        directory = self._bars_dir(symbol, timeframe, create=True)

        written = 0
        for key, part in frame.groupby(
            frame["time_utc"].dt.strftime("%Y-%m"), sort=True
        ):
            path = directory / f"{key}.parquet"
            combined = part
            if path.is_file():
                existing = _read_parquet(path)
                # Incoming last, so `keep="last"` makes the fresh record win.
                combined = pd.concat([existing, part], ignore_index=True)
            combined = (
                combined.drop_duplicates(subset="time_utc", keep="last")
                .sort_values("time_utc")
                .reset_index(drop=True)
            )
            _atomic_write_parquet(path, combined)
            written += len(part)

        return written

    def _validate_and_frame(
        self, symbol: str, timeframe: Timeframe, bars: Sequence[Candle]
    ) -> pd.DataFrame:
        rows: list[dict[str, Any]] = []
        for candle in bars:
            moment = ensure_utc(candle.time)
            # §11.2: "Per-bar recorded spread from the historical store, not a
            # constant." A non-positive spread is not a cheap fill, it is an
            # unrecorded one — and a store that accepts it produces a
            # frictionless backtest that looks like a real result.
            if candle.spread is None or candle.spread <= 0:
                raise DataIntegrityError(
                    f"{symbol} {timeframe.value} bar at {moment.isoformat()} has "
                    f"spread={candle.spread!r}. §11.2 requires a recorded "
                    f"per-bar spread and the store will not persist a zero. If "
                    f"this broker genuinely reports zero spread in its rate "
                    f"array, that is a data-source problem to settle with the "
                    f"broker, not a value to write down."
                )
            if candle.high < candle.low:
                raise DataIntegrityError(
                    f"{symbol} {timeframe.value} bar at {moment.isoformat()}: "
                    f"high {candle.high} < low {candle.low}"
                )
            if candle.high < max(candle.open, candle.close) or candle.low > min(
                candle.open, candle.close
            ):
                raise DataIntegrityError(
                    f"{symbol} {timeframe.value} bar at {moment.isoformat()}: "
                    f"OHLC inconsistent (o={candle.open} h={candle.high} "
                    f"l={candle.low} c={candle.close})"
                )
            rows.append(
                {
                    "time_utc": moment,
                    "open": float(candle.open),
                    "high": float(candle.high),
                    "low": float(candle.low),
                    "close": float(candle.close),
                    "tick_volume": int(candle.tick_volume),
                    "spread": int(candle.spread),
                }
            )

        frame = pd.DataFrame(rows, columns=_BAR_COLUMNS)
        frame["time_utc"] = pd.to_datetime(frame["time_utc"], utc=True)
        return frame.sort_values("time_utc").reset_index(drop=True)

    # ------------------------------------------------------------ reading

    def bars(
        self,
        symbol: str,
        timeframe: Timeframe,
        start: datetime,
        end: datetime,
    ) -> list[Candle]:
        """`BarSource.bars`. `start <= bar.time < end`, ascending, UTC."""
        frame = self._read_window(symbol, timeframe, start, end)
        return _frame_to_candles(frame)

    def m1_bars(self, symbol: str, start: datetime, end: datetime) -> list[Candle]:
        """`BarSource.m1_bars` — §11.1 sub-bar resolution."""
        return self.bars(symbol, Timeframe.M1, start, end)

    def _read_window(
        self,
        symbol: str,
        timeframe: Timeframe,
        start: datetime,
        end: datetime,
    ) -> pd.DataFrame:
        start_utc = ensure_utc(start)
        end_utc = ensure_utc(end)
        directory = self._bars_dir(symbol, timeframe)
        if end_utc <= start_utc or not directory.is_dir():
            return pd.DataFrame(columns=_BAR_COLUMNS)

        parts: list[pd.DataFrame] = []
        for key in self._partition_keys(start_utc, end_utc):
            path = directory / f"{key}.parquet"
            if path.is_file():
                parts.append(_read_parquet(path))
        if not parts:
            return pd.DataFrame(columns=_BAR_COLUMNS)

        frame = pd.concat(parts, ignore_index=True)
        frame = frame[
            (frame["time_utc"] >= start_utc) & (frame["time_utc"] < end_utc)
        ]
        frame = frame.sort_values("time_utc").reset_index(drop=True)
        _assert_spread_present(frame, symbol, timeframe)
        return frame

    def symbol_spec(self, symbol: str) -> SymbolSpec:
        """`BarSource.symbol_spec` — the spec that was live at record time."""
        return self.symbol_record(symbol).spec

    def swap_rates(self, symbol: str) -> tuple[float, float]:
        """`(swap_long, swap_short)` as recorded. §11.2 charges both."""
        record = self.symbol_record(symbol)
        return record.swap_long, record.swap_short

    def available_symbols(self) -> list[str]:
        """`BarSource.available_symbols` — broker-resolved names."""
        if not self._root.is_dir():
            return []
        names: list[str] = []
        for directory in sorted(self._root.iterdir()):
            meta_path = directory / _META_FILENAME
            if not meta_path.is_file():
                continue
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            name = meta.get("resolved_name")
            if isinstance(name, str) and name:
                names.append(name)
        return sorted(names)

    def coverage(
        self, symbol: str, timeframe: Timeframe
    ) -> tuple[datetime, datetime] | None:
        """`BarSource.coverage` — (first, last) bar open time, or None.

        Does not raise on an unknown symbol; returning None is the protocol's
        answer for "absent", and a caller asking about coverage is usually
        asking precisely because it does not know.
        """
        try:
            directory = self._bars_dir(symbol, timeframe)
        except DataIntegrityError:
            return None
        if not directory.is_dir():
            return None
        files = sorted(directory.glob("*.parquet"))
        if not files:
            return None

        first: datetime | None = None
        last: datetime | None = None
        for path in (files[0], files[-1]):
            frame = _read_parquet(path)
            if frame.empty:
                continue
            candidate_first = frame["time_utc"].min().to_pydatetime()
            candidate_last = frame["time_utc"].max().to_pydatetime()
            first = candidate_first if first is None else min(first, candidate_first)
            last = candidate_last if last is None else max(last, candidate_last)
        if first is None or last is None:
            return None
        return first, last

    # --------------------------------------------------- §11.1 M1 coverage

    def has_m1(self, symbol: str, start: datetime, end: datetime) -> bool:
        """`BarSource.has_m1` — True only when M1 coverage of `[start, end)` can
        be *demonstrated*. Partial coverage is False. Absence of evidence is
        False.

        How "the market was closed" is told apart from "the data is missing"
        ------------------------------------------------------------------
        **The spec does not say.** §11.1 requires the sub-bar walk and names
        "gaps, weekends, deep history" as the cases where M1 is unavailable, but
        it gives no rule for recognising them, and there is no trading-calendar
        source anywhere in the spec or in `config/`. Rather than invent a
        weekend rule (which would be wrong for BTCUSD, for broker holidays, and
        for the Friday close, all of which differ per symbol and per broker),
        this implementation asks the data:

        A minute is **expected** if and only if the store holds a bar on the
        *reference timeframe* — the finest analysis timeframe, from
        `engine.timeframes.analysis` — whose span covers it. MT5 emits a
        higher-timeframe bar only for periods in which the market traded, so the
        presence of that bar is direct recorded evidence that this broker was
        quoting the symbol then. `has_m1` returns True only when every expected
        minute has an M1 bar.

        What this deliberately gets wrong, and in which direction
        --------------------------------------------------------
        A minute inside an open reference bar that received **no ticks at all**
        has no M1 bar, and this rule counts it as missing. That is a false
        negative: `has_m1` says False, §11.1 falls back to the conservative
        stop-first assumption, and the trade is counted in the reported
        ambiguity rate. The error is visible and it is on the safe side.

        The failure it refuses to make is the other one — claiming coverage that
        does not exist, which produces a *confident wrong answer* from a sub-bar
        walk over a hole. §11.1: "ambiguity survives only if a single M1 candle
        spans both levels", and that guarantee is only worth anything if the M1
        series is actually complete.

        Consequently, a window with no reference bars at all also returns False.
        There is no evidence the market was open, so there is nothing to walk,
        and "nothing was expected therefore everything is present" is exactly
        the vacuous truth that would let a hole pass.
        """
        expected, present = self._m1_expectation(symbol, start, end)
        if not expected:
            return False
        return expected.issubset(present)

    def m1_gaps(
        self, symbol: str, start: datetime, end: datetime
    ) -> list[tuple[datetime, datetime]]:
        """Contiguous missing-minute ranges, as `[from, to)`. Diagnostics.

        Not part of `BarSource`. It exists so `has_m1() is False` can be
        explained to the operator rather than merely obeyed — a recorder that
        cannot say *which* minutes are missing cannot re-fetch them.
        """
        expected, present = self._m1_expectation(symbol, start, end)
        missing = sorted(expected - present)
        if not missing:
            return []

        minute = timedelta(minutes=1)
        gaps: list[tuple[datetime, datetime]] = []
        run_start = missing[0]
        previous = missing[0]
        for moment in missing[1:]:
            if moment - previous > minute:
                gaps.append((run_start, previous + minute))
                run_start = moment
            previous = moment
        gaps.append((run_start, previous + minute))
        return gaps

    def _m1_expectation(
        self, symbol: str, start: datetime, end: datetime
    ) -> tuple[set[datetime], set[datetime]]:
        start_utc = ensure_utc(start)
        end_utc = ensure_utc(end)
        if end_utc <= start_utc:
            return set(), set()

        reference_span = timeframe_delta(self._reference_tf)
        try:
            # Widened: a reference bar opening before `start` still covers
            # minutes inside the window.
            reference = self._read_window(
                symbol, self._reference_tf, start_utc - reference_span, end_utc
            )
            m1 = self._read_window(symbol, Timeframe.M1, start_utc, end_utc)
        except DataIntegrityError:
            # An unknown symbol, or a store with unrecorded spread, cannot
            # demonstrate coverage. It must not be reported as complete.
            return set(), set()

        minute = timedelta(minutes=1)
        expected: set[datetime] = set()
        for raw in reference["time_utc"]:
            bar_open = raw.to_pydatetime()
            cursor = max(bar_open, start_utc)
            bar_end = bar_open + reference_span
            while cursor < bar_end and cursor < end_utc:
                expected.add(cursor)
                cursor += minute

        present = {raw.to_pydatetime() for raw in m1["time_utc"]}
        return expected, present


# --------------------------------------------------------------- helpers


def _read_parquet(path: Path) -> pd.DataFrame:
    try:
        table = pq.read_table(path)
    except Exception as exc:  # pragma: no cover - corrupt file path
        raise DataIntegrityError(f"unreadable parquet {path}: {exc}") from exc
    missing = [name for name in _BAR_COLUMNS if name not in table.column_names]
    if missing:
        raise DataIntegrityError(
            f"{path} is missing columns {missing}. Expected the Stage 0 bar "
            f"schema {_BAR_COLUMNS}."
        )
    frame = table.to_pandas()
    frame["time_utc"] = pd.to_datetime(frame["time_utc"], utc=True)
    return frame[_BAR_COLUMNS]


def _assert_spread_present(
    frame: pd.DataFrame, symbol: str, timeframe: Timeframe
) -> None:
    """§11.2. A source that cannot supply spread raises rather than returning 0."""
    if frame.empty:
        return
    if "spread" not in frame.columns:
        raise DataIntegrityError(
            f"{symbol} {timeframe.value}: no spread column. §11.2 requires "
            f"per-bar recorded spread; a constant is not a substitute."
        )
    spread = frame["spread"]
    if spread.isna().any():
        first = frame.loc[spread.isna(), "time_utc"].iloc[0]
        raise DataIntegrityError(
            f"{symbol} {timeframe.value}: spread is null from {first}. §11.2 "
            f"requires a recorded per-bar spread."
        )
    if (spread <= 0).any():
        first = frame.loc[spread <= 0, "time_utc"].iloc[0]
        count = int((spread <= 0).sum())
        raise DataIntegrityError(
            f"{symbol} {timeframe.value}: {count} bar(s) carry a non-positive "
            f"spread, first at {first}. A zero spread is a frictionless "
            f"backtest wearing a disguise and is never returned silently."
        )


def _frame_to_candles(frame: pd.DataFrame) -> list[Candle]:
    if frame.empty:
        return []
    return [
        Candle(
            time=row.time_utc.to_pydatetime().astimezone(UTC),
            open=float(row.open),
            high=float(row.high),
            low=float(row.low),
            close=float(row.close),
            tick_volume=int(row.tick_volume),
            spread=int(row.spread),
        )
        for row in frame.itertuples(index=False)
    ]


def _atomic_write_parquet(path: Path, frame: pd.DataFrame) -> None:
    """Write via a temp file and rename, so a crash cannot truncate a partition."""
    table = pa.Table.from_pandas(
        frame[_BAR_COLUMNS], schema=_BAR_SCHEMA, preserve_index=False
    )
    temporary = path.with_name(path.name + ".tmp")
    pq.write_table(table, temporary)
    os.replace(temporary, path)


def _atomic_write_text(path: Path, text: str) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, path)


def iter_store_timeframes(config: Config) -> list[Timeframe]:
    """Every timeframe the store maintains: analysis timeframes plus M1.

    M1 is not an analysis timeframe (`engine.yaml` says so) but it is mandatory
    (§11.1), so the recorder must never derive its list from `analysis` alone.
    """
    analysis = [Timeframe(name) for name in config.get("engine.timeframes.analysis")]
    sub_bar = Timeframe(config.get("engine.timeframes.sub_bar"))
    ordered: list[Timeframe] = []
    for timeframe in [*analysis, sub_bar]:
        if timeframe not in ordered:
            ordered.append(timeframe)
    return ordered


__all__ = [
    "ParquetBarStore",
    "SymbolRecord",
    "STORE_FORMAT_VERSION",
    "iter_store_timeframes",
]
