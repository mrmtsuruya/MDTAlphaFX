"""§6.1 signal lifecycle — locking, expiry, and forward-only movement.

This is the regression surface the build prompt calls "the test that matters
most in the system":

    a locked signal's side, entry, stop and targets are unchanged across every
    subsequent bar until it resolves.

The production implementation is now present. These tests remain the executable
contract that prevents later lifecycle work from weakening its lock guarantees.

Two orchestration rules sit above this pure state-machine surface and are covered
through ``SignalLifecycleService`` in ``test_lifecycle_service.py``:

* queuing a second candidate behind the one active locked signal; and
* the external operator/AUTO decisions that select ``TAKEN`` or ``IGNORED``.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from backend.contracts import Direction, SignalState, Timeframe
from backend.core.timeutil import timeframe_delta
from backend.lifecycle.machine import (
    FROZEN_ON_LOCK,
    IMMUTABLE_FROM,
    TERMINAL,
    LockViolation,
    advance,
    allowed_transitions,
    assert_lock_invariant,
    should_expire,
    should_mark_too_late,
)
from tests.stage1.gate_doubles import (
    BAR_ZERO,
    CHASE_TOLERANCE_ATR_FIXTURE,
    SIGNAL_TTL_BARS,
    exit_plan,
    frozen_fields,
    gate_outcome,
    lifecycle_ctx,
    levels_config,
    locked_signal,
    signal,
    snapshot,
    vote_tally,
    with_field,
)

CONFIG = levels_config()


# ============================================================= graph and sets


def test_frozen_on_lock_is_exactly_rule_ones_list():
    """§6.1 rule 1 freezes all seven named decision fields — no omissions."""
    assert FROZEN_ON_LOCK == (
        "entry_zone",
        "exit_plan",
        "direction",
        "score",
        "breadth",
        "quality",
        "votes",
    )


def test_every_state_from_lock_onward_is_marked_immutable():
    """§6.1's state table labels every state from LOCKED onward immutable."""
    assert set(IMMUTABLE_FROM) == {
        SignalState.LOCKED,
        SignalState.ENTRY_HIT,
        SignalState.TAKEN,
        SignalState.IGNORED,
        SignalState.MONITORING,
        SignalState.CLOSED_TP,
        SignalState.CLOSED_SL,
        SignalState.TOO_LATE,
        SignalState.EXPIRED,
    }


def test_the_four_resolution_states_are_terminal():
    """§6.1 / §12.1: every locked signal ultimately reaches one of four ends."""
    assert set(TERMINAL) == {
        SignalState.CLOSED_TP,
        SignalState.CLOSED_SL,
        SignalState.TOO_LATE,
        SignalState.EXPIRED,
    }


@pytest.mark.parametrize(
    "before,required_after",
    [
        pytest.param(
            SignalState.SCANNING,
            SignalState.FORMING,
            id="6.1-SCANNING-to-FORMING",
        ),
        pytest.param(
            SignalState.FORMING,
            SignalState.AWAITING_VALIDATION,
            id="6.1-FORMING-to-AWAITING_VALIDATION",
        ),
        pytest.param(
            SignalState.AWAITING_VALIDATION,
            SignalState.LOCKED,
            id="6.1-AWAITING_VALIDATION-to-LOCKED",
        ),
        pytest.param(
            SignalState.LOCKED,
            SignalState.ENTRY_HIT,
            id="6.1-LOCKED-to-ENTRY_HIT",
        ),
        pytest.param(
            SignalState.LOCKED,
            SignalState.TOO_LATE,
            id="6.1-LOCKED-to-TOO_LATE",
        ),
        pytest.param(
            SignalState.LOCKED,
            SignalState.EXPIRED,
            id="6.1-LOCKED-to-EXPIRED",
        ),
        pytest.param(
            SignalState.ENTRY_HIT,
            SignalState.TAKEN,
            id="6.1-ENTRY_HIT-to-TAKEN",
        ),
        pytest.param(
            SignalState.ENTRY_HIT,
            SignalState.IGNORED,
            id="6.1-ENTRY_HIT-to-IGNORED",
        ),
        pytest.param(
            SignalState.TAKEN,
            SignalState.MONITORING,
            id="6.1-TAKEN-to-MONITORING",
        ),
        pytest.param(
            SignalState.MONITORING,
            SignalState.CLOSED_TP,
            id="6.1-MONITORING-to-CLOSED_TP",
        ),
        pytest.param(
            SignalState.MONITORING,
            SignalState.CLOSED_SL,
            id="6.1-MONITORING-to-CLOSED_SL",
        ),
    ],
)
def test_every_explicit_forward_edge_is_available(before, required_after):
    """§6.1's diagram, edge by edge, without inventing unspecified triggers."""
    assert required_after in allowed_transitions(before)


@pytest.mark.parametrize("state", TERMINAL)
def test_terminal_states_have_no_outgoing_edges(state):
    """§6.1: resolution is forward-only; a resolved signal never reopens."""
    assert allowed_transitions(state) == ()


def test_no_transition_returns_to_an_earlier_state():
    """§6.1: the state machine "advances forward only — never returns"."""
    rank = {
        SignalState.SCANNING: 0,
        SignalState.FORMING: 1,
        SignalState.AWAITING_VALIDATION: 2,
        SignalState.LOCKED: 3,
        SignalState.ENTRY_HIT: 4,
        SignalState.TAKEN: 5,
        SignalState.IGNORED: 5,
        SignalState.MONITORING: 6,
        SignalState.CLOSED_TP: 7,
        SignalState.CLOSED_SL: 7,
        SignalState.TOO_LATE: 7,
        SignalState.EXPIRED: 7,
    }

    for before in SignalState:
        for after in allowed_transitions(before):
            assert rank[after] > rank[before], (
                f"§6.1 forbids {before.value} returning or moving sideways "
                f"to {after.value}"
            )


@pytest.mark.parametrize(
    "state,only_next",
    [
        pytest.param(
            SignalState.SCANNING,
            (SignalState.FORMING,),
            id="6.1-no-skip-from-SCANNING",
        ),
        pytest.param(
            SignalState.FORMING,
            (SignalState.AWAITING_VALIDATION,),
            id="6.1-no-skip-from-FORMING",
        ),
        pytest.param(
            SignalState.AWAITING_VALIDATION,
            (SignalState.LOCKED,),
            id="6.1-no-skip-from-AWAITING_VALIDATION",
        ),
    ],
)
def test_the_unambiguous_spine_cannot_skip_states(state, only_next):
    """§6.1's main spine has explicit adjacent states, not arbitrary jumps."""
    assert allowed_transitions(state) == only_next


# =============================================================== entering lock


@pytest.mark.parametrize(
    "entry_timeframe",
    [
        pytest.param(Timeframe.M1, id="6.1-lock-ttl-M1"),
        pytest.param(Timeframe.M5, id="6.1-lock-ttl-M5"),
        pytest.param(Timeframe.M15, id="6.1-lock-ttl-M15"),
        pytest.param(Timeframe.H1, id="6.1-lock-ttl-H1"),
        pytest.param(Timeframe.H4, id="6.1-lock-ttl-H4"),
    ],
)
def test_entering_lock_stamps_both_times_once(entry_timeframe):
    """§6.1 rule 1: lock time and the resolved wall-clock expiry are stamped."""
    lock_time = BAR_ZERO + timedelta(hours=4)
    before = signal(
        state=SignalState.AWAITING_VALIDATION,
        entry_timeframe=entry_timeframe,
        locked_at=None,
        expires_at=BAR_ZERO,
    )

    after = advance(
        before,
        lifecycle_ctx(
            now=lock_time,
            bar_close_time=lock_time,
            price=2005.0,
        ),
        CONFIG,
    )

    assert after.state is SignalState.LOCKED
    assert after.locked_at == lock_time
    assert after.expires_at == (
        lock_time + SIGNAL_TTL_BARS * timeframe_delta(entry_timeframe)
    )


def test_locking_freezes_the_provisional_decision_surface_bit_for_bit():
    """§5.5 / §6.1: provisional levels become the frozen values at LOCKED."""
    before = signal(
        state=SignalState.AWAITING_VALIDATION,
        direction=Direction.BUY,
        entry_zone={"min": 2000.25, "max": 2002.75},
        plan=exit_plan(
            stop_loss=1988.5,
            take_profit_1=2024.125,
            take_profit_2=2047.75,
        ),
        score=76.4,
        breadth=46 / 57,
        quality=85.0,
        votes=vote_tally(
            buy_votes=4,
            buy_points=391.0,
            sell_votes=1,
            sell_points=93.0,
            contested=True,
            leading_contributor="module_20",
        ),
    )
    expected = frozen_fields(before)

    after = advance(before, lifecycle_ctx(price=2005.0), CONFIG)

    assert after.state is SignalState.LOCKED
    assert frozen_fields(after) == expected


def test_scanning_waits_until_a_forming_structure_is_detected():
    before = signal(state=SignalState.SCANNING)

    after = advance(
        before,
        lifecycle_ctx(forming_detected=False),
        CONFIG,
    )

    assert after.state is SignalState.SCANNING


def test_forming_waits_until_direction_and_entry_zone_resolve():
    before = signal(state=SignalState.FORMING)

    after = advance(
        before,
        lifecycle_ctx(candidate_resolved=False),
        CONFIG,
    )

    assert after.state is SignalState.FORMING


def test_awaiting_validation_does_not_lock_while_regime_is_pending():
    before = signal(state=SignalState.AWAITING_VALIDATION, locked_at=None)

    after = advance(
        before,
        lifecycle_ctx(regime_confirmed=False),
        CONFIG,
    )

    assert after.state is SignalState.AWAITING_VALIDATION
    assert after.locked_at is None


def test_failed_validity_gate_never_locks_provisional_levels():
    before = signal(
        state=SignalState.AWAITING_VALIDATION,
        locked_at=None,
        gate=gate_outcome(
            passed=False,
            failed_conditions=("MIN_CLUSTERS", "POOR_RR"),
        ),
    )

    after = advance(before, lifecycle_ctx(regime_confirmed=True), CONFIG)

    assert after.state is SignalState.AWAITING_VALIDATION
    assert after.locked_at is None
    assert after.entry_zone == before.entry_zone
    assert after.exit_plan == before.exit_plan


# =========================================================== lock invariants


@pytest.mark.parametrize(
    "field,replacement",
    [
        pytest.param(
            "direction",
            Direction.SELL,
            id="6.1-lock-invariant-direction",
        ),
        pytest.param(
            "entry_zone",
            {"min": 1998.0, "max": 2000.0},
            id="6.1-lock-invariant-entry-zone",
        ),
        pytest.param(
            "exit_plan",
            exit_plan(
                stop_loss=1985.0,
                take_profit_1=2017.5,
                take_profit_2=2034.0,
            ),
            id="6.1-lock-invariant-stop",
        ),
        pytest.param(
            "exit_plan",
            exit_plan(
                stop_loss=1990.0,
                take_profit_1=2022.0,
                take_profit_2=2034.0,
            ),
            id="6.1-lock-invariant-tp1",
        ),
        pytest.param(
            "exit_plan",
            exit_plan(
                stop_loss=1990.0,
                take_profit_1=2017.5,
                take_profit_2=2040.0,
            ),
            id="6.1-lock-invariant-tp2",
        ),
        pytest.param("score", 81.0, id="6.1-lock-invariant-score"),
        pytest.param("breadth", 0.85, id="6.1-lock-invariant-breadth"),
        pytest.param("quality", 95.0, id="6.1-lock-invariant-quality"),
        pytest.param(
            "votes",
            vote_tally(
                buy_votes=5,
                buy_points=500.0,
                sell_votes=0,
                sell_points=0.0,
                contested=False,
                leading_contributor="module_1",
            ),
            id="6.1-lock-invariant-votes",
        ),
    ],
)
def test_every_frozen_field_recomputation_raises_lock_violation(field, replacement):
    """§6.1 rules 1–2: recomputation after lock is an assertion failure."""
    before = locked_signal()
    after = with_field(before, **{field: replacement})

    with pytest.raises(LockViolation):
        assert_lock_invariant(before, after)


def test_nested_in_place_level_mutation_is_detected():
    """§6.1 rule 2: a shallow identity check must not miss nested changes."""
    before = locked_signal()
    after = before.model_copy(deep=True)
    after.entry_zone["min"] = 1999.0

    with pytest.raises(LockViolation):
        assert_lock_invariant(before, after)


def test_state_and_age_may_advance_without_breaking_the_lock():
    """§6.1 rule 5: display state changes; the decision surface does not."""
    before = locked_signal(age_bars=0)
    after = with_field(
        before,
        state=SignalState.ENTRY_HIT,
        age_bars=1,
    )

    assert_lock_invariant(before, after)


def test_the_lock_invariant_applies_after_taken_and_during_monitoring():
    """§6.1 rule 4: later scans become monitoring-only after acceptance."""
    taken = locked_signal(state=SignalState.TAKEN)
    monitoring = with_field(
        taken,
        state=SignalState.MONITORING,
        age_bars=taken.age_bars + 1,
    )

    assert_lock_invariant(taken, monitoring)
    assert frozen_fields(monitoring) == frozen_fields(taken)


def test_locked_values_survive_every_bar_until_price_reaches_the_zone():
    """§6.1 / §9 Stage 3 gate: the core multi-bar regression sequence."""
    current = locked_signal()
    original = frozen_fields(current)

    for bars_since_lock, price in enumerate((2005.0, 2006.0, 2007.0), start=1):
        current = advance(
            current,
            lifecycle_ctx(
                price=price,
                now=current.locked_at
                + bars_since_lock * timeframe_delta(current.entry_timeframe),
                bar_close_time=current.locked_at
                + bars_since_lock * timeframe_delta(current.entry_timeframe),
                bars_since_lock=bars_since_lock,
            ),
            CONFIG,
        )
        assert current.state is SignalState.LOCKED
        assert current.age_bars == bars_since_lock
        assert frozen_fields(current) == original

    entry_hit = advance(
        current,
        lifecycle_ctx(
            price=2001.0,
            now=current.locked_at + 4 * timeframe_delta(current.entry_timeframe),
            bar_close_time=current.locked_at
            + 4 * timeframe_delta(current.entry_timeframe),
            bars_since_lock=4,
        ),
        CONFIG,
    )

    assert entry_hit.state is SignalState.ENTRY_HIT
    assert frozen_fields(entry_hit) == original
    assert_lock_invariant(current, entry_hit)


def test_age_bars_never_changes_any_locked_level():
    """§6.1 rule 5: age is display state and cannot feed level derivation."""
    base = locked_signal()
    original = frozen_fields(base)

    for age in (1, 4, SIGNAL_TTL_BARS - 1):
        aged = advance(
            base,
            lifecycle_ctx(
                price=2005.0,
                now=base.locked_at + age * timeframe_delta(base.entry_timeframe),
                bar_close_time=base.locked_at
                + age * timeframe_delta(base.entry_timeframe),
                bars_since_lock=age,
            ),
            CONFIG,
        )
        assert aged.age_bars == age
        assert frozen_fields(aged) == original


def test_later_bars_never_restamp_lock_or_expiry():
    """§6.1 rule 1: the two timestamps are stamped on entering LOCKED, once."""
    base = locked_signal()
    expected_lock = base.locked_at
    expected_expiry = base.expires_at

    later = advance(
        base,
        lifecycle_ctx(
            price=2005.0,
            now=base.locked_at + timeframe_delta(base.entry_timeframe),
            bar_close_time=base.locked_at
            + timeframe_delta(base.entry_timeframe),
            bars_since_lock=1,
        ),
        CONFIG,
    )

    assert later.locked_at == expected_lock
    assert later.expires_at == expected_expiry


# ======================================================= expiry and TOO_LATE


def test_expiry_uses_the_wall_clock_timestamp_stamped_at_lock():
    """§2 / §6.1: ``expires_at`` is resolved wall-clock state, not a live TTL."""
    locked = locked_signal()

    just_before = lifecycle_ctx(
        now=locked.expires_at - timedelta(seconds=1),
        bar_close_time=locked.expires_at - timedelta(seconds=1),
        bars_since_lock=SIGNAL_TTL_BARS - 1,
    )
    just_after = lifecycle_ctx(
        now=locked.expires_at + timedelta(seconds=1),
        bar_close_time=locked.expires_at + timedelta(seconds=1),
        bars_since_lock=SIGNAL_TTL_BARS,
    )
    exactly_at = lifecycle_ctx(
        now=locked.expires_at,
        bar_close_time=locked.expires_at,
        bars_since_lock=SIGNAL_TTL_BARS,
    )

    assert should_expire(locked, just_before, CONFIG) is False
    assert should_expire(locked, exactly_at, CONFIG) is True
    assert should_expire(locked, just_after, CONFIG) is True


@pytest.mark.parametrize(
    "state",
    [
        pytest.param(SignalState.ENTRY_HIT, id="6.1-expiry-not-after-trigger"),
        pytest.param(SignalState.TAKEN, id="6.1-expiry-not-after-taken"),
        pytest.param(SignalState.MONITORING, id="6.1-expiry-not-while-monitoring"),
    ],
)
def test_expiry_applies_only_while_untriggered(state):
    """§6.1: EXPIRED means the TTL elapsed *without a trigger*."""
    triggered = locked_signal(state=state)
    after_expiry = lifecycle_ctx(
        now=triggered.expires_at + timedelta(hours=1),
        bar_close_time=triggered.expires_at + timedelta(hours=1),
        bars_since_lock=SIGNAL_TTL_BARS + 1,
        has_open_position=state in (SignalState.TAKEN, SignalState.MONITORING),
    )

    assert should_expire(triggered, after_expiry, CONFIG) is False


def test_a_later_config_change_cannot_move_an_existing_signals_expiry():
    """§6.1 rule 1: expiry is stamped once and the config version is explainable."""
    locked = locked_signal()
    after_old_expiry = lifecycle_ctx(
        now=locked.expires_at + timedelta(seconds=1),
        bar_close_time=locked.expires_at + timedelta(seconds=1),
        bars_since_lock=SIGNAL_TTL_BARS,
    )
    changed_config = levels_config(signal_ttl_bars=SIGNAL_TTL_BARS * 10)

    assert should_expire(locked, after_old_expiry, changed_config) is True
    assert locked.expires_at == (
        locked.locked_at
        + SIGNAL_TTL_BARS * timeframe_delta(locked.entry_timeframe)
    )


@pytest.mark.parametrize(
    "direction,at_boundary,beyond_boundary",
    [
        pytest.param(
            Direction.BUY,
            2002.0 + CHASE_TOLERANCE_ATR_FIXTURE * 10.0,
            2002.01 + CHASE_TOLERANCE_ATR_FIXTURE * 10.0,
            id="6.1-TOO_LATE-BUY-strictly-above-zone",
        ),
        pytest.param(
            Direction.SELL,
            2000.0 - CHASE_TOLERANCE_ATR_FIXTURE * 10.0,
            1999.99 - CHASE_TOLERANCE_ATR_FIXTURE * 10.0,
            id="6.1-TOO_LATE-SELL-strictly-below-zone",
        ),
    ],
)
def test_chase_tolerance_is_strict_and_directional(
    direction,
    at_boundary,
    beyond_boundary,
):
    """§6.1: TOO_LATE only after price passes the zone by ``>`` tolerance × ATR."""
    locked = locked_signal(direction=direction)

    assert (
        should_mark_too_late(
            locked,
            lifecycle_ctx(price=at_boundary, atr=10.0),
            CONFIG,
        )
        is False
    )
    assert (
        should_mark_too_late(
            locked,
            lifecycle_ctx(price=beyond_boundary, atr=10.0),
            CONFIG,
        )
        is True
    )


@pytest.mark.parametrize(
    "direction,price",
    [
        pytest.param(Direction.BUY, 2017.5, id="6.1-TOO_LATE-BUY-reached-TP1"),
        pytest.param(Direction.SELL, 1982.5, id="6.1-TOO_LATE-SELL-reached-TP1"),
    ],
)
def test_reaching_tp1_untaken_is_too_late_even_inside_chase_tolerance(
    direction,
    price,
):
    """§6.1's second TOO_LATE trigger: a paid-out move is no longer an entry."""
    plan = (
        exit_plan(stop_loss=1990.0, take_profit_1=2017.5, take_profit_2=2034.0)
        if direction is Direction.BUY
        else exit_plan(stop_loss=2010.0, take_profit_1=1982.5, take_profit_2=1966.0)
    )
    locked = locked_signal(direction=direction, plan=plan)

    assert should_mark_too_late(
        locked,
        lifecycle_ctx(price=price, atr=100.0),
        CONFIG,
    )


@pytest.mark.parametrize(
    "state",
    [
        pytest.param(SignalState.TAKEN, id="6.1-TOO_LATE-not-after-TAKEN"),
        pytest.param(
            SignalState.MONITORING,
            id="6.1-TOO_LATE-not-during-MONITORING",
        ),
    ],
)
def test_tp1_is_not_too_late_after_the_signal_was_taken(state):
    """§6.1 says the TP1 shortcut applies only when the signal is untaken."""
    taken = locked_signal(state=state)

    assert (
        should_mark_too_late(
            taken,
            lifecycle_ctx(
                price=taken.exit_plan.take_profit_1,
                atr=100.0,
                has_open_position=True,
            ),
            CONFIG,
        )
        is False
    )


def test_chase_tolerance_is_read_from_config():
    """§6.1 / CLAUDE rule: the ATR multiple is config, never a literal."""
    locked = locked_signal(direction=Direction.BUY)
    price = locked.entry_zone["max"] + 15.0

    tight = should_mark_too_late(
        locked,
        lifecycle_ctx(price=price, atr=10.0),
        levels_config(chase_tolerance_atr=1.0),
    )
    loose = should_mark_too_late(
        locked,
        lifecycle_ctx(price=price, atr=10.0),
        levels_config(chase_tolerance_atr=2.0),
    )

    assert tight is True
    assert loose is False


# =================================================== per-timeframe independence


def test_two_timeframes_on_the_same_symbol_advance_independently():
    """§6.1: an H4 lifecycle cannot freeze or block the M15 lifecycle."""
    h4 = locked_signal(
        entry_timeframe=Timeframe.H4,
        state=SignalState.MONITORING,
        signal_id="44444444-4444-4444-8444-444444444444",
    )
    m15 = locked_signal(
        entry_timeframe=Timeframe.M15,
        state=SignalState.LOCKED,
        signal_id="15151515-1515-4151-8151-151515151515",
    )
    h4_before = snapshot(h4)

    m15_after = advance(
        m15,
        lifecycle_ctx(
            price=2001.0,
            bars_since_lock=1,
            has_open_position=False,
        ),
        CONFIG,
    )

    assert m15_after.state is SignalState.ENTRY_HIT
    assert snapshot(h4) == h4_before
    assert h4.state is SignalState.MONITORING


def test_monitoring_one_timeframe_does_not_block_a_second_timeframe_lock():
    """§6.1 rule 4 plus per-timeframe independence, in the opposite direction."""
    h4 = locked_signal(
        entry_timeframe=Timeframe.H4,
        state=SignalState.MONITORING,
        signal_id="44444444-4444-4444-8444-444444444444",
    )
    m15_candidate = signal(
        entry_timeframe=Timeframe.M15,
        state=SignalState.AWAITING_VALIDATION,
        signal_id="15151515-1515-4151-8151-151515151515",
    )

    m15_locked = advance(
        m15_candidate,
        lifecycle_ctx(price=2005.0, has_open_position=False),
        CONFIG,
    )

    assert m15_locked.state is SignalState.LOCKED
    assert h4.state is SignalState.MONITORING


def test_later_scans_are_monitoring_only_after_a_position_is_live():
    """§6.1 rule 4: an ordinary scan cannot reconsider a live position."""
    live = locked_signal(state=SignalState.MONITORING)
    original = frozen_fields(live)

    after_scan = advance(
        live,
        lifecycle_ctx(
            price=2005.0,
            bars_since_lock=4,
            has_open_position=True,
        ),
        CONFIG,
    )

    assert after_scan.state is SignalState.MONITORING
    assert frozen_fields(after_scan) == original
