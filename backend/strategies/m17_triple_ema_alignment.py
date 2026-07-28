"""Module 17 — Triple EMA Alignment."""

from __future__ import annotations

from collections.abc import Sequence

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from .common import ProfiledStrategy, latest_atr, price, validate_bars
from .configuration import ModuleProfile
from .indicators import ema


class TripleEmaAlignment(ProfiledStrategy):
    module_id = 17
    module_name = "Triple EMA Alignment"
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
        self.slope_bars = profile.integer("slope_bars", positive=True)
        self.atr_period = profile.integer("atr_period", positive=True)
        self.fast_middle_separation_atr = float(
            profile.number("fast_middle_separation_atr", non_negative=True)
        )
        self.middle_slow_separation_atr = float(
            profile.number("middle_slow_separation_atr", non_negative=True)
        )
        super().__init__(
            profile,
            min_bars=max(periods[-1] + self.slope_bars, self.atr_period),
        )

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
        fast = fast_values[-1]
        middle = middle_values[-1]
        slow = slow_values[-1]
        atr_value = latest_atr(bars, self.atr_period)
        if fast is None or middle is None or slow is None or atr_value is None:
            return self.flat()

        bullish = fast > middle > slow
        bearish = fast < middle < slow
        if bullish == bearish:
            return self.flat()
        direction = Direction.BUY if bullish else Direction.SELL

        prior_index = -1 - self.slope_bars
        prior_fast = fast_values[prior_index]
        prior_middle = middle_values[prior_index]
        prior_slow = slow_values[prior_index]
        if prior_fast is None or prior_middle is None or prior_slow is None:
            return self.flat()

        separation_fast_middle = abs(fast - middle)
        separation_middle_slow = abs(middle - slow)
        if direction is Direction.BUY:
            slopes_agree = (
                fast > prior_fast
                and middle > prior_middle
                and slow > prior_slow
            )
            stop_price = middle
        else:
            slopes_agree = (
                fast < prior_fast
                and middle < prior_middle
                and slow < prior_slow
            )
            stop_price = middle

        event_time = bars[-1].time.isoformat()
        return self.result(
            bars=bars,
            spec=spec,
            direction=direction,
            zone_min=fast,
            zone_max=middle,
            overlay_type="EMA_BAND",
            geometry=[
                {
                    "type": "band",
                    "time": event_time,
                    "min": price(min(fast, middle), spec),
                    "max": price(max(fast, middle), spec),
                }
            ],
            stop_anchor={
                "type": "EMA",
                "period": self.ema_periods[1],
                "time": event_time,
                "price": price(stop_price, spec),
            },
            opposing_structures=[
                {
                    "type": "EMA",
                    "period": self.ema_periods[2],
                    "time": event_time,
                    "price": price(slow, spec),
                }
            ],
            indicators={
                "ema_fast": fast,
                "ema_middle": middle,
                "ema_slow": slow,
                "atr": atr_value,
                "fast_middle_separation_atr": separation_fast_middle / atr_value,
                "middle_slow_separation_atr": separation_middle_slow / atr_value,
                "slopes_agree": slopes_agree,
            },
            quality_flags=(
                separation_fast_middle
                >= self.fast_middle_separation_atr * atr_value,
                separation_middle_slow
                >= self.middle_slow_separation_atr * atr_value,
                slopes_agree,
            ),
        )


__all__ = ["TripleEmaAlignment"]
