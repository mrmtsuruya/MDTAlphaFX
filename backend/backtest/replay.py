"""Bar-close replay engine — §9 Stage 0, §11.

    §11 preamble: "The replay engine from Stage 0 is also the backtester — same
    pipeline, same code path, historical bars instead of live ones. If the
    backtester has its own evaluation logic, it is testing something other than
    the system you will trade."

So this is written as *the* evaluation loop, not as a backtest-shaped copy of
one. The seams a later stage plugs into are:

- **Bars** arrive through the `BarSource` protocol. A live wiring supplies a
  source backed by the MT5 connector instead of the store; nothing in this file
  changes.
- **Levels** arrive through `PlanSource`. Stage 0 ships the one that reads them
  from `StrategyResult.evidence`; Stage 1's §5.5 level derivation becomes a
  second implementation, not a fork of this loop.
- **Fills** go through `broker_rules` and `costs`, which are the same objects
  §7.3 and §11.2 govern in production.

**Rule 6 — evaluation happens on bar close, not on tick.** The loop only ever
hands a strategy bars that have closed. A strategy evaluating at the close of
bar *i* cannot see bar *i+1*, and cannot fill before bar *i+1* opens.

**Determinism.** No wall-clock read, no randomness, no dict iteration over
unsorted keys, no mutable module state. Same inputs, byte-identical
`to_dict()`, forever. This is a precondition for §11.3's walk-forward analysis
being meaningful at all: if a rerun of the same window differs, an in-sample
versus out-of-sample comparison measures the engine's noise, not the strategy's.

**Not in scope (Stage 1+).** No regime classification, no cluster scoring, no
confluence, no gates, no level derivation, no signal lifecycle, no order
placement. The engine drives a `Strategy` and resolves the trade it implies.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Protocol

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec, Timeframe
from ..core.config import Config
from ..core.errors import ConfigError, DataIntegrityError
from ..core.timeutil import bar_close_time, ensure_utc
from ..data.source import BarSource
from ..strategies.base import Strategy, check_window
from .broker_rules import (
    BrokerRules,
    Operation,
    RejectReason,
    check_volume,
    normalise_price,
    round_volume_down,
)
from .costs import CostModel, OrderKind, SwapRates, TradeCosts
from .intrabar import IntrabarResolver, Resolution, ResolutionPath

# Keys a `StrategyResult.evidence` dict must carry for `EvidencePlanSource` to
# find the trade the module implies. Names, not numbers — see AMBIGUITY-B11.
EVIDENCE_STOP_KEY = "stop_loss"
EVIDENCE_TARGET_KEY = "take_profit"


class EntryFill(str, Enum):
    """Where a bar-close signal fills. AMBIGUITY-B08 — only one is implemented."""

    NEXT_BAR_OPEN = "NEXT_BAR_OPEN"


class UnresolvedPolicy(str, Enum):
    """What happens to a position still open when the data runs out.
    AMBIGUITY-B09 — only one is implemented."""

    REPORT_SEPARATELY = "REPORT_SEPARATELY"


class TerminalReason(str, Enum):
    TARGET = "TARGET"
    STOP = "STOP"
    DATA_END = "DATA_END"


class SkipReason(str, Enum):
    """Why a fired signal produced no trade. Recorded, never dropped — rule 8's
    principle: a filter the operator cannot see is one they will misconfigure."""

    POSITION_OPEN = "POSITION_OPEN"
    NO_NEXT_BAR = "NO_NEXT_BAR"
    FILL_REJECTED = "FILL_REJECTED"
    ENTRY_BEYOND_LEVELS = "ENTRY_BEYOND_LEVELS"
    NO_PLAN = "NO_PLAN"


@dataclass(frozen=True)
class TradePlan:
    """The trade a fired module implies. Immutable — rule 9's principle applied
    a stage early: once these levels exist they are never recomputed, so a
    position cannot drift underneath its own risk calculation."""

    direction: Direction
    stop_loss: float
    take_profit: float


class PlanSource(Protocol):
    """Turns a `StrategyResult` into a `TradePlan`, or None.

    This is the seam where Stage 1's §5.5 level derivation lands. It is a
    separate object rather than a branch inside the loop precisely so that
    landing it does not mean editing this file.
    """

    def plan_for(
        self, result: StrategyResult, bars: list[Candle], spec: SymbolSpec
    ) -> TradePlan | None: ...


class EvidencePlanSource:
    """Reads levels from `StrategyResult.evidence`.

    §2's `StrategyResult` has `fired`, `direction`, `score` and `evidence` — and
    no level fields. §5.5, which computes stop and targets, is **Stage 1**. So a
    Stage 0 replay has no specified source of levels at all (AMBIGUITY-B11);
    `evidence` is the only field on the frozen contract that can carry them, and
    this reads the two documented keys out of it.

    Absent or malformed keys produce `None` and a recorded `NO_PLAN` skip. They
    are never defaulted — a stop distance invented by the harness would be the
    single most expensive number in the whole result set.
    """

    def plan_for(
        self, result: StrategyResult, bars: list[Candle], spec: SymbolSpec
    ) -> TradePlan | None:
        evidence = result.evidence or {}
        stop = evidence.get(EVIDENCE_STOP_KEY)
        target = evidence.get(EVIDENCE_TARGET_KEY)
        if not isinstance(stop, (int, float)) or not isinstance(target, (int, float)):
            return None
        if isinstance(stop, bool) or isinstance(target, bool):
            return None
        if result.direction not in (Direction.BUY, Direction.SELL):
            return None
        if result.direction is Direction.BUY and not stop < target:
            return None
        if result.direction is Direction.SELL and not target < stop:
            return None
        return TradePlan(
            direction=result.direction,
            stop_loss=float(stop),
            take_profit=float(target),
        )


@dataclass(frozen=True)
class RunSpec:
    """One replay. Every field explicit — nothing is inferred from a clock."""

    symbol: str
    timeframe: Timeframe
    start: datetime
    end: datetime
    volume: float | None = None
    """Lots. `None` reads `backtest.replay.volume`, which is an unresolved
    operator decision until set (AMBIGUITY-B10)."""
    swap_rates: SwapRates | None = None
    """`None` reads `costs.swap.rates.<symbol>`, likewise unresolved until set
    (AMBIGUITY-B03)."""


@dataclass(frozen=True)
class SimulatedTrade:
    """One resolved round trip. Carries how it was resolved, not just what it
    paid — a result set whose ambiguity is not attached to individual trades
    cannot be segmented by it later."""

    trade_id: str
    symbol: str
    timeframe: Timeframe
    module_id: int
    module_name: str
    direction: Direction

    signal_bar_time: datetime
    entry_time: datetime
    entry_price: float
    stop_loss: float
    take_profit: float
    volume: float

    exit_time: datetime
    exit_price: float
    terminal_reason: TerminalReason
    resolution_path: ResolutionPath
    ambiguous_fill: bool
    gapped_exit: bool
    resolution_detail: str
    bars_held: int
    sessions: tuple[str, ...]

    risk_price: float
    gross_r: float
    commission_r: float
    swap_r: float
    net_r: float
    gross_pnl_ccy: float
    net_pnl_ccy: float
    costs: TradeCosts

    @property
    def resolved(self) -> bool:
        """False for a trade closed only because the data ran out. Those have no
        terminal price the market ever offered, so they are excluded from the
        aggregates rather than quietly counted as wins or losses."""
        return self.terminal_reason is not TerminalReason.DATA_END

    def to_dict(self) -> dict[str, Any]:
        return {
            "trade_id": self.trade_id,
            "symbol": self.symbol,
            "timeframe": self.timeframe.value,
            "module_id": self.module_id,
            "module_name": self.module_name,
            "direction": self.direction.value,
            "signal_bar_time": self.signal_bar_time.isoformat(),
            "entry_time": self.entry_time.isoformat(),
            "entry_price": self.entry_price,
            "stop_loss": self.stop_loss,
            "take_profit": self.take_profit,
            "volume": self.volume,
            "exit_time": self.exit_time.isoformat(),
            "exit_price": self.exit_price,
            "terminal_reason": self.terminal_reason.value,
            "resolution_path": self.resolution_path.value,
            "ambiguous_fill": self.ambiguous_fill,
            "gapped_exit": self.gapped_exit,
            "resolution_detail": self.resolution_detail,
            "bars_held": self.bars_held,
            "sessions": list(self.sessions),
            "risk_price": self.risk_price,
            "gross_r": self.gross_r,
            "commission_r": self.commission_r,
            "swap_r": self.swap_r,
            "net_r": self.net_r,
            "gross_pnl_ccy": self.gross_pnl_ccy,
            "net_pnl_ccy": self.net_pnl_ccy,
            "costs": {
                "spread_points_entry": self.costs.spread_points_entry,
                "spread_points_exit": self.costs.spread_points_exit,
                "spread_price_entry": self.costs.spread_price_entry,
                "spread_price_exit": self.costs.spread_price_exit,
                "slippage_price_entry": self.costs.slippage_price_entry,
                "slippage_price_exit": self.costs.slippage_price_exit,
                "commission_ccy": self.costs.commission_ccy,
                "swap_ccy": self.costs.swap_ccy,
                "rollover_nights": self.costs.rollover_nights,
                "triple_nights": self.costs.triple_nights,
            },
        }


@dataclass(frozen=True)
class SkippedSignal:
    """A module fired and no trade resulted. §10.2: "Near-misses are logged
    too." Without these the report cannot distinguish a strategy that never
    fires from one whose every fill the broker would have refused."""

    signal_bar_time: datetime
    direction: Direction
    reason: SkipReason
    detail: str
    reject_reasons: tuple[RejectReason, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "signal_bar_time": self.signal_bar_time.isoformat(),
            "direction": self.direction.value,
            "reason": self.reason.value,
            "detail": self.detail,
            "reject_reasons": [r.value for r in self.reject_reasons],
        }


@dataclass(frozen=True)
class RunResult:
    symbol: str
    timeframe: Timeframe
    start: datetime
    end: datetime
    bars_evaluated: int
    volume: float
    config_version: str
    module_id: int
    module_name: str
    trades: tuple[SimulatedTrade, ...]
    skipped: tuple[SkippedSignal, ...]

    def to_dict(self) -> dict[str, Any]:
        """Stable, JSON-serialisable, key-ordered. Two identical runs serialise
        byte-identically; that is the determinism assertion."""
        return {
            "symbol": self.symbol,
            "timeframe": self.timeframe.value,
            "start": self.start.isoformat(),
            "end": self.end.isoformat(),
            "bars_evaluated": self.bars_evaluated,
            "volume": self.volume,
            "config_version": self.config_version,
            "module_id": self.module_id,
            "module_name": self.module_name,
            "trades": [t.to_dict() for t in self.trades],
            "skipped": [s.to_dict() for s in self.skipped],
        }


class ReplayEngine:
    """Walks history bar by bar and resolves whatever the strategy implies."""

    def __init__(
        self,
        config: Config,
        source: BarSource,
        plan_source: PlanSource | None = None,
    ):
        declared_analysis_only = getattr(source, "analysis_only", None)
        declared_cost_valid = getattr(source, "cost_valid", None)
        if declared_analysis_only is True or declared_cost_valid is False:
            raise DataIntegrityError(
                "ReplayEngine refuses the declared analysis-only/cost-invalid "
                f"source {type(source).__module__}.{type(source).__qualname__}: "
                f"analysis_only={declared_analysis_only!r}, "
                f"cost_valid={declared_cost_valid!r}. Detector co-firing data "
                "cannot enter replay, cost modelling, execution simulation, "
                "outcome resolution, trade metrics, or backtests."
            )
        self._config = config
        self._source = source
        self._plans = plan_source or EvidencePlanSource()

        evaluate_on = config.get("backtest.replay.evaluate_on")
        if evaluate_on != "BAR_CLOSE":
            raise ConfigError(
                f"backtest.replay.evaluate_on is {evaluate_on!r}. Rule 6: "
                f"evaluation happens on bar close, not on tick. There is no "
                f"other supported value."
            )

        entry_fill = config.get("backtest.replay.entry_fill")
        try:
            self._entry_fill = EntryFill(entry_fill)
        except ValueError as exc:
            raise ConfigError(
                f"backtest.replay.entry_fill is {entry_fill!r}; only "
                f"{[e.value for e in EntryFill]} is implemented. The spec does "
                f"not say where a bar-close signal fills (AMBIGUITY-B08)."
            ) from exc

        unresolved = config.get("backtest.replay.unresolved_at_data_end")
        try:
            self._unresolved = UnresolvedPolicy(unresolved)
        except ValueError as exc:
            raise ConfigError(
                f"backtest.replay.unresolved_at_data_end is {unresolved!r}; only "
                f"{[p.value for p in UnresolvedPolicy]} is implemented "
                f"(AMBIGUITY-B09)."
            ) from exc

        warmup = config.get("backtest.replay.warmup_bars")
        if not isinstance(warmup, int) or isinstance(warmup, bool) or warmup < 0:
            raise ConfigError(
                f"backtest.replay.warmup_bars must be a non-negative integer, "
                f"got {warmup!r}."
            )
        self._warmup_bars = warmup

        concurrent = config.get("backtest.replay.concurrent_positions_per_symbol")
        if concurrent != 1:
            raise ConfigError(
                f"backtest.replay.concurrent_positions_per_symbol is "
                f"{concurrent!r}. §7.4 sets max positions per symbol to 1 and "
                f"only that is implemented; stacking positions in replay would "
                f"measure a strategy the live guards refuse to run."
            )

        self._resolver = IntrabarResolver(config, source)

    # ------------------------------------------------------------------ run

    def run(self, strategy: Strategy, run: RunSpec) -> RunResult:
        start = ensure_utc(run.start)
        end = ensure_utc(run.end)
        if end <= start:
            raise ValueError("RunSpec.end must be after RunSpec.start")

        spec = self._source.symbol_spec(run.symbol)

        coverage = self._source.coverage(run.symbol, run.timeframe)
        if coverage is None:
            raise DataIntegrityError(
                f"no {run.timeframe.value} coverage for {run.symbol} in the "
                f"source. Refusing to replay a window the store does not hold."
            )
        first, last = ensure_utc(coverage[0]), ensure_utc(coverage[1])
        if start < first or end > bar_close_time(last, run.timeframe):
            raise DataIntegrityError(
                f"requested window [{start.isoformat()}, {end.isoformat()}) "
                f"exceeds {run.symbol} {run.timeframe.value} coverage "
                f"[{first.isoformat()}, {last.isoformat()}]. A short series "
                f"silently returned is a backtest over less history than it "
                f"claims."
            )

        # Costs are resolved BEFORE any bar is walked. §11.2: a run with
        # unresolved friction refuses to start rather than running frictionless.
        cost_model = CostModel(self._config, run.symbol, spec, run.swap_rates)
        rules = BrokerRules(self._config, run.symbol)

        volume = self._resolve_volume(run, spec)

        bars = self._source.bars(run.symbol, run.timeframe, start, end)
        if not bars:
            raise DataIntegrityError(
                f"source returned no {run.timeframe.value} bars for "
                f"{run.symbol} in [{start.isoformat()}, {end.isoformat()})"
            )

        trades: list[SimulatedTrade] = []
        skipped: list[SkippedSignal] = []
        evaluated = 0

        # Index of the bar at which the currently-open position resolves. While
        # a position is open the loop keeps evaluating (so skips are recorded),
        # but cannot open another — §7.4, one position per symbol.
        open_until_index = -1

        first_evaluable = strategy.min_bars + self._warmup_bars

        for i in range(first_evaluable - 1, len(bars)):
            # Rule 6: the window is exactly the bars that have CLOSED. Bar i has
            # just closed; bar i+1 does not exist yet as far as the strategy is
            # concerned.
            window = bars[: i + 1]
            check_window(strategy, window)
            evaluated += 1

            result = strategy.evaluate(window, spec)
            if not result.fired or result.direction is Direction.NONE:
                continue

            signal_bar = bars[i]
            signal_bar_time = ensure_utc(signal_bar.time)

            if i < open_until_index:
                skipped.append(
                    SkippedSignal(
                        signal_bar_time=signal_bar_time,
                        direction=result.direction,
                        reason=SkipReason.POSITION_OPEN,
                        detail=(
                            "a position was already open on this symbol; §7.4 "
                            "allows one position per symbol"
                        ),
                    )
                )
                continue

            plan = self._plans.plan_for(result, window, spec)
            if plan is None:
                skipped.append(
                    SkippedSignal(
                        signal_bar_time=signal_bar_time,
                        direction=result.direction,
                        reason=SkipReason.NO_PLAN,
                        detail=(
                            f"the module fired but supplied no usable "
                            f"{EVIDENCE_STOP_KEY}/{EVIDENCE_TARGET_KEY} in its "
                            f"evidence, and the harness will not invent levels "
                            f"(§5.5 is Stage 1)"
                        ),
                    )
                )
                continue

            if i + 1 >= len(bars):
                skipped.append(
                    SkippedSignal(
                        signal_bar_time=signal_bar_time,
                        direction=result.direction,
                        reason=SkipReason.NO_NEXT_BAR,
                        detail=(
                            "signal fired on the last bar of the window; there "
                            "is no bar to fill on without looking ahead"
                        ),
                    )
                )
                continue

            trade, skip, resolved_index = self._open_and_track(
                bars=bars,
                signal_index=i,
                plan=plan,
                result=result,
                spec=spec,
                volume=volume,
                cost_model=cost_model,
                rules=rules,
                run=run,
            )
            if skip is not None:
                skipped.append(skip)
                continue

            assert trade is not None
            trades.append(trade)
            open_until_index = resolved_index

        return RunResult(
            symbol=run.symbol,
            timeframe=run.timeframe,
            start=start,
            end=end,
            bars_evaluated=evaluated,
            volume=volume,
            config_version=self._config.version,
            module_id=strategy.module_id,
            module_name=strategy.module_name,
            trades=tuple(trades),
            skipped=tuple(skipped),
        )

    # ------------------------------------------------------------- internals

    def _resolve_volume(self, run: RunSpec, spec: SymbolSpec) -> float:
        raw = run.volume
        if raw is None:
            raw = self._config.get("backtest.replay.volume")
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise ConfigError(
                f"backtest.replay.volume must be a number of lots, got {raw!r}."
            )
        volume = round_volume_down(float(raw), spec)
        validation = check_volume(volume, spec)
        if not validation.accepted:
            raise ConfigError(
                "the configured replay volume violates §7.3: "
                + "; ".join(validation.detail)
            )
        return volume

    def _open_and_track(
        self,
        *,
        bars: list[Candle],
        signal_index: int,
        plan: TradePlan,
        result: StrategyResult,
        spec: SymbolSpec,
        volume: float,
        cost_model: CostModel,
        rules: BrokerRules,
        run: RunSpec,
    ) -> tuple[SimulatedTrade | None, SkippedSignal | None, int]:
        signal_bar = bars[signal_index]
        signal_bar_time = ensure_utc(signal_bar.time)
        entry_bar = bars[signal_index + 1]
        entry_time = ensure_utc(entry_bar.time)

        # AMBIGUITY-B08: NEXT_BAR_OPEN. Bar close is when the engine learns; the
        # next open is the first price it could have traded at.
        reference = entry_bar.open
        entry_price = normalise_price(
            cost_model.entry_fill(
                reference_price=reference,
                direction=plan.direction,
                order_kind=OrderKind.MARKET,
                bar=entry_bar,
            ),
            spec,
        )

        validation = rules.validate_fill(
            bar=entry_bar,
            price=entry_price,
            stop_loss=plan.stop_loss,
            take_profit=plan.take_profit,
            volume=volume,
            spec=spec,
            moment=entry_time,
            operation=Operation.OPEN,
        )
        if not validation.accepted:
            return (
                None,
                SkippedSignal(
                    signal_bar_time=signal_bar_time,
                    direction=plan.direction,
                    reason=SkipReason.FILL_REJECTED,
                    detail="; ".join(validation.detail),
                    reject_reasons=validation.reasons,
                ),
                -1,
            )

        # Slippage or spread can push the fill through its own stop or past its
        # own target. A position whose risk is zero or inverted is not a trade.
        beyond = (
            plan.direction is Direction.BUY
            and not plan.stop_loss < entry_price < plan.take_profit
        ) or (
            plan.direction is Direction.SELL
            and not plan.take_profit < entry_price < plan.stop_loss
        )
        if beyond:
            return (
                None,
                SkippedSignal(
                    signal_bar_time=signal_bar_time,
                    direction=plan.direction,
                    reason=SkipReason.ENTRY_BEYOND_LEVELS,
                    detail=(
                        f"fill at {entry_price!r} does not sit between "
                        f"stop {plan.stop_loss!r} and target "
                        f"{plan.take_profit!r} after spread and slippage"
                    ),
                ),
                -1,
            )

        risk_price = abs(entry_price - plan.stop_loss)

        for j in range(signal_index + 1, len(bars)):
            bar = bars[j]
            outcome = self._resolver.resolve(
                symbol=run.symbol,
                bar=bar,
                timeframe=run.timeframe,
                direction=plan.direction,
                stop=plan.stop_loss,
                target=plan.take_profit,
                price_adjustment=lambda candidate_bar: cost_model.spread_adjustment(
                    plan.direction,
                    candidate_bar,
                    is_exit=True,
                ),
            )
            if outcome.resolution is Resolution.NEITHER:
                continue

            terminal = (
                TerminalReason.STOP
                if outcome.resolution is Resolution.STOP_FIRST
                else TerminalReason.TARGET
            )
            exit_order_kind = (
                OrderKind.STOP if terminal is TerminalReason.STOP else OrderKind.LIMIT
            )
            assert outcome.fill_price is not None
            resolved_exit_bar = outcome.fill_bar or bar
            exit_price = normalise_price(
                outcome.fill_price
                + cost_model.slippage_adjustment(
                    plan.direction,
                    exit_order_kind,
                    is_exit=True,
                ),
                spec,
            )
            exit_time = outcome.fill_time or ensure_utc(bar.time)

            return (
                self._build_trade(
                    run=run,
                    result=result,
                    plan=plan,
                    spec=spec,
                    volume=volume,
                    cost_model=cost_model,
                    rules=rules,
                    signal_bar_time=signal_bar_time,
                    entry_bar=entry_bar,
                    entry_time=entry_time,
                    entry_price=entry_price,
                    exit_bar=resolved_exit_bar,
                    exit_time=exit_time,
                    exit_price=exit_price,
                    exit_order_kind=exit_order_kind,
                    terminal=terminal,
                    outcome_path=outcome.path,
                    ambiguous=outcome.ambiguous_fill,
                    gapped=outcome.gapped,
                    detail=outcome.detail,
                    bars_held=j - signal_index,
                    risk_price=risk_price,
                ),
                None,
                j,
            )

        # Data ran out with the position open. AMBIGUITY-B09: marked to the last
        # close, counted, and excluded from the aggregates by `resolved`.
        last_bar = bars[-1]
        last_time = bar_close_time(ensure_utc(last_bar.time), run.timeframe)
        exit_price = normalise_price(
            cost_model.exit_fill(
                reference_price=last_bar.close,
                direction=plan.direction,
                order_kind=OrderKind.MARKET,
                bar=last_bar,
            ),
            spec,
        )
        return (
            self._build_trade(
                run=run,
                result=result,
                plan=plan,
                spec=spec,
                volume=volume,
                cost_model=cost_model,
                rules=rules,
                signal_bar_time=signal_bar_time,
                entry_bar=entry_bar,
                entry_time=entry_time,
                entry_price=entry_price,
                exit_bar=last_bar,
                exit_time=last_time,
                exit_price=exit_price,
                exit_order_kind=OrderKind.MARKET,
                terminal=TerminalReason.DATA_END,
                outcome_path=ResolutionPath.UNAMBIGUOUS,
                ambiguous=False,
                gapped=False,
                detail=(
                    "position still open when the bar data ran out; marked to "
                    "the last close and excluded from the aggregates"
                ),
                bars_held=len(bars) - 1 - signal_index,
                risk_price=risk_price,
            ),
            None,
            len(bars),
        )

    def _build_trade(
        self,
        *,
        run: RunSpec,
        result: StrategyResult,
        plan: TradePlan,
        spec: SymbolSpec,
        volume: float,
        cost_model: CostModel,
        rules: BrokerRules,
        signal_bar_time: datetime,
        entry_bar: Candle,
        entry_time: datetime,
        entry_price: float,
        exit_bar: Candle,
        exit_time: datetime,
        exit_price: float,
        exit_order_kind: OrderKind,
        terminal: TerminalReason,
        outcome_path: ResolutionPath,
        ambiguous: bool,
        gapped: bool,
        detail: str,
        bars_held: int,
        risk_price: float,
    ) -> SimulatedTrade:
        costs = cost_model.round_trip(
            volume=volume,
            direction=plan.direction,
            entry_bar=entry_bar,
            exit_bar=exit_bar,
            entry_order_kind=OrderKind.MARKET,
            exit_order_kind=exit_order_kind,
            opened_at=entry_time,
            closed_at=exit_time,
        )

        sign = 1.0 if plan.direction is Direction.BUY else -1.0
        price_move = (exit_price - entry_price) * sign

        # Spread and slippage are already inside `entry_price` and `exit_price`
        # — they moved the fills. Commission and swap are account-currency
        # amounts and cannot be, so they are converted with §7.2's
        # value_per_point identity and reported both ways. §11.4 asks for
        # expectancy in R; §11.2 states these costs in currency; neither section
        # reconciles them (AMBIGUITY-B05), so both are kept.
        gross_r = price_move / risk_price
        commission_r = cost_model.to_price(costs.commission_ccy, volume) / risk_price
        swap_r = cost_model.to_price(costs.swap_ccy, volume) / risk_price
        net_r = gross_r - commission_r + swap_r

        gross_pnl_ccy = (
            (price_move / spec.point) * cost_model.value_per_point * volume
        )
        net_pnl_ccy = gross_pnl_ccy - costs.commission_ccy + costs.swap_ccy

        return SimulatedTrade(
            trade_id=(
                f"{run.symbol}|{run.timeframe.value}|{result.module_id}|"
                f"{signal_bar_time.isoformat()}"
            ),
            symbol=run.symbol,
            timeframe=run.timeframe,
            module_id=result.module_id,
            module_name=result.module_name,
            direction=plan.direction,
            signal_bar_time=signal_bar_time,
            entry_time=entry_time,
            entry_price=entry_price,
            stop_loss=plan.stop_loss,
            take_profit=plan.take_profit,
            volume=volume,
            exit_time=exit_time,
            exit_price=exit_price,
            terminal_reason=terminal,
            resolution_path=outcome_path,
            ambiguous_fill=ambiguous,
            gapped_exit=gapped,
            resolution_detail=detail,
            bars_held=bars_held,
            sessions=rules.sessions.sessions_at(entry_time),
            risk_price=risk_price,
            gross_r=gross_r,
            commission_r=commission_r,
            swap_r=swap_r,
            net_r=net_r,
            gross_pnl_ccy=gross_pnl_ccy,
            net_pnl_ccy=net_pnl_ccy,
            costs=costs,
        )


__all__ = [
    "EVIDENCE_STOP_KEY",
    "EVIDENCE_TARGET_KEY",
    "EntryFill",
    "UnresolvedPolicy",
    "TerminalReason",
    "SkipReason",
    "TradePlan",
    "PlanSource",
    "EvidencePlanSource",
    "RunSpec",
    "SimulatedTrade",
    "SkippedSignal",
    "RunResult",
    "ReplayEngine",
]
