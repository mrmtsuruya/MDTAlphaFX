"""Pure §3.1 market-regime feature computation.

The caller supplies closed candles, indicator periods, and one explicit news
blackout flag per bar. No configuration file, clock, network, or other mutable
state is read here.

Numerical conventions are deliberately explicit:

* ADX is Wilder's smoothing, first available after ``2 * period`` directional
  observations (bar index ``2 * period - 1``).
* EMA series are seeded with their period SMA. Alignment requires strict
  fast/middle/slow ordering and all three one-bar slopes to point the same way.
* ATR is Wilder's smoothing, seeded from the first ``period`` true ranges.
* ATR percentile is the average rank of the current ATR inside the trailing
  window, including the current bar. Average rank makes a tied/constant window
  neutral instead of falsely assigning it the 100th percentile.
* R² is the squared Pearson correlation of close against bar index over the
  trailing window. A constant close series has no trend and returns zero.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import timedelta

from ..contracts import Candle
from .classifier import RegimeInputs


@dataclass(frozen=True)
class RegimeFeatureConfig:
    """Caller-owned §3.1 indicator periods.

    No defaults live in computation code. Production constructs this from the
    versioned configuration; tests and replays inject the exact periods they
    intend to evaluate.
    """

    adx_period: int
    ema_periods: tuple[int, int, int]
    atr_period: int
    atr_percentile_lookback: int
    r_squared_bars: int

    def __post_init__(self) -> None:
        periods = tuple(self.ema_periods)
        object.__setattr__(self, "ema_periods", periods)

        integer_fields = {
            "adx_period": self.adx_period,
            "atr_period": self.atr_period,
            "atr_percentile_lookback": self.atr_percentile_lookback,
            "r_squared_bars": self.r_squared_bars,
        }
        for name, value in integer_fields.items():
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{name} must be a positive integer")

        if len(periods) != 3:
            raise ValueError("ema_periods must contain fast, middle and slow periods")
        if any(
            isinstance(period, bool)
            or not isinstance(period, int)
            or period < 1
            for period in periods
        ):
            raise ValueError("ema_periods must contain positive integers")
        if not periods[0] < periods[1] < periods[2]:
            raise ValueError("ema_periods must be strictly increasing")


@dataclass(frozen=True)
class NewsBlackoutFlags:
    """One explicit economic-calendar blackout decision per candle."""

    values: tuple[bool, ...]

    def __post_init__(self) -> None:
        values = tuple(self.values)
        if any(type(value) is not bool for value in values):
            raise TypeError("news blackout flags must be bool values")
        object.__setattr__(self, "values", values)

    @classmethod
    def no_blackouts(cls, bar_count: int) -> "NewsBlackoutFlags":
        """Explicitly opt into a no-blackout replay/test series."""

        if isinstance(bar_count, bool) or not isinstance(bar_count, int) or bar_count < 0:
            raise ValueError("bar_count must be a non-negative integer")
        return cls((False,) * bar_count)


def _validate_candles(candles: Sequence[Candle]) -> tuple[Candle, ...]:
    bars = tuple(candles)
    previous_time = None
    for index, bar in enumerate(bars):
        if not isinstance(bar, Candle):
            raise TypeError(f"candles[{index}] must be a Candle")
        if bar.time.tzinfo is None or bar.time.utcoffset() != timedelta(0):
            raise ValueError(f"candles[{index}].time must be timezone-aware UTC")
        if previous_time is not None and bar.time <= previous_time:
            raise ValueError("candles must be in strictly increasing time order")
        previous_time = bar.time

        prices = {
            "open": bar.open,
            "high": bar.high,
            "low": bar.low,
            "close": bar.close,
        }
        for name, value in prices.items():
            if isinstance(value, bool) or not math.isfinite(float(value)):
                raise ValueError(f"candles[{index}].{name} must be finite")
        if bar.high < bar.low:
            raise ValueError(f"candles[{index}] high is below low")
        if bar.high < max(bar.open, bar.close):
            raise ValueError(f"candles[{index}] high does not contain its body")
        if bar.low > min(bar.open, bar.close):
            raise ValueError(f"candles[{index}] low does not contain its body")
    return bars


def _true_ranges(bars: Sequence[Candle]) -> list[float]:
    if not bars:
        return []
    result = [float(bars[0].high - bars[0].low)]
    for previous, current in zip(bars, bars[1:]):
        result.append(
            max(
                float(current.high - current.low),
                abs(float(current.high - previous.close)),
                abs(float(current.low - previous.close)),
            )
        )
    return result


def _wilder_average(values: Sequence[float], period: int) -> list[float | None]:
    """Wilder average seeded at ``period - 1`` from the first period values."""

    result: list[float | None] = [None] * len(values)
    if len(values) < period:
        return result
    current = sum(values[:period]) / period
    result[period - 1] = current
    for index in range(period, len(values)):
        current = ((period - 1) * current + values[index]) / period
        result[index] = current
    return result


def _ema(values: Sequence[float], period: int) -> list[float | None]:
    """SMA-seeded exponential moving average."""

    result: list[float | None] = [None] * len(values)
    if len(values) < period:
        return result
    current = sum(values[:period]) / period
    result[period - 1] = current
    smoothing = 2.0 / (period + 1.0)
    for index in range(period, len(values)):
        current = smoothing * values[index] + (1.0 - smoothing) * current
        result[index] = current
    return result


def _adx(bars: Sequence[Candle], period: int) -> list[float | None]:
    """Wilder ADX with first value at index ``2 * period - 1``."""

    count = len(bars)
    result: list[float | None] = [None] * count
    if count <= period:
        return result

    true_range = [0.0] * count
    plus_dm = [0.0] * count
    minus_dm = [0.0] * count
    for index in range(1, count):
        previous = bars[index - 1]
        current = bars[index]
        true_range[index] = max(
            float(current.high - current.low),
            abs(float(current.high - previous.close)),
            abs(float(current.low - previous.close)),
        )
        up_move = float(current.high - previous.high)
        down_move = float(previous.low - current.low)
        plus_dm[index] = up_move if up_move > down_move and up_move > 0.0 else 0.0
        minus_dm[index] = (
            down_move if down_move > up_move and down_move > 0.0 else 0.0
        )

    smoothed_tr = sum(true_range[1 : period + 1])
    smoothed_plus = sum(plus_dm[1 : period + 1])
    smoothed_minus = sum(minus_dm[1 : period + 1])
    dx: list[float | None] = [None] * count

    def directional_index() -> float:
        if smoothed_tr == 0.0:
            return 0.0
        plus_di = 100.0 * smoothed_plus / smoothed_tr
        minus_di = 100.0 * smoothed_minus / smoothed_tr
        total = plus_di + minus_di
        return 0.0 if total == 0.0 else 100.0 * abs(plus_di - minus_di) / total

    dx[period] = directional_index()
    for index in range(period + 1, count):
        smoothed_tr = (
            smoothed_tr - smoothed_tr / period + true_range[index]
        )
        smoothed_plus = (
            smoothed_plus - smoothed_plus / period + plus_dm[index]
        )
        smoothed_minus = (
            smoothed_minus - smoothed_minus / period + minus_dm[index]
        )
        dx[index] = directional_index()

    first_adx_index = 2 * period - 1
    if count <= first_adx_index:
        return result
    seed = [value for value in dx[period : first_adx_index + 1] if value is not None]
    current_adx = sum(seed) / period
    result[first_adx_index] = current_adx
    for index in range(first_adx_index + 1, count):
        current_dx = dx[index]
        assert current_dx is not None
        current_adx = ((period - 1) * current_adx + current_dx) / period
        result[index] = current_adx
    return result


def _average_rank_percentiles(
    values: Sequence[float | None], lookback: int
) -> list[float | None]:
    """Trailing average-rank percentiles, including the current observation."""

    result: list[float | None] = [None] * len(values)
    ready_values: list[float] = []
    for index, value in enumerate(values):
        if value is None:
            continue
        ready_values.append(value)
        if len(ready_values) < lookback:
            continue
        window = ready_values[-lookback:]
        less = sum(candidate < value for candidate in window)
        equal = sum(candidate == value for candidate in window)
        average_rank = less + (equal + 1.0) / 2.0
        result[index] = 100.0 * average_rank / lookback
    return result


def _r_squared(values: Sequence[float], window: int) -> list[float | None]:
    """Rolling close-on-index linear-regression R²."""

    result: list[float | None] = [None] * len(values)
    if len(values) < window:
        return result
    x_mean = (window - 1) / 2.0
    x_variance = sum((index - x_mean) ** 2 for index in range(window))
    for end in range(window - 1, len(values)):
        sample = values[end - window + 1 : end + 1]
        y_mean = sum(sample) / window
        y_variance = sum((value - y_mean) ** 2 for value in sample)
        if y_variance == 0.0:
            result[end] = 0.0
            continue
        covariance = sum(
            (index - x_mean) * (value - y_mean)
            for index, value in enumerate(sample)
        )
        result[end] = max(
            0.0,
            min(1.0, covariance * covariance / (x_variance * y_variance)),
        )
    return result


def compute_regime_inputs(
    candles: Sequence[Candle],
    news_blackouts: NewsBlackoutFlags,
    config: RegimeFeatureConfig,
) -> tuple[RegimeInputs | None, ...]:
    """Return one ready value or warm-up ``None`` for every input candle."""

    if not isinstance(config, RegimeFeatureConfig):
        raise TypeError("config must be a RegimeFeatureConfig")
    if not isinstance(news_blackouts, NewsBlackoutFlags):
        raise TypeError("news_blackouts must be an explicit NewsBlackoutFlags")

    bars = _validate_candles(candles)
    if len(news_blackouts.values) != len(bars):
        raise ValueError(
            "news blackout flag count must exactly match the candle count"
        )
    if not bars:
        return ()

    closes = [float(bar.close) for bar in bars]
    fast_period, middle_period, slow_period = config.ema_periods
    fast_ema = _ema(closes, fast_period)
    middle_ema = _ema(closes, middle_period)
    slow_ema = _ema(closes, slow_period)
    atr = _wilder_average(_true_ranges(bars), config.atr_period)
    atr_percentile = _average_rank_percentiles(
        atr, config.atr_percentile_lookback
    )
    adx = _adx(bars, config.adx_period)
    r_squared = _r_squared(closes, config.r_squared_bars)

    result: list[RegimeInputs | None] = [None] * len(bars)
    for index in range(1, len(bars)):
        current_emas = (fast_ema[index], middle_ema[index], slow_ema[index])
        previous_emas = (
            fast_ema[index - 1],
            middle_ema[index - 1],
            slow_ema[index - 1],
        )
        if (
            adx[index] is None
            or atr_percentile[index] is None
            or r_squared[index] is None
            or any(value is None for value in current_emas)
            or any(value is None for value in previous_emas)
        ):
            continue

        fast, middle, slow = current_emas
        previous_fast, previous_middle, previous_slow = previous_emas
        assert fast is not None and middle is not None and slow is not None
        assert (
            previous_fast is not None
            and previous_middle is not None
            and previous_slow is not None
        )
        bullish = (
            fast > middle > slow
            and fast > previous_fast
            and middle > previous_middle
            and slow > previous_slow
        )
        bearish = (
            fast < middle < slow
            and fast < previous_fast
            and middle < previous_middle
            and slow < previous_slow
        )
        result[index] = RegimeInputs(
            adx=float(adx[index]),
            ema_stack_aligned=bullish or bearish,
            ema_stack_bullish=bullish,
            atr_percentile=float(atr_percentile[index]),
            r_squared=float(r_squared[index]),
            within_news_blackout=news_blackouts.values[index],
        )
    return tuple(result)


__all__ = [
    "RegimeFeatureConfig",
    "NewsBlackoutFlags",
    "compute_regime_inputs",
]
