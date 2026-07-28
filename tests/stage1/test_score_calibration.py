"""§5.3.1 and §5.3.2's published tables, as assertions about §5.2's formula.

These tables are the only place the spec states what its own arithmetic
produces, which makes them the closest thing to a golden file the scoring layer
has. They are tested here rather than with §5.3's gate because every number in
them is an output of `compute_breadth_quality_score`, not of a threshold.

    "**These figures assume `ALPHA = 0.5` and the §5.1 hypothesised weights.**
     The Stage 2 co-firing measurement will change the weights and therefore
     this whole table. Regenerating it is part of that task, not an afterthought
     — a stale calibration table is worse than none, because the operator will
     trust it."

So this file pins ALPHA to 0.5 and the weights to §5.1's table, both from
`stage1_doubles`, and never reads `config/`. When Stage 2 re-measures the
weights, these tests are *supposed* to fail — that failure is the reminder to
regenerate the table.

One transcription note. §5.3.1 and §5.3.2 label their rows by cluster COUNT
while §5.2's breadth is weight-based, so "4 of 6" does not by itself determine a
breadth. The published breadth column disambiguates: 0.53, 0.69 and 0.85 are
each produced by exactly one subset of the six TRENDING with-trend weights (36,
47 and 58 of 68). Every test below asserts the published breadth first, so a
wrong subset fails on the breadth line rather than shifting the score by two
points and looking like a formula error.
"""

from __future__ import annotations

import pytest

from backend.contracts import Direction, Regime
from backend.scoring.score import compute_breadth_quality_score
from tests.stage1.stage1_doubles import (
    ALPHA,
    CALIBRATION_BREADTH,
    CALIBRATION_ROWS,
    CLUSTER_A,
    CLUSTER_B,
    CLUSTER_C,
    CLUSTER_D1,
    CLUSTER_E,
    CLUSTER_H,
    CLUSTER_REGISTRY,
    DENOM_TRENDING_WITH_TREND,
    REGIME_CLUSTER_MAP,
    all_firing,
)


def _trending_score(cluster_ids, quality, alpha=ALPHA):
    """Score a with-trend BUY in TRENDING with every named cluster firing at
    `quality`. Denominator 68 throughout, per §5.2."""
    return compute_breadth_quality_score(
        all_firing(cluster_ids, Direction.BUY, quality),
        CLUSTER_REGISTRY,
        Regime.TRENDING_BULLISH,
        Direction.BUY,
        Direction.BUY,
        REGIME_CLUSTER_MAP,
        alpha,
        1.0,
    )


def _row(cluster_count, quality, alpha=ALPHA):
    return _trending_score(CALIBRATION_ROWS[cluster_count], quality, alpha)


# ================================================== §5.3.1 threshold calibration
#
#   Scores in TRENDING (denominator 68), by cluster count:
#
#   | Clusters agreeing            | Breadth | q85  | q90  | q93  |
#   | 3 (the min_clusters floor)   | 0.53    | 61.8 | 65.5 | 67.7 |
#   | 4                            | 0.69    | 70.7 | 74.8 | 77.3 |
#   | 5                            | 0.85    | 78.5 | 83.1 | 85.9 |
#   | 6 (all enabled)              | 1.00    | 85.0 | 90.0 | 93.0 |


@pytest.mark.parametrize(
    "clusters,quality,expected",
    [
        pytest.param(3, 85.0, 61.8, id="5.3.1-3_clusters-q85-61.8"),
        pytest.param(3, 90.0, 65.5, id="5.3.1-3_clusters-q90-65.5"),
        pytest.param(3, 93.0, 67.7, id="5.3.1-3_clusters-q93-67.7"),
        pytest.param(4, 85.0, 70.7, id="5.3.1-4_clusters-q85-70.7"),
        pytest.param(4, 90.0, 74.8, id="5.3.1-4_clusters-q90-74.8"),
        pytest.param(4, 93.0, 77.3, id="5.3.1-4_clusters-q93-77.3"),
        pytest.param(5, 85.0, 78.5, id="5.3.1-5_clusters-q85-78.5"),
        pytest.param(5, 90.0, 83.1, id="5.3.1-5_clusters-q90-83.1"),
        pytest.param(5, 93.0, 85.9, id="5.3.1-5_clusters-q93-85.9"),
        pytest.param(6, 85.0, 85.0, id="5.3.1-6_clusters-q85-85.0"),
        pytest.param(6, 90.0, 90.0, id="5.3.1-6_clusters-q90-90.0"),
        pytest.param(6, 93.0, 93.0, id="5.3.1-6_clusters-q93-93.0"),
    ],
)
def test_threshold_calibration_table(clusters, quality, expected):
    """§5.3.1's table, one test per cell, to one decimal place as published."""
    breakdown = _row(clusters, quality)

    assert breakdown.denominator == DENOM_TRENDING_WITH_TREND
    assert breakdown.breadth == pytest.approx(CALIBRATION_BREADTH[clusters], abs=0.005)
    assert breakdown.quality == pytest.approx(quality)
    assert breakdown.score == pytest.approx(expected, abs=0.05)


def test_the_min_clusters_floor_puts_a_floor_under_the_score():
    """§5.3.1: "The `min_clusters` rule imposes a floor on the score. Three of
    six clusters is breadth ≈ 0.53, so **no emitted signal scores below ≈ 62 in
    TRENDING** regardless of the threshold."

    Which is why "the dial therefore has real travel only between roughly 62 and
    93" — a display threshold of 55 is indistinguishable from one of 62.
    """
    breakdown = _row(3, 85.0)
    assert breakdown.score == pytest.approx(62.0, abs=0.5)


def test_a_threshold_above_the_achievable_quality_is_unreachable():
    """§5.3.1: "A threshold above the achievable `quality` is **unreachable at
    any breadth**. At quality 90, a threshold of 91 can never be met."

    Follows from `score = √breadth × quality` with breadth ≤ 1, and is asserted
    at the only breadth where it could fail — 1.0, every cluster firing.
    """
    at_full_breadth = _row(6, 90.0)
    assert at_full_breadth.breadth == pytest.approx(1.0)
    assert at_full_breadth.score == pytest.approx(90.0)
    assert at_full_breadth.score < 91.0


@pytest.mark.parametrize(
    "clusters",
    [
        pytest.param(3, id="5.3.1-score_never_exceeds_quality-3_clusters"),
        pytest.param(4, id="5.3.1-score_never_exceeds_quality-4_clusters"),
        pytest.param(5, id="5.3.1-score_never_exceeds_quality-5_clusters"),
        pytest.param(6, id="5.3.1-score_never_exceeds_quality-6_clusters"),
    ],
)
def test_score_never_exceeds_quality(clusters):
    """§5.3.1 — the general form of the unreachability rule.

    `breadth ** ALPHA ≤ 1` for any breadth in 0..1 and any positive ALPHA, so
    breadth can only ever discount quality, never amplify it. An implementation
    that normalised breadth to a 1.0-centred multiplier would break this and
    would look right in the six-cluster row.
    """
    quality = 93.0
    breakdown = _row(clusters, quality)
    assert breakdown.score <= quality + 1e-9


# ==================================================== §5.3.2 reachability
#
#   Resulting score in TRENDING (denominator 68, ALPHA 0.5):
#
#   | Clusters | Breadth | q80 | q85 | q90 | q95 | q100 |
#   | 3 of 6   | 0.53    |  58 |  62 |  65 |  69 |   73 |
#   | 4 of 6   | 0.69    |  67 |  71 |  75 |  79 |   83 |
#   | 5 of 6   | 0.85    |  74 |  79 |  83 |  88 |   92 |
#   | 6 of 6   | 1.00    |  80 |  85 |  90 |  95 |  100 |


@pytest.mark.parametrize(
    "clusters,quality,expected",
    [
        pytest.param(3, 80.0, 58, id="5.3.2-3_of_6-q80-58"),
        pytest.param(3, 85.0, 62, id="5.3.2-3_of_6-q85-62"),
        pytest.param(3, 90.0, 65, id="5.3.2-3_of_6-q90-65"),
        pytest.param(3, 95.0, 69, id="5.3.2-3_of_6-q95-69"),
        pytest.param(3, 100.0, 73, id="5.3.2-3_of_6-q100-73"),
        pytest.param(4, 80.0, 67, id="5.3.2-4_of_6-q80-67"),
        pytest.param(4, 85.0, 71, id="5.3.2-4_of_6-q85-71"),
        pytest.param(4, 90.0, 75, id="5.3.2-4_of_6-q90-75"),
        pytest.param(4, 95.0, 79, id="5.3.2-4_of_6-q95-79"),
        pytest.param(4, 100.0, 83, id="5.3.2-4_of_6-q100-83"),
        pytest.param(5, 80.0, 74, id="5.3.2-5_of_6-q80-74"),
        pytest.param(5, 85.0, 79, id="5.3.2-5_of_6-q85-79"),
        pytest.param(5, 90.0, 83, id="5.3.2-5_of_6-q90-83"),
        pytest.param(5, 95.0, 88, id="5.3.2-5_of_6-q95-88"),
        pytest.param(5, 100.0, 92, id="5.3.2-5_of_6-q100-92"),
        pytest.param(6, 80.0, 80, id="5.3.2-6_of_6-q80-80"),
        pytest.param(6, 85.0, 85, id="5.3.2-6_of_6-q85-85"),
        pytest.param(6, 90.0, 90, id="5.3.2-6_of_6-q90-90"),
        pytest.param(6, 95.0, 95, id="5.3.2-6_of_6-q95-95"),
        pytest.param(6, 100.0, 100, id="5.3.2-6_of_6-q100-100"),
    ],
)
def test_reachability_table(clusters, quality, expected):
    """§5.3.2's table, one test per cell, to the nearest whole point as
    published. "A threshold you can technically configure and never observe is
    not a setting, it is a wall." """
    breakdown = _row(clusters, quality)

    assert breakdown.breadth == pytest.approx(CALIBRATION_BREADTH[clusters], abs=0.005)
    assert round(breakdown.score) == expected


@pytest.mark.parametrize(
    "clusters,quality,target",
    [
        pytest.param(4, 96.0, 80, id="5.3.2-to_reach_80-4_clusters_need_q96"),
        pytest.param(5, 87.0, 80, id="5.3.2-to_reach_80-5_clusters_need_q87"),
        pytest.param(6, 80.0, 80, id="5.3.2-to_reach_80-6_clusters_need_q80"),
        pytest.param(5, 97.5, 90, id="5.3.2-to_reach_90-5_clusters_need_q97.5"),
        pytest.param(6, 90.0, 90, id="5.3.2-to_reach_90-6_clusters_need_q90"),
    ],
)
def test_what_a_threshold_costs_in_clusters_and_quality(clusters, quality, target):
    """§5.3.2: "**To reach 80:** four clusters need quality 96, five need 87,
    six need 80. **To reach 90:** five clusters need quality 97.5, six need 90."

    These are the numbers that tell the operator what `auto_execute_threshold`
    is actually asking of the market. Asserted to half a point, which is the
    precision the sentence is written to.
    """
    breakdown = _row(clusters, quality)
    assert breakdown.score == pytest.approx(target, abs=0.5)


def test_nothing_below_five_clusters_can_reach_90():
    """§5.3.2: "**Nothing below five clusters can reach 90 at any quality.**"

    Four clusters at a perfect 100 tops out at 83. This is a hard structural
    bound, not a tendency, so it is asserted strictly rather than approximately
    — and it is the sentence that makes a display threshold above 90 equivalent
    to switching the system off.
    """
    four_at_perfect_quality = _row(4, 100.0)
    assert four_at_perfect_quality.score < 90.0
    assert round(four_at_perfect_quality.score) == 83

    three_at_perfect_quality = _row(3, 100.0)
    assert three_at_perfect_quality.score < 90.0


def test_neither_archetype_reaches_eighty_on_its_own():
    """§5.3.2: "A clean pullback fires A, B, C and E — four clusters, ~75 at
    quality 90. A clean breakout fires D₁, H and part of E — three clusters,
    ~65. **Neither archetype reaches 80 on its own.**"

    This is the structural claim underneath "80+ should be uncommon and 90+
    genuinely rare": the TRENDING enabled set contains clusters describing
    opposite price behaviour — returning to a level (A, B, C) and leaving with
    force (D₁, H) — so five- or six-cluster agreement requires a break-and-retest
    with the break still fresh.

    Only the "neither reaches 80" claim is asserted strictly. The pullback's ~75
    is asserted too, since A+B+C+E is exactly the 47/68 row. The breakout's ~65
    is not: D₁+H+E weighs 33, not the 36 the three-cluster row assumes, so the
    published ~65 and the arithmetic's ~63 disagree — reported, not resolved.
    """
    pullback = _trending_score((CLUSTER_A, CLUSTER_B, CLUSTER_C, CLUSTER_E), 90.0)
    breakout = _trending_score((CLUSTER_D1, CLUSTER_H, CLUSTER_E), 90.0)

    assert pullback.score == pytest.approx(75.0, abs=0.5)
    assert pullback.score < 80.0
    assert breakout.score < 80.0
    assert breakout.score < pullback.score


# ============================================== §5.3.2 the ALPHA tuning table
#
#   Scores at quality 90:
#
#   | ALPHA          | 3 clusters | 4 clusters | 5 clusters | 6 clusters |
#   | 0.5 (default)  |         65 |         75 |         83 |         90 |
#   | 0.4            |         70 |         78 |         84 |         90 |
#   | 0.3            |         74 |         81 |         86 |         90 |
#   | 0.2            |         79 |         84 |         87 |         90 |


@pytest.mark.parametrize(
    "alpha,clusters,expected",
    [
        pytest.param(0.5, 3, 65, id="5.3.2-alpha0.5-3_clusters-65"),
        pytest.param(0.5, 4, 75, id="5.3.2-alpha0.5-4_clusters-75"),
        pytest.param(0.5, 5, 83, id="5.3.2-alpha0.5-5_clusters-83"),
        pytest.param(0.5, 6, 90, id="5.3.2-alpha0.5-6_clusters-90"),
        pytest.param(0.4, 3, 70, id="5.3.2-alpha0.4-3_clusters-70"),
        pytest.param(0.4, 4, 78, id="5.3.2-alpha0.4-4_clusters-78"),
        pytest.param(0.4, 5, 84, id="5.3.2-alpha0.4-5_clusters-84"),
        pytest.param(0.4, 6, 90, id="5.3.2-alpha0.4-6_clusters-90"),
        pytest.param(0.3, 3, 74, id="5.3.2-alpha0.3-3_clusters-74"),
        pytest.param(0.3, 4, 81, id="5.3.2-alpha0.3-4_clusters-81"),
        pytest.param(0.3, 5, 86, id="5.3.2-alpha0.3-5_clusters-86"),
        pytest.param(0.3, 6, 90, id="5.3.2-alpha0.3-6_clusters-90"),
        pytest.param(0.2, 3, 79, id="5.3.2-alpha0.2-3_clusters-79"),
        pytest.param(0.2, 4, 84, id="5.3.2-alpha0.2-4_clusters-84"),
        pytest.param(0.2, 5, 87, id="5.3.2-alpha0.2-5_clusters-87"),
        pytest.param(0.2, 6, 90, id="5.3.2-alpha0.2-6_clusters-90"),
    ],
)
def test_alpha_tuning_table(alpha, clusters, expected):
    """§5.3.2's ALPHA table at quality 90, one test per cell.

    "**Recommendation:** hold ALPHA at 0.5 through Stage 1, plot the realised
    score distribution over a year of replay, and set it from that." The table
    is what that decision is made against, so it has to be reproducible.
    """
    breakdown = _row(clusters, 90.0, alpha=alpha)
    assert round(breakdown.score) == expected


def test_lowering_alpha_erodes_the_distinction_the_clustering_layer_draws():
    """§5.3.2: "At ALPHA 0.2, three clusters score 79 against five clusters' 87,
    and the distinction the whole scoring layer was built to draw begins to
    disappear."

    The gap between three-cluster and five-cluster agreement narrows from 18
    points at ALPHA 0.5 to 8 at ALPHA 0.2. That is the trade-off the operator is
    accepting, stated as an assertion rather than as prose.
    """
    gap_at_half = _row(5, 90.0, alpha=0.5).score - _row(3, 90.0, alpha=0.5).score
    gap_at_fifth = _row(5, 90.0, alpha=0.2).score - _row(3, 90.0, alpha=0.2).score

    assert gap_at_half == pytest.approx(18.0, abs=1.0)
    assert gap_at_fifth == pytest.approx(8.0, abs=1.0)
    assert gap_at_fifth < gap_at_half
