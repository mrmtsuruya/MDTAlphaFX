"""Enumerations from spec §2 — Core data contracts.

FROZEN. Adding, renaming, reordering or retyping a member invalidates every
strategy module. See CLAUDE.md, "Contracts are frozen".
"""

from enum import Enum


class Timeframe(str, Enum):
    H4 = "H4"
    H1 = "H1"
    M15 = "M15"
    M5 = "M5"
    M1 = "M1"


class Regime(str, Enum):
    TRENDING_BULLISH = "TRENDING_BULLISH"
    TRENDING_BEARISH = "TRENDING_BEARISH"
    RANGING = "RANGING"
    VOLATILE_NEWS = "VOLATILE_NEWS"
    TRANSITIONAL = "TRANSITIONAL"  # no confident classification


class Direction(str, Enum):
    BUY = "BUY"
    SELL = "SELL"
    NONE = "NONE"


class SignalState(str, Enum):
    """Lifecycle. Advances forward only — never returns to an earlier state.
    Tracked independently per timeframe (§6.1)."""

    SCANNING = "SCANNING"  # no candidate on this timeframe
    FORMING = "FORMING"  # structure building, no entry zone yet
    AWAITING_VALIDATION = "AWAITING_VALIDATION"  # candidate found, confirmation pending
    LOCKED = "LOCKED"  # levels frozen, waiting for price
    ENTRY_HIT = "ENTRY_HIT"  # price in the zone — decide now
    TAKEN = "TAKEN"  # operator accepted (or AUTO fired)
    IGNORED = "IGNORED"  # operator declined
    MONITORING = "MONITORING"  # position live, tracking to SL/TP
    CLOSED_TP = "CLOSED_TP"
    CLOSED_SL = "CLOSED_SL"
    TOO_LATE = "TOO_LATE"  # price ran past the zone — do not chase
    EXPIRED = "EXPIRED"  # ttl elapsed untriggered


class PatternState(str, Enum):
    FORMING = "FORMING"  # geometry detected, watch only
    READY = "READY"  # all filters passed, plan valid
    CONFIRMED_FILTERED = "CONFIRMED_FILTERED"  # breakout formed, a rule blocked entry
    INVALIDATED = "INVALIDATED"


__all__ = [
    "Timeframe",
    "Regime",
    "Direction",
    "SignalState",
    "PatternState",
]
