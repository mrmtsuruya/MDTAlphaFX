"""Stage 1 lifecycle ownership and external decision events.

The small bar-close state machine in :mod:`backend.lifecycle.machine` is pure:
it owns no queue and cannot invent an operator/AUTO decision.  This service is
the approved owner of those two integration concerns (§6.1):

* one active signal per ``(resolved_symbol, timeframe)``;
* a FIFO of separately persisted candidates behind it; and
* explicit TAKEN/IGNORED events.

Persistence is injected.  Stage 1 therefore stays deterministic and testable;
Stage 3 may bind the protocol to the journal without changing lifecycle rules.
"""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from threading import RLock
from typing import Protocol

from ..contracts import Signal, SignalState, Timeframe
from .machine import LifecycleContext, TERMINAL, advance

LifecycleKey = tuple[str, Timeframe]


class DecisionKind(str, Enum):
    TAKEN = "TAKEN"
    IGNORED = "IGNORED"


@dataclass(frozen=True)
class SignalDecisionEvent:
    signal_id: str
    decision: DecisionKind
    decided_at: datetime
    actor: str
    reason: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.signal_id, str) or not self.signal_id.strip():
            raise ValueError("signal_id cannot be empty")
        if not isinstance(self.decision, DecisionKind):
            raise TypeError("decision must be a DecisionKind")
        if not isinstance(self.actor, str) or not self.actor.strip():
            raise ValueError("decision actor cannot be empty")
        if self.reason is not None and not isinstance(self.reason, str):
            raise TypeError("decision reason must be a string or None")
        _require_utc(self.decided_at, "decided_at")


class LifecycleSink(Protocol):
    """Persistence seam implemented by the Stage 3 journal adapter."""

    def record_signal(self, signal: Signal, *, reason: str) -> None: ...

    def record_decision(self, event: SignalDecisionEvent) -> None: ...


class NullLifecycleSink:
    def record_signal(self, signal: Signal, *, reason: str) -> None:
        del signal, reason

    def record_decision(self, event: SignalDecisionEvent) -> None:
        del event


class SignalLifecycleService:
    """Own active signals and FIFO candidates without merging them."""

    def __init__(self, sink: LifecycleSink | None = None) -> None:
        self._sink = sink if sink is not None else NullLifecycleSink()
        self._active: dict[LifecycleKey, Signal] = {}
        self._queued: dict[LifecycleKey, deque[Signal]] = defaultdict(deque)
        self._lock = RLock()

    @staticmethod
    def key_for(signal: Signal) -> LifecycleKey:
        return signal.symbol, signal.entry_timeframe

    def active(self, key: LifecycleKey) -> Signal | None:
        with self._lock:
            value = self._active.get(key)
            return value.model_copy(deep=True) if value is not None else None

    def queued(self, key: LifecycleKey) -> tuple[Signal, ...]:
        with self._lock:
            return tuple(item.model_copy(deep=True) for item in self._queued[key])

    def submit_candidate(self, candidate: Signal) -> bool:
        """Persist a candidate and return True iff it became active."""
        if candidate.state is not SignalState.AWAITING_VALIDATION:
            raise ValueError(
                "a submitted candidate must be AWAITING_VALIDATION, got "
                f"{candidate.state.value}"
            )
        key = self.key_for(candidate)
        with self._lock:
            if self._contains_signal_id(candidate.signal_id):
                raise ValueError(f"duplicate signal_id {candidate.signal_id}")
            if key not in self._active:
                self._active[key] = candidate.model_copy(deep=True)
                self._sink.record_signal(candidate, reason="ACTIVE_CANDIDATE")
                return True
            self._queued[key].append(candidate.model_copy(deep=True))
            # Rule 8 and the approved profile: the second candidate is durable
            # at queue time, not when the first signal eventually resolves.
            self._sink.record_signal(candidate, reason="QUEUED_CANDIDATE")
            return False

    def refresh_candidate(self, candidate: Signal) -> Signal:
        """Replace one still-provisional candidate with its latest evaluation.

        §5.5 explicitly permits levels to be recomputed while a signal is
        ``AWAITING_VALIDATION``. The service owns a deep copy, so without this
        seam a pending regime or failed gate could never later become lockable.
        Identity and queue position stay fixed; only the provisional decision
        surface is refreshed.
        """

        if candidate.state is not SignalState.AWAITING_VALIDATION:
            raise ValueError(
                "a refreshed candidate must be AWAITING_VALIDATION, got "
                f"{candidate.state.value}"
            )
        if candidate.locked_at is not None:
            raise ValueError("a provisional candidate cannot already be locked")

        key = self.key_for(candidate)
        with self._lock:
            active = self._active.get(key)
            if active is not None and active.signal_id == candidate.signal_id:
                self._assert_refresh_identity(active, candidate)
                if active.state is not SignalState.AWAITING_VALIDATION:
                    raise ValueError(
                        "a locked or resolved active signal cannot be refreshed"
                    )
                refreshed = candidate.model_copy(deep=True)
                self._active[key] = refreshed
                self._sink.record_signal(refreshed, reason="CANDIDATE_REFRESH")
                return refreshed.model_copy(deep=True)

            queue = self._queued.get(key)
            if queue is not None:
                for index, existing in enumerate(queue):
                    if existing.signal_id != candidate.signal_id:
                        continue
                    self._assert_refresh_identity(existing, candidate)
                    refreshed = candidate.model_copy(deep=True)
                    queue[index] = refreshed
                    self._sink.record_signal(
                        refreshed, reason="QUEUED_CANDIDATE_REFRESH"
                    )
                    return refreshed.model_copy(deep=True)

            raise KeyError(
                f"candidate {candidate.signal_id} is not active or queued for "
                f"{key[0]} {key[1].value}"
            )

    def advance_active(
        self, key: LifecycleKey, ctx: LifecycleContext, config: dict
    ) -> Signal:
        with self._lock:
            current = self._require_active(key)
            updated = advance(current, ctx, config)
            self._active[key] = updated
            self._sink.record_signal(updated, reason="LIFECYCLE_ADVANCE")
            if updated.state in TERMINAL:
                self._promote_after_terminal(key)
            return updated.model_copy(deep=True)

    def decide(
        self, key: LifecycleKey, event: SignalDecisionEvent
    ) -> Signal:
        """Apply an explicit ENTRY_HIT decision; never infer one from price."""
        with self._lock:
            current = self._require_active(key)
            if current.signal_id != event.signal_id:
                raise ValueError(
                    f"decision targets {event.signal_id}, active signal is "
                    f"{current.signal_id}"
                )
            if current.state is not SignalState.ENTRY_HIT:
                raise ValueError(
                    "TAKEN/IGNORED decision requires ENTRY_HIT, got "
                    f"{current.state.value}"
                )
            state = (
                SignalState.TAKEN
                if event.decision is DecisionKind.TAKEN
                else SignalState.IGNORED
            )
            updated = current.model_copy(deep=True, update={"state": state})
            self._active[key] = updated
            self._sink.record_decision(event)
            self._sink.record_signal(updated, reason=f"DECISION_{state.value}")
            return updated.model_copy(deep=True)

    def _require_active(self, key: LifecycleKey) -> Signal:
        try:
            return self._active[key]
        except KeyError as exc:
            raise KeyError(f"no active lifecycle for {key[0]} {key[1].value}") from exc

    def _contains_signal_id(self, signal_id: str) -> bool:
        if any(item.signal_id == signal_id for item in self._active.values()):
            return True
        return any(
            item.signal_id == signal_id
            for queue in self._queued.values()
            for item in queue
        )

    @staticmethod
    def _assert_refresh_identity(before: Signal, after: Signal) -> None:
        stable = (
            "signal_id",
            "fingerprint",
            "created_at",
            "symbol",
            "entry_timeframe",
        )
        changed = [
            field for field in stable if getattr(before, field) != getattr(after, field)
        ]
        if changed:
            raise ValueError(
                "candidate refresh changed stable identity field(s): "
                + ", ".join(changed)
            )

    def _promote_after_terminal(self, key: LifecycleKey) -> None:
        self._active.pop(key, None)
        queue = self._queued[key]
        if queue:
            promoted = queue.popleft()
            self._active[key] = promoted
            self._sink.record_signal(promoted, reason="QUEUE_PROMOTED")
        if not queue:
            self._queued.pop(key, None)


def _require_utc(value: datetime, name: str) -> None:
    if not isinstance(value, datetime):
        raise TypeError(f"{name} must be a datetime")
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be timezone-aware UTC")
    if value.utcoffset().total_seconds() != 0:
        raise ValueError(f"{name} must be UTC")


__all__ = [
    "DecisionKind",
    "LifecycleKey",
    "LifecycleSink",
    "NullLifecycleSink",
    "SignalDecisionEvent",
    "SignalLifecycleService",
]
