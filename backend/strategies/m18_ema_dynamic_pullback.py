"""Module 18 — EMA Dynamic Pullback."""

from __future__ import annotations

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from .common import (
    ProfiledStrategy,
    latest_atr,
    lower_wick,
    median_tick_volume,
    price,
    upper_wick,
    validate_bars,
)
from .configuration import ModuleProfile
from .indicators import atr, ema


class EmaDynamicPullback(ProfiledStrategy):
    module_id = 18
    module_name = "EMA Dynamic Pullback"
    cluster_id = "E"

    def __init__(self, profile: ModuleProfile):
        periods = profile.value("ema_periods")
        if (
            not isinstance(periods, tuple)
            or len(periods) != 3
            or any(
                isinstance(period, bool)
                or not isinstance(period, int)
                or period < 1
                for period in periods
            )
            or not periods[0] < periods[1] < periods[2]
        ):
            raise ValueError("ema_periods must be three strictly increasing integers")
        self.ema_periods = periods
        self.atr_period = profile.integer("atr_period", positive=True)
        self.volume_period = profile.integer("volume_median_bars", positive=True)
        self.touch_tolerance_atr = float(
            profile.number("touch_tolerance_atr", non_negative=True)
        )
        self.minimum_rejection_wick_atr = float(
            profile.number("minimum_rejection_wick_atr", non_negative=True)
        )
        self.high_volume_ratio = float(
            profile.number("high_volume_ratio", non_negative=True)
        )
        super().__init__(
            profile,
            min_bars=max(periods[-1] + 1, self.atr_period + 1, self.volume_period),
        )

    @staticmethod
    def _strict_direction(
        fast: float, middle: float, slow: float
    ) -> Direction:
        if fast > middle > slow:
            return Direction.BUY
        if fast < middle < slow:
            return Direction.SELL
        return Direction.NONE

    def _qualification(
        self,
        *,
        bar: Candle,
        fast: float,
        middle: float,
        slow: float,
        atr_value: float,
    ) -> tuple[Direction, float | None, bool]:
        direction = self._strict_direction(fast, middle, slow)
        if direction is Direction.NONE:
            return direction, None, False
        tolerance = self.touch_tolerance_atr * atr_value
        touched_fast = (
            float(bar.low) <= fast + tolerance
            and float(bar.high) >= fast - tolerance
        )
        touched_middle = (
            float(bar.low) <= middle + tolerance
            and float(bar.high) >= middle - tolerance
        )
        if direction is Direction.BUY:
            closes_trendward_fast = float(bar.close) > fast
            closes_trendward_middle = float(bar.close) > middle
        else:
            closes_trendward_fast = float(bar.close) < fast
            closes_trendward_middle = float(bar.close) < middle
        if touched_fast and closes_trendward_fast:
            return direction, fast, True
        if touched_middle and closes_trendward_middle:
            return direction, middle, False
        return direction, None, False

    def evaluate(
        self, bars: list[Candle], spec: SymbolSpec
    ) -> StrategyResult:
        validate_bars(bars)
        if len(bars) < self.min_bars:
            return self.flat()

        closes = [float(bar.close) for bar in bars]
        fast_values, middle_values, slow_values = (
            ema(closes, period) for period in self.ema_periods
        )
        atr_values = atr(bars, self.atr_period)
        current_values = (
            fast_values[-1],
            middle_values[-1],
            slow_values[-1],
            atr_values[-1],
        )
        previous_values = (
            fast_values[-2],
            middle_values[-2],
            slow_values[-2],
            atr_values[-2],
        )
        if any(value is None for value in current_values + previous_values):
            return self.flat()
        fast, middle, slow, atr_value = current_values
        previous_fast, previous_middle, previous_slow, previous_atr = previous_values
        assert (
            fast is not None
            and middle is not None
            and slow is not None
            and atr_value is not None
            and previous_fast is not None
            and previous_middle is not None
            and previous_slow is not None
            and previous_atr is not None
        )
        if atr_value <= 0.0 or previous_atr <= 0.0:
            return self.flat()

        direction, touched_ema, touched_fast = self._qualification(
            bar=bars[-1],
            fast=fast,
            middle=middle,
            slow=slow,
            atr_value=atr_value,
        )
        if touched_ema is None:
            return self.flat()
        _, previous_touched, _ = self._qualification(
            bar=bars[-2],
            fast=previous_fast,
            middle=previous_middle,
            slow=previous_slow,
            atr_value=previous_atr,
        )
        if previous_touched is not None:
            return self.flat()

        tolerance = self.touch_tolerance_atr * atr_value
        rejection_wick = (
            lower_wick(bars[-1])
            if direction is Direction.BUY
            else upper_wick(bars[-1])
        )
        volume_median = median_tick_volume(bars[:-1], self.volume_period)
        high_volume = (
            volume_median is not None
            and volume_median > 0.0
            and float(bars[-1].tick_volume)
            >= self.high_volume_ratio * volume_median
        )
        event_time = bars[-1].time.isoformat()
        return self.result(
            bars=bars,
            spec=spec,
            direction=direction,
            zone_min=touched_ema - tolerance,
            zone_max=touched_ema + tolerance,
            overlay_type="EMA_TOUCH_ZONE",
            geometry=[
                {
                    "type": "band",
                    "time": event_time,
                    "min": price(touched_ema - tolerance, spec),
                    "max": price(touched_ema + tolerance, spec),
                    "ema_period": (
                        self.ema_periods[0] if touched_fast else self.ema_periods[1]
                    ),
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
            opposing_structures=[
                {
                    "type": "EMA",
                    "period": self.ema_periods[1],
                    "time": event_time,
                    "price": price(middle, spec),
                }
            ],
            indicators={
                "ema_fast": fast,
                "ema_middle": middle,
                "ema_slow": slow,
                "touched_ema": touched_ema,
                "atr": atr_value,
                "rejection_wick_atr": rejection_wick / atr_value,
                "tick_volume": int(bars[-1].tick_volume),
                "tick_volume_median": volume_median,
                "volume_proxy": "TICK_VOLUME",
            },
            quality_flags=(
                touched_fast,
                rejection_wick >= self.minimum_rejection_wick_atr * atr_value,
                high_volume,
            ),
        )


__all__ = ["EmaDynamicPullback"]
