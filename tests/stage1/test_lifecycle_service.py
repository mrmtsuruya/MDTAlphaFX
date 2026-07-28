"""Approved Stage 1 lifecycle ownership and explicit decision events."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from backend.contracts import SignalState
from backend.lifecycle.service import (
    DecisionKind,
    SignalDecisionEvent,
    SignalLifecycleService,
)
from tests.stage1.gate_doubles import (
    BAR_ZERO,
    gate_outcome,
    levels_config,
    lifecycle_ctx,
    signal,
)


class RecordingSink:
    def __init__(self) -> None:
        self.signals: list[tuple[str, str]] = []
        self.decisions: list[SignalDecisionEvent] = []

    def record_signal(self, item, *, reason: str) -> None:
        self.signals.append((item.signal_id, reason))

    def record_decision(self, event: SignalDecisionEvent) -> None:
        self.decisions.append(event)


def _second_candidate():
    return signal(
        signal_id="22222222-2222-4222-8222-222222222222",
        fingerprint="b2c3d4e",
    )


def _entry_hit(service: SignalLifecycleService):
    key = service.key_for(signal())
    service.advance_active(key, lifecycle_ctx(price=2005.0), levels_config())
    reached = service.advance_active(
        key,
        lifecycle_ctx(
            price=2001.0,
            now=BAR_ZERO + timedelta(hours=2),
            bar_close_time=BAR_ZERO + timedelta(hours=2),
            bars_since_lock=1,
        ),
        levels_config(),
    )
    assert reached.state is SignalState.ENTRY_HIT
    return key, reached


def test_second_candidate_is_persisted_and_queued_without_merging():
    sink = RecordingSink()
    service = SignalLifecycleService(sink)
    first = signal()
    second = _second_candidate()
    key = service.key_for(first)

    assert service.submit_candidate(first) is True
    assert service.submit_candidate(second) is False

    assert service.active(key).signal_id == first.signal_id
    assert [item.signal_id for item in service.queued(key)] == [second.signal_id]
    assert sink.signals == [
        (first.signal_id, "ACTIVE_CANDIDATE"),
        (second.signal_id, "QUEUED_CANDIDATE"),
    ]


def test_terminal_resolution_promotes_the_fifo_candidate():
    service = SignalLifecycleService()
    first = signal()
    second = _second_candidate()
    key = service.key_for(first)
    service.submit_candidate(first)
    service.submit_candidate(second)
    service.advance_active(key, lifecycle_ctx(price=2005.0), levels_config())

    resolved = service.advance_active(
        key,
        lifecycle_ctx(
            price=2100.0,
            now=BAR_ZERO + timedelta(hours=2),
            bar_close_time=BAR_ZERO + timedelta(hours=2),
            bars_since_lock=1,
        ),
        levels_config(),
    )

    assert resolved.state is SignalState.TOO_LATE
    assert service.active(key).signal_id == second.signal_id
    assert service.queued(key) == ()


def test_price_never_invents_taken_or_ignored_and_event_is_required():
    sink = RecordingSink()
    service = SignalLifecycleService(sink)
    first = signal()
    service.submit_candidate(first)
    key, reached = _entry_hit(service)

    still_waiting = service.advance_active(
        key,
        lifecycle_ctx(
            price=2001.0,
            now=BAR_ZERO + timedelta(hours=3),
            bar_close_time=BAR_ZERO + timedelta(hours=3),
            bars_since_lock=2,
        ),
        levels_config(),
    )
    assert still_waiting.state is SignalState.ENTRY_HIT

    event = SignalDecisionEvent(
        signal_id=reached.signal_id,
        decision=DecisionKind.TAKEN,
        decided_at=BAR_ZERO + timedelta(hours=3),
        actor="operator",
    )
    decided = service.decide(key, event)
    assert decided.state is SignalState.TAKEN
    assert sink.decisions == [event]


def test_ignored_signal_is_counterfactually_monitored_to_resolution():
    service = SignalLifecycleService()
    first = signal()
    service.submit_candidate(first)
    key, reached = _entry_hit(service)
    ignored = service.decide(
        key,
        SignalDecisionEvent(
            signal_id=reached.signal_id,
            decision=DecisionKind.IGNORED,
            decided_at=BAR_ZERO + timedelta(hours=2),
            actor="operator",
            reason="setup skipped",
        ),
    )
    assert ignored.state is SignalState.IGNORED

    resolved = service.advance_active(
        key,
        lifecycle_ctx(
            price=ignored.exit_plan.take_profit_2,
            now=BAR_ZERO + timedelta(hours=4),
            bar_close_time=BAR_ZERO + timedelta(hours=4),
            bars_since_lock=3,
        ),
        levels_config(),
    )
    assert resolved.state is SignalState.CLOSED_TP
    assert service.active(key) is None


def test_decision_events_reject_naive_and_non_utc_datetimes():
    common = {
        "signal_id": "11111111-1111-4111-8111-111111111111",
        "decision": DecisionKind.TAKEN,
        "actor": "operator",
    }
    with pytest.raises(ValueError, match="timezone-aware UTC"):
        SignalDecisionEvent(decided_at=datetime(2026, 3, 2, 8, 0), **common)
    with pytest.raises(ValueError, match="must be UTC"):
        SignalDecisionEvent(
            decided_at=datetime(
                2026, 3, 2, 16, 0, tzinfo=timezone(timedelta(hours=8))
            ),
            **common,
        )


def test_decision_event_rejects_untyped_external_strings():
    with pytest.raises(TypeError, match="DecisionKind"):
        SignalDecisionEvent(
            signal_id="11111111-1111-4111-8111-111111111111",
            decision="TAKEN",  # type: ignore[arg-type]
            decided_at=BAR_ZERO,
            actor="operator",
        )


def test_pending_candidate_can_refresh_then_lock_after_gate_passes():
    sink = RecordingSink()
    service = SignalLifecycleService(sink)
    pending = signal(
        gate=gate_outcome(
            passed=False,
            failed_conditions=("MIN_CLUSTERS",),
        ),
        entry_zone={"min": 2000.0, "max": 2002.0},
    )
    key = service.key_for(pending)
    service.submit_candidate(pending)

    held = service.advance_active(
        key,
        lifecycle_ctx(regime_confirmed=False),
        levels_config(),
    )
    assert held.state is SignalState.AWAITING_VALIDATION

    refreshed = pending.model_copy(
        deep=True,
        update={
            "gate": gate_outcome(passed=True),
            "entry_zone": {"min": 2001.0, "max": 2003.0},
        },
    )
    service.refresh_candidate(refreshed)
    locked = service.advance_active(
        key,
        lifecycle_ctx(regime_confirmed=True),
        levels_config(),
    )

    assert locked.state is SignalState.LOCKED
    assert locked.entry_zone == {"min": 2001.0, "max": 2003.0}
    assert (pending.signal_id, "CANDIDATE_REFRESH") in sink.signals


def test_locked_signal_cannot_be_refreshed_as_a_candidate():
    service = SignalLifecycleService()
    pending = signal()
    key = service.key_for(pending)
    service.submit_candidate(pending)
    service.advance_active(key, lifecycle_ctx(), levels_config())

    with pytest.raises(ValueError, match="locked or resolved"):
        service.refresh_candidate(pending)
