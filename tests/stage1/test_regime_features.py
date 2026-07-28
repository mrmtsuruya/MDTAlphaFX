"""Focused §3.1 feature computation tests.

These tests pin indicator conventions that otherwise differ subtly between
libraries: Wilder seeds, SMA-seeded EMAs, slope-aware alignment, average-rank
ATR percentile, and close-on-index R².
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from backend.contracts import Candle
from backend.regime import (
    NewsBlackoutFlags,
    RegimeFeatureConfig,
    compute_regime_inputs,
)
from backend.regime.classifier import RegimeInputs


UTC = timezone.utc
FULL_CONFIG = RegimeFeatureConfig(
    adx_period=14,
    ema_periods=(20, 50, 200),
    atr_period=14,
    atr_percentile_lookback=100,
    r_squared_bars=50,
)
SMALL_CONFIG = RegimeFeatureConfig(
    adx_period=3,
    ema_periods=(2, 3, 5),
    atr_period=3,
    atr_percentile_lookback=4,
    r_squared_bars=4,
)


def _trend_bars(
    count: int,
    *,
    step: float = 1.0,
    first_close: float = 100.0,
    range_size=lambda _index: 1.0,
    start: datetime = datetime(2025, 1, 1, tzinfo=UTC),
) -> list[Candle]:
    result = []
    previous_close = first_close - step
    for index in range(count):
        close = first_close + index * step
        radius = float(range_size(index))
        result.append(
            Candle(
                time=start + timedelta(hours=index),
                open=previous_close,
                high=max(previous_close, close) + radius,
                low=min(previous_close, close) - radius,
                close=close,
                tick_volume=100,
                spread=2,
            )
        )
        previous_close = close
    return result


def _constant_bars(count: int, close: float = 100.0) -> list[Candle]:
    start = datetime(2025, 1, 1, tzinfo=UTC)
    return [
        Candle(
            time=start + timedelta(hours=index),
            open=close,
            high=close + 1.0,
            low=close - 1.0,
            close=close,
            tick_volume=100,
            spread=2,
        )
        for index in range(count)
    ]


def test_full_config_warms_up_one_output_per_bar_and_first_readiness_is_index_200():
    bars = _trend_bars(230)
    outputs = compute_regime_inputs(
        bars,
        NewsBlackoutFlags.no_blackouts(len(bars)),
        FULL_CONFIG,
    )

    assert len(outputs) == len(bars)
    assert all(value is None for value in outputs[:200])
    assert isinstance(outputs[200], RegimeInputs)
    assert all(isinstance(value, RegimeInputs) for value in outputs[200:])


def test_small_periods_pin_each_warmup_convention_at_index_five():
    """EMA slope, ATR lookback and Wilder ADX all first coexist at index five."""

    bars = _trend_bars(8)
    outputs = compute_regime_inputs(
        bars,
        NewsBlackoutFlags.no_blackouts(len(bars)),
        SMALL_CONFIG,
    )

    assert outputs[:5] == (None,) * 5
    assert outputs[5] is not None


def test_clean_linear_uptrend_has_adx_100_bullish_alignment_and_r_squared_one():
    bars = _trend_bars(230)
    latest = compute_regime_inputs(
        bars,
        NewsBlackoutFlags.no_blackouts(len(bars)),
        FULL_CONFIG,
    )[-1]

    assert latest is not None
    assert latest.adx == pytest.approx(100.0)
    assert latest.ema_stack_aligned is True
    assert latest.ema_stack_bullish is True
    assert latest.r_squared == pytest.approx(1.0)


def test_clean_linear_downtrend_has_adx_100_and_bearish_alignment():
    bars = _trend_bars(230, step=-1.0, first_close=500.0)
    latest = compute_regime_inputs(
        bars,
        NewsBlackoutFlags.no_blackouts(len(bars)),
        FULL_CONFIG,
    )[-1]

    assert latest is not None
    assert latest.adx == pytest.approx(100.0)
    assert latest.ema_stack_aligned is True
    assert latest.ema_stack_bullish is False
    assert latest.r_squared == pytest.approx(1.0)


def test_ema_order_without_matching_slopes_is_not_aligned():
    """A mature bullish ordering must not survive after all slopes stop agreeing."""

    bars = _trend_bars(220)
    for _ in range(5):
        previous = bars[-1]
        close = previous.close - 2.0
        bars.append(
            Candle(
                time=previous.time + timedelta(hours=1),
                open=previous.close,
                high=previous.close + 1.0,
                low=close - 1.0,
                close=close,
                tick_volume=100,
                spread=2,
            )
        )

    outputs = compute_regime_inputs(
        bars,
        NewsBlackoutFlags.no_blackouts(len(bars)),
        FULL_CONFIG,
    )

    assert outputs[219] is not None
    assert outputs[219].ema_stack_aligned is True
    assert outputs[-1] is not None
    assert outputs[-1].ema_stack_aligned is False
    assert outputs[-1].ema_stack_bullish is False


def test_constant_atr_window_uses_neutral_average_rank_not_false_extreme():
    bars = _trend_bars(230)
    latest = compute_regime_inputs(
        bars,
        NewsBlackoutFlags.no_blackouts(len(bars)),
        FULL_CONFIG,
    )[-1]

    assert latest is not None
    assert latest.atr_percentile == pytest.approx(50.5)


def test_new_maximum_atr_is_the_hundredth_percentile():
    bars = _trend_bars(230, range_size=lambda index: 1.0 + index / 100.0)
    latest = compute_regime_inputs(
        bars,
        NewsBlackoutFlags.no_blackouts(len(bars)),
        FULL_CONFIG,
    )[-1]

    assert latest is not None
    assert latest.atr_percentile == pytest.approx(100.0)


def test_constant_close_has_zero_trend_cleanliness_and_no_ema_alignment():
    bars = _constant_bars(230)
    latest = compute_regime_inputs(
        bars,
        NewsBlackoutFlags.no_blackouts(len(bars)),
        FULL_CONFIG,
    )[-1]

    assert latest is not None
    assert latest.adx == pytest.approx(0.0)
    assert latest.r_squared == pytest.approx(0.0)
    assert latest.ema_stack_aligned is False
    assert latest.ema_stack_bullish is False


def test_blackout_flags_are_explicit_and_propagated_per_ready_bar():
    bars = _trend_bars(205)
    flags = [False] * len(bars)
    flags[200] = True
    outputs = compute_regime_inputs(
        bars,
        NewsBlackoutFlags(tuple(flags)),
        FULL_CONFIG,
    )

    assert outputs[200] is not None
    assert outputs[200].within_news_blackout is True
    assert outputs[201] is not None
    assert outputs[201].within_news_blackout is False


def test_blackout_flags_have_no_silent_false_default():
    bars = _trend_bars(8)

    with pytest.raises(TypeError):
        compute_regime_inputs(bars, config=SMALL_CONFIG)  # type: ignore[call-arg]
    with pytest.raises(TypeError, match="explicit NewsBlackoutFlags"):
        compute_regime_inputs(bars, [False] * len(bars), SMALL_CONFIG)  # type: ignore[arg-type]


def test_blackout_flags_require_real_booleans_and_exact_bar_count():
    with pytest.raises(TypeError, match="must be bool"):
        NewsBlackoutFlags((False, 0, True))  # type: ignore[arg-type]

    bars = _trend_bars(8)
    with pytest.raises(ValueError, match="exactly match"):
        compute_regime_inputs(
            bars,
            NewsBlackoutFlags.no_blackouts(len(bars) - 1),
            SMALL_CONFIG,
        )


@pytest.mark.parametrize(
    "kwargs",
    [
        {"adx_period": 0},
        {"ema_periods": (20, 20, 200)},
        {"ema_periods": (20, 50)},
        {"atr_period": -1},
        {"atr_percentile_lookback": 0},
        {"r_squared_bars": True},
    ],
)
def test_invalid_indicator_periods_fail_loudly(kwargs):
    values = {
        "adx_period": 14,
        "ema_periods": (20, 50, 200),
        "atr_period": 14,
        "atr_percentile_lookback": 100,
        "r_squared_bars": 50,
    }
    values.update(kwargs)
    with pytest.raises(ValueError):
        RegimeFeatureConfig(**values)


def test_candles_must_be_strictly_ordered_utc_and_geometrically_valid():
    bars = _trend_bars(8)

    naive = bars.copy()
    naive[0] = naive[0].model_copy(
        update={"time": naive[0].time.replace(tzinfo=None)}
    )
    with pytest.raises(ValueError, match="timezone-aware UTC"):
        compute_regime_inputs(
            naive,
            NewsBlackoutFlags.no_blackouts(len(naive)),
            SMALL_CONFIG,
        )

    non_utc = bars.copy()
    non_utc[0] = non_utc[0].model_copy(
        update={"time": non_utc[0].time.astimezone(timezone(timedelta(hours=8)))}
    )
    with pytest.raises(ValueError, match="timezone-aware UTC"):
        compute_regime_inputs(
            non_utc,
            NewsBlackoutFlags.no_blackouts(len(non_utc)),
            SMALL_CONFIG,
        )

    duplicated = bars.copy()
    duplicated[1] = duplicated[1].model_copy(update={"time": duplicated[0].time})
    with pytest.raises(ValueError, match="strictly increasing"):
        compute_regime_inputs(
            duplicated,
            NewsBlackoutFlags.no_blackouts(len(duplicated)),
            SMALL_CONFIG,
        )

    invalid_ohlc = bars.copy()
    invalid_ohlc[0] = invalid_ohlc[0].model_copy(
        update={"high": invalid_ohlc[0].low - 1.0}
    )
    with pytest.raises(ValueError, match="high is below low"):
        compute_regime_inputs(
            invalid_ohlc,
            NewsBlackoutFlags.no_blackouts(len(invalid_ohlc)),
            SMALL_CONFIG,
        )


def test_computation_is_deterministic_and_does_not_mutate_inputs():
    bars = _trend_bars(230)
    snapshots = [bar.model_dump() for bar in bars]
    flags = NewsBlackoutFlags.no_blackouts(len(bars))

    first = compute_regime_inputs(bars, flags, FULL_CONFIG)
    second = compute_regime_inputs(bars, flags, FULL_CONFIG)

    assert first == second
    assert [bar.model_dump() for bar in bars] == snapshots


def test_empty_explicit_input_returns_empty_output():
    assert (
        compute_regime_inputs(
            [],
            NewsBlackoutFlags.no_blackouts(0),
            SMALL_CONFIG,
        )
        == ()
    )
