"""§5.2.1 Vote tally — both sides of the argument, and §5.2.2 FLAT mode.

    "`score` describes only the winning side. A setup where four clusters say
     SELL and none say BUY, and one where four say SELL and one says BUY at
     strength 96, produce an identical score. **They are not the same trade.**"

    def tally(clusters, regime, trend_direction) -> VoteTally:
        buy  = [c for c in clusters if c.fired and c.direction == Direction.BUY
                and enabled_in(regime, c, Direction.BUY,  trend_direction)]
        sell = [c for c in clusters if c.fired and c.direction == Direction.SELL
                and enabled_in(regime, c, Direction.SELL, trend_direction)]
        pts  = lambda cs: sum(c.score * c.weight for c in cs) / 10.0
        return VoteTally(
            buy_votes=len(buy),   buy_points=pts(buy),
            sell_votes=len(sell), sell_points=pts(sell),
            contested=bool(buy) and bool(sell),
            leading_contributor=max(buy + sell, key=lambda c: c.score).top_module,
        )

    "The tally is **displayed, not scored** — it does not modify `score`."
"""

from __future__ import annotations

import pytest

from backend.contracts import Direction, Regime
from backend.scoring.score import compute_breadth_quality_score, flat_score, tally
from tests.stage1.stage1_doubles import (
    ALPHA,
    CLUSTER_A,
    CLUSTER_B,
    CLUSTER_C,
    CLUSTER_D2,
    CLUSTER_E,
    CLUSTER_G,
    CLUSTER_REGISTRY,
    MODULES_OF,
    REGIME_CLUSTER_MAP,
    WEIGHTS,
    firing,
    module_result,
    resolved,
    weight_sum,
)


def _tally(clusters, *, regime=Regime.RANGING, trend=Direction.NONE):
    return tally(clusters, CLUSTER_REGISTRY, regime, trend, REGIME_CLUSTER_MAP)


def _score(clusters, *, regime, direction, trend=Direction.NONE):
    return compute_breadth_quality_score(
        clusters,
        CLUSTER_REGISTRY,
        regime,
        direction,
        trend,
        REGIME_CLUSTER_MAP,
        ALPHA,
        1.0,
    )


#: §5.2.1's rendered example — "BUY — 1 vote / 96 pts | SELL — 4 votes / 296
#: pts". Cluster G weighs 10, so a single G firing at 96 is exactly 96 points,
#: which is where the dissenting-vote fixture below comes from.
DISSENTER = firing(
    CLUSTER_G, Direction.BUY, 96.0, modules=(25,), top_module="VWAP Deviation Touch"
)

_SELL_BLOC = (
    firing(CLUSTER_A, Direction.SELL, 70.0, modules=(1,), top_module="Bearish FVG Fill"),
    firing(CLUSTER_B, Direction.SELL, 68.0, modules=(4,), top_module="Bearish Order Block"),
    firing(
        CLUSTER_C, Direction.SELL, 72.0, modules=(6,), top_module="Buy-Side Liquidity Sweep"
    ),
    firing(
        CLUSTER_D2, Direction.SELL, 66.0, modules=(7,), top_module="Change of Character"
    ),
)


# ================================= a 4-vs-0 and a 4-vs-1 are not the same trade


def test_four_versus_zero_and_four_versus_one_differ():
    """§5.2.1's entire motivation, asserted as object inequality.

    Both setups produce the same `score`, because §5.2 only ever counts the
    winning direction. The `VoteTally` is what carries the difference, and if
    the two tallies compare equal then the section has been implemented as a
    field nobody reads.
    """
    four_vs_zero = _tally(resolved(*_SELL_BLOC))
    four_vs_one = _tally(resolved(*_SELL_BLOC, DISSENTER))

    assert four_vs_zero != four_vs_one

    assert four_vs_zero.sell_votes == four_vs_one.sell_votes == 4
    assert four_vs_zero.buy_votes == 0
    assert four_vs_one.buy_votes == 1
    assert four_vs_zero.contested is False
    assert four_vs_one.contested is True


def test_the_dissenting_side_does_not_change_the_winning_sides_numbers():
    """§5.2.1 — the tally reports both sides; it does not net them off.

    The SELL side reads identically whether or not a BUY vote exists. Netting
    would be a second, undocumented scoring rule sitting behind a display
    field.
    """
    uncontested = _tally(resolved(*_SELL_BLOC))
    contested = _tally(resolved(*_SELL_BLOC, DISSENTER))

    assert contested.sell_votes == uncontested.sell_votes
    assert contested.sell_points == pytest.approx(uncontested.sell_points)


# ============================================================== contested


@pytest.mark.parametrize(
    "buy_clusters,sell_clusters,expected",
    [
        pytest.param((), (), False, id="5.2.1-contested-0_vs_0-False"),
        pytest.param((CLUSTER_A,), (), False, id="5.2.1-contested-1_vs_0-False"),
        pytest.param((), (CLUSTER_A,), False, id="5.2.1-contested-0_vs_1-False"),
        pytest.param((CLUSTER_A,), (CLUSTER_B,), True, id="5.2.1-contested-1_vs_1-True"),
        pytest.param(
            (CLUSTER_G,),
            (CLUSTER_A, CLUSTER_B, CLUSTER_C, CLUSTER_D2),
            True,
            id="5.2.1-contested-1_vs_4-True",
        ),
    ],
)
def test_contested_is_true_iff_both_sides_have_a_vote(
    buy_clusters, sell_clusters, expected
):
    """§2: `contested: bool  # both sides have ≥1 vote`, and §5.2.1's
    `contested=bool(buy) and bool(sell)`.

    §5.3 reads this and nothing else: "A `contested` tally makes a signal
    **auto-ineligible regardless of score** — if the strongest single reading on
    the chart argues the other way, that is a decision for a person." A
    threshold-based approximation of contested — say, opposition worth more than
    N points — would let a 96-strength dissent through on a technicality.
    """
    clusters = resolved(
        *(firing(cid, Direction.BUY, 80.0) for cid in buy_clusters),
        *(firing(cid, Direction.SELL, 80.0) for cid in sell_clusters),
    )
    votes = _tally(clusters)

    assert votes.contested is expected
    assert votes.buy_votes == len(buy_clusters)
    assert votes.sell_votes == len(sell_clusters)


# ================================================================== points


def test_points_are_score_times_weight_over_ten():
    """§5.2.1: `pts = lambda cs: sum(c.score * c.weight for c in cs) / 10.0`,
    and §2: "Σ (cluster score × weight) / 10".

    Cluster A weighs 11 and B weighs 12, so 90 and 80 give (990 + 960)/10 =
    195.0 — not 85 (the mean), not 170 (score×count/10) and not 1950 (the
    divisor dropped). Points exist to make the two sides comparable at a glance
    in §5.2.1's rendered line, so the scale has to be stable.
    """
    clusters = resolved(
        firing(CLUSTER_A, Direction.SELL, 90.0),
        firing(CLUSTER_B, Direction.SELL, 80.0),
    )
    votes = _tally(clusters)

    assert votes.sell_points == pytest.approx((90.0 * 11 + 80.0 * 12) / 10.0)
    assert votes.sell_points == pytest.approx(195.0)
    assert votes.buy_points == 0.0


def test_a_single_cluster_of_weight_ten_at_96_is_96_points():
    """§5.2.1's rendered example: "`BUY — 1 vote / 96 pts | SELL — 4 votes /
    296 pts`"."""
    votes = _tally(resolved(DISSENTER))
    assert votes.buy_votes == 1
    assert votes.buy_points == pytest.approx(96.0)


def test_votes_count_clusters_not_modules():
    """§5.1.1: "cluster E is five modules and one vote, cluster F is one module
    and one vote, and neither is worth more for having more parts."

    E holds five modules and A holds three; two clusters firing is two votes,
    not eight. A tally counting modules would reproduce exactly the inflation
    §5.2.2 says FLAT mode suffers from, in the field the operator looks at to
    decide.
    """
    clusters = resolved(
        firing(CLUSTER_A, Direction.BUY, 80.0, modules=MODULES_OF[CLUSTER_A]),
        firing(CLUSTER_E, Direction.BUY, 80.0, modules=MODULES_OF[CLUSTER_E]),
    )
    votes = _tally(clusters, regime=Regime.TRENDING_BULLISH, trend=Direction.BUY)

    assert len(MODULES_OF[CLUSTER_A]) + len(MODULES_OF[CLUSTER_E]) == 8
    assert votes.buy_votes == 2


# ==================================================== leading_contributor


def test_the_leading_contributor_can_be_the_dissenting_vote():
    """§5.2.1: "The user needs to see that the one dissenting vote is **the
    strongest single reading on the chart**."

    `leading_contributor` is `max(buy + sell, ...)` — across BOTH sides. An
    implementation that took the maximum of the winning side would report a 72
    while a 96 argued the other way, which inverts the meaning of the field the
    §5.3 auto-ineligibility rule is justified by.
    """
    clusters = resolved(*_SELL_BLOC, DISSENTER)
    votes = _tally(clusters)

    assert votes.sell_votes == 4
    assert votes.buy_votes == 1
    assert DISSENTER.score > max(c.score for c in _SELL_BLOC)
    assert votes.leading_contributor == DISSENTER.top_module


def test_the_leading_contributor_is_the_winning_side_when_it_is_strongest():
    """§5.2.1 — the same rule with the maximum on the other side.

    Asserted so the previous test cannot be satisfied by an implementation that
    always reports the losing side.
    """
    strong_sell = firing(
        CLUSTER_C, Direction.SELL, 99.0, modules=(15,), top_module="Pinbar Exhaustion"
    )
    clusters = resolved(
        firing(CLUSTER_A, Direction.SELL, 70.0),
        strong_sell,
        firing(CLUSTER_G, Direction.BUY, 80.0),
    )
    votes = _tally(clusters)

    assert votes.contested is True
    assert votes.leading_contributor == strong_sell.top_module


# ============================ each side is filtered with its OWN direction


def test_a_counter_only_cluster_appears_on_the_counter_trend_side_only():
    """§5.2.1: each side is filtered by `enabled_in` with **its own direction** —
    `enabled_in(regime, c, Direction.BUY, trend)` for the buy side and
    `enabled_in(regime, c, Direction.SELL, trend)` for the sell side.

    In TRENDING with a BUY trend, D₂ is ✅¹. Firing BUY it is invisible; firing
    SELL it is a vote. Passing one direction to both sides collapses this and
    either silences every early-reversal warning or lets D₂ add conviction to
    the trend it is warning about.
    """
    with_trend = resolved(
        firing(CLUSTER_A, Direction.BUY, 80.0),
        firing(CLUSTER_D2, Direction.BUY, 90.0),
    )
    against_trend = resolved(
        firing(CLUSTER_A, Direction.BUY, 80.0),
        firing(CLUSTER_D2, Direction.SELL, 90.0),
    )

    trending = dict(regime=Regime.TRENDING_BULLISH, trend=Direction.BUY)

    suppressed_side = _tally(with_trend, **trending)
    assert suppressed_side.buy_votes == 1, "§3.4 ✅¹ — D₂ cannot back the trend"
    assert suppressed_side.buy_points == pytest.approx(80.0 * WEIGHTS[CLUSTER_A] / 10.0)
    assert suppressed_side.contested is False

    counter_side = _tally(against_trend, **trending)
    assert counter_side.buy_votes == 1
    assert counter_side.sell_votes == 1, "§3.4 ✅¹ — D₂ may warn against the trend"
    assert counter_side.sell_points == pytest.approx(90.0 * WEIGHTS[CLUSTER_D2] / 10.0)
    assert counter_side.contested is True


def test_a_suppressed_cluster_votes_on_neither_side():
    """§5.2.1 filters both sides through `enabled_in`, so §3.4's ⛔ applies to
    the tally as well as to the score. G is suppressed in TRENDING."""
    clusters = resolved(
        firing(CLUSTER_A, Direction.BUY, 80.0),
        firing(CLUSTER_G, Direction.SELL, 95.0),
    )
    votes = _tally(clusters, regime=Regime.TRENDING_BULLISH, trend=Direction.BUY)

    assert votes.sell_votes == 0
    assert votes.sell_points == 0.0
    assert votes.contested is False


# ================================================ displayed, NOT scored


def test_the_tally_does_not_modify_the_score():
    """§5.2.1: "The tally is **displayed, not scored** — it does not modify
    `score`. Folding opposition into the composite would double-count the regime
    gate, which has already suppressed the clusters that should not be
    speaking."

    Same SELL clusters, once alone and once with a 96-strength BUY dissent
    beside them. Every field of the `ScoreBreakdown` is identical, and computing
    the tally in between changes nothing — §5.3's `contested` flag is where the
    dissent is allowed to act, and it acts on eligibility, not on the number.
    """
    sell_bloc = (
        firing(CLUSTER_A, Direction.SELL, 85.0),
        firing(CLUSTER_B, Direction.SELL, 85.0),
        firing(CLUSTER_C, Direction.SELL, 85.0),
    )
    uncontested = resolved(*sell_bloc)
    contested = resolved(*sell_bloc, DISSENTER)

    before = _score(uncontested, regime=Regime.RANGING, direction=Direction.SELL)

    votes = _tally(contested)
    assert votes.contested is True

    after = _score(contested, regime=Regime.RANGING, direction=Direction.SELL)

    assert after == before
    assert after.score == before.score
    assert after.breadth == before.breadth
    assert after.quality == before.quality
    assert after.numerator == weight_sum(CLUSTER_A, CLUSTER_B, CLUSTER_C)


def test_an_empty_tally_counts_nothing():
    """§5.2.1 over a bar where nothing fired.

    §5.3 constructs a `Signal` "whenever a direction resolves" and §2 makes
    `TimeframeState.votes` mandatory, so this object is built on quiet bars too.
    Votes and points must be zero and `contested` False.

    `leading_contributor` is deliberately NOT asserted: §5.2.1's `max(buy +
    sell, ...)` has no defined value over an empty sequence and §2 types the
    field as a required `str`. Reported as an open question, not answered here.
    """
    votes = _tally(resolved())

    assert votes.buy_votes == 0
    assert votes.sell_votes == 0
    assert votes.buy_points == 0.0
    assert votes.sell_points == 0.0
    assert votes.contested is False


# ================================================= §5.2.2 FLAT compatibility


def test_flat_mode_ignores_cluster_membership():
    """§5.2.2: "`FLAT` weights every module equally and **skips the §5.1
    collapse**, reproducing the behaviour of tools that score by raw module
    count."

    Five modules drawn from a single cluster and five drawn from five different
    clusters must produce the same FLAT score. Under CLUSTERED they differ
    enormously — one cluster firing versus five — and that difference is the
    entire value of §5.1. FLAT exists so the two can be compared on the same
    history in the Backtester, which requires it to genuinely not look at
    clusters.
    """
    one_cluster = [
        module_result(module_id, Direction.BUY, 90.0)
        for module_id in MODULES_OF[CLUSTER_E]  # 17, 18, 19, 21, 22 — all cluster E
    ]
    five_clusters = [
        module_result(module_id, Direction.BUY, 90.0)
        for module_id in (1, 3, 5, 8, 17)  # clusters A, B, C, D₁, E
    ]
    assert len(one_cluster) == len(five_clusters) == 5

    assert flat_score(one_cluster, Direction.BUY) == pytest.approx(
        flat_score(five_clusters, Direction.BUY)
    )


def test_flat_mode_counts_only_modules_agreeing_with_the_direction():
    """§5.2.2 — `flat_score` takes a direction, so opposition and silence do not
    score. Without this the mode is a module census rather than a score."""
    all_buy = [module_result(m, Direction.BUY, 90.0) for m in (1, 3, 5, 8, 17)]

    assert flat_score(all_buy, Direction.SELL) < flat_score(all_buy, Direction.BUY)


def test_flat_mode_shares_the_hundred_point_scale():
    """§5.2.2: "treat any FLAT score above 90 as an artefact of module count" —
    which only reads as a warning if FLAT and CLUSTERED share a scale."""
    results = [module_result(m, Direction.BUY, 90.0) for m in range(1, 29)]
    score = flat_score(results, Direction.BUY)

    assert 0.0 <= score <= 100.0
