"""Focused Stage 2 tests for Price Action/Pivots modules 11–16."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from backend.contracts import Direction
from backend.core.config import Config
from backend.strategies.m11_quasimodo_level_reversal import (
    QuasimodoLevelReversal,
)
from backend.strategies.m12_support_resistance_flip import SupportResistanceFlip
from backend.strategies.m13_supply_demand_zone_retest import (
    SupplyDemandZoneRetest,
)
from backend.strategies.m14_double_bottom_top_validation import (
    DoubleBottomTopValidation,
)
from backend.strategies.m15_pinbar_hammer_exhaustion import (
    PinbarHammerExhaustion,
)
from backend.strategies.m16_engulfing_cluster import EngulfingCluster
from tests.doubles import candle, spec_for_tests


SPEC = spec_for_tests()
CONFIG = Config.load(Path("config"))
START = datetime(2026, 1, 1, tzinfo=timezone.utc)
REQUIRED_EVIDENCE = {
    "schema_version",
    "min",
    "max",
    "event_time",
    "overlay_type",
    "geometry",
    "stop_anchor",
    "opposing_structures",
    "indicators",
    "quality_flags",
    "timeframe_seconds",
}


def _strategy(strategy_type):
    return strategy_type(strategy_type.profile_from_config(CONFIG))


def _baseline(count: int):
    return [
        candle(
            START + timedelta(hours=index),
            100.0,
            101.0,
            99.0,
            100.0,
            tick_volume=100,
        )
        for index in range(count)
    ]


def _replace(
    bars,
    index: int,
    open_: float,
    high: float,
    low: float,
    close: float,
    *,
    volume: int = 100,
) -> None:
    bars[index] = candle(
        bars[index].time,
        open_,
        high,
        low,
        close,
        tick_volume=volume,
    )


def _deterministic_evaluate(strategy, bars):
    first = strategy.evaluate(bars, SPEC)
    assert first == strategy.evaluate(bars, SPEC)
    return first


def _quasimodo_age_case(return_age: int):
    strategy = _strategy(QuasimodoLevelReversal)
    bars = _baseline(strategy.min_bars)
    _replace(bars, 15, 100.0, 103.0, 99.0, 100.0)
    _replace(bars, 25, 100.0, 101.0, 97.0, 100.0)
    _replace(bars, 35, 100.0, 105.0, 99.0, 100.0)
    break_index = strategy.min_bars - 1 - return_age
    _replace(bars, break_index, 100.0, 101.0, 95.5, 96.0, volume=150)
    for index in range(break_index + 1, strategy.min_bars - 1):
        _replace(bars, index, 98.0, 100.0, 97.5, 98.0)
    _replace(
        bars,
        strategy.min_bars - 1,
        100.0,
        103.1,
        99.0,
        100.3,
        volume=160,
    )
    return strategy, bars, Direction.SELL


def _quasimodo_case():
    return _quasimodo_age_case(10)


def _flip_age_case(retest_age: int):
    strategy = _strategy(SupportResistanceFlip)
    bars = _baseline(strategy.min_bars)
    _replace(bars, 15, 100.0, 103.0, 99.0, 100.0)
    _replace(bars, 35, 100.0, 103.0, 99.0, 100.0)
    break_index = strategy.min_bars - 1 - retest_age
    _replace(bars, break_index, 100.0, 104.5, 99.5, 104.0, volume=160)
    for index in range(break_index + 1, strategy.min_bars - 1):
        _replace(bars, index, 104.5, 105.0, 103.8, 104.5)
    _replace(
        bars,
        strategy.min_bars - 1,
        104.5,
        105.0,
        103.1,
        104.8,
    )
    return strategy, bars, Direction.BUY


def _flip_case():
    return _flip_age_case(10)


def _zone_age_case(retest_age: int):
    strategy = _strategy(SupplyDemandZoneRetest)
    bars = _baseline(strategy.min_bars)
    impulse_index = strategy.min_bars - 1 - retest_age
    _replace(bars, impulse_index - 2, 100.0, 100.5, 99.5, 100.2)
    _replace(bars, impulse_index - 1, 100.2, 100.5, 99.5, 100.0)
    _replace(
        bars,
        impulse_index,
        100.1,
        105.5,
        99.8,
        105.1,
        volume=160,
    )
    for index in range(impulse_index + 1, strategy.min_bars - 1):
        _replace(bars, index, 104.0, 105.0, 103.5, 104.2)
    _replace(
        bars,
        strategy.min_bars - 1,
        104.0,
        104.5,
        100.1,
        104.2,
    )
    return strategy, bars, Direction.BUY


def _zone_case():
    return _zone_age_case(5)


def _double_bottom_volume_case(second_volume: int):
    strategy = _strategy(DoubleBottomTopValidation)
    bars = _baseline(strategy.min_bars)
    first_index = 12
    second_index = strategy.min_bars - 1 - strategy.pivot_right
    _replace(bars, first_index, 99.0, 100.0, 97.0, 99.5, volume=100)
    _replace(
        bars,
        second_index,
        97.3,
        100.0,
        97.1,
        99.5,
        volume=second_volume,
    )
    return strategy, bars, Direction.BUY


def _double_bottom_case():
    return _double_bottom_volume_case(70)


def _pinbar_wick_case(lower_wick_size: float):
    strategy = _strategy(PinbarHammerExhaustion)
    bars = _baseline(strategy.min_bars)
    _replace(bars, strategy.min_bars - 15, 100.0, 101.0, 97.0, 100.0)
    _replace(
        bars,
        strategy.min_bars - 1,
        99.0,
        100.5,
        99.0 - lower_wick_size,
        100.0,
        volume=70,
    )
    return strategy, bars, Direction.BUY


def _pinbar_case():
    strategy = _strategy(PinbarHammerExhaustion)
    bars = _baseline(strategy.min_bars)
    _replace(bars, strategy.min_bars - 15, 100.0, 101.0, 97.0, 100.0)
    _replace(
        bars,
        strategy.min_bars - 1,
        100.0,
        100.4,
        97.1,
        100.2,
        volume=70,
    )
    return strategy, bars, Direction.BUY


def _engulfing_volume_case(volume: int):
    strategy = _strategy(EngulfingCluster)
    bars = _baseline(strategy.min_bars)
    _replace(bars, strategy.min_bars - 2, 100.0, 101.0, 99.0, 100.0)
    _replace(
        bars,
        strategy.min_bars - 1,
        99.0,
        102.0,
        98.0,
        101.5,
        volume=volume,
    )
    return strategy, bars, Direction.BUY


def _engulfing_case():
    return _engulfing_volume_case(160)


@pytest.mark.parametrize(
    "case",
    [
        _quasimodo_case,
        _flip_case,
        _zone_case,
        _double_bottom_case,
        _pinbar_case,
        _engulfing_case,
    ],
)
def test_approved_price_action_detection_emits_complete_geometry(case):
    strategy, bars, expected_direction = case()

    first = strategy.evaluate(bars, SPEC)
    second = strategy.evaluate(bars, SPEC)

    assert first == second
    assert first.fired is True
    assert first.direction is expected_direction
    assert first.module_id == strategy.module_id
    assert first.score in (65.0, 75.0, 85.0, 95.0)
    assert REQUIRED_EVIDENCE == set(first.evidence)
    assert first.evidence["min"] <= first.evidence["max"]
    assert first.evidence["geometry"]
    assert len(first.evidence["quality_flags"]) == 3
    assert first.evidence["timeframe_seconds"] == 3600


@pytest.mark.parametrize(
    "strategy_type",
    [
        QuasimodoLevelReversal,
        SupportResistanceFlip,
        SupplyDemandZoneRetest,
        DoubleBottomTopValidation,
        PinbarHammerExhaustion,
        EngulfingCluster,
    ],
)
def test_short_windows_are_total_and_non_firing(strategy_type):
    strategy = _strategy(strategy_type)
    bars = _baseline(strategy.min_bars - 1)

    result = strategy.evaluate(bars, SPEC)

    assert result.fired is False
    assert result.direction is Direction.NONE
    assert result.score == 0.0
    assert result.evidence == {}


def test_engulfing_requires_the_previous_full_range_to_be_absorbed():
    strategy, bars, _ = _engulfing_case()
    previous = bars[-2]
    current = bars[-1]
    _replace(
        bars,
        strategy.min_bars - 1,
        current.open,
        previous.high - SPEC.point,
        current.low,
        100.5,
        volume=current.tick_volume,
    )

    result = strategy.evaluate(bars, SPEC)

    assert result.fired is False
    assert result.direction is Direction.NONE


def test_quasimodo_maximum_return_age_is_inclusive_and_next_bar_is_negative():
    strategy, boundary_bars, _ = _quasimodo_age_case(20)
    _, outside_bars, _ = _quasimodo_age_case(21)

    boundary = _deterministic_evaluate(strategy, boundary_bars)
    outside = _deterministic_evaluate(strategy, outside_bars)

    assert strategy.maximum_return == 20
    assert boundary.fired is True
    assert boundary.direction is Direction.SELL
    assert outside.fired is False
    assert outside.direction is Direction.NONE


def test_flip_maximum_retest_age_is_inclusive_and_next_bar_is_negative():
    strategy, boundary_bars, _ = _flip_age_case(20)
    _, outside_bars, _ = _flip_age_case(21)

    boundary = _deterministic_evaluate(strategy, boundary_bars)
    outside = _deterministic_evaluate(strategy, outside_bars)

    assert strategy.maximum_retest == 20
    assert boundary.fired is True
    assert boundary.direction is Direction.BUY
    assert outside.fired is False
    assert outside.direction is Direction.NONE


def test_zone_maximum_retest_age_is_inclusive_and_next_bar_is_negative():
    strategy, boundary_bars, _ = _zone_age_case(20)
    _, outside_bars, _ = _zone_age_case(21)

    boundary = _deterministic_evaluate(strategy, boundary_bars)
    outside = _deterministic_evaluate(strategy, outside_bars)

    assert strategy.maximum_retest == 20
    assert boundary.fired is True
    assert boundary.direction is Direction.BUY
    assert outside.fired is False
    assert outside.direction is Direction.NONE


def test_double_bottom_second_volume_ratio_boundary_and_just_above():
    strategy, boundary_bars, _ = _double_bottom_volume_case(80)
    _, outside_bars, _ = _double_bottom_volume_case(81)

    boundary = _deterministic_evaluate(strategy, boundary_bars)
    outside = _deterministic_evaluate(strategy, outside_bars)

    assert strategy.profile.number("second_volume_ratio") == 0.80
    assert boundary.fired is True
    assert boundary.direction is Direction.BUY
    assert boundary.evidence["indicators"]["second_to_first_volume_ratio"] == 0.80
    assert outside.fired is False
    assert outside.direction is Direction.NONE


def test_pinbar_wick_to_body_ratio_boundary_and_just_below():
    strategy, boundary_bars, _ = _pinbar_wick_case(2.00)
    _, outside_bars, _ = _pinbar_wick_case(1.99)

    boundary = _deterministic_evaluate(strategy, boundary_bars)
    outside = _deterministic_evaluate(strategy, outside_bars)

    assert strategy.profile.number("wick_to_body_ratio") == 2.00
    assert boundary.fired is True
    assert boundary.direction is Direction.BUY
    assert boundary.evidence["indicators"]["wick_to_body_ratio"] == pytest.approx(2.0)
    assert outside.fired is False
    assert outside.direction is Direction.NONE


def test_engulfing_high_volume_boundary_and_one_unit_below():
    strategy, boundary_bars, _ = _engulfing_volume_case(120)
    _, outside_bars, _ = _engulfing_volume_case(119)

    boundary = _deterministic_evaluate(strategy, boundary_bars)
    outside = _deterministic_evaluate(strategy, outside_bars)

    assert strategy.profile.number("high_volume_ratio") == 1.20
    assert boundary.fired is True
    assert boundary.direction is Direction.BUY
    assert boundary.evidence["indicators"]["volume_ratio"] == pytest.approx(1.20)
    assert outside.fired is False
    assert outside.direction is Direction.NONE
