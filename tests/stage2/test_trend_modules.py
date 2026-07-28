"""Focused synthetic gates for approved Stage 2 modules 17–22."""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

import backend.strategies.m17_triple_ema_alignment as m17_module
import backend.strategies.m18_ema_dynamic_pullback as m18_module
import backend.strategies.m20_regular_rsi_divergence as m20_module
import backend.strategies.m21_adx_trend_acceleration as m21_module
import backend.strategies.m22_supertrend_directional_flip as m22_module
from backend.contracts import Candle, Direction
from backend.core.timeutil import UTC
from backend.strategies.common import Pivot
from backend.strategies.m17_triple_ema_alignment import TripleEmaAlignment
from backend.strategies.m18_ema_dynamic_pullback import EmaDynamicPullback
from backend.strategies.m19_macd_zero_line_crossover import (
    MacdZeroLineCrossover,
)
from backend.strategies.m20_regular_rsi_divergence import RegularRsiDivergence
from backend.strategies.m21_adx_trend_acceleration import AdxTrendAcceleration
from backend.strategies.m22_supertrend_directional_flip import (
    SupertrendDirectionalFlip,
)
from tests.doubles import real_config, spec_for_tests


START = datetime(2026, 1, 5, tzinfo=UTC)
SPEC = spec_for_tests()


def _bars(
    closes: list[float],
    *,
    volumes: list[int] | None = None,
    pad: float = 0.2,
) -> list[Candle]:
    result: list[Candle] = []
    previous = closes[0]
    for index, close in enumerate(closes):
        open_price = previous if index else close - pad
        result.append(
            Candle(
                time=START + timedelta(minutes=15 * index),
                open=open_price,
                high=max(open_price, close) + pad,
                low=min(open_price, close) - pad,
                close=close,
                tick_volume=volumes[index] if volumes is not None else 100,
                spread=20,
            )
        )
        previous = close
    return result


def _module(module_type):
    config = real_config()
    return module_type(module_type.profile_from_config(config))


def _first_fire(module, bars: list[Candle]):
    for end in range(module.min_bars, len(bars) + 1):
        result = module.evaluate(bars[:end], SPEC)
        if result.fired:
            return result
    pytest.fail(f"module {module.module_id} did not fire on its positive fixture")


@pytest.mark.parametrize(
    "module_type",
    [
        TripleEmaAlignment,
        EmaDynamicPullback,
        MacdZeroLineCrossover,
        RegularRsiDivergence,
        AdxTrendAcceleration,
        SupertrendDirectionalFlip,
    ],
)
def test_short_windows_are_total_and_non_firing(module_type):
    module = _module(module_type)
    bars = _bars([100.0] * module.min_bars)
    result = module.evaluate(bars[:-1], SPEC)
    assert result.fired is False
    assert result.direction is Direction.NONE
    assert result.score == 0.0
    assert result.evidence == {}


def test_m17_strict_alignment_is_the_single_continuous_state_detector():
    module = _module(TripleEmaAlignment)
    bars = _bars([100.0 + index * 0.5 for index in range(210)])

    first = module.evaluate(bars[:-1], SPEC)
    second = module.evaluate(bars, SPEC)

    assert first.fired is True
    assert second.fired is True
    assert second.direction is Direction.BUY
    assert second.evidence["quality_flags"] == [True, True, True]
    assert second.evidence["min"] <= second.evidence["max"]
    assert second == module.evaluate(bars, SPEC)


def test_m18_fires_on_first_ema20_pullback_and_emits_the_touch_zone():
    volumes = [100] * 204 + [300]
    bars = _bars(
        [100.0 + index * 0.5 for index in range(205)],
        volumes=volumes,
    )
    last = bars[-1]
    bars[-1] = last.model_copy(update={"low": last.close - 7.0})
    result = _module(EmaDynamicPullback).evaluate(bars, SPEC)

    assert result.fired is True
    assert result.direction is Direction.BUY
    assert result.evidence["geometry"][0]["ema_period"] == 20
    assert result.evidence["quality_flags"] == [True, True, True]
    assert result.evidence["min"] <= result.evidence["max"]


def test_m19_macd_zero_cross_is_directional_and_event_only():
    closes = (
        [120.0 - index * 0.4 for index in range(50)]
        + [100.0 + index * 0.8 for index in range(50)]
    )
    result = _first_fire(_module(MacdZeroLineCrossover), _bars(closes))

    assert result.direction is Direction.BUY
    assert result.evidence["indicators"]["previous_macd"] <= 0.0
    assert result.evidence["indicators"]["macd"] > 0.0
    assert result.evidence["min"] <= result.evidence["max"]


def test_m20_regular_bearish_divergence_uses_confirmed_pivots():
    closes = (
        [100.0 + index for index in range(25)]
        + [123.0 - index for index in range(15)]
        + [109.0 + (17.0 / 14.0) * index for index in range(15)]
        + [124.0, 122.0]
    )
    bars = _bars(closes)
    bars[24] = bars[24].model_copy(update={"high": 125.0})
    bars[54] = bars[54].model_copy(update={"high": 127.0})
    result = _module(RegularRsiDivergence).evaluate(bars, SPEC)

    assert result.fired is True
    assert result.direction is Direction.SELL
    indicators = result.evidence["indicators"]
    assert indicators["price_extension_atr"] > 0.0
    assert indicators["prior_rsi"] > indicators["latest_rsi"]
    assert result.evidence["min"] <= result.evidence["max"]


def test_m21_adx_cross_uses_di_for_direction():
    closes = [100.0] * 50 + [101.0 + index for index in range(50)]
    result = _first_fire(_module(AdxTrendAcceleration), _bars(closes, pad=0.5))

    indicators = result.evidence["indicators"]
    assert result.direction is Direction.BUY
    assert indicators["previous_adx"] <= 25.0 < indicators["adx"]
    assert indicators["plus_di"] > indicators["minus_di"]
    assert result.evidence["min"] <= result.evidence["max"]


def test_m22_canonical_final_band_fires_only_on_the_flip_bar():
    closes = (
        [100.0 + index * 0.8 for index in range(40)]
        + [131.2 - (index + 1) * 1.2 for index in range(30)]
    )
    module = _module(SupertrendDirectionalFlip)
    bars = _bars(closes, pad=0.5)
    result = _first_fire(module, bars)

    assert result.direction in (Direction.BUY, Direction.SELL)
    assert result.evidence["overlay_type"] == "HAIRLINE"
    assert result.evidence["min"] == result.evidence["max"]
    assert result.evidence["stop_anchor"]["type"] == "SUPERTREND_BAND"


@pytest.mark.parametrize(
    ("module_type", "bars_factory"),
    [
        (TripleEmaAlignment, lambda count: _bars([100.0] * count)),
        (
            EmaDynamicPullback,
            lambda count: _bars([100.0 + index * 0.5 for index in range(count)]),
        ),
        (
            MacdZeroLineCrossover,
            lambda count: _bars([100.0 + index * 0.5 for index in range(count)]),
        ),
        (
            RegularRsiDivergence,
            lambda count: _bars([100.0 + index * 0.2 for index in range(count)]),
        ),
        (AdxTrendAcceleration, lambda count: _bars([100.0] * count, pad=0.5)),
        (
            SupertrendDirectionalFlip,
            lambda count: _bars([100.0 + index * 0.5 for index in range(count)]),
        ),
    ],
)
def test_trend_modules_have_explicit_full_window_negative_fixtures(
    module_type, bars_factory
):
    module = _module(module_type)
    result = module.evaluate(bars_factory(module.min_bars + 10), SPEC)
    assert result.fired is False
    assert result.direction is Direction.NONE
    assert result.evidence == {}


def test_m17_approved_separation_boundaries_are_inclusive(monkeypatch):
    module = _module(TripleEmaAlignment)
    bars = _bars([100.0] * module.min_bars)
    values = {
        20: (100.7, 100.6),
        50: (100.5, 100.4),
        200: (100.0, 99.9),
    }

    def exact_ema(closes, period):
        current, prior = values[period]
        output = [current] * len(closes)
        output[-1 - module.slope_bars] = prior
        return output

    monkeypatch.setattr(m17_module, "ema", exact_ema)
    monkeypatch.setattr(m17_module, "latest_atr", lambda *_: 1.0)
    exact = module.evaluate(bars, SPEC)
    assert exact.fired is True
    assert exact.evidence["quality_flags"][:2] == [True, True]
    assert exact.evidence["indicators"]["fast_middle_separation_atr"] == pytest.approx(
        0.20
    )
    assert exact.evidence["indicators"]["middle_slow_separation_atr"] == pytest.approx(
        0.50
    )

    values[20] = (100.699999, 100.6)
    outside = module.evaluate(bars, SPEC)
    assert outside.fired is True
    assert outside.evidence["quality_flags"][0] is False


def test_m18_touch_tolerance_fires_at_boundary_and_not_just_outside(monkeypatch):
    module = _module(EmaDynamicPullback)
    bars = _bars([101.0] * module.min_bars)

    def fixed_ema(closes, period):
        level = {20: 100.0, 50: 90.0, 200: 80.0}[period]
        return [level] * len(closes)

    monkeypatch.setattr(m18_module, "ema", fixed_ema)
    monkeypatch.setattr(m18_module, "atr", lambda candles, period: [1.0] * len(candles))
    exact_bar = bars[-1].model_copy(
        update={"open": 100.2, "high": 100.3, "low": 100.1, "close": 100.2}
    )
    exact = module.evaluate(bars[:-1] + [exact_bar], SPEC)
    assert exact.fired is True
    assert exact.direction is Direction.BUY

    outside_bar = exact_bar.model_copy(update={"low": 100.100001})
    outside = module.evaluate(bars[:-1] + [outside_bar], SPEC)
    assert outside.fired is False


def test_m19_zero_cross_accepts_exact_zero_and_rejects_positive_prior(
    monkeypatch,
):
    module = _module(MacdZeroLineCrossover)
    bars = _bars([100.0] * module.min_bars)

    def series_with_previous(previous):
        macd = [None] * len(bars)
        signal = [None] * len(bars)
        macd[-2], macd[-1], signal[-1] = previous, 0.01, 0.0
        return macd, signal

    monkeypatch.setattr(module, "_series", lambda closes: series_with_previous(0.0))
    exact = module.evaluate(bars, SPEC)
    assert exact.fired is True
    assert exact.direction is Direction.BUY

    monkeypatch.setattr(
        module, "_series", lambda closes: series_with_previous(0.000001)
    )
    outside = module.evaluate(bars, SPEC)
    assert outside.fired is False


def test_m20_minimum_divergence_and_price_extension_boundaries(monkeypatch):
    module = _module(RegularRsiDivergence)
    bars = _bars([100.0] * module.min_bars)
    confirmation_index = len(bars) - 1 - module.pivot_right
    pivots = [
        Pivot(10, bars[10].time.isoformat(), 100.0),
        Pivot(
            confirmation_index,
            bars[confirmation_index].time.isoformat(),
            100.0625,
        ),
    ]
    monkeypatch.setattr(m20_module, "latest_atr", lambda *_: 1.25)
    monkeypatch.setattr(m20_module, "confirmed_pivot_highs", lambda *_: pivots)
    monkeypatch.setattr(m20_module, "confirmed_pivot_lows", lambda *_: [])

    def rsi_values(latest):
        values = [None] * len(bars)
        values[10] = 70.0
        values[confirmation_index] = latest
        return values

    monkeypatch.setattr(m20_module, "rsi", lambda *_: rsi_values(65.0))
    exact = module.evaluate(bars, SPEC)
    assert exact.fired is True
    assert exact.direction is Direction.SELL
    assert exact.evidence["indicators"]["price_extension_atr"] == pytest.approx(
        0.05
    )
    assert exact.evidence["indicators"]["rsi_divergence_points"] == pytest.approx(
        5.0
    )

    monkeypatch.setattr(m20_module, "rsi", lambda *_: rsi_values(65.000001))
    outside = module.evaluate(bars, SPEC)
    assert outside.fired is False


def test_m21_adx_trigger_accepts_exact_previous_boundary(monkeypatch):
    module = _module(AdxTrendAcceleration)
    bars = _bars([100.0] * module.min_bars, pad=0.5)

    def adx_values(previous):
        adx = [None] * len(bars)
        plus = [None] * len(bars)
        minus = [None] * len(bars)
        adx[-2], adx[-1] = previous, 26.0
        plus[-1], minus[-1] = 20.0, 10.0
        return adx, plus, minus

    monkeypatch.setattr(m21_module, "adx_di", lambda *_: adx_values(25.0))
    monkeypatch.setattr(m21_module, "latest_atr", lambda *_: 1.0)
    exact = module.evaluate(bars, SPEC)
    assert exact.fired is True
    assert exact.direction is Direction.BUY

    monkeypatch.setattr(m21_module, "adx_di", lambda *_: adx_values(25.000001))
    outside = module.evaluate(bars, SPEC)
    assert outside.fired is False


def test_m22_close_beyond_band_confirmation_is_inclusive(monkeypatch):
    module = _module(SupertrendDirectionalFlip)
    bars = _bars([100.0] * module.min_bars, pad=0.5)

    def points():
        values = [None] * len(bars)
        values[-2] = m22_module._SupertrendPoint(
            Direction.SELL, 101.0, 99.0, 1.0
        )
        values[-1] = m22_module._SupertrendPoint(
            Direction.BUY, 99.0, 100.0, 1.0
        )
        return values

    monkeypatch.setattr(module, "_series", lambda _: points())
    exact_bar = bars[-1].model_copy(
        update={"open": 100.0, "high": 100.5, "low": 99.5, "close": 100.25}
    )
    exact = module.evaluate(bars[:-1] + [exact_bar], SPEC)
    assert exact.fired is True
    assert exact.evidence["quality_flags"][1] is True
    assert exact.evidence["indicators"]["close_beyond_band_atr"] == pytest.approx(
        0.25
    )

    outside_bar = exact_bar.model_copy(update={"close": 100.249999})
    outside = module.evaluate(bars[:-1] + [outside_bar], SPEC)
    assert outside.fired is True
    assert outside.evidence["quality_flags"][1] is False
