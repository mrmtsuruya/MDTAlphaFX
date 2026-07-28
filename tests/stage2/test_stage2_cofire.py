"""Synthetic tests for the pure Stage 2 co-firing analysis core."""

from __future__ import annotations

import math
from itertools import combinations

import pytest

from backend.analysis.stage2_cofire import (
    MODULE_IDS,
    CofireObservation,
    PairRegimeMetrics,
    analyse_cofiring,
    cluster_modules,
    compute_pair_metrics,
    equal_cluster_weights,
)
from backend.contracts import Direction, Regime, StrategyResult


CURRENT_MEMBERSHIP = {
    "A": (1, 2, 10),
    "B": (3, 4, 9, 12, 13),
    "C": (5, 6, 14, 15, 16),
    "D1": (8,),
    "D2": (7, 11),
    "E": (17, 18, 19, 21, 22),
    "F": (20,),
    "G": (24, 25, 26),
    "H": (23, 27, 28),
}


def _result(
    module_id: int,
    direction: Direction = Direction.NONE,
) -> StrategyResult:
    fired = direction in (Direction.BUY, Direction.SELL)
    return StrategyResult(
        module_id=module_id,
        module_name=f"M{module_id:02d}",
        fired=fired,
        direction=direction,
        score=65.0 if fired else 0.0,
        evidence={"min": 1.0, "max": 1.0} if fired else {},
    )


def _observation(
    regime: Regime,
    firing: dict[int, Direction] | None = None,
) -> CofireObservation:
    firing = firing or {}
    return CofireObservation(
        regime=regime,
        results=tuple(
            _result(module_id, firing.get(module_id, Direction.NONE))
            for module_id in MODULE_IDS
        ),
    )


def _row(
    rows: tuple[PairRegimeMetrics, ...], module_a: int, module_b: int
) -> PairRegimeMetrics:
    return next(
        row
        for row in rows
        if row.module_a == module_a and row.module_b == module_b
    )


def test_pair_metrics_separate_agreement_from_conflict_and_use_exact_denominators():
    observations = [
        _observation(Regime.RANGING, {1: Direction.BUY, 2: Direction.BUY}),
        _observation(Regime.RANGING, {1: Direction.BUY, 2: Direction.SELL}),
        _observation(Regime.RANGING, {1: Direction.BUY}),
        _observation(Regime.RANGING),
    ]
    row = _row(compute_pair_metrics(observations, Regime.RANGING), 1, 2)
    assert row.observation_count == 4
    assert row.fire_count_a == 3
    assert row.fire_count_b == 2
    assert row.same_direction_joint_count == 1
    assert row.same_direction_joint_bar_rate == 0.25
    assert row.jaccard == 0.25
    assert row.conditional_a_given_b == 0.5
    assert row.conditional_b_given_a == pytest.approx(1.0 / 3.0)
    assert row.opposite_direction_conflict_count == 1
    assert row.opposite_direction_conflict_rate == 0.25
    assert row.phi == pytest.approx(2.0 / math.sqrt(180.0))
    assert row.degenerate is False


def test_opposite_direction_fires_are_conflicts_and_negative_phi_not_cofiring():
    observations = [
        _observation(Regime.TRANSITIONAL, {1: Direction.BUY, 2: Direction.SELL}),
        _observation(Regime.TRANSITIONAL, {1: Direction.SELL, 2: Direction.BUY}),
    ]
    row = _row(compute_pair_metrics(observations, None), 1, 2)
    assert row.same_direction_joint_count == 0
    assert row.jaccard == 0.0
    assert row.phi == -1.0
    assert row.opposite_direction_conflict_count == 2
    assert row.opposite_direction_conflict_rate == 1.0


def test_zero_denominators_emit_zero_rates_instead_of_nan_or_infinity():
    row = _row(compute_pair_metrics([], Regime.VOLATILE_NEWS), 1, 2)
    assert row.observation_count == 0
    assert row.fire_count_a == 0
    assert row.fire_count_b == 0
    assert row.same_direction_joint_bar_rate == 0.0
    assert row.jaccard == 0.0
    assert row.conditional_a_given_b == 0.0
    assert row.conditional_b_given_a == 0.0
    assert row.phi == 0.0
    assert row.degenerate is True
    assert row.opposite_direction_conflict_rate == 0.0


def _metric_rows(phi: float = 0.0) -> tuple[PairRegimeMetrics, ...]:
    return tuple(
        PairRegimeMetrics(
            regime=None,
            module_a=module_a,
            module_b=module_b,
            observation_count=100,
            fire_count_a=30,
            fire_count_b=30,
            same_direction_joint_count=0,
            same_direction_joint_bar_rate=0.0,
            jaccard=0.0,
            conditional_a_given_b=0.0,
            conditional_b_given_a=0.0,
            phi=phi,
            degenerate=False,
            opposite_direction_conflict_count=0,
            opposite_direction_conflict_rate=0.0,
        )
        for module_a, module_b in combinations(MODULE_IDS, 2)
    )


def test_equal_distance_linkage_ties_resolve_by_ascending_module_tuple():
    fire_counts = {module_id: 30 for module_id in MODULE_IDS}
    first = cluster_modules(
        _metric_rows(),
        fire_counts,
        CURRENT_MEMBERSHIP,
        minimum_module_fires=30,
        target_cluster_count=9,
    )
    second = cluster_modules(
        tuple(reversed(_metric_rows())),
        fire_counts,
        CURRENT_MEMBERSHIP,
        minimum_module_fires=30,
        target_cluster_count=9,
    )
    assert first == second
    assert first == (
        ("A", tuple(range(1, 21)), ()),
        ("B", (21,), ()),
        ("C", (22,), ()),
        ("D1", (23,), ()),
        ("D2", (24,), ()),
        ("E", (25,), ()),
        ("F", (26,), ()),
        ("G", (27,), ()),
        ("H", (28,), ()),
    )


def test_insufficient_modules_retain_current_membership_and_are_labelled():
    analysis = analyse_cofiring(
        [],
        CURRENT_MEMBERSHIP,
        minimum_module_fires=30,
        target_cluster_count=9,
        weight_total=100,
    )
    proposed = {
        cluster.cluster_id: cluster
        for cluster in analysis.clusters
    }
    assert analysis.insufficient_modules == MODULE_IDS
    assert len(analysis.overall) == 378
    assert len(analysis.by_regime) == 5 * 378
    for cluster_id, modules in CURRENT_MEMBERSHIP.items():
        assert proposed[cluster_id].modules == modules
        assert proposed[cluster_id].insufficient_modules == modules
        assert proposed[cluster_id].provisional
    assert sum(cluster.weight for cluster in analysis.clusters) == 100
    assert proposed["A"].weight == 12
    assert all(
        cluster.weight == 11
        for cluster_id, cluster in proposed.items()
        if cluster_id != "A"
    )


def test_one_insufficient_module_stays_anchored_to_its_current_cluster_id():
    rows = list(_metric_rows())
    pair_index = next(
        index
        for index, row in enumerate(rows)
        if (row.module_a, row.module_b) == (1, 28)
    )
    original = rows[pair_index]
    rows[pair_index] = PairRegimeMetrics(
        **{**original.__dict__, "phi": 1.0}
    )
    fire_counts = {module_id: 30 for module_id in MODULE_IDS}
    fire_counts[1] = 29
    clustered = cluster_modules(
        rows,
        fire_counts,
        CURRENT_MEMBERSHIP,
        minimum_module_fires=30,
        target_cluster_count=9,
    )
    anchored = next(cluster for cluster in clustered if cluster[0] == "A")
    assert 1 in anchored[1]
    assert anchored[2] == (1,)


def test_equal_weight_remainder_is_deterministic_in_sorted_cluster_order():
    assert equal_cluster_weights(
        ("H", "A", "D2", "C", "B", "G", "F", "E", "D1"),
        weight_total=100,
    ) == {
        "A": 12,
        "B": 11,
        "C": 11,
        "D1": 11,
        "D2": 11,
        "E": 11,
        "F": 11,
        "G": 11,
        "H": 11,
    }


def test_observation_requires_exact_partition_and_consistent_fire_direction():
    with pytest.raises(ValueError, match="modules 1..28"):
        CofireObservation(
            regime=Regime.RANGING,
            results=tuple(_result(module_id) for module_id in range(1, 28)),
        )
    invalid = list(_observation(Regime.RANGING).results)
    invalid[0] = StrategyResult(
        module_id=1,
        module_name="M01",
        fired=True,
        direction=Direction.NONE,
        score=65.0,
        evidence={},
    )
    with pytest.raises(ValueError, match="requires BUY or SELL"):
        CofireObservation(regime=Regime.RANGING, results=tuple(invalid))
