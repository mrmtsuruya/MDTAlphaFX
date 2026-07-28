"""Signal, scoring and lifecycle contracts from spec §2.

FROZEN. See CLAUDE.md, "Contracts are frozen".
"""

from datetime import datetime

from pydantic import BaseModel

from .enums import Direction, Regime, SignalState, Timeframe
from .market import ClusterResult, StrategyResult


class VoteTally(BaseModel):
    """Both sides of the argument. A 4-vs-0 and a 4-vs-1 are not the same
    signal, and a score that hides the opposition is not interpretable."""

    buy_votes: int
    buy_points: float  # Σ (cluster score × weight) / 10, BUY side
    sell_votes: int
    sell_points: float
    contested: bool  # both sides have ≥1 vote
    leading_contributor: str  # module_name of the highest-scoring firing module


class TimeframeState(BaseModel):
    timeframe: Timeframe
    regime: Regime
    regime_confidence: float  # 0..1
    bars_in_regime: int
    breadth: float  # 0..1, clusters agreeing / clusters available
    quality: float  # 0..100, weighted mean of firing clusters
    score: float  # 0..100, final composite
    direction: Direction
    state: SignalState  # this timeframe's own lifecycle position
    votes: VoteTally
    clusters: list[ClusterResult]
    modules: list[StrategyResult]


class ExitPlan(BaseModel):
    """How the position is closed. Price levels and currency targets coexist —
    whichever triggers first wins. Trailing is evaluated only after activation."""

    stop_loss: float
    take_profit_1: float
    take_profit_2: float | None

    # Currency-denominated exit, in account currency. None disables.
    tp_currency: float | None = None  # close at +X account currency
    sl_currency: float | None = None  # close at -X account currency

    # Trailing. None disables. Distances in points.
    trail_activate_points: int | None = None  # profit before trailing arms
    trail_distance_points: int | None = None  # gap maintained behind price
    trail_step_points: int | None = None  # min move before stop is amended
    breakeven_at_r: float | None = 1.0  # move stop to entry at N×R


class GateOutcome(BaseModel):
    """Written for every evaluation, passing or failing. Rule 8."""

    passed: bool
    failed_conditions: list[str]  # e.g. ["MIN_CLUSTERS", "MAX_SPREAD"]
    score: float
    breadth: float
    quality: float
    display_threshold: float
    auto_execute_threshold: float


class Signal(BaseModel):
    signal_id: str  # UUID — the idempotency key
    fingerprint: str  # 7-char base36 of signal_id — for humans and support
    created_at: datetime  # UTC
    locked_at: datetime | None  # when levels froze; None before LOCKED
    expires_at: datetime  # resolved wall-clock, not a bar count
    age_bars: int  # bars elapsed on the entry timeframe since lock
    symbol: str
    direction: Direction
    order_type: str  # MARKET | BUY_LIMIT | SELL_LIMIT | BUY_STOP | SELL_STOP
    score: float
    breadth: float  # 0..1 — never omitted, see §8.2 display rule
    quality: float  # 0..100
    votes: VoteTally  # entry-timeframe tally
    entry_zone: dict  # {"min": float, "max": float}
    exit_plan: ExitPlan
    sl_basis: str  # human-readable, e.g. "1.06 ATR below swing low"
    htf_regime: Regime  # regime of the bias timeframe
    entry_timeframe: Timeframe
    timeframes: dict[Timeframe, TimeframeState]
    mtf_aligned: str  # "1/5" — timeframes agreeing with this direction
    state: SignalState
    gate: GateOutcome
    displayed: bool  # score >= display_threshold (a FILTER, not a gate)
    auto_eligible: bool  # score >= auto_execute_threshold AND symbol enabled
    pattern_context: "PatternResult | None"  # advisory only, never scored (§6.4)
    config_version: str  # stamped at lock — makes the signal explicable later
    outcome: "OutcomeRecord | None"  # written once, at resolution (§12.1)
    llm_rationale: str | None  # populated asynchronously, never scored


__all__ = [
    "VoteTally",
    "TimeframeState",
    "ExitPlan",
    "GateOutcome",
    "Signal",
]
