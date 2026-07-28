"""§5.5 Level derivation — entry zone, stop, targets. **Ordering is the point.**

    "**Ordering matters and is easy to get wrong.** Levels are computed at
     `AWAITING_VALIDATION` as *provisional* values, because §5.3's validity gate
     includes `POOR_RR`, which cannot be evaluated before a target exists. They
     are then **frozen on transition to `LOCKED`** and immutable thereafter.
     Computing them at lock — as an earlier draft of this section said — makes
     the validity gate reference values that do not yet exist."

        AWAITING_VALIDATION  ->  derive levels (provisional, may be recomputed each bar)
                             ->  run validity gate, including POOR_RR
                LOCKED       ->  freeze. Nothing recomputes them.

v2.4 lists this as one of the four contradictions its gate audit found, so the
earlier — wrong — ordering is a live regression risk rather than a hypothetical
one. `test_poor_rr_is_evaluable_before_lock` is what catches it coming back.

Three other things this file is written to catch:

- **`stops_level` may only widen a stop, never tighten it.** It is a broker value
  from `SymbolSpec` (§7.1: "Never assume these values"), and a step 4 that
  *sets* the distance rather than flooring it silently converts a structural stop
  into a minimum-distance one.
- **Snapping may only reduce a target.** A snap that pushed a target out would
  manufacture reward the chart does not offer.
- **`POOR_RR` is measured on the snapped TP1**, not the raw R-multiple — so a
  1.5R plan with a level in the way is correctly rejected at 1.09R.

Every constant is declared in `gate_doubles` with its §5.5 sentence. They are
the approved Appendix B decisions 16–19; pinning them here keeps the baseline
contract stable if per-symbol tuning is authorized later.
"""

from __future__ import annotations

import pytest

from backend.contracts import Direction, Regime, SignalState, Timeframe
from backend.lifecycle.machine import IMMUTABLE_FROM
from backend.scoring.gate import evaluate_validity
from backend.scoring.levels import (
    OpposingStructure,
    check_poor_rr,
    derive_entry_zone,
    derive_stop,
    derive_targets,
)
from tests.doubles import spec_for_tests
from tests.stage1.gate_doubles import (
    MIN_RR,
    MIN_SL_ATR,
    MIN_ZONE_ATR,
    SL_BUFFER_ATR,
    SNAP_ATR,
    TP1_R,
    breakdown,
    evidence_zone,
    levels_config,
    scoring_config,
    signal,
    swing,
)
from tests.stage1.stage1_doubles import (
    CLUSTER_A,
    CLUSTER_B,
    CLUSTER_C,
    CLUSTER_REGISTRY,
    firing,
)

CONFIG = levels_config()
SPEC = spec_for_tests()  # digits 2, point 0.01, stops_level 10 — never assumed

ATR = 10.0
ZONE = {"min": 2000.0, "max": 2002.0}
ENTRY_MID = 2001.0

#: A stop that is not the ATR floor and not the broker floor, so the four steps
#: can be isolated: swing low 1990, buffered by 0.25 × 10, gives 1987.50, which
#: is 12.50 from the zone's lower edge — 1.25 ATR, above the 1.0 ATR floor, and
#: 1250 points, far above `stops_level`.
STRUCTURAL_SWING_LOW = 1990.0
STRUCTURAL_STOP = 1987.50
R_DISTANCE = ENTRY_MID - 1990.0  # 11.0, used by the target cases


def _stop(
    *,
    direction: Direction = Direction.BUY,
    zone: dict | None = None,
    low: float = STRUCTURAL_SWING_LOW,
    high: float = 2015.0,
    label: str = "swing low",
    atr: float = ATR,
    spec=SPEC,
    config: dict = CONFIG,
) -> tuple[float, str]:
    return derive_stop(
        direction,
        dict(zone if zone is not None else ZONE),
        swing(high=high, low=low, label=label),
        atr,
        spec,
        config,
    )


def _targets(
    *,
    direction: Direction = Direction.BUY,
    entry_mid: float = ENTRY_MID,
    stop: float = 1990.0,
    opposing: list[float] | None = None,
    atr: float = ATR,
    spec=SPEC,
    config: dict = CONFIG,
):
    return derive_targets(
        direction,
        entry_mid,
        stop,
        list(opposing or []),
        atr,
        spec,
        config,
    )


# ================================================================= entry zone


def test_a_wide_structural_zone_is_used_as_it_stands():
    """§5.5: "The leading contributor's own structure defines it — an order
    block's body, an FVG's gap, a sweep's rejection wick. [...] the zone is that
    range."

    The widening is a *minimum*, not a normalisation. A 2.00-wide order block
    against a 10.0 ATR is already 0.20 ATR — wider than `min_zone_atr` — and must
    survive untouched, or every zone in the system becomes the same width and the
    leading contributor's structure stops meaning anything.
    """
    zone = derive_entry_zone(evidence_zone(2000.0, 2002.0), ATR, SPEC, CONFIG)

    assert zone["min"] == pytest.approx(2000.0)
    assert zone["max"] == pytest.approx(2002.0)


@pytest.mark.parametrize(
    "low,high",
    [
        pytest.param(2001.0, 2001.0, id="5.5-min_zone_atr-a_zero_width_zone_is_widened"),
        pytest.param(2001.0, 2001.2, id="5.5-min_zone_atr-a_hairline_zone_is_widened"),
        pytest.param(2001.0, 2002.4, id="5.5-min_zone_atr-just_under_the_minimum_is_widened"),
    ],
)
def test_a_hairline_zone_is_widened_to_the_atr_minimum(low, high):
    """§5.5: "widened to a minimum of `min_zone_atr` × ATR(14) (default 0.15) **so
    a hairline zone is not unfillable**."

    0.15 × 10.0 ATR = 1.50. The reason is mechanical rather than aesthetic: a
    sweep's rejection wick can define a zone a few points wide, and a limit order
    inside it never fills — so the signal reaches `EXPIRED` having been correct.

    **Where** the extra width goes is not specified** — §5.5 says "widened to a
    minimum" and never says whether it grows about the midpoint, from one edge,
    or toward the entry side. So this asserts the width and that the original
    structure is still inside it, and nothing about the centring. Reported, not
    resolved.
    """
    zone = derive_entry_zone(evidence_zone(low, high), ATR, SPEC, CONFIG)
    minimum_width = MIN_ZONE_ATR * ATR

    assert zone["max"] - zone["min"] == pytest.approx(minimum_width, abs=0.01)
    assert zone["min"] <= low
    assert zone["max"] >= high


def test_the_zone_minimum_scales_with_atr_not_with_price():
    """§5.5 states the minimum in ATR, so the same structure on a quiet day and a
    violent one produces different zones.

    That is the whole reason the constant is an ATR multiple rather than points,
    and it is why §5.5 adds: "They are the parameters most likely to need
    per-symbol tuning — a 0.25 ATR buffer on XAUUSD is not a 0.25 ATR buffer on
    EURUSD in practice, because the wick distributions differ."
    """
    hairline = evidence_zone(2001.0, 2001.1)

    quiet = derive_entry_zone(hairline, 4.0, SPEC, CONFIG)
    violent = derive_entry_zone(hairline, 20.0, SPEC, CONFIG)

    assert quiet["max"] - quiet["min"] == pytest.approx(MIN_ZONE_ATR * 4.0, abs=0.01)
    assert violent["max"] - violent["min"] == pytest.approx(MIN_ZONE_ATR * 20.0, abs=0.01)


def test_the_zone_minimum_is_read_from_config():
    """CLAUDE.md: "Config, never constants. Every threshold, weight, ATR multiple,
    timeout and session window lives in `config/*.yaml`."

    §5.5's `min_zone_atr` is approved at 0.15 but remains configuration, not a
    code constant. This catches an implementation that ignores an authorized
    future per-symbol calibration.
    """
    hairline = evidence_zone(2001.0, 2001.1)

    narrow = derive_entry_zone(hairline, ATR, SPEC, levels_config(min_zone_atr=0.10))
    wide = derive_entry_zone(hairline, ATR, SPEC, levels_config(min_zone_atr=0.50))

    assert narrow["max"] - narrow["min"] == pytest.approx(1.0, abs=0.01)
    assert wide["max"] - wide["min"] == pytest.approx(5.0, abs=0.01)


# ================================================ derive_stop — four steps, in order


def test_the_stop_anchors_beyond_the_structure_and_buffers_past_it():
    """§5.5 steps 1 and 2:

        anchor = swing.low if direction == BUY else swing.high
        buffer = atr * sl_buffer_atr            # default 0.25
        stop   = anchor - buffer if BUY else anchor + buffer

    "**Buffer past it, so a wick through the level is not a stop-out.**"

    Swing low 1990.00 less 0.25 × 10.0 gives 1987.50, and neither the ATR floor
    (1.0 ATR from the zone edge = 1990.00) nor the broker floor (10 points =
    0.10) binds here — 12.50 clears both — so this row isolates steps 1 and 2.
    """
    stop, _ = _stop()

    assert stop == pytest.approx(STRUCTURAL_STOP)
    assert stop < STRUCTURAL_SWING_LOW, "buffered BEYOND the swing, not at it"


def test_the_stop_buffer_is_read_from_config():
    """§5.5 / CLAUDE.md: ``sl_buffer_atr`` is config, never a literal.

    The swing is far enough from the zone that neither the ATR floor nor the
    broker floor binds, so changing only the buffer must move the stop by the
    corresponding ATR distance.
    """
    narrow, _ = _stop(config=levels_config(sl_buffer_atr=0.10))
    wide, _ = _stop(config=levels_config(sl_buffer_atr=0.50))

    assert narrow == pytest.approx(STRUCTURAL_SWING_LOW - 0.10 * ATR)
    assert wide == pytest.approx(STRUCTURAL_SWING_LOW - 0.50 * ATR)
    assert wide < narrow


def test_the_atr_floor_widens_a_stop_that_sits_too_close_to_the_zone():
    """§5.5 step 3: "Floor: never tighter than `min_sl_atr` × ATR from the zone
    edge."

    A swing low at 1999.50 is inside the noise: buffered it gives 1997.00, only
    3.00 — 0.30 ATR — below the zone's lower edge. The floor pushes it out to
    exactly 1.0 ATR, 1990.00.

    Asserted as a *widening*: the floored stop must be further from the zone than
    the structural one, never nearer. A `min(...)`/`max(...)` inverted here
    produces a stop that looks plausible and is systematically too tight.
    """
    structural, _ = _stop(low=1999.50)
    edge = ZONE["min"]

    assert structural == pytest.approx(edge - MIN_SL_ATR * ATR)
    assert edge - structural == pytest.approx(MIN_SL_ATR * ATR)
    assert structural < 1997.00, "the floor widened it; it must not have tightened it"


def test_the_minimum_stop_distance_is_read_from_config():
    """§5.5 / CLAUDE.md: ``min_sl_atr`` is config, never a literal.

    The same close structural anchor is widened to two different floors while
    the buffer and broker values remain unchanged.
    """
    half_atr, _ = _stop(
        low=1999.50,
        config=levels_config(min_sl_atr=0.50),
    )
    one_and_a_half_atr, _ = _stop(
        low=1999.50,
        config=levels_config(min_sl_atr=1.50),
    )

    assert half_atr == pytest.approx(ZONE["min"] - 0.50 * ATR)
    assert one_and_a_half_atr == pytest.approx(ZONE["min"] - 1.50 * ATR)
    assert one_and_a_half_atr < half_atr


def test_the_atr_floor_does_not_pull_in_a_stop_that_already_clears_it():
    """§5.5 step 3 is a floor, not a target distance.

    The mirror of the test above and the reason it is a separate case: an
    implementation that *assigned* `edge - min_dist` instead of comparing first
    passes the widening test and destroys every structural stop wider than 1 ATR,
    which is most of them.
    """
    stop, _ = _stop(low=STRUCTURAL_SWING_LOW)

    assert stop == pytest.approx(STRUCTURAL_STOP)
    assert ZONE["min"] - stop > MIN_SL_ATR * ATR


@pytest.mark.parametrize(
    "stops_level,expected_min_distance",
    [
        pytest.param(0, 0.0, id="7.1-stops_level_0-broker_reports_zero-no_widening"),
        pytest.param(10, 0.10, id="5.5-stops_level_10-already_cleared-no_widening"),
        pytest.param(1250, 12.50, id="5.5-stops_level_1250-exactly_at_the_structural_stop"),
    ],
)
def test_the_broker_floor_never_tightens_a_stop(stops_level, expected_min_distance):
    """§5.5 step 4: "Broker floor (§7.3). **Widen, never tighten.**"

    The structural stop sits 12.50 from the zone edge — 1250 points. At every
    `stops_level` at or below that the broker constraint is already satisfied and
    the stop must not move. An implementation that *set* the distance to
    `stops_level` would pass a "does it respect the broker minimum" test and
    return 1999.90 here, tightening a 1.25 ATR stop to one point.

    `stops_level = 0` is not hypothetical: `docs/AMBIGUITY.md` #011 records that
    all four symbols on the operator's broker report `stops_level: 0`, so the
    zero row is the one that actually runs in production today.
    """
    spec = spec_for_tests(stops_level=stops_level)

    stop, _ = _stop(spec=spec)

    assert stop == pytest.approx(STRUCTURAL_STOP)
    assert ZONE["min"] - stop >= expected_min_distance


@pytest.mark.parametrize(
    "stops_level",
    [
        pytest.param(1500, id="5.5-stops_level_1500-widens_the_structural_stop"),
        pytest.param(5000, id="5.5-stops_level_5000-widens_it_a_long_way"),
    ],
)
def test_the_broker_floor_widens_a_stop_that_would_violate_stops_level(stops_level):
    """§5.5 step 4 — the case the floor exists for.

    §7.3's checklist rejects an order whose stop is inside `stops_level`, so a
    stop that violates it is not a tight stop, it is a *rejected order*. Widening
    is the only correction available; tightening is not a legal outcome and
    neither is leaving it.

    `stops_level` comes from `SymbolSpec`, resolved per §7.1. CLAUDE.md:
    "Hardcoding any of them is a financial bug, not a style issue."
    """
    spec = spec_for_tests(stops_level=stops_level)
    required = stops_level * spec.point

    stop, _ = _stop(spec=spec)

    assert ZONE["min"] - stop >= required - 1e-9
    assert stop <= STRUCTURAL_STOP, "step 4 may only widen"


def test_the_broker_floor_reads_point_from_the_symbol_spec():
    """§5.5 step 4 converts through `spec.point`:

        if abs(edge - stop) / spec.point < spec.stops_level:

    §7.1 / CLAUDE.md: "`digits`, `point`, `tick_value`, `volume_step`,
    `stops_level`, `freeze_level` come from `symbol_info()` at startup and are
    resolved per symbol. Never assume broker values."

    The same `stops_level` count against two different point sizes is two
    different price distances, so an implementation with 0.01 baked in reads
    correct on gold and wrong on everything else.
    """
    coarse = spec_for_tests(stops_level=1500, point=0.01, digits=2)
    fine = spec_for_tests(stops_level=1500, point=0.0001, digits=4)

    coarse_stop, _ = _stop(spec=coarse)
    fine_stop, _ = _stop(spec=fine)

    assert ZONE["min"] - coarse_stop >= 15.0 - 1e-9  # 1500 × 0.01
    assert fine_stop == pytest.approx(STRUCTURAL_STOP)  # 1500 × 0.0001 = 0.15, cleared


def test_the_stop_is_rounded_to_the_symbols_digits():
    """§5.5: `return round(stop, spec.digits), basis`.

    A stop carrying more precision than the instrument quotes is rejected by the
    broker or silently re-quoted, and either way the level in the journal is not
    the level on the account.
    """
    for digits in (2, 3, 4):
        spec = spec_for_tests(digits=digits, point=10.0 ** -digits, stops_level=0)
        stop, _ = _stop(low=1990.3333, spec=spec)
        assert stop == pytest.approx(round(stop, digits))


@pytest.mark.parametrize(
    "direction,low,high,edge,expected",
    [
        pytest.param(
            Direction.BUY, STRUCTURAL_SWING_LOW, 2015.0, ZONE["min"], STRUCTURAL_STOP,
            id="5.5-BUY-anchors_on_swing_low_below_the_zone",
        ),
        pytest.param(
            Direction.SELL, 1990.0, 2015.0, ZONE["max"], 2017.50,
            id="5.5-SELL-anchors_on_swing_high_above_the_zone",
        ),
    ],
)
def test_direction_selects_the_anchor_and_the_zone_edge(
    direction, low, high, edge, expected
):
    """§5.5: `anchor = swing.low if direction == BUY else swing.high`, and
    `edge = zone["min"] if direction == BUY else zone["max"]`.

    Both flip together. A stop that anchored on the swing high for a BUY would be
    above the entry, and the ATR floor measured from the wrong edge understates
    the distance by the zone's own width — small on a tight zone, and exactly the
    kind of error that shows up as a run of stop-outs rather than as a crash.
    """
    stop, _ = _stop(direction=direction, low=low, high=high)

    assert stop == pytest.approx(expected)
    if direction is Direction.BUY:
        assert stop < edge
    else:
        assert stop > edge


# ================================================================== sl_basis


def test_sl_basis_is_a_human_sentence_naming_the_structure_and_the_distance():
    """§5.5: `basis = f"{abs(edge - stop) / atr:.2f} ATR beyond {swing.label}"`,
    surfaced as *"1.06 ATR below swing low"* — "because a stop the user cannot
    explain is a stop they will move."

    Three things must be in it: the swing's own label, the unit, and the realised
    distance in ATR to two decimal places. The distance here is 12.50 against a
    10.0 ATR, so the sentence must say 1.25 — the *realised* multiple, not the
    configured 0.25 buffer, which is the number an implementation is most likely
    to interpolate by mistake.

    §5.5's f-string says "beyond" while its worked example says "below", so the
    preposition is not asserted. Reported, not resolved.
    """
    label = "swing low at 1990.00"
    stop, basis = _stop(label=label)

    realised_atr_multiple = (ZONE["min"] - stop) / ATR
    assert realised_atr_multiple == pytest.approx(1.25)

    assert basis
    assert label in basis
    assert "ATR" in basis
    assert f"{realised_atr_multiple:.2f}" in basis
    assert f"{SL_BUFFER_ATR:.2f}" not in basis or SL_BUFFER_ATR == realised_atr_multiple


def test_sl_basis_reports_the_floored_distance_when_the_floor_binds():
    """§5.5 — the basis describes the stop that was actually produced.

    When step 3 widens the stop to 1.0 ATR, the sentence must say 1.00, not the
    0.25 the buffer asked for. A basis computed before the floors is a sentence
    about a stop that was never placed, which is worse than no sentence.
    """
    stop, basis = _stop(low=1999.50)

    assert (ZONE["min"] - stop) / ATR == pytest.approx(MIN_SL_ATR)
    assert f"{MIN_SL_ATR:.2f}" in basis


# =================================================================== targets


def test_tp1_is_an_r_multiple_off_the_realised_stop_distance():
    """§5.5: "R-multiples off the **realised** stop distance":

        R = |entry_mid − stop_loss|
        TP1 = entry ± tp1_r × R      (default 1.5)
    "Realised" is the load-bearing word. R is measured against the stop that came
    out of `derive_stop` — after the ATR floor and the broker floor — not against
    the structural stop that went in. A target sized off the pre-floor distance
    understates R and manufactures a reward:risk the position does not have.

    With no opposing structure supplied, §5.5 requires TP2 to be ``None``.
    """
    tp1, tp2, rr = _targets(stop=1990.0)

    assert R_DISTANCE == pytest.approx(11.0)
    assert tp1 == pytest.approx(ENTRY_MID + TP1_R * R_DISTANCE)  # 2017.50
    assert tp2 is None
    assert rr == pytest.approx(TP1_R)


def test_a_wider_realised_stop_moves_the_targets_out_with_it():
    """§5.5 — the corollary. Two stops, same entry, R-multiples that track.

    This is what makes the floors in `derive_stop` visible downstream: widening a
    stop does not improve the reward:risk, it moves the target. An implementation
    that computed targets from a fixed point distance would leave RR drifting
    with volatility and `POOR_RR` would stop meaning anything.
    """
    tight_tp1, _, tight_rr = _targets(stop=1995.0)  # R = 6
    wide_tp1, _, wide_rr = _targets(stop=1985.0)  # R = 16

    assert tight_tp1 == pytest.approx(ENTRY_MID + TP1_R * 6.0)
    assert wide_tp1 == pytest.approx(ENTRY_MID + TP1_R * 16.0)
    assert tight_rr == pytest.approx(wide_rr) == pytest.approx(TP1_R)


def test_tp1_r_is_read_from_config():
    """§5.5 / CLAUDE.md: ``tp1_r`` is config, never a literal."""
    conservative = _targets(
        stop=1990.0,
        config=levels_config(tp1_r=1.20),
    )
    ambitious = _targets(
        stop=1990.0,
        config=levels_config(tp1_r=2.00),
    )

    assert conservative[0] == pytest.approx(ENTRY_MID + 1.20 * R_DISTANCE)
    assert ambitious[0] == pytest.approx(ENTRY_MID + 2.00 * R_DISTANCE)
    assert conservative[2] == pytest.approx(1.20)
    assert ambitious[2] == pytest.approx(2.00)


@pytest.mark.parametrize(
    "direction,stop,opposing,raw_tp1",
    [
        pytest.param(Direction.BUY, 1990.0, [2016.0], 2017.50, id="5.5-snap-BUY-level_below_tp1_reduces_it"),
        pytest.param(Direction.SELL, 2012.0, [1986.0], 1984.50, id="5.5-snap-SELL-level_above_tp1_reduces_it"),
    ],
)
def test_snapping_pulls_a_target_back_to_just_inside_the_nearest_level(
    direction, stop, opposing, raw_tp1
):
    """§5.5: "Each target is pulled back to just inside the nearest opposing level
    (prior swing, unfilled FVG, session high/low) within `snap_atr` × ATR (default
    0.5)."

    0.5 × 10.0 ATR = 5.00, and the level here is 1.50 from the raw target, so it
    is inside the snap window and the target moves to it.

    "Just inside" is not quantified — §5.5 does not say by how much, and it may
    reasonably be one tick, one point or exactly the level. So this asserts the
    direction and the bound, never the exact price. Reported, not resolved.
    """
    tp1, _, rr = _targets(direction=direction, stop=stop, opposing=opposing)
    level = opposing[0]

    if direction is Direction.BUY:
        assert ENTRY_MID < tp1 <= level
        assert tp1 < raw_tp1
        assert rr == pytest.approx((tp1 - ENTRY_MID) / abs(ENTRY_MID - stop))
    else:
        assert level <= tp1 < ENTRY_MID
        assert tp1 > raw_tp1
        assert rr == pytest.approx((ENTRY_MID - tp1) / abs(ENTRY_MID - stop))


def test_snapping_selects_the_nearest_of_multiple_opposing_levels():
    """§5.5: choose the nearest eligible opposing level, independent of order.

    Both levels are inside the BUY snap window and may only pull TP1 inward.
    The 2016 level is nearer the raw 2017.50 target than 2013, so the result must
    match the single-nearest-level case and must not depend on list order.
    """
    nearest_only = _targets(opposing=[2016.0])[0]
    near_then_far = _targets(opposing=[2016.0, 2013.0])[0]
    far_then_near = _targets(opposing=[2013.0, 2016.0])[0]

    assert near_then_far == pytest.approx(nearest_only)
    assert far_then_near == pytest.approx(nearest_only)
    assert 2013.0 < nearest_only <= 2016.0


@pytest.mark.parametrize(
    "direction,stop,opposing,raw_tp1",
    [
        pytest.param(Direction.BUY, 1990.0, [2020.0], 2017.50, id="5.5-snap-BUY-a_level_BEYOND_tp1_must_not_extend_it"),
        pytest.param(Direction.SELL, 2012.0, [1982.0], 1984.50, id="5.5-snap-SELL-a_level_BEYOND_tp1_must_not_extend_it"),
    ],
)
def test_snapping_may_only_reduce_a_target_never_push_it_out(
    direction, stop, opposing, raw_tp1
):
    """§5.5: "**Never pushed out — snapping may only reduce the target.**"
    `config/levels.yaml` restates it as `snap_may_only_reduce: true`.

    The level in each row is 2.50 away — comfortably inside the 5.00 snap window
    — but on the far side of the target. A snap implemented as "move to the
    nearest level within range" takes the bait and invents 0.23R of reward that
    the chart does not offer, then `POOR_RR` waves the trade through.

    This is the asymmetry test for targets, and it is the same shape as
    `test_the_broker_floor_never_tightens_a_stop`: a one-directional adjustment
    implemented as an unconditional assignment.
    """
    tp1, _, rr = _targets(direction=direction, stop=stop, opposing=opposing)

    assert tp1 == pytest.approx(raw_tp1)
    assert rr == pytest.approx(TP1_R)


def test_a_level_outside_the_snap_window_is_ignored():
    """§5.5: "within `snap_atr` × ATR (default 0.5)".

    A level 12.50 from the target is 1.25 ATR away and outside the window, so it
    is not the "nearest opposing level" this rule is about. Without this case an
    implementation that snapped to the nearest level at *any* distance would pass
    every other target test in the file.
    """
    tp1, _, rr = _targets(opposing=[2005.0])

    assert tp1 == pytest.approx(ENTRY_MID + TP1_R * R_DISTANCE)
    assert rr == pytest.approx(TP1_R)


def test_the_snap_window_is_read_from_config():
    """CLAUDE.md: "Config, never constants." `snap_atr` is Appendix B #18.

    The same level is inside the window at 0.5 ATR and outside it at 0.1 ATR, so
    the operator's choice must change the answer.
    """
    inside = _targets(opposing=[2014.0], config=levels_config(snap_atr=SNAP_ATR))
    outside = _targets(opposing=[2014.0], config=levels_config(snap_atr=0.1))

    assert inside[0] < ENTRY_MID + TP1_R * R_DISTANCE
    assert outside[0] == pytest.approx(ENTRY_MID + TP1_R * R_DISTANCE)


@pytest.mark.parametrize(
    "direction,stop",
    [
        pytest.param(Direction.BUY, 1990.0, id="5.5-TP2-no-support-BUY"),
        pytest.param(Direction.SELL, 2012.0, id="5.5-TP2-no-support-SELL"),
    ],
)
def test_tp2_is_none_when_no_opposing_structure_supports_it(direction, stop):
    """§5.5: TP2 is ``None`` when no structure supports a second target."""
    _, tp2, _ = _targets(direction=direction, stop=stop, opposing=[])

    assert tp2 is None


def test_typed_opposing_structures_preserve_identity_and_support_tp2():
    """The approved target geometry retains structure provenance."""

    structures = [
        OpposingStructure(2016.0, "PRIOR_SWING", Timeframe.H1, "swing-h1-42"),
        OpposingStructure(2034.0, "UNFILLED_FVG", Timeframe.H4, "fvg-h4-07"),
    ]

    tp1, tp2, _ = _targets(opposing=structures)

    assert tp1 == pytest.approx(2015.99)
    assert tp2 == pytest.approx(2033.99)


def test_typed_opposing_structures_require_a_stable_identifier():
    with pytest.raises(ValueError, match="stable_id must not be empty"):
        _targets(
            opposing=[
                OpposingStructure(2016.0, "PRIOR_SWING", Timeframe.H1, " ")
            ]
        )


# ================================================================== POOR_RR


@pytest.mark.parametrize(
    "rr,expected",
    [
        pytest.param(TP1_R, False, id="5.5-POOR_RR-1.5_the_unsnapped_multiple-passes"),
        pytest.param(1.36, False, id="5.5-POOR_RR-1.36_after_a_light_snap-passes"),
        pytest.param(MIN_RR, False, id="5.5-POOR_RR-EXACTLY_min_rr_1.2-passes"),
        pytest.param(1.19, True, id="5.5-POOR_RR-1.19_just_below_min_rr-rejected"),
        pytest.param(1.09, True, id="5.5-POOR_RR-1.09_after_a_heavy_snap-rejected"),
        pytest.param(0.8, True, id="5.5-POOR_RR-0.8_less_than_one_R-rejected"),
    ],
)
def test_poor_rr_rejects_below_min_rr_inclusive_at_the_boundary(rr, expected):
    """§5.5: "If TP1 after snapping yields **less than** `min_rr` (default 1.2)
    against the stop, the signal fails validity with `POOR_RR`."

    "Less than", so exactly 1.2 passes. "A correct read of the chart with no room
    to the next level is not a trade."
    """
    assert check_poor_rr(rr, CONFIG) is expected


def test_poor_rr_is_measured_on_the_snapped_tp1_not_the_raw_r_multiple():
    """§5.5: "**If TP1 after snapping** yields less than `min_rr`".

    The distinction is the entire rule. Raw, this plan is 1.5R and passes
    comfortably. With a prior swing at 2013.00 — 4.50 from the target and inside
    the 5.00 snap window — the achievable target is 12.00 against an 11.00 stop,
    1.09R, and the trade is rejected.

    An implementation that checked `tp1_r` against `min_rr` compares two
    constants, always passes, and never rejects anything — a `POOR_RR` that can
    never fire is indistinguishable from one that is not implemented.
    """
    unsnapped_tp1, _, unsnapped_rr = _targets()
    assert unsnapped_rr == pytest.approx(TP1_R)
    assert check_poor_rr(unsnapped_rr, CONFIG) is False

    snapped_tp1, _, snapped_rr = _targets(opposing=[2013.0])

    assert snapped_tp1 < unsnapped_tp1
    assert snapped_rr < MIN_RR
    assert snapped_rr == pytest.approx((snapped_tp1 - ENTRY_MID) / R_DISTANCE)
    assert check_poor_rr(snapped_rr, CONFIG) is True


def test_min_rr_is_read_from_config():
    """CLAUDE.md: "Config, never constants." `min_rr` is Appendix B #17.

    §5.5 calls decisions 16–19 "the ones most likely to be wrong at first and
    cheapest to fix later; they are per-symbol", so the threshold moving must
    change the verdict on a fixed number.
    """
    assert check_poor_rr(1.3, levels_config(min_rr=1.2)) is False
    assert check_poor_rr(1.3, levels_config(min_rr=1.5)) is True


# ============================================= THE ORDERING: provisional, then lock


def test_poor_rr_is_evaluable_before_lock():
    """§5.5: "Levels are computed at `AWAITING_VALIDATION` as *provisional*
    values, **because §5.3's validity gate includes `POOR_RR`, which cannot be
    evaluated before a target exists**. [...] Computing them at lock — as an
    earlier draft of this section said — makes the validity gate reference values
    that do not yet exist."

    v2.4's gate audit lists this among four contradictions it found, so the wrong
    ordering is a regression that has already happened once.

    The whole chain runs here against a signal that is still at
    `AWAITING_VALIDATION` with `locked_at` unset: derive the stop, derive the
    targets, measure RR on the snapped TP1, and feed the verdict into §5.3's
    gate. Nothing in that sequence touches `LOCKED`, and the signal's own state
    is asserted before and after to prove it.
    """
    candidate = signal(state=SignalState.AWAITING_VALIDATION, locked_at=None)
    assert candidate.locked_at is None
    assert candidate.state not in IMMUTABLE_FROM

    stop, _ = _stop()
    tp1, _, rr = _targets(stop=stop, opposing=[2005.0])
    poor = check_poor_rr(rr, CONFIG)

    outcome = evaluate_validity(
        breakdown(score=75.0),
        (
            firing(CLUSTER_A, Direction.BUY, 90.0, modules=(1,)),
            firing(CLUSTER_B, Direction.BUY, 90.0, modules=(12,)),
            firing(CLUSTER_C, Direction.BUY, 90.0, modules=(5,)),
        ),
        CLUSTER_REGISTRY,
        Regime.TRENDING_BULLISH,
        20,
        26,
        False,
        False,
        poor,
        scoring_config(),
    )

    assert candidate.locked_at is None, "the gate ran without locking anything"
    assert candidate.state is SignalState.AWAITING_VALIDATION
    assert outcome.passed is (not poor)
    assert ("POOR_RR" in outcome.failed_conditions) is poor


def test_a_poor_rr_candidate_fails_validity_and_is_never_locked():
    """§5.5 + §5.3 — the rejection path, end to end.

    A plan with a prior swing 4.50 short of its target yields 1.09R, fails
    condition `POOR_RR`, and therefore fails validity — which §5.3 says means
    "not tradeable **at any score**". Nothing about that verdict requires the
    signal to have locked, and the levels that produced it were provisional.
    """
    # Keep the intended 11-point risk stated in the prose. The separately
    # derived structural stop is 1987.5 (13.5 points of risk), which correctly
    # puts 2013 outside the 0.5 ATR snap window and is not a POOR_RR fixture.
    _, _, rr = _targets(stop=1990.0, opposing=[2013.0])

    candidate = signal(state=SignalState.AWAITING_VALIDATION, locked_at=None, score=99.0)
    outcome = evaluate_validity(
        breakdown(score=99.0),
        (
            firing(CLUSTER_A, Direction.BUY, 95.0, modules=(1,)),
            firing(CLUSTER_B, Direction.BUY, 95.0, modules=(12,)),
            firing(CLUSTER_C, Direction.BUY, 95.0, modules=(5,)),
        ),
        CLUSTER_REGISTRY,
        Regime.TRENDING_BULLISH,
        20,
        26,
        False,
        False,
        check_poor_rr(rr, CONFIG),
        scoring_config(),
    )

    assert outcome.passed is False
    assert outcome.failed_conditions == ["POOR_RR"]
    assert candidate.locked_at is None


def test_provisional_levels_may_be_recomputed_on_every_bar_before_lock():
    """§5.5: "derive levels (**provisional, may be recomputed each bar**)".

    Explicitly permitted, and the counterpart to §6.1 rule 1's prohibition after
    lock. A candidate at `AWAITING_VALIDATION` is still tracking a structure that
    is still forming, so freezing early is as wrong as recomputing late.

    Three consecutive bars with a rising ATR and a rising swing low must produce
    three different stops, each internally consistent, and no exception.
    """
    bars = [
        (9.0, 1988.0),
        (10.0, 1990.0),
        (12.0, 1992.0),
    ]
    stops = [_stop(atr=atr, low=low)[0] for atr, low in bars]

    assert len(set(stops)) == 3, "provisional levels track the bars; they do not freeze"
    for (atr, low), stop in zip(bars, stops):
        buffered = low - SL_BUFFER_ATR * atr
        atr_floor = ZONE["min"] - MIN_SL_ATR * atr
        assert stop == pytest.approx(min(buffered, atr_floor))


def test_awaiting_validation_is_not_an_immutable_state_and_locked_is():
    """§6.1's table: `AWAITING_VALIDATION` carries "provisional" levels, `LOCKED`
    carries "**immutable**" ones.

    `IMMUTABLE_FROM` is where that table becomes executable, and it is what
    `derive_*` must be called *before*. Paired with a live derivation so the
    assertion is about the ordering rather than about a tuple literal.
    """
    assert SignalState.AWAITING_VALIDATION not in IMMUTABLE_FROM
    assert SignalState.FORMING not in IMMUTABLE_FROM
    assert SignalState.LOCKED in IMMUTABLE_FROM

    stop, basis = _stop()
    assert stop == pytest.approx(STRUCTURAL_STOP)
    assert basis
