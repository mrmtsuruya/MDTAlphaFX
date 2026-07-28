"""Module 25 — VWAP Deviation Touch."""

from __future__ import annotations

import math

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from ..core.config import Config
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


class VwapDeviationTouch(ProfiledStrategy):
    module_id = 25
    module_name = "VWAP Deviation Touch"
    cluster_id = "G"

    def __init__(self, profile: ModuleProfile):
        min_bars = max(
            profile.integer("minimum_anchor_bars", positive=True),
            profile.integer("atr_period", positive=True),
            profile.integer("volume_median_bars", positive=True),
        )
        super().__init__(profile, min_bars=min_bars)

    @classmethod
    def from_config(cls, config: Config) -> "VwapDeviationTouch":
        profile = cls.profile_from_config(config)
        if profile.text("anchor") != "UTC_DAY":
            raise ValueError("module 25 supports only the approved UTC_DAY anchor")
        if profile.text("price_source") != "HLC3":
            raise ValueError("module 25 supports only the approved HLC3 price")
        if profile.text("volume_source") != "TICK_VOLUME":
            raise ValueError("module 25 supports only recorded tick volume")
        return cls(profile)

    def evaluate(self, bars: list[Candle], spec: SymbolSpec) -> StrategyResult:
        if len(bars) < self.min_bars:
            return self.flat()
        validate_bars(bars)
        current_date = bars[-1].time.date()
        anchored = [bar for bar in bars if bar.time.date() == current_date]
        minimum = self.profile.integer("minimum_anchor_bars", positive=True)
        if len(anchored) < minimum:
            return self.flat()
        typical = [
            (float(bar.high) + float(bar.low) + float(bar.close)) / 3.0
            for bar in anchored
        ]
        volumes = [float(bar.tick_volume) for bar in anchored]
        total_volume = sum(volumes)
        if total_volume <= 0.0:
            return self.flat()
        vwap = sum(value * volume for value, volume in zip(typical, volumes)) / total_volume
        mean = sum(typical) / len(typical)
        sigma = math.sqrt(
            sum((value - mean) ** 2 for value in typical) / len(typical)
        )
        deviations = float(self.profile.number("standard_deviations", positive=True))
        upper = vwap + deviations * sigma
        lower = vwap - deviations * sigma
        last = bars[-1]
        bullish = last.low <= lower and last.close > lower
        bearish = last.high >= upper and last.close < upper
        if bullish == bearish:
            return self.flat()
        if bullish:
            direction = Direction.BUY
            band = lower
            extreme = float(last.low)
            wick = lower_wick(last)
        else:
            direction = Direction.SELL
            band = upper
            extreme = float(last.high)
            wick = upper_wick(last)
        atr_value = latest_atr(
            bars, self.profile.integer("atr_period", positive=True)
        )
        volume_median = median_tick_volume(
            bars, self.profile.integer("volume_median_bars", positive=True)
        )
        if atr_value is None or volume_median is None:
            return self.flat()
        flags = (
            abs(extreme - band)
            >= float(self.profile.number("minimum_overshoot_atr", non_negative=True))
            * atr_value,
            wick
            >= float(
                self.profile.number("minimum_rejection_wick_atr", non_negative=True)
            )
            * atr_value,
            last.tick_volume
            <= float(self.profile.number("low_volume_ratio", positive=True))
            * volume_median,
        )
        return self.result(
            bars=bars,
            spec=spec,
            direction=direction,
            zone_min=band,
            zone_max=extreme,
            overlay_type="VWAP_DEVIATION_TOUCH",
            geometry=[
                {
                    "type": "vwap_deviation_rejection",
                    "time": last.time.isoformat(),
                    "vwap": price(vwap, spec),
                    "band": price(band, spec),
                    "extreme": price(extreme, spec),
                }
            ],
            stop_anchor={"price": price(extreme, spec), "label": "deviation extreme"},
            indicators={
                "vwap": vwap,
                "population_deviation": sigma,
                "upper": upper,
                "lower": lower,
                "anchor_bars": len(anchored),
                "atr": atr_value,
                "tick_volume_median": volume_median,
            },
            quality_flags=flags,
        )


__all__ = ["VwapDeviationTouch"]
