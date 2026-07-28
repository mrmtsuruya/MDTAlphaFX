"""§5.2 Score computation.

    available = [c for c in CLUSTERS if enabled_in(regime, c)]
    firing    = [c for c in available if c.fired and c.direction == signal_direction]

    breadth = sum(c.weight for c in firing) / sum(c.weight for c in available)

    quality = (sum(c.score * c.weight for c in firing)
               / sum(c.weight for c in firing)) if firing else 0.0

    score = 100 * (breadth ** ALPHA) * (quality / 100)      # ALPHA default 0.5
    score *= htf_alignment_penalty                           # 1.0 aligned, 0.6 opposing

    "Two distinct quantities. Do not collapse them into one number without
     keeping both visible."

ALPHA is declared in `stage1_doubles` as 0.5, not read from
`config/scoring.yaml`, because §5.3.1's and §5.3.2's published tables are only
reproducible at the approved baseline of 0.5.
"""

from __future__ import annotations

import pytest

from backend.contracts import Direction, Regime
from backend.scoring.score import compute_breadth_quality_score, enabled_in
from tests.stage1.stage1_doubles import (
    ALPHA,
    CLUSTER_A,
    CLUSTER_B,
    CLUSTER_C,
    CLUSTER_D1,
    CLUSTER_D2,
    CLUSTER_E,
    CLUSTER_F,
    CLUSTER_G,
    CLUSTER_H,
    CLUSTER_REGISTRY,
    COUNTER_BIAS_PENALTY,
    DENOM_RANGING,
    DENOM_TRANSITIONAL,
    DENOM_TRENDING_COUNTER_TREND,
    DENOM_TRENDING_WITH_TREND,
    REGIME_CLUSTER_MAP,
    TRENDING_COUNTER_TREND_CLUSTERS,
    TRENDING_WITH_TREND_CLUSTERS,
    all_firing,
    firing,
    resolved,
    weight_sum,
)


def _score(
    clusters,
    *,
    regime,
    direction,
    trend=Direction.NONE,
    alpha=ALPHA,
    penalty=1.0,
):
    return compute_breadth_quality_score(
        clusters,
        CLUSTER_REGISTRY,
        regime,
        direction,
        trend,
        REGIME_CLUSTER_MAP,
        alpha,
        penalty,
    )


# ================================ the denominator is the ENABLED set, not all
#
# ---------------------------------------------------------------------------
# THE COUNTER-TREND DENOMINATOR IS CONTESTED. READ BEFORE EDITING.
#
# §5.2 states four working denominators in prose — "TRENDING counter-trend = 22
# (D₂, F)" — and §5.3.1's per-regime table repeats it ("TRENDING, counter-trend
# | 22 | 2 clusters available"), and §5.3.1's worked example depends on it
# ("both clusters firing at quality 95, breadth 1.0 gives 95, then §3.5's 0.6
# penalty takes it to 57").
#
# §5.2's own `enabled_in` snippet, applied literally, gives 90 rather than 22:
# an ENABLED cluster returns True for either direction, so a counter-trend SELL
# in TRENDING has A, B, C, D₁, E and H available alongside D₂ and F. `config/
# regime.yaml` says the same in prose — "ENABLED: may contribute in either
# direction".
#
# The two readings are not close. D₂ + F firing at quality 95 scores 95 → 57
# after the penalty under the stated figure, and 47 → 28 under the snippet.
#
# The cases below assert the figure the spec states three times, because that is
# what §5.3.1's calibration table is built on. They are the tests to revisit if
# the snippet turns out to be the intended semantics. Reported, not resolved.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "regime,direction,trend,expected_denominator,expected_members",
    [
        pytest.param(
            Regime.TRENDING_BULLISH,
            Direction.BUY,
            Direction.BUY,
            DENOM_TRENDING_WITH_TREND,
            TRENDING_WITH_TREND_CLUSTERS,
            id="5.2-denominator-TRENDING_with_trend-68",
        ),
        pytest.param(
            Regime.TRENDING_BEARISH,
            Direction.SELL,
            Direction.SELL,
            DENOM_TRENDING_WITH_TREND,
            TRENDING_WITH_TREND_CLUSTERS,
            id="5.2-denominator-TRENDING_bearish_with_trend-68",
        ),
        pytest.param(
            Regime.TRENDING_BULLISH,
            Direction.SELL,
            Direction.BUY,
            DENOM_TRENDING_COUNTER_TREND,
            TRENDING_COUNTER_TREND_CLUSTERS,
            id="5.2-denominator-TRENDING_counter_trend-22-APPROVED",
        ),
        pytest.param(
            Regime.TRENDING_BEARISH,
            Direction.BUY,
            Direction.SELL,
            DENOM_TRENDING_COUNTER_TREND,
            TRENDING_COUNTER_TREND_CLUSTERS,
            id="5.2-denominator-TRENDING_bearish_counter_trend-22-APPROVED",
        ),
        pytest.param(
            Regime.RANGING,
            Direction.BUY,
            Direction.NONE,
            DENOM_RANGING,
            None,
            id="5.2-denominator-RANGING-67",
        ),
        pytest.param(
            Regime.TRANSITIONAL,
            Direction.BUY,
            Direction.NONE,
            DENOM_TRANSITIONAL,
            None,
            id="5.2-denominator-TRANSITIONAL-57",
        ),
    ],
)
def test_working_denominators(regime, direction, trend, expected_denominator, expected_members):
    """§5.2: "Working denominators under the §5.1 weights: **TRENDING
    with-trend = 68** (A, B, C, D₁, E, H) · **TRENDING counter-trend = 22**
    (D₂, F) · **RANGING = 67** (A, B, C, D₂, F, G) · **TRANSITIONAL = 57**
    (A, B, C, D₂, F)."

    "If suppressed clusters remained in the denominator, the maximum achievable
    score would differ per regime and a threshold of 85 could be unreachable in
    one regime and routine in another, with nothing surfacing the discrepancy."
    """
    if expected_members is not None:
        assert weight_sum(*expected_members) == expected_denominator

    breakdown = _score(resolved(), regime=regime, direction=direction, trend=trend)
    assert breakdown.denominator == expected_denominator


@pytest.mark.parametrize(
    "regime,expected",
    [
        pytest.param(Regime.RANGING, DENOM_RANGING, id="5.2-RANGING-no_trend_to_counter"),
        pytest.param(
            Regime.TRANSITIONAL,
            DENOM_TRANSITIONAL,
            id="5.2-TRANSITIONAL-no_trend_to_counter",
        ),
    ],
)
@pytest.mark.parametrize(
    "trend",
    [
        pytest.param(Direction.NONE, id="trend_NONE"),
        pytest.param(Direction.BUY, id="trend_BUY"),
        pytest.param(Direction.SELL, id="trend_SELL"),
    ],
)
def test_denominator_outside_trending_is_independent_of_trend_direction(
    regime, expected, trend
):
    """§3.4 marks ✅¹ only in the TRENDING column, so outside TRENDING the
    candidate direction cannot change the available set.

    An implementation that applies the COUNTER_ONLY rule by cluster rather than
    by cell drops D₂ and F from RANGING's denominator whenever a trend direction
    happens to be supplied, taking 67 to 45 and inflating every RANGING breadth
    by half.
    """
    breakdown = _score(
        resolved(), regime=regime, direction=Direction.BUY, trend=trend
    )
    assert breakdown.denominator == expected


# ============================ the critical one: COUNTER_ONLY and the denominator


def test_a_with_trend_signal_excludes_counter_only_clusters_from_its_denominator():
    """§5.2: "A with-trend BUY can never earn their weight, so scoring it
    against a denominator that includes them **understates breadth by roughly
    25%**."

    The same firing set is scored two ways here: once by the implementation, and
    once by the arithmetic an implementation that forgot the direction argument
    would produce. The gap is the whole reason `enabled_in` takes a direction.
    """
    firing_set = (CLUSTER_A, CLUSTER_B, CLUSTER_C, CLUSTER_E)
    clusters = all_firing(firing_set, Direction.BUY, 90.0)

    breakdown = _score(
        clusters,
        regime=Regime.TRENDING_BULLISH,
        direction=Direction.BUY,
        trend=Direction.BUY,
    )

    numerator = weight_sum(*firing_set)
    assert numerator == 47
    assert breakdown.numerator == numerator
    assert breakdown.denominator == DENOM_TRENDING_WITH_TREND
    assert breakdown.breadth == pytest.approx(47 / 68)

    # What the same firing set produces when D₂ and F are wrongly left in the
    # denominator: 68 + 22 = 90.
    naive_denominator = DENOM_TRENDING_WITH_TREND + DENOM_TRENDING_COUNTER_TREND
    naive_breadth = numerator / naive_denominator
    assert breakdown.breadth != pytest.approx(naive_breadth)

    understatement = 1.0 - (naive_breadth / breakdown.breadth)
    assert understatement == pytest.approx(0.244, abs=0.01), "§5.2 — 'roughly 25%'"


def test_a_counter_only_cluster_firing_with_the_trend_earns_nothing():
    """§3.4 note 1: COUNTER_ONLY clusters "cannot add conviction to a with-trend
    signal".

    D₂ fires with the trend at a perfect 100 and must move neither the numerator
    nor the quality. Excluding it from the denominator while still counting it
    in the numerator would be worse than either mistake alone — it would let a
    with-trend signal earn weight that the denominator says is unavailable, and
    breadth could exceed 1.0.
    """
    clusters = resolved(
        firing(CLUSTER_A, Direction.BUY, 90.0),
        firing(CLUSTER_D2, Direction.BUY, 100.0),
    )

    breakdown = _score(
        clusters,
        regime=Regime.TRENDING_BULLISH,
        direction=Direction.BUY,
        trend=Direction.BUY,
    )

    assert breakdown.numerator == weight_sum(CLUSTER_A)
    assert breakdown.quality == pytest.approx(90.0), "D₂'s 100 must not raise quality"
    assert breakdown.breadth <= 1.0


def test_a_counter_trend_signal_is_scored_against_the_counter_only_pair_alone():
    """§5.2 — the mirror case, and the contested one. See the block comment
    above `test_working_denominators`.

    The approved STAGE1-A01 reading follows §5.2's prose and §5.3.1's table:
    a counter-trend signal's available
    set is D₂ and F, weight 22 — "TRENDING, counter-trend | 22 | 2" clusters
    available, both firing at quality 95 giving breadth 1.0 and a score of 95
    before the penalty. Ordinary ENABLED clusters are with-trend only.
    """
    clusters = all_firing(TRENDING_COUNTER_TREND_CLUSTERS, Direction.SELL, 95.0)

    breakdown = _score(
        clusters,
        regime=Regime.TRENDING_BULLISH,
        direction=Direction.SELL,
        trend=Direction.BUY,
    )

    assert breakdown.denominator == DENOM_TRENDING_COUNTER_TREND
    assert breakdown.numerator == DENOM_TRENDING_COUNTER_TREND
    assert breakdown.breadth == pytest.approx(1.0)


def test_a_suppressed_cluster_contributes_nothing_even_if_it_fires():
    """§3.4: "`SUPPRESSED` means members return `fired=False` regardless of
    pattern."

    Tier 1 gates modules externally (rule 2), so a suppressed cluster should
    never present as fired at all — but the scorer is the second line of that
    defence and must not credit one if it does. G is enabled in RANGING only;
    here it fires a textbook 100 in TRENDING and earns nothing.
    """
    clusters = resolved(
        firing(CLUSTER_A, Direction.BUY, 70.0),
        firing(CLUSTER_G, Direction.BUY, 100.0),
    )

    breakdown = _score(
        clusters,
        regime=Regime.TRENDING_BULLISH,
        direction=Direction.BUY,
        trend=Direction.BUY,
    )

    assert breakdown.numerator == weight_sum(CLUSTER_A)
    assert breakdown.quality == pytest.approx(70.0)


def test_a_cluster_firing_the_other_way_is_not_in_the_firing_set():
    """§5.2: `firing = [c for c in available if c.fired and c.direction ==
    signal_direction]`.

    Opposition belongs to §5.2.1's tally, which is displayed and not scored. It
    must not reach the numerator with a sign flip or be silently dropped from
    the denominator either — the denominator is a property of the regime, not of
    what happened to fire.
    """
    clusters = resolved(
        firing(CLUSTER_A, Direction.BUY, 80.0),
        firing(CLUSTER_B, Direction.SELL, 95.0),
    )

    breakdown = _score(
        clusters,
        regime=Regime.TRENDING_BULLISH,
        direction=Direction.BUY,
        trend=Direction.BUY,
    )

    assert breakdown.numerator == weight_sum(CLUSTER_A)
    assert breakdown.denominator == DENOM_TRENDING_WITH_TREND
    assert breakdown.quality == pytest.approx(80.0)


# ==================================================== breadth, quality, score


def test_breadth_and_quality_are_weight_ratios_not_counts():
    """§5.2's two formulae, on a case where counting and weighting differ.

    A (weight 11) at score 80 and B (weight 12) at 90: breadth is 23/68, not
    2/6, and quality is the weighted mean 85.22, not the arithmetic mean 85.
    §5.1 assigns weight per cluster precisely so that these two answers can
    differ.
    """
    clusters = resolved(
        firing(CLUSTER_A, Direction.BUY, 80.0),
        firing(CLUSTER_B, Direction.BUY, 90.0),
    )

    breakdown = _score(
        clusters,
        regime=Regime.TRENDING_BULLISH,
        direction=Direction.BUY,
        trend=Direction.BUY,
    )

    expected_breadth = (11 + 12) / 68
    expected_quality = (80.0 * 11 + 90.0 * 12) / (11 + 12)

    assert breakdown.breadth == pytest.approx(expected_breadth)
    assert breakdown.quality == pytest.approx(expected_quality)
    assert breakdown.quality != pytest.approx(85.0), "§5.2 — weighted, not arithmetic"
    assert breakdown.breadth != pytest.approx(2 / 6), "§5.2 — weighted, not counted"


def test_the_composite_is_breadth_to_the_alpha_times_quality():
    """§5.2: `score = 100 * (breadth ** ALPHA) * (quality / 100)`.

    §5.3.1 notes this "simplifies to `√breadth × quality`" at ALPHA 0.5, which
    is the form asserted here — 0.3382 breadth and 85.22 quality give 49.56, not
    the 28.8 a plain product of the two normalised terms would give.
    """
    clusters = resolved(
        firing(CLUSTER_A, Direction.BUY, 80.0),
        firing(CLUSTER_B, Direction.BUY, 90.0),
    )

    breakdown = _score(
        clusters,
        regime=Regime.TRENDING_BULLISH,
        direction=Direction.BUY,
        trend=Direction.BUY,
    )

    breadth = 23 / 68
    quality = (80.0 * 11 + 90.0 * 12) / 23
    assert breakdown.score == pytest.approx(100.0 * (breadth**0.5) * (quality / 100.0))
    assert breakdown.score == pytest.approx(49.56, abs=0.01)


def test_quality_is_zero_when_nothing_fires():
    """§5.2: `quality = (...) if firing else 0.0`.

    The guard is in the spec's own snippet because the expression divides by
    `sum(c.weight for c in firing)`. Nothing firing must yield 0.0 — not a
    `ZeroDivisionError`, not `nan`, and not the neutral 50 that would look
    reasonable in the UI and clear a low display threshold.
    """
    breakdown = _score(
        resolved(),
        regime=Regime.TRENDING_BULLISH,
        direction=Direction.BUY,
        trend=Direction.BUY,
    )

    assert breakdown.quality == 0.0
    assert breakdown.breadth == 0.0
    assert breakdown.score == 0.0
    assert breakdown.numerator == 0
    assert breakdown.denominator == DENOM_TRENDING_WITH_TREND


def test_breadth_quality_and_score_are_returned_together():
    """§5.2: "Do not collapse them into one number without keeping both
    visible", and §8.2's display rule — "A score never appears without its
    breadth and quality."

    §13.4 enforces that in the UI through `ScoreDisplay`'s props; the engine
    enforces it by making `ScoreBreakdown` the only return type. The numerator
    and denominator ride along so a rejection can be explained without
    re-deriving the enabled set.
    """
    clusters = all_firing(
        (CLUSTER_A, CLUSTER_B, CLUSTER_C), Direction.BUY, 88.0
    )
    breakdown = _score(
        clusters,
        regime=Regime.TRENDING_BULLISH,
        direction=Direction.BUY,
        trend=Direction.BUY,
    )

    assert 0.0 <= breakdown.breadth <= 1.0
    assert 0.0 <= breakdown.quality <= 100.0
    assert 0.0 <= breakdown.score <= 100.0
    assert breakdown.numerator == weight_sum(CLUSTER_A, CLUSTER_B, CLUSTER_C)
    assert breakdown.denominator == DENOM_TRENDING_WITH_TREND
    assert breakdown.htf_penalty_applied == 1.0


# ================================================== the HTF penalty comes last


def test_the_htf_penalty_is_applied_after_the_formula():
    """§5.2: `score *= htf_alignment_penalty` on the line *after* the composite.

    Order is observable: breadth and quality are reported unpenalised and only
    `score` carries the 0.6. Folding the penalty into quality instead would show
    the operator a counter-bias setup's confirmations as 40% weaker than they
    read on the chart, which is not what §3.5 says — it says the *conviction* is
    lower, not the evidence.

    The signal here is with-trend on its own timeframe and opposes the **bias
    timeframe** (§3.5's H4), which is the axis the penalty actually measures.
    That keeps the case clear of the contested counter-trend denominator noted
    above: breadth 1.0 comes from all six with-trend clusters firing, 68 of 68.
    """
    clusters = all_firing(TRENDING_WITH_TREND_CLUSTERS, Direction.BUY, 100.0)

    breakdown = _score(
        clusters,
        regime=Regime.TRENDING_BULLISH,
        direction=Direction.BUY,
        trend=Direction.BUY,
        penalty=COUNTER_BIAS_PENALTY,
    )

    assert breakdown.denominator == DENOM_TRENDING_WITH_TREND
    assert breakdown.breadth == pytest.approx(1.0), "breadth is not penalised"
    assert breakdown.quality == pytest.approx(100.0), "quality is not penalised"
    assert breakdown.score == pytest.approx(60.0)
    assert breakdown.htf_penalty_applied == COUNTER_BIAS_PENALTY


@pytest.mark.parametrize(
    "quality,expected",
    [
        pytest.param(100.0, 60.0, id="5.2.2-counter_bias_cap-q100_gives_60"),
        pytest.param(95.0, 57.0, id="5.3.1-counter_bias-q95_gives_57"),
        pytest.param(90.0, 54.0, id="5.2.2-counter_bias-q90_gives_54"),
    ],
)
def test_a_counter_bias_signal_caps_at_sixty(quality, expected):
    """§5.2.2: "Counter-trend signals cap at **60**, because §3.5's 0.6 penalty
    is applied after the formula."

    §5.3.1 spells out the consequence: "breadth 1.0 gives 95, then §3.5's 0.6
    penalty takes it to 57 — below even the display threshold. **Counter-trend
    signals cannot auto-execute, arithmetically.**"

    The cap is a property of the penalty and breadth 1.0, not of which clusters
    produced that breadth, so this uses the six with-trend clusters and holds
    whichever way the counter-trend denominator question resolves. The three
    rows are 0.6 × quality, and none of them reaches a 70 display threshold.
    """
    clusters = all_firing(TRENDING_WITH_TREND_CLUSTERS, Direction.BUY, quality)

    breakdown = _score(
        clusters,
        regime=Regime.TRENDING_BULLISH,
        direction=Direction.BUY,
        trend=Direction.BUY,
        penalty=COUNTER_BIAS_PENALTY,
    )

    assert breakdown.breadth == pytest.approx(1.0)
    assert breakdown.score == pytest.approx(expected, abs=0.05)
    assert breakdown.score <= 60.0


# ======================================================== the ceiling is 100


def test_the_ceiling_is_exactly_100():
    """§5.2.2: "**The ceiling is 100, not 99.** Since `score` reduces to
    `√breadth × quality`, breadth 1.0 with quality 100 yields exactly 100. It is
    a real bound, not an asymptote."

    Asserted exactly, not approximately-below — a formula that asymptotes would
    give 99.97 here and nothing downstream would notice.
    """
    clusters = all_firing(TRENDING_WITH_TREND_CLUSTERS, Direction.BUY, 100.0)

    breakdown = _score(
        clusters,
        regime=Regime.TRENDING_BULLISH,
        direction=Direction.BUY,
        trend=Direction.BUY,
    )

    assert breakdown.breadth == pytest.approx(1.0)
    assert breakdown.quality == pytest.approx(100.0)
    assert breakdown.score == pytest.approx(100.0)
    assert breakdown.score <= 100.0


def test_all_six_clusters_firing_is_breadth_one():
    """§5.2 — the six with-trend clusters are the whole denominator, so all six
    firing is breadth 1.0 by construction: 68/68."""
    clusters = all_firing(TRENDING_WITH_TREND_CLUSTERS, Direction.BUY, 90.0)

    breakdown = _score(
        clusters,
        regime=Regime.TRENDING_BULLISH,
        direction=Direction.BUY,
        trend=Direction.BUY,
    )

    assert breakdown.numerator == breakdown.denominator == DENOM_TRENDING_WITH_TREND
    assert breakdown.breadth == pytest.approx(1.0)


# ============================================================ ALPHA's reach


@pytest.mark.parametrize(
    "alpha",
    [
        pytest.param(0.2, id="5.3.2-alpha_0.2-no_effect_at_breadth_1"),
        pytest.param(0.3, id="5.3.2-alpha_0.3-no_effect_at_breadth_1"),
        pytest.param(0.4, id="5.3.2-alpha_0.4-no_effect_at_breadth_1"),
        pytest.param(0.5, id="5.3.2-alpha_0.5-no_effect_at_breadth_1"),
        pytest.param(1.0, id="5.3.2-alpha_1.0-no_effect_at_breadth_1"),
        pytest.param(2.0, id="5.3.2-alpha_2.0-no_effect_at_breadth_1"),
    ],
)
def test_alpha_has_no_effect_when_every_cluster_fires(alpha):
    """§5.3.2: "ALPHA has **no effect at all** on the six-cluster row, since 1.0
    raised to any power is 1.0; it only redistributes the partial-agreement
    band."

    Tuning ALPHA therefore cannot make a full-agreement signal score higher, and
    an operator reaching for it to lift the top of the distribution is reaching
    for the wrong dial.
    """
    clusters = all_firing(TRENDING_WITH_TREND_CLUSTERS, Direction.BUY, 90.0)

    breakdown = _score(
        clusters,
        regime=Regime.TRENDING_BULLISH,
        direction=Direction.BUY,
        trend=Direction.BUY,
        alpha=alpha,
    )

    assert breakdown.score == pytest.approx(90.0)


def test_alpha_does_redistribute_the_partial_agreement_band():
    """§5.3.2 — the other half of the same sentence.

    At three of six clusters, ALPHA 0.3 must score higher than ALPHA 0.5:
    "At ALPHA 0.3 a four-cluster confluence reaches 80 without moving any
    threshold." A test asserting only the no-effect case would pass against an
    implementation that ignored ALPHA entirely.
    """
    clusters = all_firing((CLUSTER_B, CLUSTER_C, CLUSTER_E), Direction.BUY, 90.0)
    common = dict(
        regime=Regime.TRENDING_BULLISH,
        direction=Direction.BUY,
        trend=Direction.BUY,
    )

    at_half = _score(clusters, alpha=0.5, **common)
    at_three_tenths = _score(clusters, alpha=0.3, **common)

    assert at_three_tenths.score > at_half.score
    assert at_three_tenths.breadth == pytest.approx(
        at_half.breadth
    ), "§5.3.2 — ALPHA shapes the mapping, not the measurement"


# ============================================== enabled_in, the three states


@pytest.mark.parametrize(
    "cluster_id,direction,trend,expected",
    [
        pytest.param(
            CLUSTER_D1, Direction.BUY, Direction.BUY, True, id="5.2-enabled_in-ENABLED-with"
        ),
        pytest.param(
            CLUSTER_D1,
            Direction.SELL,
            Direction.BUY,
            False,
            id="5.2-enabled_in-ENABLED-counter",
        ),
        pytest.param(
            CLUSTER_H, Direction.BUY, Direction.BUY, True, id="5.2-enabled_in-ENABLED-H"
        ),
        pytest.param(
            CLUSTER_G,
            Direction.BUY,
            Direction.BUY,
            False,
            id="5.2-enabled_in-SUPPRESSED-with",
        ),
        pytest.param(
            CLUSTER_G,
            Direction.SELL,
            Direction.BUY,
            False,
            id="5.2-enabled_in-SUPPRESSED-counter",
        ),
        pytest.param(
            CLUSTER_D2,
            Direction.BUY,
            Direction.BUY,
            False,
            id="5.2-enabled_in-COUNTER_ONLY-with_trend_excluded",
        ),
        pytest.param(
            CLUSTER_D2,
            Direction.SELL,
            Direction.BUY,
            True,
            id="5.2-enabled_in-COUNTER_ONLY-counter_trend_counts",
        ),
        pytest.param(
            CLUSTER_F,
            Direction.BUY,
            Direction.SELL,
            True,
            id="5.2-enabled_in-COUNTER_ONLY-buy_against_downtrend",
        ),
    ],
)
def test_enabled_in_is_direction_aware(cluster_id, direction, trend, expected):
    """§5.2's `enabled_in`, cell by cell:

        if state == "SUPPRESSED":   return False
        if state == "COUNTER_ONLY": return direction != trend_direction
        if direction != trend_direction: return False
        return True

    The final direction check is the approved STAGE1-A01 reading: the dedicated
    counter-trend denominator contains D2 and F only. The regime here is
    TRENDING_BULLISH for the BUY-trend cases and
    TRENDING_BEARISH for the SELL-trend one, since §3.4's ✅¹ applies to the
    TRENDING row either way it points.
    """
    regime = (
        Regime.TRENDING_BULLISH if trend is Direction.BUY else Regime.TRENDING_BEARISH
    )
    assert (
        enabled_in(regime, cluster_id, direction, trend, REGIME_CLUSTER_MAP) is expected
    )
