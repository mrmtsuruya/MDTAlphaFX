"""The Stage 0 gate, as one command.

§9 Stage 0 states the gate in two parts:

    "a trivial strategy runs end-to-end over history and produces a metrics
     report, and a synthetic fixture in which stop and target share a candle
     resolves correctly against M1 data."

This script runs both and prints a verdict for each. It is deliberately not a
test — pytest proves the parts; this proves the *stage*, in a form an operator
can read.

    python scripts/run_gate.py

**On config.** The operator-approved §11.2 costs are loaded by the real config
before either gate condition runs. The sentinel guard is also exercised against
an isolated copied config, proving that a future unresolved value still refuses
instead of silently becoming zero.

**On "over history".** Condition 1 runs over a deterministic synthetic series
until all configured fixture periods exist as readable Parquet stores and replay
successfully. `config/backtest.yaml` holds the fixture windows as unresolved
operator decisions, so `scripts/record_fixtures.py` cannot run yet and there is
no recorded history to replay. Empty directories and lookalike junk do not
count. Until every configured period is replayed, condition 1 reports PASS
(SYNTHETIC) — the harness works end to end, but it has not yet been shown to
work on data from your broker.
"""

from __future__ import annotations

import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.contracts import Direction, Timeframe  # noqa: E402
from backend.core.config import Config  # noqa: E402
from backend.core.errors import ConfigError, DataIntegrityError  # noqa: E402
from backend.core.timeutil import (  # noqa: E402
    UTC,
    bar_close_time,
    ensure_utc,
    timeframe_delta,
)
from backend.backtest.intrabar import (  # noqa: E402
    IntrabarResolver,
    Resolution,
    ResolutionPath,
)
from backend.backtest.costs import CostModel, SwapRates, SwapUnit  # noqa: E402
from backend.backtest.metrics import build_report  # noqa: E402
from backend.backtest.replay import ReplayEngine, RunSpec  # noqa: E402
from backend.data.store import ParquetBarStore, iter_store_timeframes  # noqa: E402
from backend.strategies.trivial import NBarBreakout  # noqa: E402
from tests.doubles import (  # noqa: E402
    TEST_SYMBOL,
    InMemoryBarSource,
    candle,
    expand_to_m1,
    make_test_config,
    real_config,
    spec_for_tests,
    zigzag_series,
)

RULE = "=" * 78
THIN = "-" * 78

GATE_1_OVERRIDES = {
    "backtest.gate_strategy.lookback_bars": 3,
    "backtest.gate_strategy.stop_points": 100,
    "backtest.gate_strategy.target_points": 100,
}


class GateFailure(Exception):
    """One of the two gate conditions did not hold."""


@dataclass(frozen=True)
class RecordedFixtureRun:
    """One configured period proven through the real Parquet replay path."""

    period: str
    directory: Path
    symbol: str
    timeframe: Timeframe
    trade_count: int
    summary: str
    rendered_report: str


@dataclass(frozen=True)
class RecordedFixtureGate:
    """Qualification state for the configured recorded-fixture set.

    A partial set is useful evidence, but it is not §9's trending + ranging +
    high-volatility fixture set and therefore cannot remove the SYNTHETIC label.
    """

    expected_periods: tuple[str, ...]
    runs: tuple[RecordedFixtureRun, ...]
    rejected: tuple[tuple[str, str], ...]

    @property
    def completed_periods(self) -> tuple[str, ...]:
        completed = {run.period for run in self.runs}
        return tuple(period for period in self.expected_periods if period in completed)

    @property
    def total_trade_count(self) -> int:
        return sum(run.trade_count for run in self.runs)

    @property
    def all_periods_qualified(self) -> bool:
        return bool(self.expected_periods) and set(self.completed_periods) == set(
            self.expected_periods
        )

    @property
    def aggregate_failure(self) -> str | None:
        if self.all_periods_qualified and self.total_trade_count == 0:
            return (
                "all configured recorded periods qualified structurally but "
                "resolved zero trades in aggregate; §9 still requires recorded "
                "history to produce a metrics report with actual trades"
            )
        return None

    @property
    def complete(self) -> bool:
        return self.all_periods_qualified and self.aggregate_failure is None


# --------------------------------------------------------------------------
# Precondition: the harness must refuse to run frictionless.
# --------------------------------------------------------------------------


def check_costs_refuse_to_default() -> str:
    """Approved costs must load and unresolved replacements must still refuse.

    Not part of the stated gate, but checked first because both conditions
    below are meaningless if a cost silently defaults.
    """
    cfg = real_config()
    try:
        CostModel(cfg, TEST_SYMBOL, spec_for_tests())
        volume = cfg.get("backtest.replay.volume")
    except (ConfigError, ValueError) as exc:
        raise GateFailure(f"approved §11.2 config is not priceable: {exc}") from exc
    if isinstance(volume, bool) or not isinstance(volume, (int, float)) or volume <= 0:
        raise GateFailure(f"backtest.replay.volume must be positive, got {volume!r}")

    guarded_keys = (
        "costs.slippage.market_order_points",
        "costs.commission.per_lot_per_side.XAUUSD",
        "backtest.replay.volume",
    )
    with tempfile.TemporaryDirectory(prefix="mdt-cost-guard-") as directory:
        for index, key in enumerate(guarded_keys):
            injected = make_test_config(
                Path(directory) / str(index),
                {key: "<OPERATOR DECISION>"},
                include_defaults=False,
            )
            try:
                injected.get(key)
            except ConfigError:
                continue
            raise GateFailure(
                f"injected unresolved config key '{key}' did not refuse"
            )
    return (
        "approved costs load before replay; injected unresolved values still "
        "refuse — a run cannot start unpriced"
    )


# --------------------------------------------------------------------------
# Gate condition 1
# --------------------------------------------------------------------------


def gate_1_end_to_end(config: Config) -> tuple[str, str]:
    """Synthetic trivial strategy, end to end, producing a metrics report."""
    start = datetime(2026, 3, 2, 8, 0, tzinfo=UTC)
    tf = Timeframe.M15
    bars = zigzag_series(
        start, tf, base=2000.0, leg_bars=8, step=0.5, cycles=7, half_range=0.10
    )
    source = InMemoryBarSource(spec_for_tests(), {tf: bars}, expand_to_m1(bars, tf))

    result = ReplayEngine(config, source).run(
        NBarBreakout.from_config(config),
        RunSpec(
            symbol=TEST_SYMBOL,
            timeframe=tf,
            start=bars[0].time,
            end=bar_close_time(bars[-1].time, tf),
        ),
    )

    if result.bars_evaluated == 0:
        raise GateFailure("replay evaluated zero bars — nothing ran end to end")
    if not result.trades:
        raise GateFailure(
            "replay produced no trades, so no metrics report can be built. "
            "The gate requires a strategy that actually resolves positions."
        )

    report = build_report(result, config)
    rendered = report.render()
    if not rendered.strip():
        raise GateFailure("metrics report rendered empty")

    # Determinism — §11.3's walk-forward is meaningless without it.
    again = ReplayEngine(config, source).run(
        NBarBreakout.from_config(config),
        RunSpec(
            symbol=TEST_SYMBOL,
            timeframe=tf,
            start=bars[0].time,
            end=bar_close_time(bars[-1].time, tf),
        ),
    )
    if again.to_dict() != result.to_dict():
        raise GateFailure("two identical runs disagreed — the replay is not deterministic")

    summary = (
        f"{result.bars_evaluated} bars evaluated, {len(result.trades)} trades "
        f"resolved, {len(result.skipped)} signals recorded-and-skipped, "
        f"metrics report rendered, reruns byte-identical"
    )
    return summary, rendered


# --------------------------------------------------------------------------
# Gate condition 1 — recorded fixture qualification
# --------------------------------------------------------------------------


def _fixtures_root(config: Config) -> Path:
    root = Path(config.get("engine.paths.fixtures"))
    if not root.is_absolute():
        root = (config.source_dir.parent / root).resolve()
    return root


def gate_1_recorded(config: Config) -> RecordedFixtureGate:
    """Replay every configured fixture period through its Parquet store.

    The real config is deliberately used by the command, so unresolved costs,
    replay volume and swap-unit decisions keep the result synthetic. Tests pass
    an isolated, explicitly resolved config. No operator sentinel is replaced
    here.
    """
    periods = config.section("backtest.fixtures.periods")
    expected = tuple(periods)
    root = _fixtures_root(config)
    runs: list[RecordedFixtureRun] = []
    rejected: list[tuple[str, str]] = []

    for period in expected:
        directory = root / period
        try:
            runs.extend(_replay_recorded_period(config, period, directory))
        except (GateFailure, ConfigError, DataIntegrityError, OSError, ValueError) as exc:
            rejected.append((period, str(exc)))

    return RecordedFixtureGate(
        expected_periods=expected,
        runs=tuple(runs),
        rejected=tuple(rejected),
    )


def _replay_recorded_period(
    config: Config, period: str, directory: Path
) -> tuple[RecordedFixtureRun, ...]:
    if not directory.is_dir():
        raise GateFailure(f"fixture directory is missing: {directory}")

    start, end = _configured_period_bounds(config, period)
    expected_symbols = _configured_period_symbols(config, period)
    store = ParquetBarStore.from_config(config, root=directory)
    resolved_symbols = store.available_symbols()
    if not resolved_symbols:
        raise GateFailure(
            f"{directory} contains no readable symbol metadata; an empty or "
            f"lookalike directory is not a recorded fixture"
        )

    aliases: dict[str, str] = {}
    for resolved_symbol in resolved_symbols:
        record = store.symbol_record(resolved_symbol)
        aliases[record.requested_name] = resolved_symbol
        aliases[record.resolved_name] = resolved_symbol

    missing_symbols = [symbol for symbol in expected_symbols if symbol not in aliases]
    if missing_symbols:
        raise GateFailure(
            f"missing expected recorded symbol(s) {missing_symbols}; configured "
            f"for period '{period}': {list(expected_symbols)}"
        )

    runs = tuple(
        _replay_recorded_symbol(
            config,
            store,
            period,
            directory,
            aliases[symbol],
            start,
            end,
        )
        for symbol in expected_symbols
    )
    if len({run.symbol for run in runs}) != len(expected_symbols):
        raise GateFailure(
            f"period '{period}' maps multiple configured symbols to one recorded "
            "symbol; each expected symbol must be qualified independently"
        )
    return runs


def _configured_period_bounds(
    config: Config, period: str
) -> tuple[datetime, datetime]:
    moments: list[datetime] = []
    for edge in ("start", "end"):
        key = f"backtest.fixtures.periods.{period}.{edge}"
        raw = config.get(key)
        text = str(raw).strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            moment = datetime.fromisoformat(text)
        except ValueError as exc:
            raise ConfigError(
                f"{key} must be an ISO-8601 UTC instant, got {raw!r}"
            ) from exc
        if moment.tzinfo is None:
            raise ConfigError(
                f"{key} has no timezone. §10.1 requires configured fixture "
                "bounds to be explicit UTC instants."
            )
        moments.append(ensure_utc(moment))

    start, end = moments
    if end <= start:
        raise ConfigError(
            f"fixture period '{period}' has end {end.isoformat()} not after "
            f"start {start.isoformat()}"
        )
    return start, end


def _configured_period_symbols(config: Config, period: str) -> tuple[str, ...]:
    period_config = config.section(f"backtest.fixtures.periods.{period}")
    raw = period_config.get("symbols")
    if raw is None:
        raw = config.get("symbols.watchlist")
    if not isinstance(raw, list) or not raw:
        raise ConfigError(
            f"fixture period '{period}' must resolve to a non-empty symbol list"
        )
    symbols = tuple(str(symbol).strip() for symbol in raw)
    if any(not symbol for symbol in symbols):
        raise ConfigError(f"fixture period '{period}' contains an empty symbol")
    if len(set(symbols)) != len(symbols):
        raise ConfigError(
            f"fixture period '{period}' contains duplicate symbols: {list(symbols)}"
        )
    return symbols


def _replay_recorded_symbol(
    config: Config,
    store: ParquetBarStore,
    period: str,
    directory: Path,
    resolved_symbol: str,
    start: datetime,
    end: datetime,
) -> RecordedFixtureRun:
    record = store.symbol_record(resolved_symbol)
    symbol = record.requested_name
    required_timeframes = iter_store_timeframes(config)
    missing = [
        timeframe.value
        for timeframe in required_timeframes
        if store.coverage(symbol, timeframe) is None
    ]
    if missing:
        raise GateFailure(
            f"missing required recorded timeframe(s) {missing}; §9 requires "
            "analysis bars plus M1"
        )
    _require_recorded_window_coverage(
        store, symbol, required_timeframes, start, end
    )
    m1_complete = store.has_m1(symbol, start, end)
    m1_gaps = store.m1_gaps(symbol, start, end)
    m1_gap_count = len(m1_gaps)
    m1_missing_minutes = int(
        sum(
            (gap_end - gap_start) / timedelta(minutes=1)
            for gap_start, gap_end in m1_gaps
        )
    )

    timeframe = Timeframe.M15
    if timeframe not in required_timeframes:
        raise GateFailure(
            f"{timeframe.value} is not configured as an analysis timeframe; "
            f"the Stage 0 trivial gate is pinned to M15"
        )

    try:
        swap_unit = SwapUnit(config.get("costs.swap.rates.unit"))
    except ValueError as exc:
        raise ConfigError(
            "costs.swap.rates.unit must be POINTS or ACCOUNT_CURRENCY before a "
            "recorded fixture can be costed"
        ) from exc
    swap_rates = SwapRates(
        long=record.swap_long,
        short=record.swap_short,
        unit=swap_unit,
    )
    run_spec = RunSpec(
        symbol=symbol,
        timeframe=timeframe,
        start=start,
        end=end,
        swap_rates=swap_rates,
    )

    result = ReplayEngine(config, store).run(
        NBarBreakout.from_config(config), run_spec
    )
    if result.bars_evaluated == 0:
        raise GateFailure("replay evaluated zero recorded bars")

    report = build_report(result, config)
    invalid_fallbacks = [
        trade
        for trade in result.trades
        if trade.resolution_path is ResolutionPath.FALLBACK_NO_M1
        and not trade.ambiguous_fill
    ]
    if invalid_fallbacks:
        raise GateFailure(
            "§11.1 invariant failed: FALLBACK_NO_M1 trade(s) were not marked "
            "ambiguous_fill=True"
        )
    rendered = report.render()
    if not rendered.strip():
        raise GateFailure("recorded-fixture metrics report rendered empty")

    again = ReplayEngine(config, store).run(
        NBarBreakout.from_config(config), run_spec
    )
    if again.to_dict() != result.to_dict():
        raise GateFailure("two recorded-fixture runs disagreed")

    trade_summary = (
        f"{len(result.trades)} trades resolved"
        if result.trades
        else "0 trades resolved — NO CONCLUSIONS (§11.4)"
    )
    summary = (
        f"{period}: {result.bars_evaluated} bars evaluated, "
        f"{trade_summary}, {len(result.skipped)} signals "
        f"recorded-and-skipped, metrics rendered, reruns byte-identical; "
        + (
            "M1 coverage complete"
            if m1_complete
            else (
                f"M1 has {m1_missing_minutes} missing minute(s) in "
                f"{m1_gap_count} gap run(s), §11.1 fallback enabled"
            )
        )
        + (
            f"; PASS (LOWER_BOUND): ambiguity {report.overall.ambiguity_rate:.2%} "
            f"exceeds {report.ambiguity_rate_warn:.2%}"
            if report.ambiguity_exceeds_warn
            else f"; ambiguity {report.overall.ambiguity_rate:.2%}"
        )
    )
    return RecordedFixtureRun(
        period=period,
        directory=directory,
        symbol=symbol,
        timeframe=timeframe,
        trade_count=len(result.trades),
        summary=summary,
        rendered_report=rendered,
    )


def _require_recorded_window_coverage(
    store: ParquetBarStore,
    symbol: str,
    required_timeframes: list[Timeframe],
    start: datetime,
    end: datetime,
) -> None:
    incomplete: list[str] = []
    for timeframe in required_timeframes:
        coverage = store.coverage(symbol, timeframe)
        if coverage is None:
            continue
        first_open, last_open = coverage
        covered_until = bar_close_time(last_open, timeframe)
        # A range read returns bars whose OPEN lies inside [start, end).  When
        # `start` is not aligned to a coarser timeframe, the first legitimate
        # open is the next boundary (e.g. 16:00 H4 for a 13:00 start). Permit
        # less than one timeframe of leading alignment, but no stale window.
        starts_too_late = first_open >= start + timeframe_delta(timeframe)
        if starts_too_late or covered_until < end:
            incomplete.append(
                f"{timeframe.value}={first_open.isoformat()}.."
                f"{covered_until.isoformat()}"
            )
            continue
        if not store.bars(symbol, timeframe, start, end):
            incomplete.append(f"{timeframe.value}=no bars inside configured window")

    if incomplete:
        raise GateFailure(
            "recorded timeframe coverage does not span configured half-open "
            f"window [{start.isoformat()}, {end.isoformat()}): {incomplete}"
        )


# --------------------------------------------------------------------------
# Gate condition 2
# --------------------------------------------------------------------------


def _one_candle_spanning_both(m1_reaches_target_first: bool):
    """An M15 candle whose range contains BOTH the stop and the target.

    OHLC alone cannot say which came first — that is §11.1's whole problem. The
    M1 series underneath is what settles it, and it is built two ways so the
    resolver has to actually read it rather than guess.
    """
    t0 = datetime(2026, 3, 2, 8, 0, tzinfo=UTC)
    entry, stop, target = 2000.00, 1999.00, 2001.00

    parent = candle(t0, entry, 2001.50, 1998.50, 2000.50, spread=20)

    # Fifteen M1 bars. One ordering touches 2001.00 first, the other 1999.00,
    # and neither individual M1 bar spans both levels.
    m1 = []
    for k in range(15):
        ts = t0.replace(minute=k)
        if m1_reaches_target_first:
            if k == 3:
                m1.append(candle(ts, 2000.4, 2001.50, 2000.3, 2001.2, spread=20))
            elif k == 9:
                m1.append(candle(ts, 2000.2, 2000.3, 1998.50, 1999.0, spread=20))
            else:
                m1.append(candle(ts, 2000.0, 2000.2, 1999.8, 2000.1, spread=20))
        else:
            if k == 3:
                m1.append(candle(ts, 1999.9, 2000.1, 1998.50, 1998.8, spread=20))
            elif k == 9:
                m1.append(candle(ts, 1999.5, 2001.50, 1999.4, 2001.0, spread=20))
            else:
                m1.append(candle(ts, 2000.0, 2000.2, 1999.8, 2000.1, spread=20))

    source = InMemoryBarSource(spec_for_tests(), {Timeframe.M15: [parent]}, m1)
    return source, parent, entry, stop, target


def gate_2_intrabar(config: Config) -> str:
    """A synthetic fixture where stop and target fall inside one candle,
    resolved correctly against M1 data."""
    lines: list[str] = []

    for target_first in (True, False):
        source, parent, entry, stop, target = _one_candle_spanning_both(target_first)

        # The premise: the parent candle really does contain both levels.
        if not (parent.low <= stop and parent.high >= target):
            raise GateFailure("fixture is wrong — the candle does not span both levels")

        outcome = IntrabarResolver(config, source).resolve(
            symbol=TEST_SYMBOL,
            timeframe=Timeframe.M15,
            bar=parent,
            direction=Direction.BUY,
            stop=stop,
            target=target,
        )

        expected = Resolution.TARGET_FIRST if target_first else Resolution.STOP_FIRST
        if outcome.resolution is not expected:
            raise GateFailure(
                f"M1 says {expected.value} was reached first, resolver said "
                f"{outcome.resolution.value!r} via {outcome.path.value}"
            )
        if outcome.path is not ResolutionPath.SUB_BAR_WALK:
            raise GateFailure(
                f"expected the §11.1 sub-bar walk to decide this, got "
                f"{outcome.path.value!r}"
            )
        if outcome.ambiguous_fill:
            raise GateFailure(
                "resolver flagged AMBIGUOUS_FILL despite complete M1 coverage. "
                "§11.1's sub-bar walk resolved it; flagging it inflates the "
                "ambiguity rate and understates the equity curve."
            )
        lines.append(
            f"    M1 reaches {expected.value:<12} -> {outcome.resolution.value:<12} "
            f"via {outcome.path.value:<14} ambiguous=False"
        )

    # And the conservative fallback, without M1. §11.1 rule 2.
    source, parent, entry, stop, target = _one_candle_spanning_both(
        m1_reaches_target_first=True
    )
    bare = InMemoryBarSource(spec_for_tests(), {Timeframe.M15: [parent]}, [])
    outcome = IntrabarResolver(config, bare).resolve(
        symbol=TEST_SYMBOL,
        timeframe=Timeframe.M15,
        bar=parent,
        direction=Direction.BUY,
        stop=stop,
        target=target,
    )
    if outcome.resolution is not Resolution.STOP_FIRST:
        raise GateFailure(
            f"without M1 the fallback must assume the STOP was hit first "
            f"(§11.1 rule 2), got {outcome.resolution.value!r}. The M1 series "
            f"that was removed reached the TARGET first — resolving favourably "
            f"here would be the exact bias §11.1 forbids."
        )
    if not outcome.ambiguous_fill:
        raise GateFailure("fallback did not flag AMBIGUOUS_FILL — §11.1 rule 3")
    lines.append(
        f"    M1 unavailable            -> {outcome.resolution.value:<12} "
        f"via {outcome.path.value:<14} ambiguous=True"
    )

    return "\n".join(lines)


def main() -> int:
    print(RULE)
    print("MDTAlphaFX — Stage 0 gate")
    print("§9: a trivial strategy runs end-to-end over history and produces a")
    print("    metrics report, AND a synthetic fixture in which stop and target")
    print("    share a candle resolves correctly against M1 data.")
    print(RULE)

    failures: list[str] = []
    repository_config = real_config()
    recorded_complete = False

    print("\nPRECONDITION  §11.2 costs are not skippable")
    try:
        print(f"  PASS  {check_costs_refuse_to_default()}")
    except GateFailure as exc:
        print(f"  FAIL  {exc}")
        failures.append("precondition")

    with tempfile.TemporaryDirectory() as tmp:
        config = make_test_config(Path(tmp), GATE_1_OVERRIDES)

        print("\nCONDITION 1   trivial strategy runs end-to-end, metrics report")
        report_text = ""
        report_label = "Synthetic metrics report (§11.4)"
        try:
            summary, report_text = gate_1_end_to_end(config)
            recorded = gate_1_recorded(repository_config)
            if recorded.complete:
                recorded_complete = True
                print(f"  PASS  {summary}")
                for run in recorded.runs:
                    print(f"        RECORDED  {run.summary}")
                report_run = next(
                    run for run in recorded.runs if run.trade_count > 0
                )
                report_text = report_run.rendered_report
                report_label = (
                    f"Recorded metrics report — {report_run.period} "
                    f"(§11.4)"
                )
            else:
                print(f"  PASS (SYNTHETIC)  {summary}")
                if recorded.runs:
                    print(
                        f"        Recorded fixture replay is incomplete "
                        f"({len(recorded.completed_periods)}/"
                        f"{len(recorded.expected_periods)} "
                        f"configured periods passed):"
                    )
                    for run in recorded.runs:
                        print(f"          PASS  {run.summary}")
                else:
                    print("        No configured recorded fixture period replayed.")
                for period, reason in recorded.rejected:
                    print(f"          {period}: {reason}")
                if recorded.aggregate_failure:
                    print(f"          aggregate: {recorded.aggregate_failure}")
                print("        Empty/junk directories do not count. The harness is")
                print("        proven; it has NOT been proven across the configured")
                print("        broker-history fixture set.")
        except GateFailure as exc:
            print(f"  FAIL  {exc}")
            failures.append("condition 1")

        print("\nCONDITION 2   stop and target in one candle, resolved against M1")
        try:
            print(gate_2_intrabar(config))
            print("  PASS  sub-bar walk resolves both orderings; "
                  "absent M1 falls back to the loss and flags it")
        except GateFailure as exc:
            print(f"  FAIL  {exc}")
            failures.append("condition 2")

        if report_text:
            print("\n" + THIN)
            print(report_label)
            print(THIN)
            print(report_text)

    print("\n" + RULE)
    if failures:
        print(f"STAGE 0 GATE: FAILED — {', '.join(failures)}")
        print(RULE)
        return 1
    if recorded_complete:
        print("STAGE 0 GATE: PASSED — RECORDED FIXTURES QUALIFIED")
        print("All configured broker-history periods replayed deterministically;")
        print("the §9 recorded-history and intrabar conditions are closed.")
    else:
        print("STAGE 0 GATE: PASSED (SYNTHETIC HARNESS ONLY)")
        print("The recorded-history condition remains open. Record every approved")
        print("fixture period and require an unqualified RECORDED pass above.")
    print(RULE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
