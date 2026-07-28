"""§6.1 Signal lifecycle state machine.

**The single most important behaviour in the system, and absent from v2.**
Without it every module re-evaluates on each bar close and the entry zone, stop
and targets drift underneath a user who is mid-decision. A signal that changes
while you look at it cannot be acted on.

    SCANNING ─► FORMING ─► AWAITING_VALIDATION ─► LOCKED ─► ENTRY_HIT ─┬─► TAKEN ─► MONITORING ─┬─► CLOSED_TP
        ▲                            │              │        │        │                        └─► CLOSED_SL
        │                            │              │        │        └─► IGNORED
        └────────── EXPIRED ◄────────┴──────────────┴────────┴─► TOO_LATE

The state machine ADVANCES FORWARD ONLY — it never returns to an earlier state.
Each timeframe runs its own instance.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from math import isfinite
from typing import Any

from ..contracts import Direction, Signal, SignalState, Timeframe
from ..core.timeutil import timeframe_delta

#: §6.1 rule 1 — frozen on entering LOCKED. **Nothing recomputes them.**
FROZEN_ON_LOCK = (
    "entry_zone",
    "exit_plan",
    "direction",
    "score",
    "breadth",
    "quality",
    "votes",
)

#: States at or beyond which levels are immutable (§6.1 table).
IMMUTABLE_FROM = (
    SignalState.LOCKED,
    SignalState.ENTRY_HIT,
    SignalState.TAKEN,
    SignalState.IGNORED,
    SignalState.MONITORING,
    SignalState.CLOSED_TP,
    SignalState.CLOSED_SL,
    SignalState.TOO_LATE,
    SignalState.EXPIRED,
)

#: Terminal states. §12.1 writes an OutcomeRecord for each (rule 11).
TERMINAL = (
    SignalState.CLOSED_TP,
    SignalState.CLOSED_SL,
    SignalState.TOO_LATE,
    SignalState.EXPIRED,
)


class LockViolation(Exception):
    """§6.1 rule 1/2 — something tried to change a locked signal's side or
    levels. This is an assertion, not a recoverable error: rule 9 calls
    recomputation "the bug this rule exists to prevent"."""


@dataclass(frozen=True)
class LifecycleContext:
    """Everything a transition decision needs, passed explicitly so the machine
    reads no clock and no global state."""

    now: datetime  # UTC
    bar_close_time: datetime  # UTC
    price: float
    atr: float
    bars_since_lock: int
    forming_detected: bool
    candidate_resolved: bool
    regime_confirmed: bool
    has_open_position: bool


def allowed_transitions(state: SignalState) -> tuple[SignalState, ...]:
    """§6.1 — the edges out of one state. Forward only."""
    return {
        SignalState.SCANNING: (SignalState.FORMING,),
        SignalState.FORMING: (SignalState.AWAITING_VALIDATION,),
        SignalState.AWAITING_VALIDATION: (SignalState.LOCKED,),
        SignalState.LOCKED: (
            SignalState.ENTRY_HIT,
            SignalState.TOO_LATE,
            SignalState.EXPIRED,
        ),
        SignalState.ENTRY_HIT: (
            SignalState.TAKEN,
            SignalState.IGNORED,
            SignalState.TOO_LATE,
        ),
        SignalState.TAKEN: (SignalState.MONITORING,),
        # An ignored signal is still followed counterfactually (§12.3). It
        # never owns an order, but it must resolve under rule 11.
        SignalState.IGNORED: (
            SignalState.CLOSED_TP,
            SignalState.CLOSED_SL,
            SignalState.TOO_LATE,
            SignalState.EXPIRED,
        ),
        SignalState.MONITORING: (
            SignalState.CLOSED_TP,
            SignalState.CLOSED_SL,
        ),
        SignalState.CLOSED_TP: (),
        SignalState.CLOSED_SL: (),
        SignalState.TOO_LATE: (),
        SignalState.EXPIRED: (),
    }[state]


def advance(signal: Signal, ctx: LifecycleContext, config: dict) -> Signal:
    """§6.1 — evaluate one bar close against one signal.

    Locking rules, non-negotiable:

    1. On entering LOCKED, the `FROZEN_ON_LOCK` fields are frozen and
       `locked_at` / `expires_at` are stamped. **Nothing recomputes them.**
    2. Later evaluations on the same timeframe **cannot change the side or the
       levels** of a locked signal. They may only advance its state, or produce
       a *separate* candidate that queues behind it.
    3. One active locked signal per (symbol, timeframe). A second candidate
       while one is locked is recorded and QUEUED, not merged.
    4. Once TAKEN or MONITORING, later scans are **monitoring only** until SL or
       final TP. "The engine stops looking for a reason to change its mind about
       a position it already holds."
    5. `age_bars` increments on each entry-timeframe close after `locked_at`. It
       is display state and NEVER affects levels.

    Must raise `LockViolation` rather than silently recomputing.
    """
    _validate_context(ctx)

    if signal.state in TERMINAL:
        return signal.model_copy(deep=True)

    if signal.state is SignalState.SCANNING:
        state = (
            SignalState.FORMING
            if ctx.forming_detected
            else SignalState.SCANNING
        )
        return signal.model_copy(deep=True, update={"state": state})
    if signal.state is SignalState.FORMING:
        state = (
            SignalState.AWAITING_VALIDATION
            if ctx.candidate_resolved
            else SignalState.FORMING
        )
        return signal.model_copy(
            deep=True, update={"state": state}
        )

    if signal.state is SignalState.AWAITING_VALIDATION:
        # §6.1: this state waits for BOTH regime confirmation and the complete
        # validity gate. A failed candidate remains observable and provisional;
        # it must never acquire frozen, apparently actionable levels.
        if not ctx.regime_confirmed or not signal.gate.passed:
            return signal.model_copy(deep=True)
        ttl_bars = _positive_int(config, "signal_ttl_bars", section="lifecycle")
        locked_at = ctx.bar_close_time
        after = signal.model_copy(
            deep=True,
            update={
                "state": SignalState.LOCKED,
                "locked_at": locked_at,
                "expires_at": locked_at
                + ttl_bars * timeframe_delta(signal.entry_timeframe),
                "age_bars": 0,
            },
        )
        # The decision surface is provisional before this edge, but the act of
        # locking itself must not alter it.
        for field in FROZEN_ON_LOCK:
            if getattr(after, field) != getattr(signal, field):
                raise LockViolation(f"locking changed frozen field '{field}'")
        return after

    before = signal.model_copy(deep=True)
    age = max(signal.age_bars, ctx.bars_since_lock)
    state = signal.state

    if state is SignalState.LOCKED:
        if should_mark_too_late(signal, ctx, config):
            state = SignalState.TOO_LATE
        elif should_expire(signal, ctx, config):
            state = SignalState.EXPIRED
        elif _price_in_zone(signal, ctx.price):
            state = SignalState.ENTRY_HIT
    elif state is SignalState.ENTRY_HIT:
        # TAKEN/IGNORED are external decisions. The small bar-close machine
        # cannot invent one. It can still stop an unacted entry being chased.
        if should_mark_too_late(signal, ctx, config):
            state = SignalState.TOO_LATE
    elif state is SignalState.TAKEN:
        if ctx.has_open_position:
            state = SignalState.MONITORING
    elif state in (SignalState.MONITORING, SignalState.IGNORED):
        terminal = _price_resolution(signal, ctx.price)
        if terminal is not None:
            state = terminal
        elif state is SignalState.IGNORED:
            if should_mark_too_late(signal, ctx, config):
                state = SignalState.TOO_LATE
            elif should_expire(signal, ctx, config):
                state = SignalState.EXPIRED

    after = signal.model_copy(
        deep=True,
        update={"state": state, "age_bars": age},
    )
    assert_lock_invariant(before, after)
    return after


def should_expire(signal: Signal, ctx: LifecycleContext, config: dict) -> bool:
    """§6.1 EXPIRED — `signal_ttl_bars` elapsed without a trigger.

    Note `Signal.expires_at` is a resolved WALL-CLOCK time (§2), not a bar
    count, even though the TTL is configured in bars — so the conversion happens
    once, at lock.
    """
    del config  # expiry was resolved once at lock; later config cannot move it
    if signal.state not in (SignalState.LOCKED, SignalState.IGNORED):
        return False
    return ctx.now >= signal.expires_at


def should_mark_too_late(
    signal: Signal, ctx: LifecycleContext, config: dict
) -> bool:
    """§6.1 TOO_LATE — price passed the zone by more than
    `chase_tolerance_atr` × ATR, **or reached TP1 untaken.**

    Two triggers, not one. The second is easy to miss and is what stops the UI
    offering an entry on a move that has already paid out.
    """
    if signal.state in (
        SignalState.TAKEN,
        SignalState.MONITORING,
        SignalState.CLOSED_TP,
        SignalState.CLOSED_SL,
        SignalState.TOO_LATE,
        SignalState.EXPIRED,
    ):
        return False

    tolerance = _non_negative_float(
        config, "chase_tolerance_atr", section="lifecycle"
    )
    distance = tolerance * ctx.atr
    zone_min, zone_max = _zone_bounds(signal)

    if signal.direction is Direction.BUY:
        chased = ctx.price > zone_max + distance
        paid_out = (
            signal.exit_plan.take_profit_1 > zone_max
            and ctx.price >= signal.exit_plan.take_profit_1
        )
    elif signal.direction is Direction.SELL:
        chased = ctx.price < zone_min - distance
        paid_out = (
            signal.exit_plan.take_profit_1 < zone_min
            and ctx.price <= signal.exit_plan.take_profit_1
        )
    else:
        return False
    return chased or paid_out


def assert_lock_invariant(before: Signal, after: Signal) -> None:
    """§6.1 rules 1–2 as an executable assertion.

    §9 Stage 3's gate is a replay asserting exactly this across every bar. Rule
    9 exists because recomputation is the failure mode; treat these as
    invariants with assertions, not as intentions.
    """
    if before.state not in IMMUTABLE_FROM:
        return
    changed = [
        field
        for field in FROZEN_ON_LOCK
        if getattr(before, field) != getattr(after, field)
    ]
    if changed:
        raise LockViolation(
            "§6.1 locked signal recomputed frozen field(s): "
            + ", ".join(changed)
        )
    if after.locked_at != before.locked_at:
        raise LockViolation("§6.1 locked_at was restamped after lock")
    if after.expires_at != before.expires_at:
        raise LockViolation("§6.1 expires_at was restamped after lock")


def _config_value(config: dict[str, Any], key: str, *, section: str) -> Any:
    """Accept the declared YAML shape and the flat test-double shape."""
    nested = config.get(section)
    if isinstance(nested, dict) and key in nested:
        return nested[key]
    if key in config:
        return config[key]
    raise ValueError(f"missing lifecycle config value {section}.{key}")


def _positive_int(config: dict[str, Any], key: str, *, section: str) -> int:
    value = _config_value(config, key, section=section)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{section}.{key} must be a positive integer")
    return value


def _non_negative_float(
    config: dict[str, Any], key: str, *, section: str
) -> float:
    value = _config_value(config, key, section=section)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{section}.{key} must be numeric")
    number = float(value)
    if not isfinite(number) or number < 0:
        raise ValueError(f"{section}.{key} must be finite and non-negative")
    return number


def _validate_context(ctx: LifecycleContext) -> None:
    if ctx.now.tzinfo is None or ctx.now.utcoffset() is None:
        raise ValueError("LifecycleContext.now must be timezone-aware UTC")
    if ctx.bar_close_time.tzinfo is None or ctx.bar_close_time.utcoffset() is None:
        raise ValueError("LifecycleContext.bar_close_time must be timezone-aware UTC")
    if ctx.now.utcoffset().total_seconds() != 0:
        raise ValueError("LifecycleContext.now must be UTC")
    if ctx.bar_close_time.utcoffset().total_seconds() != 0:
        raise ValueError("LifecycleContext.bar_close_time must be UTC")
    if not isfinite(ctx.price) or not isfinite(ctx.atr) or ctx.atr <= 0:
        raise ValueError("LifecycleContext price must be finite and ATR positive")
    if ctx.bars_since_lock < 0:
        raise ValueError("LifecycleContext.bars_since_lock cannot be negative")
    for name in (
        "forming_detected",
        "candidate_resolved",
        "regime_confirmed",
        "has_open_position",
    ):
        if type(getattr(ctx, name)) is not bool:
            raise ValueError(f"LifecycleContext.{name} must be boolean")


def _zone_bounds(signal: Signal) -> tuple[float, float]:
    try:
        low = float(signal.entry_zone["min"])
        high = float(signal.entry_zone["max"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("Signal.entry_zone must contain numeric min/max") from exc
    if not (isfinite(low) and isfinite(high)) or low > high:
        raise ValueError("Signal.entry_zone must be finite and ordered")
    return low, high


def _price_in_zone(signal: Signal, price: float) -> bool:
    low, high = _zone_bounds(signal)
    return low <= price <= high


def _price_resolution(signal: Signal, price: float) -> SignalState | None:
    target = (
        signal.exit_plan.take_profit_2
        if signal.exit_plan.take_profit_2 is not None
        else signal.exit_plan.take_profit_1
    )
    if signal.direction is Direction.BUY:
        if price <= signal.exit_plan.stop_loss:
            return SignalState.CLOSED_SL
        if price >= target:
            return SignalState.CLOSED_TP
    elif signal.direction is Direction.SELL:
        if price >= signal.exit_plan.stop_loss:
            return SignalState.CLOSED_SL
        if price <= target:
            return SignalState.CLOSED_TP
    return None


__all__ = [
    "FROZEN_ON_LOCK",
    "IMMUTABLE_FROM",
    "TERMINAL",
    "LockViolation",
    "LifecycleContext",
    "allowed_transitions",
    "advance",
    "should_expire",
    "should_mark_too_late",
    "assert_lock_invariant",
]
