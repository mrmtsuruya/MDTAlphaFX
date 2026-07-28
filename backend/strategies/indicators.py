"""Pure, parameterised indicator primitives for Stage 2 modules.

No primitive carries a default period, multiplier, or price source. Those
values are injected from the approved ``config/strategies.yaml`` profile.
"""

from __future__ import annotations

import math
import statistics
from collections.abc import Sequence

from ..contracts import Candle


def sma(values: Sequence[float], period: int) -> list[float | None]:
    result: list[float | None] = [None] * len(values)
    if period < 1:
        raise ValueError("period must be positive")
    if len(values) < period:
        return result
    running = sum(float(value) for value in values[:period])
    result[period - 1] = running / period
    for index in range(period, len(values)):
        running += float(values[index]) - float(values[index - period])
        result[index] = running / period
    return result


def ema(values: Sequence[float], period: int) -> list[float | None]:
    """SMA-seeded EMA, matching the approved Stage 1 convention."""

    result: list[float | None] = [None] * len(values)
    if period < 1:
        raise ValueError("period must be positive")
    if len(values) < period:
        return result
    current = sum(float(value) for value in values[:period]) / period
    result[period - 1] = current
    smoothing = 2.0 / (period + 1.0)
    for index in range(period, len(values)):
        current = smoothing * float(values[index]) + (1.0 - smoothing) * current
        result[index] = current
    return result


def true_ranges(bars: Sequence[Candle]) -> list[float]:
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


def wilder_average(values: Sequence[float], period: int) -> list[float | None]:
    result: list[float | None] = [None] * len(values)
    if period < 1:
        raise ValueError("period must be positive")
    if len(values) < period:
        return result
    current = sum(float(value) for value in values[:period]) / period
    result[period - 1] = current
    for index in range(period, len(values)):
        current = ((period - 1) * current + float(values[index])) / period
        result[index] = current
    return result


def atr(bars: Sequence[Candle], period: int) -> list[float | None]:
    return wilder_average(true_ranges(bars), period)


def rolling_median(values: Sequence[float], period: int) -> list[float | None]:
    result: list[float | None] = [None] * len(values)
    if period < 1:
        raise ValueError("period must be positive")
    for index in range(period - 1, len(values)):
        result[index] = float(statistics.median(values[index - period + 1 : index + 1]))
    return result


def rolling_population_std(
    values: Sequence[float], period: int
) -> list[float | None]:
    result: list[float | None] = [None] * len(values)
    if period < 1:
        raise ValueError("period must be positive")
    for index in range(period - 1, len(values)):
        sample = [float(value) for value in values[index - period + 1 : index + 1]]
        mean = sum(sample) / period
        result[index] = math.sqrt(
            sum((value - mean) ** 2 for value in sample) / period
        )
    return result


def rsi(values: Sequence[float], period: int) -> list[float | None]:
    """Wilder RSI."""

    result: list[float | None] = [None] * len(values)
    if period < 1:
        raise ValueError("period must be positive")
    if len(values) <= period:
        return result
    gains: list[float] = []
    losses: list[float] = []
    for previous, current in zip(values, values[1:]):
        change = float(current) - float(previous)
        gains.append(max(change, 0.0))
        losses.append(max(-change, 0.0))
    average_gain = sum(gains[:period]) / period
    average_loss = sum(losses[:period]) / period

    def value() -> float:
        if average_loss == 0.0:
            return 100.0 if average_gain > 0.0 else 50.0
        rs = average_gain / average_loss
        return 100.0 - 100.0 / (1.0 + rs)

    result[period] = value()
    for index in range(period + 1, len(values)):
        average_gain = ((period - 1) * average_gain + gains[index - 1]) / period
        average_loss = ((period - 1) * average_loss + losses[index - 1]) / period
        result[index] = value()
    return result


def adx_di(
    bars: Sequence[Candle], period: int
) -> tuple[list[float | None], list[float | None], list[float | None]]:
    """Wilder ADX with +DI and -DI series."""

    count = len(bars)
    adx_values: list[float | None] = [None] * count
    plus_values: list[float | None] = [None] * count
    minus_values: list[float | None] = [None] * count
    if count <= period:
        return adx_values, plus_values, minus_values

    tr = [0.0] * count
    plus_dm = [0.0] * count
    minus_dm = [0.0] * count
    for index in range(1, count):
        previous = bars[index - 1]
        current = bars[index]
        tr[index] = max(
            float(current.high - current.low),
            abs(float(current.high - previous.close)),
            abs(float(current.low - previous.close)),
        )
        up = float(current.high - previous.high)
        down = float(previous.low - current.low)
        plus_dm[index] = up if up > down and up > 0.0 else 0.0
        minus_dm[index] = down if down > up and down > 0.0 else 0.0

    smoothed_tr = sum(tr[1 : period + 1])
    smoothed_plus = sum(plus_dm[1 : period + 1])
    smoothed_minus = sum(minus_dm[1 : period + 1])
    dx: list[float | None] = [None] * count

    def update(index: int) -> None:
        plus_di = 0.0 if smoothed_tr == 0.0 else 100.0 * smoothed_plus / smoothed_tr
        minus_di = (
            0.0 if smoothed_tr == 0.0 else 100.0 * smoothed_minus / smoothed_tr
        )
        plus_values[index] = plus_di
        minus_values[index] = minus_di
        total = plus_di + minus_di
        dx[index] = 0.0 if total == 0.0 else 100.0 * abs(plus_di - minus_di) / total

    update(period)
    for index in range(period + 1, count):
        smoothed_tr = smoothed_tr - smoothed_tr / period + tr[index]
        smoothed_plus = smoothed_plus - smoothed_plus / period + plus_dm[index]
        smoothed_minus = smoothed_minus - smoothed_minus / period + minus_dm[index]
        update(index)

    first_adx = 2 * period - 1
    if count <= first_adx:
        return adx_values, plus_values, minus_values
    seed = [value for value in dx[period : first_adx + 1] if value is not None]
    current_adx = sum(seed) / period
    adx_values[first_adx] = current_adx
    for index in range(first_adx + 1, count):
        current_dx = dx[index]
        assert current_dx is not None
        current_adx = ((period - 1) * current_adx + current_dx) / period
        adx_values[index] = current_adx
    return adx_values, plus_values, minus_values


def percentile_rank(window: Sequence[float], value: float) -> float:
    if not window:
        raise ValueError("percentile window must not be empty")
    less = sum(candidate < value for candidate in window)
    equal = sum(candidate == value for candidate in window)
    average_rank = less + (equal + 1.0) / 2.0
    return 100.0 * average_rank / len(window)


__all__ = [
    "adx_di",
    "atr",
    "ema",
    "percentile_rank",
    "rolling_median",
    "rolling_population_std",
    "rsi",
    "sma",
    "true_ranges",
    "wilder_average",
]
