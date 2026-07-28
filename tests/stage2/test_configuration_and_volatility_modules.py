from __future__ import annotations

import math
from datetime import datetime, timedelta

import pytest

import backend.strategies.m23_bollinger_squeeze_breakout as m23_module
import backend.strategies.m24_bollinger_outer_reversion as m24_module
import backend.strategies.m26_keltner_channel_reversal as m26_module
import backend.strategies.m27_atr_volatility_expansion as m27_module
import backend.strategies.m28_session_open_range_breakout as m28_module
from backend.contracts import Candle, Direction, StrategyResult, SymbolSpec
from backend.core.config import Config
from backend.core.timeutil import UTC
from backend.strategies.configuration import (
    load_module_profile,
    validate_strategy_config,
)
from backend.strategies.m23_bollinger_squeeze_breakout import (
    BollingerSqueezeBreakout,
)
from backend.strategies.m24_bollinger_outer_reversion import (
    BollingerOuterReversion,
)
from backend.strategies.m25_vwap_deviation_touch import VwapDeviationTouch
from backend.strategies.m26_keltner_channel_reversal import KeltnerChannelReversal
from backend.strategies.m27_atr_volatility_expansion import AtrVolatilityExpansion
from backend.strategies.m28_session_open_range_breakout import (
    SessionOpenRangeBreakout,
)


SPEC = SymbolSpec(
    name="TEST.m",
    digits=5,
    point=0.00001,
    tick_size=0.00001,
    tick_value=1.0,
    contract_size=100000.0,
    volume_min=0.01,
    volume_max=100.0,
    volume_step=0.01,
    stops_level=0,
    freeze_level=0,
)


def _bars(count: int) -> list[Candle]:
    start = datetime(2026, 6, 8, 0, 0, tzinfo=UTC)
    values: list[Candle] = []
    close = 1.10000
    for index in range(count):
        drift = ((index % 17) - 8) * 0.00001
        open_price = close
        close = open_price + drift
        values.append(
            Candle(
                time=start + timedelta(minutes=15 * index),
                open=open_price,
                high=max(open_price, close) + 0.00020,
                low=min(open_price, close) - 0.00020,
                close=close,
                tick_volume=100 + index % 11,
                spread=12,
            )
        )
    return values


@pytest.fixture(scope="module")
def config() -> Config:
    return Config.load("config")


def test_approved_strategy_config_covers_every_module(config):
    validate_strategy_config(config)
    assert [load_module_profile(config, value).module_id for value in range(1, 29)] == list(
        range(1, 29)
    )


@pytest.mark.parametrize(
    "strategy_type",
    [
        BollingerSqueezeBreakout,
        BollingerOuterReversion,
        VwapDeviationTouch,
        KeltnerChannelReversal,
        AtrVolatilityExpansion,
        SessionOpenRangeBreakout,
    ],
)
def test_volatility_modules_are_deterministic_and_total(config, strategy_type):
    strategy = strategy_type.from_config(config)
    bars = _bars(max(strategy.min_bars, 192))
    first = strategy.evaluate(bars, SPEC)
    second = strategy.evaluate(bars, SPEC)
    assert isinstance(first, StrategyResult)
    assert first == second
    assert first.module_id == strategy.module_id
    assert 0.0 <= first.score <= 100.0
    if first.fired:
        assert first.direction in (Direction.BUY, Direction.SELL)
        assert first.evidence["min"] <= first.evidence["max"]
        assert len(first.evidence["quality_flags"]) == 3
    else:
        assert first.direction is Direction.NONE
        assert first.score == 0.0
        assert first.evidence == {}


@pytest.mark.parametrize(
    "strategy_type",
    [
        BollingerSqueezeBreakout,
        BollingerOuterReversion,
        VwapDeviationTouch,
        KeltnerChannelReversal,
        AtrVolatilityExpansion,
        SessionOpenRangeBreakout,
    ],
)
def test_volatility_modules_return_flat_on_short_window(config, strategy_type):
    strategy = strategy_type.from_config(config)
    result = strategy.evaluate(_bars(strategy.min_bars - 1), SPEC)
    assert result.fired is False
    assert result.direction is Direction.NONE
    assert result.score == 0.0
    assert result.evidence == {}


def test_m23_squeeze_percentile_boundary_and_just_outside(
    config, monkeypatch
):
    strategy = BollingerSqueezeBreakout.from_config(config)
    bars = _bars(strategy.min_bars)
    bars[-1] = bars[-1].model_copy(
        update={"open": 100.0, "high": 105.2, "low": 99.8, "close": 105.0}
    )

    def means(values, period):
        return [100.0] * len(values)

    def deviations(values, period):
        output = [1.0] * len(values)
        output[-1] = 2.0
        return output

    monkeypatch.setattr(m23_module, "sma", means)
    monkeypatch.setattr(m23_module, "rolling_population_std", deviations)
    monkeypatch.setattr(m23_module, "latest_atr", lambda *_: 1.0)
    monkeypatch.setattr(m23_module, "median_tick_volume", lambda *_: 100.0)
    monkeypatch.setattr(m23_module, "percentile_rank", lambda *_: 20.0)
    exact = strategy.evaluate(bars, SPEC)
    assert exact.fired is True
    assert exact.direction is Direction.BUY
    assert exact.evidence["indicators"]["previous_bandwidth_percentile"] == 20.0

    monkeypatch.setattr(m23_module, "percentile_rank", lambda *_: 20.000001)
    outside = strategy.evaluate(bars, SPEC)
    assert outside.fired is False

    monkeypatch.setattr(m23_module, "percentile_rank", lambda *_: 20.0)
    inside_bar = bars[-1].model_copy(
        update={"open": 100.0, "high": 100.2, "low": 99.8, "close": 100.0}
    )
    negative = strategy.evaluate(bars[:-1] + [inside_bar], SPEC)
    assert negative.fired is False


def test_m24_outer_band_touch_boundary_and_just_outside(config, monkeypatch):
    strategy = BollingerOuterReversion.from_config(config)
    bars = _bars(strategy.min_bars)
    monkeypatch.setattr(m24_module, "sma", lambda values, period: [100.0] * len(values))
    monkeypatch.setattr(
        m24_module,
        "rolling_population_std",
        lambda values, period: [1.0] * len(values),
    )
    monkeypatch.setattr(m24_module, "latest_atr", lambda *_: 1.0)
    monkeypatch.setattr(m24_module, "median_tick_volume", lambda *_: 100.0)

    exact_bar = bars[-1].model_copy(
        update={"open": 102.4, "high": 102.5, "low": 102.3, "close": 102.4}
    )
    exact = strategy.evaluate(bars[:-1] + [exact_bar], SPEC)
    assert exact.fired is True
    assert exact.direction is Direction.SELL
    assert exact.evidence["indicators"]["upper"] == pytest.approx(102.5)

    outside_bar = exact_bar.model_copy(update={"high": 102.499999})
    outside = strategy.evaluate(bars[:-1] + [outside_bar], SPEC)
    assert outside.fired is False


def _vwap_boundary_bars() -> tuple[list[Candle], float]:
    start = datetime(2026, 6, 8, 0, 0, tzinfo=UTC)
    bars: list[Candle] = []
    for index in range(20):
        value = 99.0 if index % 2 == 0 else 101.0
        bars.append(
            Candle(
                time=start + timedelta(minutes=15 * index),
                open=value,
                high=value,
                low=value,
                close=value,
                tick_volume=100,
                spread=12,
            )
        )
    sigma = math.sqrt(20.0 / 21.0)
    upper = 100.0 + 2.0 * sigma
    close = 99.5
    low = 300.0 - upper - close
    bars.append(
        Candle(
            time=start + timedelta(minutes=15 * 20),
            open=100.0,
            high=upper,
            low=low,
            close=close,
            tick_volume=100,
            spread=12,
        )
    )
    return bars, upper


def test_m25_vwap_outer_band_touch_boundary_and_just_outside(config):
    strategy = VwapDeviationTouch.from_config(config)
    bars, upper = _vwap_boundary_bars()
    exact = strategy.evaluate(bars, SPEC)
    assert exact.fired is True
    assert exact.direction is Direction.SELL
    assert exact.evidence["indicators"]["upper"] == pytest.approx(upper)
    assert bars[-1].high == pytest.approx(upper)

    epsilon = 0.000001
    outside_bar = bars[-1].model_copy(
        update={"high": upper - epsilon, "low": bars[-1].low + epsilon}
    )
    outside = strategy.evaluate(bars[:-1] + [outside_bar], SPEC)
    assert outside.fired is False


def test_m26_keltner_touch_boundary_and_just_outside(config, monkeypatch):
    strategy = KeltnerChannelReversal.from_config(config)
    bars = _bars(strategy.min_bars)
    replacements = (
        (100.0, 100.0),
        (100.0, 101.0),
        (101.0, 101.6),
        (101.6, 101.9),
    )
    for index, (open_price, close) in zip(range(len(bars) - 4, len(bars)), replacements):
        bars[index] = bars[index].model_copy(
            update={
                "open": open_price,
                "high": max(open_price, close) + 0.2,
                "low": min(open_price, close) - 0.2,
                "close": close,
            }
        )
    monkeypatch.setattr(m26_module, "ema", lambda values, period: [100.0] * len(values))
    monkeypatch.setattr(m26_module, "atr", lambda candles, period: [1.0] * len(candles))
    monkeypatch.setattr(m26_module, "median_tick_volume", lambda *_: 100.0)

    exact_bar = bars[-1].model_copy(update={"high": 102.0})
    exact = strategy.evaluate(bars[:-1] + [exact_bar], SPEC)
    assert exact.fired is True
    assert exact.direction is Direction.SELL
    assert exact.evidence["indicators"]["upper"] == pytest.approx(102.0)

    outside_bar = exact_bar.model_copy(update={"high": 101.999999})
    outside = strategy.evaluate(bars[:-1] + [outside_bar], SPEC)
    assert outside.fired is False

    not_slowing = bars.copy()
    not_slowing[-1] = not_slowing[-1].model_copy(
        update={"open": 101.6, "high": 102.2, "low": 101.4, "close": 102.0}
    )
    negative = strategy.evaluate(not_slowing, SPEC)
    assert negative.fired is False


def _atr_expansion_bars(count: int, close: float) -> list[Candle]:
    start = datetime(2026, 6, 8, 0, 0, tzinfo=UTC)
    bars = [
        Candle(
            time=start + timedelta(minutes=15 * index),
            open=100.0,
            high=101.0,
            low=99.0,
            close=100.0,
            tick_volume=100,
            spread=12,
        )
        for index in range(count)
    ]
    bars[-1] = bars[-1].model_copy(
        update={"open": 100.0, "high": max(close, 101.0) + 0.1, "close": close}
    )
    return bars


def test_m27_atr_expansion_ratio_boundary_and_just_outside(config, monkeypatch):
    strategy = AtrVolatilityExpansion.from_config(config)
    bars = _atr_expansion_bars(strategy.min_bars, 101.2)
    monkeypatch.setattr(m27_module, "median_tick_volume", lambda *_: 100.0)

    def atr_values(current):
        values = [1.0] * len(bars)
        values[-1] = current
        return values

    monkeypatch.setattr(m27_module, "atr", lambda *_: atr_values(1.5))
    exact = strategy.evaluate(bars, SPEC)
    assert exact.fired is True
    assert exact.direction is Direction.BUY
    assert exact.evidence["indicators"]["atr_ratio"] == pytest.approx(1.5)

    monkeypatch.setattr(m27_module, "atr", lambda *_: atr_values(1.499999))
    outside = strategy.evaluate(bars, SPEC)
    assert outside.fired is False

    monkeypatch.setattr(m27_module, "atr", lambda *_: atr_values(1.5))
    negative = strategy.evaluate(_atr_expansion_bars(strategy.min_bars, 100.0), SPEC)
    assert negative.fired is False


def _session_boundary_bars(close: float) -> list[Candle]:
    start = datetime(2026, 6, 8, 3, 0, tzinfo=UTC)
    bars = [
        Candle(
            time=start + timedelta(minutes=15 * index),
            open=100.0,
            high=101.0,
            low=99.0,
            close=100.0,
            tick_volume=100,
            spread=12,
        )
        for index in range(20)
    ]
    bars[-1] = bars[-1].model_copy(
        update={"open": 100.0, "high": max(close, 101.0) + 0.1, "close": close}
    )
    return bars


def test_m28_break_buffer_is_strict_at_boundary_and_fires_just_beyond(
    config, monkeypatch
):
    strategy = SessionOpenRangeBreakout.from_config(config)
    monkeypatch.setattr(m28_module, "atr", lambda bars, period: [1.0] * len(bars))
    exact = strategy.evaluate(_session_boundary_bars(101.05), SPEC)
    assert exact.fired is False

    beyond = strategy.evaluate(_session_boundary_bars(101.050001), SPEC)
    assert beyond.fired is True
    assert beyond.direction is Direction.BUY
    indicators = beyond.evidence["indicators"]
    assert indicators["opening_range_high"] == pytest.approx(101.0)
