"""§5.3.1 and §5.3.2 — what the calibration tables mean for the two thresholds.

`test_score_calibration.py` already asserts every published cell as an output of
§5.2's formula. **This file does not repeat that.** It asserts the other half:
what those numbers do when they meet `display_threshold` and
`auto_execute_threshold` — the per-regime row requirements, the floor
`min_clusters` puts under the dial, the ceiling quality puts over it, and the two
emergent behaviours v2.4 wrote down "rather than left implicit".

    "§5.3.1 gives the thresholds. This gives the shape of the achievable region,
     because **a threshold you can technically configure and never observe is not
     a setting, it is a wall.**"

Two structural notes.

**Cluster COUNT does not determine breadth.** §5.3.1 and §5.3.2 label rows by
count while §5.2's breadth is weight-based, so "4 of 6" spans several breadths.
Where a published *figure* is asserted, the subset is the one
`stage1_doubles.CALIBRATION_ROWS` pins from the published breadth column. Where a
*requirement* is asserted — "4 of 6 clears display 70" — it is asserted over
**every** subset of that size, which is stronger than the table and immune to the
disambiguation question.

**ALPHA and the weights are declared, not read.** §5.3.1: "These figures assume
`ALPHA = 0.5` and the §5.1 hypothesised weights." Reading `config/scoring.yaml`
would couple the published table's regression contract to any future runtime
calibration instead of the approved baseline that produced it.
"""

from __future__ import annotations

from itertools import combinations

import pytest

from backend.contracts import Direction, Regime
from backend.scoring.gate import is_auto_eligible, is_displayed
from backend.scoring.score import compute_breadth_quality_score
from tests.stage1.gate_doubles import (
    AUTO_EXECUTE_THRESHOLD,
    COUNTER_TREND_BEST_SCORE,
    COUNTER_TREND_BEST_SCORE_UNDER_R01_LITERAL,
    DISPLAY_THRESHOLD,
    REJECTED_TRANSITIONAL_UPLIFT,
    scoring_config,
    vote_tally,
)
from tests.stage1.stage1_doubles import (
    ALPHA,
    CALIBRATION_ROWS,
    COUNTER_BIAS_PENALTY,
    CLUSTER_REGISTRY,
    RANGING_CLUSTERS,
    REGIME_CLUSTER_MAP,
    TRANSITIONAL_CLUSTERS,
    TRANSITIONAL_THRESHOLD_UPLIFT,
    TRENDING_COUNTER_TREND_CLUSTERS,
    TRENDING_WITH_TREND_CLUSTERS,
    all_firing,
)

CONFIG = scoring_config()

#: The uplifted TRANSITIONAL display threshold, §5.3.1: "+5 lands it at 75".
TRANSITIONAL_DISPLAY = DISPLAY_THRESHOLD + TRANSITIONAL_THRESHOLD_UPLIFT

#: §5.3's unambiguous comparison: five of six clusters at quality 95 scores
#: 87.7, which clears 80 and does not clear 88.
REJECTED_AUTO_THRESHOLD = 88.0
FIVE_OF_SIX_AT_Q95 = 87.7

#: §5.3.1's per-regime table, "Clusters available" column.
_AVAILABLE = {
    Regime.TRENDING_BULLISH: TRENDING_WITH_TREND_CLUSTERS,  # 6, denominator 68
    Regime.RANGING: RANGING_CLUSTERS,  # 6, denominator 67
    Regime.TRANSITIONAL: TRANSITIONAL_CLUSTERS,  # 5, denominator 57
}

#: The effective display threshold per regime, after §3.4's uplift.
_DISPLAY = {
    Regime.TRENDING_BULLISH: DISPLAY_THRESHOLD,
    Regime.RANGING: DISPLAY_THRESHOLD,
    Regime.TRANSITIONAL: TRANSITIONAL_DISPLAY,
}


def _score(
    clusters,
    regime,
    quality,
    *,
    penalty: float = 1.0,
    direction: Direction = Direction.BUY,
    trend_direction: Direction = Direction.BUY,
) -> float:
    """A candidate in `regime` with every named cluster firing at `quality`.

    Defaults describe the with-trend BUY calibration rows. Counter-trend cases
    state SELL against a BUY trend explicitly.
    """
    return compute_breadth_quality_score(
        all_firing(clusters, direction, quality),
        CLUSTER_REGISTRY,
        regime,
        direction,
        trend_direction,
        REGIME_CLUSTER_MAP,
        ALPHA,
        penalty,
    ).score


# ======================================================= §5.3.1 per-regime table
#
#   | Regime                   | Denominator | Available | Display 70 needs | Auto 80 needs |
#   | TRENDING, with-trend     | 68 | 6 | 4 of 6            | 5 of 6      |
#   | RANGING                  | 67 | 6 | 4 of 6            | 5 of 6      |
#   | TRANSITIONAL             | 57 | 5 | 4 of 5 *(at 75)*  | 4 of 5      |
#   | TRENDING, counter-trend  | 22 | 2 | 2 of 2, ×0.6      | unreachable |


@pytest.mark.parametrize(
    "regime,clusters_needed,expected",
    [
        pytest.param(Regime.TRENDING_BULLISH, 3, False, id="5.3.1-TRENDING-3_of_6-below_display_70"),
        pytest.param(Regime.TRENDING_BULLISH, 4, True, id="5.3.1-TRENDING-4_of_6-clears_display_70"),
        pytest.param(Regime.TRENDING_BULLISH, 5, True, id="5.3.1-TRENDING-5_of_6-clears_display_70"),
        pytest.param(Regime.RANGING, 3, False, id="5.3.1-RANGING-3_of_6-below_display_70"),
        pytest.param(Regime.RANGING, 4, True, id="5.3.1-RANGING-4_of_6-clears_display_70"),
        pytest.param(Regime.RANGING, 5, True, id="5.3.1-RANGING-5_of_6-clears_display_70"),
        pytest.param(Regime.TRANSITIONAL, 3, False, id="5.3.1-TRANSITIONAL-3_of_5-below_uplifted_75"),
        pytest.param(Regime.TRANSITIONAL, 4, True, id="5.3.1-TRANSITIONAL-4_of_5-clears_uplifted_75"),
    ],
)
def test_what_each_regime_needs_to_clear_its_display_threshold(
    regime, clusters_needed, expected
):
    """§5.3.1's per-regime "Display 70 needs" column, at quality 90.

    "Denominators differ per regime (§5.2), so the same threshold means different
    things."

    Asserted over **every** subset of that size rather than one, because the
    published table names a count and §5.2's breadth is weight-based. Every
    four-cluster TRENDING subset lands between 72.4 and 74.8, and every
    three-cluster one between 61.7 and 65.5 — so the row is a real property of
    the count, not an artefact of which four.

    TRANSITIONAL's threshold is the uplifted 75, which is what the table's
    *(at 75)* annotation means.
    """
    available = _AVAILABLE[regime]
    config = scoring_config(display_threshold=DISPLAY_THRESHOLD)

    for subset in combinations(available, clusters_needed):
        score = _score(subset, regime, 90.0)
        assert is_displayed(score, regime, config) is expected, (
            f"{regime.value} {clusters_needed} of {len(available)} "
            f"{subset} scored {score:.2f} against {_DISPLAY[regime]}"
        )


@pytest.mark.parametrize(
    "regime,clusters_needed,expected",
    [
        pytest.param(Regime.TRENDING_BULLISH, 4, False, id="5.3.1-TRENDING-4_of_6-below_auto_80"),
        pytest.param(Regime.TRENDING_BULLISH, 5, True, id="5.3.1-TRENDING-5_of_6-clears_auto_80"),
        pytest.param(Regime.TRENDING_BULLISH, 6, True, id="5.3.1-TRENDING-6_of_6-clears_auto_80"),
        pytest.param(Regime.RANGING, 4, False, id="5.3.1-RANGING-4_of_6-below_auto_80"),
        pytest.param(Regime.RANGING, 5, True, id="5.3.1-RANGING-5_of_6-clears_auto_80"),
        pytest.param(Regime.RANGING, 6, True, id="5.3.1-RANGING-6_of_6-clears_auto_80"),
        pytest.param(Regime.TRANSITIONAL, 3, False, id="5.3.1-TRANSITIONAL-3_of_5-below_auto_80"),
        pytest.param(Regime.TRANSITIONAL, 5, True, id="5.3.1-TRANSITIONAL-5_of_5-clears_auto_80"),
    ],
)
def test_what_each_regime_needs_to_clear_the_auto_threshold(
    regime, clusters_needed, expected
):
    """§5.3.1's per-regime "Auto 80 needs" column, at quality 90, uncontested.

    "80 corresponds to 5 of 6 clusters at quality 90, uncontested, which is a
    defensible bar for unattended execution."

    TRANSITIONAL's membership-dependent 4-of-5 row is asserted separately below.
    """
    available = _AVAILABLE[regime]

    for subset in combinations(available, clusters_needed):
        score = _score(subset, regime, 90.0)
        assert is_auto_eligible(score, vote_tally(), regime, True, CONFIG) is expected, (
            f"{regime.value} {clusters_needed} of {len(available)} "
            f"{subset} scored {score:.2f} against {AUTO_EXECUTE_THRESHOLD}"
        )


_TRANSITIONAL_FOUR_OF_FIVE = [
    pytest.param(
        subset,
        weight,
        weight == 46,
        id=f"5.3.1-TRANSITIONAL-4_of_5-weight_{weight}-"
        + "_".join(subset),
    )
    for subset in combinations(TRANSITIONAL_CLUSTERS, 4)
    for weight in [sum(CLUSTER_REGISTRY.by_id(c).weight for c in subset)]
]


@pytest.mark.parametrize("subset,weight,expected", _TRANSITIONAL_FOUR_OF_FIVE)
def test_transitional_four_of_five_auto_depends_on_weighted_membership(
    subset, weight, expected
):
    """§5.2 exact formula corrects §5.3.1's over-broad “4 of 5” label.

    At quality 90 the three subsets weighing 46/57 score about 80.8507 and
    clear the inclusive AUTO threshold. The two weighing 45/57 score about
    79.9671 and miss it. Eligibility uses the full-precision score; formatting
    a displayed score must never change an execution decision.
    """
    score = _score(subset, Regime.TRANSITIONAL, 90.0)
    expected_score = 90.0 * ((weight / 57.0) ** ALPHA)

    assert score == pytest.approx(expected_score)
    assert (
        is_auto_eligible(
            score,
            vote_tally(),
            Regime.TRANSITIONAL,
            True,
            CONFIG,
        )
        is expected
    )


# ==================================== the ceiling: quality bounds the threshold


@pytest.mark.parametrize(
    "clusters_needed",
    [
        pytest.param(3, id="5.3.1-91_unreachable_at_q90-3_clusters"),
        pytest.param(4, id="5.3.1-91_unreachable_at_q90-4_clusters"),
        pytest.param(5, id="5.3.1-91_unreachable_at_q90-5_clusters"),
        pytest.param(6, id="5.3.1-91_unreachable_at_q90-6_clusters_full_breadth"),
    ],
)
def test_a_threshold_above_the_achievable_quality_shows_nothing_at_any_breadth(
    clusters_needed,
):
    """§5.3.1: "A threshold above the achievable `quality` is **unreachable at any
    breadth**. At quality 90, a threshold of 91 can never be met."

    `test_score_calibration.py` asserts the arithmetic — that `score ≤ quality`.
    This asserts the operational consequence: with the filter at 91 and the
    market topping out at quality 90, the Signal Center is empty. The six-cluster
    row is the only one where it could fail, and it is included for that reason.

    §5.3.1's guidance: "Above 90 the system is effectively off."
    """
    config = scoring_config(display_threshold=91.0)

    for subset in combinations(TRENDING_WITH_TREND_CLUSTERS, clusters_needed):
        score = _score(subset, Regime.TRENDING_BULLISH, 90.0)
        assert is_displayed(score, Regime.TRENDING_BULLISH, config) is False


@pytest.mark.parametrize(
    "clusters_needed",
    [
        pytest.param(3, id="5.3.2-nothing_below_five_reaches_90-3_of_6_at_q100"),
        pytest.param(4, id="5.3.2-nothing_below_five_reaches_90-4_of_6_at_q100"),
    ],
)
def test_nothing_below_five_clusters_is_displayed_at_a_threshold_of_90(clusters_needed):
    """§5.3.2: "**Nothing below five clusters can reach 90 at any quality.**"

    Asserted at a *perfect* quality of 100 and over every subset, so it is a
    structural bound rather than a tendency: four clusters at 100 tops out at
    83.1. A display threshold of 90 therefore does not filter a four-cluster
    confluence, it abolishes it — which is §5.3.1's "raising it from 85 to 90 did
    not filter signals, it stopped them entirely", stated for the current
    default.
    """
    config = scoring_config(display_threshold=90.0)

    for subset in combinations(TRENDING_WITH_TREND_CLUSTERS, clusters_needed):
        score = _score(subset, Regime.TRENDING_BULLISH, 100.0)
        assert is_displayed(score, Regime.TRENDING_BULLISH, config) is False


# ==================================== the floor: min_clusters bounds the dial


@pytest.mark.parametrize(
    "threshold,expected",
    [
        pytest.param(40.0, True, id="5.3.1-min_clusters_floor-a_threshold_of_40_changes_nothing"),
        pytest.param(50.0, True, id="5.3.1-min_clusters_floor-a_threshold_of_50_changes_nothing"),
        pytest.param(61.0, True, id="5.3.1-min_clusters_floor-61_is_still_below_the_floor"),
        pytest.param(62.0, False, id="5.3.1-min_clusters_floor-62_is_the_first_threshold_that_bites"),
    ],
)
def test_min_clusters_puts_a_floor_under_the_score_and_the_dial(threshold, expected):
    """§5.3.1: "The `min_clusters` rule imposes a floor on the score. Three of six
    clusters is breadth ≈ 0.53, so **no emitted signal scores below ≈ 62 in
    TRENDING** regardless of the threshold." Hence: "The dial therefore has real
    travel only between roughly **62 and 93**."

    The consequence is that the bottom of the slider is inert — a display
    threshold of 40, 50 and 61 admit exactly the same signals, and 62 is the
    first setting that removes one. An operator who cannot see that will read a
    dead range as a broken control.

    The three-cluster row is the subset `CALIBRATION_ROWS` pins from §5.3.1's
    published breadth column (36 of 68 = 0.53). Note the floor is a property of
    *that* row rather than of every three-cluster subset: the lightest three
    weigh 32 of 68 and score 58.3 at quality 85. §5.3.1 says "≈ 62", and the
    approximation is doing real work — reported, not resolved.
    """
    floor_row = _score(CALIBRATION_ROWS[3], Regime.TRENDING_BULLISH, 85.0)
    config = scoring_config(display_threshold=threshold)

    assert is_displayed(floor_row, Regime.TRENDING_BULLISH, config) is expected


# ================================================ the auto threshold: 80, not 88


def test_five_at_q95_clears_80_but_not_88():
    """§5.3's unambiguous 80-vs-88 comparison.

    Five clusters at quality 95 score 87.7, so the same uncontested confluence
    is auto-eligible under the shipped threshold and not under the rejected one.
    No assertion is made about the minimum quality required when all six fire.
    """
    five_at_q95 = _score(CALIBRATION_ROWS[5], Regime.TRENDING_BULLISH, 95.0)
    assert five_at_q95 == pytest.approx(FIVE_OF_SIX_AT_Q95, abs=0.1)

    shipped = scoring_config(auto_execute_threshold=AUTO_EXECUTE_THRESHOLD)
    rejected = scoring_config(auto_execute_threshold=REJECTED_AUTO_THRESHOLD)
    tally = vote_tally()

    assert is_auto_eligible(five_at_q95, tally, Regime.TRENDING_BULLISH, True, shipped) is True
    assert is_auto_eligible(five_at_q95, tally, Regime.TRENDING_BULLISH, True, rejected) is False


def test_full_breadth_quality_88_reaches_an_inclusive_threshold_of_88():
    """§5.2's formula corrects §5.3's rejected-threshold arithmetic.

    At full breadth the breadth term is one, so score equals quality. Six
    clusters at quality 88 therefore reach an inclusive threshold of 88;
    quality 95 is not required. Five clusters at quality 95 still miss, as the
    preceding test proves.
    """
    score = _score(
        TRENDING_WITH_TREND_CLUSTERS,
        Regime.TRENDING_BULLISH,
        88.0,
    )
    rejected = scoring_config(auto_execute_threshold=REJECTED_AUTO_THRESHOLD)

    assert score == pytest.approx(REJECTED_AUTO_THRESHOLD)
    assert (
        is_auto_eligible(
            score,
            vote_tally(),
            Regime.TRENDING_BULLISH,
            True,
            rejected,
        )
        is True
    )

# ============================================ TRANSITIONAL: +5 is not +8


@pytest.mark.parametrize(
    "quality,under_five,under_eight",
    [
        pytest.param(85.0, True, False, id="5.3.1-TRANSITIONAL_4_of_5-q85-76.4_clears_75_not_78"),
        pytest.param(90.0, True, True, id="5.3.1-TRANSITIONAL_4_of_5-q90-clears_both"),
    ],
)
def test_the_transitional_uplift_of_five_is_clearable_where_eight_is_not(
    quality, under_five, under_eight
):
    """§5.3.1: "**TRANSITIONAL's uplift is +5, not +8.** At +8 the threshold
    becomes 78, which 4 of 5 clusters cannot reach at quality 85 (76.4) — the
    regime would need 4 of 5 at quality 90+, stricter than TRENDING's 4 of 6 by a
    wide margin."

    Both rows matter. The q85 row is the one +8 breaks; the q90 row is the "the
    regime would need 4 of 5 at quality 90+" clause, and without it the test
    would pass against an implementation that simply hid everything in
    TRANSITIONAL.

    The four-cluster subsets used are the three weighing 46 of 57, which is what
    §5.3.1's published 76.4 pins — the other two weigh 45 and score 75.5.
    """
    shipped = scoring_config(transitional_threshold_uplift=TRANSITIONAL_THRESHOLD_UPLIFT)
    rejected = scoring_config(transitional_threshold_uplift=REJECTED_TRANSITIONAL_UPLIFT)

    subsets = [
        subset
        for subset in combinations(TRANSITIONAL_CLUSTERS, 4)
        if sum(CLUSTER_REGISTRY.by_id(c).weight for c in subset) == 46
    ]
    assert len(subsets) == 3, "the premise: §5.3.1's 76.4 pins the 46-of-57 subsets"

    for subset in subsets:
        score = _score(subset, Regime.TRANSITIONAL, quality)
        assert is_displayed(score, Regime.TRANSITIONAL, shipped) is under_five
        assert is_displayed(score, Regime.TRANSITIONAL, rejected) is under_eight


def test_transitional_stays_stricter_than_trending():
    """§5.3.1: "TRANSITIONAL remains stricter than TRENDING, which is the intent;
    it is no longer accidentally near-prohibitive."

    Both halves are asserted. Stricter: a four-cluster TRENDING confluence at
    quality 90 is displayed, and a score at that level in TRANSITIONAL is not.
    Not prohibitive: TRANSITIONAL's own four-of-five at quality 90 is displayed.
    """
    trending_four = _score(CALIBRATION_ROWS[4], Regime.TRENDING_BULLISH, 90.0)
    transitional_four = _score(TRANSITIONAL_CLUSTERS[:4], Regime.TRANSITIONAL, 90.0)

    assert is_displayed(trending_four, Regime.TRENDING_BULLISH, CONFIG) is True
    assert is_displayed(trending_four, Regime.TRANSITIONAL, CONFIG) is False
    assert is_displayed(transitional_four, Regime.TRANSITIONAL, CONFIG) is True


# ============================================ counter-trend, arithmetically


@pytest.mark.parametrize(
    "quality",
    [
        pytest.param(95.0, id="5.3.1-CONTESTED-counter_trend_q95_gives_57_and_cannot_auto"),
        pytest.param(100.0, id="5.3.1-CONTESTED-counter_trend_q100_gives_60_and_cannot_auto"),
    ],
)
def test_counter_trend_cannot_auto_execute_arithmetically(quality):
    """§5.3.1: "**Counter-trend signals cannot auto-execute, arithmetically.**
    With both clusters firing at quality 95, breadth 1.0 gives 95, then §3.5's
    0.6 penalty takes it to 57 — below even the display threshold. Counter-trend
    setups therefore surface only through the Radar and Signal Center, never as
    auto candidates, and rarely as displayed signals."

    The approved STAGE1-A01 reading fixes the counter-trend denominator at 22,
    following §5.2's prose and §5.3.1's calibration table.
    """
    score = _score(
        TRENDING_COUNTER_TREND_CLUSTERS,
        Regime.TRENDING_BULLISH,
        quality,
        penalty=COUNTER_BIAS_PENALTY,
        direction=Direction.SELL,
        trend_direction=Direction.BUY,
    )

    assert score == pytest.approx(quality * COUNTER_BIAS_PENALTY, abs=0.05)
    assert is_auto_eligible(score, vote_tally(), Regime.TRENDING_BULLISH, True, CONFIG) is False
    assert is_displayed(score, Regime.TRENDING_BULLISH, CONFIG) is False


@pytest.mark.parametrize(
    "score,reading",
    [
        pytest.param(
            COUNTER_TREND_BEST_SCORE,
            "denominator 22 — §5.2 prose and §5.3.1's table",
            id="5.3.1-counter_trend_ineligible-denominator_22_reading-57",
        ),
        pytest.param(
            COUNTER_TREND_BEST_SCORE_UNDER_R01_LITERAL,
            "denominator 90 — §5.2's enabled_in snippet read literally",
            id="5.3.1-counter_trend_ineligible-denominator_90_reading-28.2",
        ),
    ],
)
def test_counter_trend_is_ineligible_under_either_reading(score, reading):
    """§5.3.1's *conclusion*, written so AMBIGUITY-R01 cannot change it.

    The best score a counter-trend signal can produce is 57 under one reading of
    the denominator and 28.2 under the other. Both are below the 70 display
    threshold and far below the 80 auto threshold, so "counter-trend setups
    surface only through the Radar and Signal Center, never as auto candidates"
    holds whichever way R01 is settled.

    Kept separate from the CONTESTED test above so that settling R01 changes one
    test and not the behaviour this file is really about.
    """
    assert is_displayed(score, Regime.TRENDING_BULLISH, CONFIG) is False
    assert is_auto_eligible(score, vote_tally(), Regime.TRENDING_BULLISH, True, CONFIG) is False


def test_a_counter_trend_signal_needs_a_threshold_below_the_noise_band_to_be_seen():
    """§5.3.1: "below even the display threshold [...] and rarely as displayed
    signals."

    The operator-facing consequence: surfacing counter-trend signals in the
    default views means dropping `display_threshold` to 57 or lower, which
    §5.3.1's guidance calls near-noise — "62–68 is near-noise and exists mainly
    for the journal". So the choice is not a slider setting, it is the Radar and
    the Signal Center, exactly as §5.3.1 says.
    """
    best = COUNTER_TREND_BEST_SCORE  # 57, §5.3.1

    assert is_displayed(best, Regime.TRENDING_BULLISH, scoring_config(display_threshold=62.0)) is False
    assert is_displayed(best, Regime.TRENDING_BULLISH, scoring_config(display_threshold=57.0)) is True
