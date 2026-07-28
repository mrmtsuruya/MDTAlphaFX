"""§5.1 Correlation clusters and §5.1.1 clusters-vs-pillars.

    "The nine weights sum to exactly 100, and all 28 modules appear exactly
     once. Both are invariants: a startup assertion checks that cluster
     membership partitions 1–28 with no gaps and no overlaps, and that the
     weights total 100. A module in two clusters would be double-counted; a
     module in none would be silently dead. **Neither failure is visible at
     runtime without the check.**"

That last sentence is why the negative cases below matter more than the positive
one. A registry that fails either invariant produces plausible scores forever.

CLUSTER IDS ARE NEVER ASSERTED. §2 comments `cluster_id` as `"A".."H"` — eight
letters — while §5.1 defines nine clusters (`docs/AMBIGUITY.md` #001, open). The
tests here assert the *invariants*: nine clusters, weights totalling 100,
modules partitioning 1–28. Settling #001 must not invalidate a single line of
this file.

The exception type a failed startup assertion raises is not specified anywhere,
so the negative tests assert only that it raises.
"""

from __future__ import annotations

import pytest

from backend.contracts import Direction, Regime
from backend.scoring.score import compute_breadth_quality_score, tally
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
    CLUSTERS_SPANNING_TWO_PILLARS,
    PILLAR_MODULES,
    REGIME_CLUSTER_MAP,
    broken_registry_module_in_no_cluster,
    broken_registry_module_in_two_clusters,
    broken_registry_weights_not_100,
    firing,
    resolved,
    tied,
    weight_sum,
)

# ============================================================ the invariants


def test_the_nine_weights_total_exactly_100():
    """§5.1: "The nine weights sum to exactly 100."

    Not "about 100" and not normalised at read time. §5.2's breadth is a ratio
    of weight sums, so a total of 99 or 101 does not break anything visibly — it
    just moves every breadth by a percent and quietly invalidates §5.3.1's
    calibration table.
    """
    assert sum(c.weight for c in CLUSTER_REGISTRY.clusters) == 100
    CLUSTER_REGISTRY.assert_invariants()


def test_there_are_nine_clusters():
    """§5.1: "Modules are therefore grouped into **9 clusters**."

    Nine, not eight. §2's `"A".."H"` comment is the open half of AMBIGUITY-001;
    the count is not in question — D₁ (module 8) and D₂ (modules 7, 11) carry
    separate weights of 11 each and describe opposite structural events.
    """
    assert len(CLUSTER_REGISTRY.clusters) == 9
    assert len({c.cluster_id for c in CLUSTER_REGISTRY.clusters}) == 9
    CLUSTER_REGISTRY.assert_invariants()


def test_the_28_modules_partition_across_clusters():
    """§5.1: cluster membership "partitions 1–28 with no gaps and no overlaps".

    Both halves asserted separately so a failure says which one broke.
    """
    members = [m for c in CLUSTER_REGISTRY.clusters for m in c.modules]

    assert len(members) == len(set(members)), "§5.1 — a module appears in two clusters"
    assert sorted(members) == list(range(1, 29)), "§5.1 — a module appears in none"

    CLUSTER_REGISTRY.assert_invariants()


def test_a_module_in_two_clusters_is_rejected():
    """§5.1: "A module in two clusters would be double-counted."

    Double-counting is precisely the failure clustering exists to prevent, so a
    registry that reintroduces it must not start. The correct registry is
    checked first: an implementation that rejects everything is not a passing
    implementation.
    """
    CLUSTER_REGISTRY.assert_invariants()

    with pytest.raises(Exception):
        broken_registry_module_in_two_clusters().assert_invariants()


def test_a_module_in_no_cluster_is_rejected():
    """§5.1: "a module in none would be silently dead."

    Silently is the operative word. A module missing from every cluster still
    evaluates, still returns a `StrategyResult`, still appears in the UI — and
    contributes nothing to any score, forever, with no error.
    """
    CLUSTER_REGISTRY.assert_invariants()

    with pytest.raises(Exception):
        broken_registry_module_in_no_cluster().assert_invariants()


def test_weights_that_do_not_total_100_are_rejected():
    """§5.1 — the second startup assertion, tested in its failing direction."""
    CLUSTER_REGISTRY.assert_invariants()

    with pytest.raises(Exception):
        broken_registry_weights_not_100().assert_invariants()


# ==================================== §5.1.1 clusters and pillars are orthogonal


def test_nine_clusters_and_four_pillars_are_different_groupings():
    """§5.1.1: "**pillars and clusters both group the same 28 modules, along
    different axes, for different purposes.**"

    Pillars group by method (4, the §4 headings, they organise the UI); clusters
    group by observation (9, they carry the weights). Both partition 1–28, and
    they are not the same partition.
    """
    cluster_sets = {frozenset(c.modules) for c in CLUSTER_REGISTRY.clusters}
    pillar_sets = {frozenset(mods) for mods in PILLAR_MODULES.values()}

    assert len(cluster_sets) == 9
    assert len(pillar_sets) == 4
    assert cluster_sets != pillar_sets

    # Both cover the same 28 modules — different axes over identical material.
    assert set().union(*cluster_sets) == set().union(*pillar_sets) == set(range(1, 29))

    # §5.1.1 records the two invariants as startup assertions, so the
    # orthogonality claim is only meaningful over a registry that satisfies them.
    CLUSTER_REGISTRY.assert_invariants()


def test_some_clusters_span_two_pillars():
    """§5.1.1: "They cut across each other, which is the entire point. One
    market event can be detected by several methods, so a cluster can span
    pillars." Bold rows in the §5.1.1 matrix are B, C and D₂.

    If no cluster spanned a pillar boundary the two groupings would be nested
    and §5.3's `min_pillars` would be a restatement of `min_clusters` rather
    than the independent check it is described as.
    """
    pillars_of = {
        c.cluster_id: {CLUSTER_REGISTRY.pillar_of_module[m] for m in c.modules}
        for c in CLUSTER_REGISTRY.clusters
    }
    spanning = {cid for cid, pillars in pillars_of.items() if len(pillars) > 1}

    assert spanning == set(CLUSTERS_SPANNING_TWO_PILLARS)
    assert spanning, "§5.1.1 — the groupings would be nested, not orthogonal"

    CLUSTER_REGISTRY.assert_invariants()


@pytest.mark.parametrize(
    "cluster_id,expected_pillars",
    [
        pytest.param(CLUSTER_A, {1}, id="5.1.1-A-pillar_1_only"),
        pytest.param(CLUSTER_B, {1, 2}, id="5.1.1-B-pillars_1_and_2"),
        pytest.param(CLUSTER_C, {1, 2}, id="5.1.1-C-pillars_1_and_2"),
        pytest.param(CLUSTER_D1, {1}, id="5.1.1-D1-pillar_1_only"),
        pytest.param(CLUSTER_D2, {1, 2}, id="5.1.1-D2-pillars_1_and_2"),
        pytest.param(CLUSTER_E, {3}, id="5.1.1-E-pillar_3_only"),
        pytest.param(CLUSTER_F, {3}, id="5.1.1-F-pillar_3_only"),
        pytest.param(CLUSTER_G, {4}, id="5.1.1-G-pillar_4_only"),
        pytest.param(CLUSTER_H, {4}, id="5.1.1-H-pillar_4_only"),
    ],
)
def test_cluster_to_pillar_matrix(cluster_id, expected_pillars):
    """§5.3's mapping table, which is §5.1.1's matrix read row-wise:

        | A, D₁    | 1 only (SMC/ICT)            |
        | B, C, D₂ | 1 and 2                     |
        | E, F     | 3 only (Trend & Momentum)   |
        | G, H     | 4 only (Volatility & MR)    |

    This is what makes §5.3's warning true — "in RANGING [a second pillar] must
    come from B, C, D₂, F or G, and F is a single module, while G is the only
    Pillar-4 cluster available".
    """
    cluster = CLUSTER_REGISTRY.by_id(cluster_id)
    pillars = {CLUSTER_REGISTRY.pillar_of_module[m] for m in cluster.modules}
    assert pillars == expected_pillars

    CLUSTER_REGISTRY.assert_invariants()


def test_a_five_module_cluster_and_a_one_module_cluster_carry_comparable_weight():
    """§5.1.1: "cluster E is five modules and one vote, cluster F is one module
    and one vote, and **neither is worth more for having more parts**."

    E holds five modules and F holds one. Their weights are 12 and 11 — within
    one point, not five to one. Under §5.2.2's FLAT mode the ratio would be five
    to one, which is the inflation §5.2.2 exists to warn about.
    """
    e = CLUSTER_REGISTRY.by_id(CLUSTER_E)
    f = CLUSTER_REGISTRY.by_id(CLUSTER_F)

    assert len(e.modules) == 5
    assert len(f.modules) == 1
    assert abs(e.weight - f.weight) <= 1
    assert e.weight < len(e.modules) * f.weight

    CLUSTER_REGISTRY.assert_invariants()


# ================================= §5.1 cluster resolution — the tie case
#
# "A cluster fires if **any** enabled member fires. Its direction is the
#  majority direction of firing members; ties resolve to `NONE` and the cluster
#  does not fire. Its score is the **maximum** score among firing members
#  agreeing with that direction."
#
# NOTE: no Stage 1 stub takes module results and returns a resolved cluster, so
# the ANY / MAJORITY / MAX halves of that rule have no seam to test against —
# reported as a gap. What *is* testable, and is where the money is, is that a
# tie is inert everywhere downstream: a cluster that resolved to NONE must not
# reach breadth, quality or either side of the tally, however strongly its
# members read.


def test_a_tied_cluster_does_not_contribute_to_breadth():
    """§5.1: "ties resolve to `NONE` and the cluster does not fire."

    The tied cluster carries score 95 so that a resolver implemented as "first
    firing member wins" — the likeliest wrong implementation — shows up as a
    breadth and quality difference rather than as nothing at all.
    """
    with_tie = resolved(
        firing(CLUSTER_A, Direction.BUY, 80.0),
        firing(CLUSTER_B, Direction.BUY, 80.0),
        tied(CLUSTER_E, score=95.0),
    )
    without_tie = resolved(
        firing(CLUSTER_A, Direction.BUY, 80.0),
        firing(CLUSTER_B, Direction.BUY, 80.0),
    )

    kwargs = dict(
        registry=CLUSTER_REGISTRY,
        regime=Regime.TRENDING_BULLISH,
        direction=Direction.BUY,
        trend_direction=Direction.BUY,
        cluster_map=REGIME_CLUSTER_MAP,
        alpha=ALPHA,
        htf_penalty=1.0,
    )
    tied_result = compute_breadth_quality_score(with_tie, **kwargs)
    clean_result = compute_breadth_quality_score(without_tie, **kwargs)

    assert tied_result.numerator == weight_sum(CLUSTER_A, CLUSTER_B)
    assert tied_result.breadth == clean_result.breadth
    assert tied_result.quality == clean_result.quality
    assert tied_result.score == clean_result.score


def test_a_tied_cluster_votes_on_neither_side():
    """§5.1 — a tie "does not fire", so §5.2.1 sees nothing to count.

    §5.2.1 filters on `c.fired`, so a tie must not raise `contested` either. A
    cluster whose members disagree with each other is not the market arguing
    with itself across independent observations; it is one observation that did
    not resolve, and §5.3 makes `contested` block AUTO regardless of score.
    """
    clusters = resolved(
        firing(CLUSTER_A, Direction.SELL, 85.0),
        firing(CLUSTER_B, Direction.SELL, 85.0),
        tied(CLUSTER_C, score=99.0),
    )

    votes = tally(
        clusters,
        registry=CLUSTER_REGISTRY,
        regime=Regime.RANGING,
        trend_direction=Direction.NONE,
        cluster_map=REGIME_CLUSTER_MAP,
    )

    assert votes.sell_votes == 2
    assert votes.buy_votes == 0
    assert votes.contested is False
