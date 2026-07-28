"""Focused tests for Stage 2 SMC/ICT modules 1–10."""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

import pytest

from backend.contracts import Candle, Direction, Timeframe
from backend.core.config import Config
from backend.core.timeutil import UTC
from backend.data.store import ParquetBarStore
from backend.strategies.configuration import ModuleProfile
from backend.strategies.common import Pivot
from backend.strategies.candidate_ranking import (
    candidate_sort_key,
    select_candidate,
)
from backend.strategies import m01_bullish_fvg_fill as fvg_core
from backend.strategies import m03_bullish_order_block as bullish_ob_module
from backend.strategies import m04_bearish_order_block as bearish_ob_module
from backend.strategies import m05_sell_side_liquidity_sweep as sell_sweep_module
from backend.strategies import m06_buy_side_liquidity_sweep as buy_sweep_module
from backend.strategies import m07_change_of_character as choch_module
from backend.strategies import m08_break_of_structure as bos_module
from backend.strategies import m09_breaker_block_mitigation as breaker_module
from backend.strategies import m10_liquidity_void_realign as void_module
from backend.strategies.m01_bullish_fvg_fill import (
    BullishFVGFill,
    _gap_candidates,
    _overlaps,
)
from backend.strategies.m02_bearish_fvg_fill import BearishFVGFill
from backend.strategies.m03_bullish_order_block import BullishOrderBlock
from backend.strategies.m04_bearish_order_block import BearishOrderBlock
from backend.strategies.m05_sell_side_liquidity_sweep import (
    SellSideLiquiditySweep,
)
from backend.strategies.m06_buy_side_liquidity_sweep import BuySideLiquiditySweep
from backend.strategies.m07_change_of_character import ChangeOfCharacter
from backend.strategies.m08_break_of_structure import BreakOfStructure
from backend.strategies.m09_breaker_block_mitigation import BreakerBlockMitigation
from backend.strategies.m10_liquidity_void_realign import (
    LiquidityVoidRealignment,
)

from tests.doubles import spec_for_tests


ROOT = Path(__file__).resolve().parents[2]
CONFIG = Config.load(ROOT / "config")

MODULE_CASES = [
    (
        BullishFVGFill,
        1,
        "Bullish FVG Fill",
        "A",
        43,
        74,
        Direction.BUY,
        95.0,
        1.33870,
        1.33942,
    ),
    (
        BearishFVGFill,
        2,
        "Bearish FVG Fill",
        "A",
        43,
        52,
        Direction.SELL,
        75.0,
        1.33818,
        1.33827,
    ),
    (
        BullishOrderBlock,
        3,
        "Bullish Order Block",
        "B",
        96,
        95,
        Direction.BUY,
        95.0,
        1.33774,
        1.33842,
    ),
    (
        BearishOrderBlock,
        4,
        "Bearish Order Block",
        "B",
        96,
        128,
        Direction.SELL,
        75.0,
        1.33671,
        1.33674,
    ),
    (
        SellSideLiquiditySweep,
        5,
        "Sell-Side Liquidity Sweep",
        "C",
        76,
        76,
        Direction.BUY,
        95.0,
        1.33770,
        1.33890,
    ),
    (
        BuySideLiquiditySweep,
        6,
        "Buy-Side Liquidity Sweep",
        "C",
        76,
        453,
        Direction.SELL,
        75.0,
        1.34207,
        1.34216,
    ),
    (
        ChangeOfCharacter,
        7,
        "Change of Character (CHoCH)",
        "D2",
        76,
        132,
        Direction.BUY,
        95.0,
        1.33705,
        1.33705,
    ),
    (
        BreakOfStructure,
        8,
        "Break of Structure (BOS)",
        "D1",
        76,
        112,
        Direction.SELL,
        75.0,
        1.33711,
        1.33711,
    ),
    (
        BreakerBlockMitigation,
        9,
        "Breaker Block Mitigation",
        "B",
        146,
        165,
        Direction.SELL,
        75.0,
        1.33661,
        1.33683,
    ),
    (
        LiquidityVoidRealignment,
        10,
        "Liquidity Void Re-alignment",
        "A",
        28,
        28,
        Direction.BUY,
        95.0,
        1.33697,
        1.33727,
    ),
]


@pytest.fixture(scope="module")
def ranging_m15():
    store = ParquetBarStore.from_config(CONFIG, root=ROOT / "fixtures" / "ranging")
    symbol = store.available_symbols()[0]
    coverage = store.coverage(symbol, Timeframe.M15)
    assert coverage is not None
    bars = store.bars(
        symbol,
        Timeframe.M15,
        coverage[0],
        coverage[1] + timedelta(minutes=15),
    )
    return bars, store.symbol_spec(symbol)


@pytest.mark.parametrize(
    (
        "strategy_type,module_id,module_name,cluster_id,min_bars,"
        "event_index,direction,score,zone_min,zone_max"
    ),
    MODULE_CASES,
)
def test_recorded_ranging_fixture_has_deterministic_positive_geometry(
    ranging_m15,
    strategy_type,
    module_id,
    module_name,
    cluster_id,
    min_bars,
    event_index,
    direction,
    score,
    zone_min,
    zone_max,
):
    """Each module has a known positive on the approved recorded M15 cohort."""

    bars, spec = ranging_m15
    strategy = strategy_type.from_config(CONFIG)
    assert strategy.module_id == module_id
    assert strategy.module_name == module_name
    assert strategy.cluster_id == cluster_id
    assert strategy.min_bars == min_bars

    window = bars[: event_index + 1]
    first = strategy.evaluate(window, spec)
    second = strategy.evaluate(window, spec)
    assert first == second
    assert first.fired
    assert first.direction is direction
    assert first.score == score
    assert first.evidence["min"] == zone_min
    assert first.evidence["max"] == zone_max
    assert first.evidence["event_time"] == bars[event_index].time.isoformat()
    assert first.evidence["schema_version"] == 1
    assert len(first.evidence["quality_flags"]) == 3
    assert first.evidence["geometry"]
    assert first.evidence["stop_anchor"]
    assert first.evidence["timeframe_seconds"] == 15 * 60


@pytest.mark.parametrize("strategy_type", [case[0] for case in MODULE_CASES])
def test_short_windows_are_total_and_flat(strategy_type):
    strategy = strategy_type.from_config(CONFIG)
    result = strategy.evaluate([], spec_for_tests())
    assert not result.fired
    assert result.direction is Direction.NONE
    assert result.score == 0.0
    assert result.evidence == {}


def _bar(
    index: int,
    open_: float,
    high: float,
    low: float,
    close: float,
    volume: int = 100,
) -> Candle:
    return Candle(
        time=datetime(2026, 1, 1, tzinfo=UTC) + timedelta(hours=index),
        open=open_,
        high=high,
        low=low,
        close=close,
        tick_volume=volume,
        spread=10,
    )


def test_same_direction_structure_collision_selects_most_recent_formation():
    """Recovery addendum: the greater formation index wins first."""

    common = {
        "atr_period": 2,
        "volume_median_bars": 2,
        "minimum_displacement_body_atr": 0.0,
        "high_volume_ratio": 1.0,
        "confidence_base": 65,
        "confidence_confirmation_bonus": 10,
        "confidence_cap": 95,
        "evidence_schema_version": 1,
    }
    parameters = {
        "gap_min_atr": 0.01,
        "large_gap_atr": 0.25,
        "maximum_age_bars": 3,
        "fill_midpoint_fraction": 0.50,
    }
    strategy = BullishFVGFill(
        ModuleProfile(module_id=1, common=common, parameters=parameters)
    )
    bars = [
        _bar(0, 99.0, 100.0, 98.0, 99.0),
        _bar(1, 99.0, 100.0, 98.0, 99.0),
        _bar(2, 99.0, 100.0, 98.0, 99.0),
        _bar(3, 100.0, 102.0, 99.5, 101.5),
        _bar(4, 101.2, 102.0, 101.0, 101.8),
        _bar(5, 102.5, 104.0, 102.0, 103.5),
        _bar(6, 103.2, 104.0, 103.0, 103.8),
        _bar(7, 103.0, 104.0, 99.0, 102.0),
    ]
    assert len(bars) == strategy.min_bars
    candidates = _gap_candidates(
        bars,
        current=len(bars) - 1,
        maximum_age=3,
        atr_period=2,
        volume_period=2,
        gap_min_atr=0.01,
        displacement_atr=0.0,
        direction="BULLISH",
    )
    first_touch = [
        gap
        for gap in candidates
        if not any(
            _overlaps(bar, gap.low, gap.high)
            for bar in bars[gap.third + 1 : -1]
        )
        and _overlaps(bars[-1], gap.low, gap.high)
    ]
    assert len(first_touch) == 2
    result = strategy.evaluate(bars, spec_for_tests())
    assert result.fired
    assert result.direction is Direction.BUY
    assert result.evidence["min"] == 102.0
    assert result.evidence["max"] == 103.0


def _ranking_key(
    *,
    formation: int,
    low: float,
    high: float,
    role: str,
    price_: float,
    indices: tuple[int, ...],
):
    return candidate_sort_key(
        formation_index=formation,
        raw_zone_min=low,
        raw_zone_max=high,
        geometry_coordinates=(
            (role, datetime(2026, 1, 1, tzinfo=UTC).isoformat(), price_),
        ),
        source_indices=indices,
    )


def test_candidate_ranking_applies_each_approved_key_tier_in_order():
    recent = _ranking_key(
        formation=8,
        low=90.0,
        high=110.0,
        role="Z",
        price_=110.0,
        indices=(8,),
    )
    older = _ranking_key(
        formation=7,
        low=100.0,
        high=100.1,
        role="A",
        price_=100.0,
        indices=(1,),
    )
    assert recent < older

    narrow = _ranking_key(
        formation=8,
        low=100.0,
        high=100.1,
        role="Z",
        price_=110.0,
        indices=(8,),
    )
    wide = _ranking_key(
        formation=8,
        low=100.0,
        high=100.2,
        role="A",
        price_=90.0,
        indices=(1,),
    )
    assert narrow < wide

    geometry_a = _ranking_key(
        formation=8,
        low=100.0,
        high=100.1,
        role="A",
        price_=110.0,
        indices=(8,),
    )
    geometry_z = _ranking_key(
        formation=8,
        low=100.0,
        high=100.1,
        role="Z",
        price_=90.0,
        indices=(1,),
    )
    assert geometry_a < geometry_z

    shorter_prefix = _ranking_key(
        formation=8,
        low=100.0,
        high=100.1,
        role="A",
        price_=110.0,
        indices=(1, 2),
    )
    longer_prefix = _ranking_key(
        formation=8,
        low=100.0,
        high=100.1,
        role="A",
        price_=110.0,
        indices=(1, 2, 3),
    )
    assert shorter_prefix < longer_prefix


def test_candidate_selection_is_enumeration_independent_and_opposite_direction_flat():
    candidates = [
        ("older", Direction.BUY, _ranking_key(
            formation=7,
            low=100.0,
            high=100.1,
            role="A",
            price_=100.0,
            indices=(7,),
        )),
        ("recent", Direction.BUY, _ranking_key(
            formation=8,
            low=100.0,
            high=100.2,
            role="Z",
            price_=100.0,
            indices=(8,),
        )),
    ]
    select = lambda values: select_candidate(
        values,
        direction_of=lambda candidate: candidate[1],
        key_of=lambda candidate: candidate[2],
    )
    assert select(candidates)[0] == "recent"
    assert select(list(reversed(candidates)))[0] == "recent"
    assert select(
        [
            candidates[0],
            ("sell", Direction.SELL, candidates[1][2]),
        ]
    ) is None


SYNTHETIC_COMMON = {
    "atr_period": 2,
    "volume_median_bars": 2,
    "pivot_left_bars": 1,
    "pivot_right_bars": 1,
    "structure_lookback_bars": 4,
    "minimum_displacement_body_atr": 0.80,
    "minimum_rejection_wick_atr": 0.50,
    "high_volume_ratio": 1.20,
    "low_volume_ratio": 0.80,
    "confidence_base": 65,
    "confidence_confirmation_bonus": 10,
    "confidence_cap": 95,
    "evidence_schema_version": 1,
}


def _profile(
    module_id: int,
    parameters: dict,
    **common_overrides,
) -> ModuleProfile:
    return ModuleProfile(
        module_id=module_id,
        common={**SYNTHETIC_COMMON, **common_overrides},
        parameters=parameters,
    )


def _constant_atr(bars, period):
    del period
    return [2.0] * len(bars)


def _stable_bars(
    count: int,
    *,
    center: float = 100.0,
) -> list[Candle]:
    return [
        _bar(
            index,
            center,
            center + 1.0,
            center - 1.0,
            center,
        )
        for index in range(count)
    ]


def _with_last(
    bars: list[Candle],
    *,
    open_: float,
    high: float,
    low: float,
    close: float,
    volume: int = 100,
) -> list[Candle]:
    return [
        *bars[:-1],
        _bar(len(bars) - 1, open_, high, low, close, volume),
    ]


def _assert_deterministic_positive(strategy, bars):
    first = strategy.evaluate(bars, spec_for_tests())
    second = strategy.evaluate(bars, spec_for_tests())
    assert first == second
    assert first.fired
    assert first.direction in (Direction.BUY, Direction.SELL)
    assert first.evidence["min"] <= first.evidence["max"]
    return first


@pytest.mark.parametrize(
    "strategy_type,module_id,direction",
    [
        (BullishFVGFill, 1, Direction.BUY),
        (BearishFVGFill, 2, Direction.SELL),
    ],
)
def test_m01_m02_synthetic_positive_negative_and_exact_gap_boundary(
    monkeypatch,
    strategy_type,
    module_id,
    direction,
):
    """The approved 0.10 ATR wick-gap boundary is inclusive."""

    monkeypatch.setattr(fvg_core, "atr", _constant_atr)
    strategy = strategy_type(
        _profile(
            module_id,
            {
                "gap_min_atr": 0.10,
                "large_gap_atr": 0.25,
                "maximum_age_bars": 1,
                "fill_midpoint_fraction": 0.50,
            },
        )
    )
    assert strategy.min_bars == 6
    if direction is Direction.BUY:
        exact = [
            _bar(0, 100.0, 101.0, 99.0, 100.0),
            _bar(1, 100.0, 101.0, 99.0, 100.0),
            _bar(2, 99.5, 100.0, 99.0, 99.5),
            _bar(3, 99.5, 102.0, 99.4, 101.5),
            _bar(4, 100.3, 101.0, 100.2, 100.8),
            _bar(5, 100.8, 101.5, 100.1, 101.0),
        ]
        outside = [*exact[:4], _bar(4, 100.3, 101.0, 100.19, 100.8), exact[5]]
        negative = _with_last(
            exact, open_=101.0, high=102.0, low=100.21, close=101.5
        )
    else:
        exact = [
            _bar(0, 100.0, 101.0, 99.0, 100.0),
            _bar(1, 100.0, 101.0, 99.0, 100.0),
            _bar(2, 100.5, 101.0, 100.2, 100.5),
            _bar(3, 100.5, 100.6, 98.0, 98.5),
            _bar(4, 99.7, 100.0, 99.0, 99.2),
            _bar(5, 99.5, 100.1, 98.5, 99.0),
        ]
        outside = [*exact[:4], _bar(4, 99.7, 100.01, 99.0, 99.2), exact[5]]
        negative = _with_last(
            exact, open_=99.0, high=99.99, low=98.0, close=98.5
        )
    assert _assert_deterministic_positive(strategy, exact).direction is direction
    assert not strategy.evaluate(outside, spec_for_tests()).fired
    assert not strategy.evaluate(negative, spec_for_tests()).fired


@pytest.mark.parametrize(
    "strategy_type,module_id,direction,module_under_test,block_direction",
    [
        (
            BullishOrderBlock,
            3,
            Direction.BUY,
            bullish_ob_module,
            "BULLISH",
        ),
        (
            BearishOrderBlock,
            4,
            Direction.SELL,
            bearish_ob_module,
            "BEARISH",
        ),
    ],
)
def test_m03_m04_synthetic_positive_negative_and_midpoint_boundary(
    monkeypatch,
    strategy_type,
    module_id,
    direction,
    module_under_test,
    block_direction,
):
    """Mitigation must close strictly back through the approved 50% midpoint."""

    parameters = {
        "break_buffer_atr": 0.05,
        "maximum_age_bars": 2,
        "mitigation_midpoint_fraction": 0.50,
    }
    strategy = strategy_type(_profile(module_id, parameters))
    bars = _stable_bars(
        strategy.min_bars,
        center=102.0 if direction is Direction.BUY else 98.0,
    )
    block = bullish_ob_module._OrderBlock(
        candle=len(bars) - 6,
        break_bar=len(bars) - 3,
        zone_low=100.0,
        zone_high=101.0,
        broken_swing=Pivot(
            index=len(bars) - 7,
            time=bars[-7].time.isoformat(),
            price=101.5,
        ),
        break_atr=2.0,
        break_volume_median=100.0,
        direction=block_direction,
    )
    monkeypatch.setattr(module_under_test, "atr", _constant_atr)
    monkeypatch.setattr(module_under_test, "_order_blocks", lambda *args, **kwargs: [block])
    if direction is Direction.BUY:
        bars[-2] = _bar(
            len(bars) - 2, 102.0, 103.0, 101.1, 102.0
        )
        positive = _with_last(
            bars, open_=100.2, high=101.5, low=100.0, close=100.51, volume=150
        )
        boundary = _with_last(
            bars, open_=100.2, high=101.5, low=100.0, close=100.50, volume=150
        )
        negative = _with_last(
            bars, open_=101.2, high=102.0, low=101.1, close=101.5
        )
    else:
        positive = _with_last(
            bars, open_=100.8, high=101.0, low=99.5, close=100.49, volume=150
        )
        boundary = _with_last(
            bars, open_=100.8, high=101.0, low=99.5, close=100.50, volume=150
        )
        negative = _with_last(
            bars, open_=99.5, high=99.9, low=99.0, close=99.2
        )
    assert _assert_deterministic_positive(strategy, positive).direction is direction
    assert not strategy.evaluate(boundary, spec_for_tests()).fired
    assert not strategy.evaluate(negative, spec_for_tests()).fired


@pytest.mark.parametrize(
    "strategy_type,module_id,direction,module_under_test,pair_direction",
    [
        (
            SellSideLiquiditySweep,
            5,
            Direction.BUY,
            sell_sweep_module,
            "SELL_SIDE",
        ),
        (
            BuySideLiquiditySweep,
            6,
            Direction.SELL,
            buy_sweep_module,
            "BUY_SIDE",
        ),
    ],
)
def test_m05_m06_synthetic_positive_negative_and_pierce_boundary(
    monkeypatch,
    strategy_type,
    module_id,
    direction,
    module_under_test,
    pair_direction,
):
    """A pierce must be strictly beyond the approved 0.05 ATR threshold."""

    strategy = strategy_type(
        _profile(
            module_id,
            {
                "minimum_separation_bars": 1,
                "maximum_separation_bars": 3,
                "equal_level_tolerance_atr": 0.10,
                "minimum_pierce_atr": 0.05,
                "close_half_fraction": 0.50,
            },
        )
    )
    bars = _stable_bars(strategy.min_bars)
    pair = sell_sweep_module._LiquidityPair(
        first=Pivot(1, bars[1].time.isoformat(), 100.0),
        second=Pivot(4, bars[4].time.isoformat(), 100.0),
        level=100.0,
        direction=pair_direction,
    )
    monkeypatch.setattr(module_under_test, "atr", _constant_atr)
    monkeypatch.setattr(
        module_under_test, "_liquidity_pairs", lambda *args, **kwargs: [pair]
    )
    if direction is Direction.BUY:
        positive = _with_last(
            bars, open_=100.1, high=101.0, low=99.89, close=100.6, volume=150
        )
        boundary = _with_last(
            bars, open_=100.1, high=101.0, low=99.90, close=100.6, volume=150
        )
        negative = _with_last(
            bars, open_=100.1, high=101.0, low=99.89, close=99.95, volume=150
        )
    else:
        positive = _with_last(
            bars, open_=99.9, high=100.11, low=99.0, close=99.4, volume=150
        )
        boundary = _with_last(
            bars, open_=99.9, high=100.10, low=99.0, close=99.4, volume=150
        )
        negative = _with_last(
            bars, open_=99.9, high=100.11, low=99.0, close=100.05, volume=150
        )
    assert _assert_deterministic_positive(strategy, positive).direction is direction
    assert not strategy.evaluate(boundary, spec_for_tests()).fired
    assert not strategy.evaluate(negative, spec_for_tests()).fired


@pytest.mark.parametrize(
    "strategy_type,module_id,direction,module_under_test,event",
    [
        (ChangeOfCharacter, 7, Direction.BUY, choch_module, "CHOCH"),
        (BreakOfStructure, 8, Direction.BUY, bos_module, "BOS"),
    ],
)
def test_m07_m08_synthetic_positive_negative_and_break_buffer_boundary(
    monkeypatch,
    strategy_type,
    module_id,
    direction,
    module_under_test,
    event,
):
    """Structure close must be strictly beyond the approved 0.05 ATR buffer."""

    strategy = strategy_type(
        _profile(
            module_id,
            {"break_buffer_atr": 0.05, "strong_break_atr": 0.25},
        )
    )
    bars = _stable_bars(strategy.min_bars)
    if event == "CHOCH":
        structure = choch_module._Structure(
            Pivot(1, bars[1].time.isoformat(), 102.0),
            Pivot(5, bars[5].time.isoformat(), 100.0),
            Pivot(2, bars[2].time.isoformat(), 99.0),
            Pivot(6, bars[6].time.isoformat(), 98.0),
        )
    else:
        structure = choch_module._Structure(
            Pivot(1, bars[1].time.isoformat(), 99.0),
            Pivot(5, bars[5].time.isoformat(), 100.0),
            Pivot(2, bars[2].time.isoformat(), 97.0),
            Pivot(6, bars[6].time.isoformat(), 98.0),
        )
    monkeypatch.setattr(module_under_test, "atr", _constant_atr)
    monkeypatch.setattr(
        module_under_test, "_latest_structure", lambda *args, **kwargs: structure
    )
    positive = _with_last(
        bars, open_=100.0, high=102.0, low=99.5, close=100.11, volume=150
    )
    boundary = _with_last(
        bars, open_=100.0, high=102.0, low=99.5, close=100.10, volume=150
    )
    negative = _with_last(
        bars, open_=100.0, high=101.0, low=99.5, close=100.05, volume=150
    )
    assert _assert_deterministic_positive(strategy, positive).direction is direction
    assert not strategy.evaluate(boundary, spec_for_tests()).fired
    assert not strategy.evaluate(negative, spec_for_tests()).fired


def test_m09_synthetic_positive_negative_and_flipped_midpoint_boundary(
    monkeypatch,
):
    """The breaker retest closes strictly through its approved 50% midpoint."""

    strategy = BreakerBlockMitigation(
        _profile(
            9,
            {
                "maximum_age_bars": 2,
                "mitigation_midpoint_fraction": 0.50,
            },
            structure_lookback_bars=3,
            break_buffer_atr=0.05,
        )
    )
    bars = _stable_bars(strategy.min_bars, center=102.0)
    break_bar = len(bars) - 5
    failure_bar = len(bars) - 3
    block = bullish_ob_module._OrderBlock(
        candle=len(bars) - 7,
        break_bar=break_bar,
        zone_low=100.0,
        zone_high=101.0,
        broken_swing=Pivot(
            len(bars) - 8,
            bars[-8].time.isoformat(),
            101.5,
        ),
        break_atr=2.0,
        break_volume_median=100.0,
        direction="BULLISH",
    )
    monkeypatch.setattr(breaker_module, "atr", _constant_atr)
    monkeypatch.setattr(
        breaker_module,
        "_order_blocks",
        lambda *args, **kwargs: [block]
        if kwargs["direction"] == "BULLISH"
        else [],
    )
    prepared = list(bars)
    prepared[failure_bar] = _bar(
        failure_bar, 101.0, 101.2, 98.8, 99.0, 150
    )
    prepared[-2] = _bar(len(bars) - 2, 99.0, 99.8, 98.5, 99.2)
    positive = _with_last(
        prepared, open_=100.8, high=101.0, low=99.5, close=100.49, volume=150
    )
    boundary = _with_last(
        prepared, open_=100.8, high=101.0, low=99.5, close=100.50, volume=150
    )
    negative = _with_last(
        prepared, open_=99.5, high=99.9, low=99.0, close=99.2
    )
    result = _assert_deterministic_positive(strategy, positive)
    assert result.direction is Direction.SELL
    assert not strategy.evaluate(boundary, spec_for_tests()).fired
    assert not strategy.evaluate(negative, spec_for_tests()).fired


def test_m10_synthetic_positive_negative_and_rebalance_fraction_boundary(
    monkeypatch,
):
    """The approved 50% void-rebalance boundary is inclusive."""

    strategy = LiquidityVoidRealignment(
        _profile(
            10,
            {
                "gap_min_atr": 0.10,
                "large_gap_atr": 0.25,
                "low_volume_ratio": 0.80,
                "maximum_rebalance_bars": 2,
                "minimum_rebalance_fraction": 0.50,
                "strong_rebalance_fraction": 0.75,
            },
        )
    )
    bars = _stable_bars(strategy.min_bars, center=103.0)
    gap = fvg_core._Gap(
        first=2,
        middle=3,
        third=4,
        low=100.0,
        high=102.0,
        atr=2.0,
        volume_median=100.0,
        direction="BULLISH",
    )
    bars[3] = _bar(3, 100.0, 102.0, 99.5, 101.7, 60)
    bars[5] = _bar(5, 102.0, 103.0, 102.0, 102.0)
    monkeypatch.setattr(
        void_module,
        "_gap_candidates",
        lambda *args, **kwargs: [gap]
        if kwargs["direction"] == "BULLISH"
        else [],
    )
    exact = _with_last(
        bars, open_=101.2, high=102.0, low=101.0, close=101.5
    )
    outside = _with_last(
        bars, open_=101.2, high=102.0, low=101.01, close=101.5
    )
    negative = _with_last(
        bars, open_=101.5, high=102.0, low=101.0, close=101.2
    )
    result = _assert_deterministic_positive(strategy, exact)
    assert result.direction is Direction.BUY
    assert result.evidence["indicators"]["rebalance_fraction"] == 0.50
    assert not strategy.evaluate(outside, spec_for_tests()).fired
    assert not strategy.evaluate(negative, spec_for_tests()).fired
