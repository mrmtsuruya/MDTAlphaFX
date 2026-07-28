"""Module 21 — ADX Trend Acceleration."""

from __future__ import annotations

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from .common import (
    ProfiledStrategy,
    body_size,
    candle_body,
    latest_atr,
    price,
    validate_bars,
)
from .configuration import ModuleProfile
from .indicators import adx_di


class AdxTrendAcceleration(ProfiledStrategy):
    module_id = 21
    module_name = "ADX Trend Acceleration"
    cluster_id = "E"

    def __init__(self, profile: ModuleProfile):
        self.adx_period = profile.integer("adx_period", positive=True)
        self.atr_period = profile.integer("atr_period", positive=True)
        self.trigger = float(profile.number("trigger", non_negative=True))
        self.minimum_rise = float(
            profile.number("minimum_rise_points", non_negative=True)
        )
        self.minimum_di_spread = float(
            profile.number("minimum_di_spread_points", non_negative=True)
        )
        self.minimum_body_atr = float(
            profile.number("minimum_displacement_body_atr", non_negative=True)
        )
        super().__init__(
            profile,
            min_bars=max(
                2 * self.adx_period + 1,
                self.atr_period,
            ),
        )

    def evaluate(
        self, bars: list[Candle], spec: SymbolSpec
    ) -> StrategyResult:
        validate_bars(bars)
        if len(bars) < self.min_bars:
            return self.flat()

        adx_values, plus_values, minus_values = adx_di(bars, self.adx_period)
        previous_adx = adx_values[-2]
        current_adx = adx_values[-1]
        plus_di = plus_values[-1]
        minus_di = minus_values[-1]
        atr_value = latest_atr(bars, self.atr_period)
        if (
            previous_adx is None
            or current_adx is None
            or plus_di is None
            or minus_di is None
            or atr_value is None
        ):
            return self.flat()
        if not (
            previous_adx <= self.trigger < current_adx
            and current_adx > previous_adx
        ):
            return self.flat()

        direction = Direction.BUY if plus_di > minus_di else Direction.SELL
        zone_min, zone_max = candle_body(bars[-1])
        event_time = bars[-1].time.isoformat()
        adx_rise = current_adx - previous_adx
        di_spread = abs(plus_di - minus_di)
        candle_body_atr = body_size(bars[-1]) / atr_value
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
                "adx": current_adx,
                "previous_adx": previous_adx,
                "adx_rise_points": adx_rise,
                "plus_di": plus_di,
                "minus_di": minus_di,
                "di_spread_points": di_spread,
                "atr": atr_value,
                "body_atr": candle_body_atr,
            },
            quality_flags=(
                adx_rise >= self.minimum_rise,
                di_spread >= self.minimum_di_spread,
                body_size(bars[-1]) >= self.minimum_body_atr * atr_value,
            ),
        )


__all__ = ["AdxTrendAcceleration"]
