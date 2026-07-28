"""Production YAML must be directly usable by the typed Stage 1 scorer."""

from __future__ import annotations

import copy

import pytest

from backend.contracts import Direction, Regime, SignalState, Timeframe
from backend.core.config import Config
from backend.core.errors import ConfigError
from backend.scoring.configuration import (
    Stage1ScoringModel,
    build_cluster_registry,
    build_regime_cluster_map,
)
from backend.scoring.gate import combine_timeframes, is_displayed
from backend.scoring.score import enabled_in
from backend.scoring.score import compute_breadth_quality_score
from backend.scoring.types import ClusterState
from tests.stage1.gate_doubles import timeframe_state


@pytest.fixture(scope="module")
def config() -> Config:
    return Config.load("config")


def test_versioned_config_builds_the_complete_typed_scoring_model(config):
    model = Stage1ScoringModel.from_config(config)

    model.registry.assert_invariants()
    assert len(model.registry.clusters) == 9
    assert set(model.cluster_map) == set(Regime)
    assert all(
        isinstance(state, ClusterState)
        for row in model.cluster_map.values()
        for state in row.values()
    )


def test_actual_yaml_map_is_direction_aware_and_score_ready(config):
    model = Stage1ScoringModel.from_config(config)

    assert enabled_in(
        Regime.RANGING,
        "A",
        Direction.BUY,
        Direction.NONE,
        model.cluster_map,
    )
    assert enabled_in(
        Regime.TRENDING_BULLISH,
        "D2",
        Direction.SELL,
        Direction.BUY,
        model.cluster_map,
    )
    assert not enabled_in(
        Regime.TRENDING_BULLISH,
        "D2",
        Direction.BUY,
        Direction.BUY,
        model.cluster_map,
    )


@pytest.mark.parametrize(
    "regime,direction,trend_direction,expected",
    [
        (Regime.TRENDING_BULLISH, Direction.BUY, Direction.BUY, 68),
        (Regime.TRENDING_BULLISH, Direction.SELL, Direction.BUY, 22),
        (Regime.RANGING, Direction.BUY, Direction.NONE, 67),
        (Regime.TRANSITIONAL, Direction.BUY, Direction.NONE, 57),
    ],
)
def test_actual_yaml_produces_the_published_scoring_denominators(
    config,
    regime,
    direction,
    trend_direction,
    expected,
):
    model = Stage1ScoringModel.from_config(config)

    result = compute_breadth_quality_score(
        (),
        model.registry,
        regime,
        direction,
        trend_direction,
        model.cluster_map,
        alpha=0.5,
        htf_penalty=1.0,
    )

    assert result.denominator == expected


def test_config_adapter_checks_the_published_denominators(config):
    clusters = config.section("clusters")
    regime = copy.deepcopy(config.section("regime"))
    regime["cluster_map"]["TRENDING"]["G"] = "ENABLED"

    registry = build_cluster_registry(clusters)
    with pytest.raises(ValueError, match="denominators"):
        build_regime_cluster_map(regime, registry)


def test_config_adapter_rejects_a_module_in_two_pillars(config):
    clusters = copy.deepcopy(config.section("clusters"))
    clusters["pillars"][2]["modules"].append(1)

    with pytest.raises(ValueError, match="more than one pillar"):
        build_cluster_registry(clusters)


def test_production_startup_rejects_inverted_thresholds(config):
    scoring = copy.deepcopy(config.section("scoring"))
    scoring["thresholds"]["display_threshold"] = 81
    scoring["thresholds"]["auto_execute_threshold"] = 80

    with pytest.raises(ConfigError, match="greater than or equal"):
        Stage1ScoringModel.from_sections(
            config.section("clusters"),
            config.section("regime"),
            scoring,
            config.section("engine"),
        )


def test_actual_config_drives_transitional_visibility(config):
    model = Stage1ScoringModel.from_config(config)

    assert is_displayed(74.99, Regime.TRANSITIONAL, model.runtime_config) is False
    assert is_displayed(75.0, Regime.TRANSITIONAL, model.runtime_config) is True


def test_actual_config_drives_mtf_entry_and_counter_bias(config):
    model = Stage1ScoringModel.from_config(config)
    states = {
        Timeframe.H4: timeframe_state(
            Timeframe.H4,
            regime=Regime.TRENDING_BULLISH,
            direction=Direction.BUY,
        ),
        Timeframe.H1: timeframe_state(
            Timeframe.H1,
            regime=Regime.TRENDING_BULLISH,
            direction=Direction.BUY,
        ),
        Timeframe.M15: timeframe_state(
            Timeframe.M15,
            regime=Regime.TRENDING_BEARISH,
            direction=Direction.SELL,
            state=SignalState.AWAITING_VALIDATION,
        ),
        Timeframe.M5: timeframe_state(
            Timeframe.M5,
            regime=Regime.TRENDING_BULLISH,
            direction=Direction.BUY,
        ),
    }

    result = combine_timeframes(states, model.runtime_config)

    assert result["candidate_direction"] == Direction.SELL.value
    assert result["counter_bias"] is True
    assert result["score_penalty"] == pytest.approx(0.6)


def test_user_selected_entry_timeframe_is_not_lost_between_config_files(config):
    engine = copy.deepcopy(config.section("engine"))
    engine["entry_timeframe"] = "M5"
    model = Stage1ScoringModel.from_sections(
        config.section("clusters"),
        config.section("regime"),
        config.section("scoring"),
        engine,
    )
    states = {
        Timeframe.H4: timeframe_state(
            Timeframe.H4, direction=Direction.BUY
        ),
        Timeframe.H1: timeframe_state(
            Timeframe.H1, direction=Direction.BUY
        ),
        Timeframe.M15: timeframe_state(
            Timeframe.M15, direction=Direction.SELL
        ),
        Timeframe.M5: timeframe_state(
            Timeframe.M5, direction=Direction.BUY
        ),
    }

    result = combine_timeframes(states, model.runtime_config)

    assert result["candidate_direction"] == Direction.BUY.value
    assert result["route"] == "STANDARD"


def test_config_adapter_freezes_the_runtime_cluster_map(config):
    model = Stage1ScoringModel.from_config(config)

    with pytest.raises(TypeError):
        model.cluster_map[Regime.RANGING]["A"] = ClusterState.SUPPRESSED

    with pytest.raises(TypeError):
        model.registry.pillar_of_module[1] = 4
