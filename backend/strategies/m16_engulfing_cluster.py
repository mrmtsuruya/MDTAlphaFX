"""Module 16 — Engulfing Cluster."""

from __future__ import annotations

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from .common import (
    ProfiledStrategy,
    bar_range,
    body_size,
    candle_body,
    latest_atr,
    median_tick_volume,
    price,
    validate_bars,
)
from .configuration import ModuleProfile


class EngulfingCluster(ProfiledStrategy):
    module_id = 16
    module_name = "Engulfing Cluster"
    cluster_id = "C"

    def __init__(self, profile: ModuleProfile):
        self.atr_period = profile.integer("atr_period", positive=True)
        self.volume_period = profile.integer("volume_median_bars", positive=True)
        min_bars = max(self.atr_period, self.volume_period + 1)
        super().__init__(profile, min_bars=min_bars)

    def evaluate(self, bars: list[Candle], spec: SymbolSpec) -> StrategyResult:
        validate_bars(bars)
        if len(bars) < self.min_bars:
            return self.flat()
        window = bars[-self.min_bars :]
        previous, current = window[-2:]
        atr_value = latest_atr(window, self.atr_period)
        volume_median = median_tick_volume(window[:-1], self.volume_period)
        if atr_value is None or volume_median is None:
            return self.flat()
        direction = (
            Direction.BUY
            if current.close > current.open
            else Direction.SELL
            if current.close < current.open
            else Direction.NONE
        )
        if direction is Direction.NONE:
            return self.flat()
        fully_engulfs = (
            float(current.high) >= float(previous.high)
            and float(current.low) <= float(previous.low)
        )
        minimum_body = (
            float(self.profile.number("minimum_body_atr", positive=True)) * atr_value
        )
        high_volume_ratio = float(
            self.profile.number("high_volume_ratio", positive=True)
        )
        if (
            not fully_engulfs
            or body_size(current) < minimum_body
            or current.tick_volume < high_volume_ratio * volume_median
        ):
            return self.flat()
        current_range = bar_range(current)
        if current_range <= 0.0:
            return self.flat()
        close_fraction = float(
            self.profile.number("close_extreme_fraction", positive=True)
        )
        closes_at_extreme = (
            float(current.close) >= float(current.high) - close_fraction * current_range
            if direction is Direction.BUY
            else float(current.close) <= float(current.low) + close_fraction * current_range
        )
        strong_volume_ratio = float(
            self.profile.number("strong_volume_ratio", positive=True)
        )
        strong_body = (
            float(self.profile.number("strong_body_atr", positive=True)) * atr_value
        )
        flags = (
            closes_at_extreme,
            current.tick_volume >= strong_volume_ratio * volume_median,
            body_size(current) >= strong_body,
        )
        zone_min, zone_max = candle_body(current)
        return self.result(
            bars=window,
            spec=spec,
            direction=direction,
            zone_min=zone_min,
            zone_max=zone_max,
            overlay_type="ENGULFING_CLUSTER",
            geometry=[
                {
                    "type": "candle_range",
                    "role": "absorbed_candle",
                    "time": previous.time.isoformat(),
                    "min": price(previous.low, spec),
                    "max": price(previous.high, spec),
                },
                {
                    "type": "candle_body",
                    "role": "engulfing_body",
                    "time": current.time.isoformat(),
                    "min": price(zone_min, spec),
                    "max": price(zone_max, spec),
                },
            ],
            stop_anchor={
                "time": current.time.isoformat(),
                "price": price(
                    current.low if direction is Direction.BUY else current.high,
                    spec,
                ),
                "role": "engulfing_extreme",
            },
            opposing_structures=[
                {
                    "time": previous.time.isoformat(),
                    "price": price(
                        previous.high
                        if direction is Direction.BUY
                        else previous.low,
                        spec,
                    ),
                    "kind": "ABSORBED_CANDLE_EXTREME",
                }
            ],
            indicators={
                "atr": atr_value,
                "body_atr": body_size(current) / atr_value,
                "close_extreme_distance_fraction": (
                    (float(current.high) - float(current.close)) / current_range
                    if direction is Direction.BUY
                    else (float(current.close) - float(current.low)) / current_range
                ),
                "tick_volume_proxy": current.tick_volume,
                "volume_median": volume_median,
                "volume_ratio": current.tick_volume / volume_median,
            },
            quality_flags=flags,
        )


__all__ = ["EngulfingCluster"]
