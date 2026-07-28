"""§6.1 Signal lifecycle state machine and orchestration service."""
from .machine import (
    FROZEN_ON_LOCK,
    IMMUTABLE_FROM,
    TERMINAL,
    LifecycleContext,
    LockViolation,
    advance,
    allowed_transitions,
    assert_lock_invariant,
    should_expire,
    should_mark_too_late,
)
from .service import (
    DecisionKind,
    LifecycleKey,
    LifecycleSink,
    NullLifecycleSink,
    SignalDecisionEvent,
    SignalLifecycleService,
)

__all__ = [
    "FROZEN_ON_LOCK",
    "IMMUTABLE_FROM",
    "TERMINAL",
    "DecisionKind",
    "LifecycleContext",
    "LifecycleKey",
    "LifecycleSink",
    "LockViolation",
    "NullLifecycleSink",
    "SignalDecisionEvent",
    "SignalLifecycleService",
    "advance",
    "allowed_transitions",
    "assert_lock_invariant",
    "should_expire",
    "should_mark_too_late",
]
