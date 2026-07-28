"""Module 19 — MACD Zero-Line Crossover."""

from __future__ import annotations

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from .common import (
    ProfiledStrategy,
    candle_body,
    median_tick_volume,
    price,
    validate_bars,
)
from .configuration import ModuleProfile
from .indicators import ema


class MacdZeroLineCrossover(ProfiledStrategy):
    module_id = 19
    module_name = "MACD Zero-Line Crossover"
    cluster_id = "E"

    def __init__(self, profile: ModuleProfile):
        self.fast_period = profile.integer("fast_ema_period", positive=True)
        self.slow_period = profile.integer("slow_ema_period", positive=True)
        self.signal_period = profile.integer("signal_ema_period", positive=True)
        if self.fast_period >= self.slow_period:
            raise ValueError("fast_ema_period must be below slow_ema_period")
        self.volume_period = profile.integer("volume_median_bars", positive=True)
        self.high_volume_ratio = float(
            profile.number("high_volume_ratio", non_negative=True)
        )
        macd_signal_ready = self.slow_period + self.signal_period - 1
        super().__init__(
            profile,
            min_bars=max(macd_signal_ready, self.volume_period),
        )

    def _series(
        self, closes: list[float]
    ) -> tuple[list[float | None], list[float | None]]:
        fast = ema(closes, self.fast_period)
        slow = ema(closes, self.slow_period)
        macd: list[float | None] = [None] * len(closes)
        ready: list[float] = []
        ready_indices: list[int] = []
        for index, (fast_value, slow_value) in enumerate(zip(fast, slow)):
            if fast_value is None or slow_value is None:
                continue
            value = fast_value - slow_value
            macd[index] = value
            ready.append(value)
            ready_indices.append(index)
        ready_signal = ema(ready, self.signal_period)
        signal: list[float | None] = [None] * len(closes)
        for index, value in zip(ready_indices, ready_signal):
            signal[index] = value
        return macd, signal

    def evaluate(
        self, bars: list[Candle], spec: SymbolSpec
    ) -> StrategyResult:
        validate_bars(bars)
        if len(bars) < self.min_bars:
            return self.flat()

        macd, signal = self._series([float(bar.close) for bar in bars])
        previous_macd = macd[-2]
        current_macd = macd[-1]
        current_signal = signal[-1]
        if (
            previous_macd is None
            or current_macd is None
            or current_signal is None
        ):
            return self.flat()

        bullish = previous_macd <= 0.0 < current_macd
        bearish = previous_macd >= 0.0 > current_macd
        if bullish == bearish:
            return self.flat()
        direction = Direction.BUY if bullish else Direction.SELL
        histogram = current_macd - current_signal
        histogram_agrees = (
            histogram > 0.0
            if direction is Direction.BUY
            else histogram < 0.0
        )
        volume_median = median_tick_volume(bars[:-1], self.volume_period)
        high_volume = (
            volume_median is not None
            and volume_median > 0.0
            and float(bars[-1].tick_volume)
            >= self.high_volume_ratio * volume_median
        )
        zone_min, zone_max = candle_body(bars[-1])
        event_time = bars[-1].time.isoformat()
        return self.result(
            bars=bars,
            spec=spec,
            direction=direction,
            zone_min=zone_min,
            zone_max=zone_max,
            overlay_type="CANDLE_BODY",
            geometry=[
                {
                    "type": "candle_body",
                    "time": event_time,
                    "min": price(zone_min, spec),
                    "max": price(zone_max, spec),
                }
            ],
            stop_anchor={
                "type": "CANDLE_EXTREME",
                "time": event_time,
                "price": price(
                    bars[-1].low
                    if direction is Direction.BUY
                    else bars[-1].high,
                    spec,
                ),
            },
            indicators={
                "macd": current_macd,
                "previous_macd": previous_macd,
                "signal": current_signal,
                "histogram": histogram,
                "tick_volume": int(bars[-1].tick_volume),
                "tick_volume_median": volume_median,
                "volume_proxy": "TICK_VOLUME",
            },
            quality_flags=(
                histogram_agrees,
                abs(current_macd) > abs(previous_macd),
                high_volume,
            ),
        )


__all__ = ["MacdZeroLineCrossover"]
