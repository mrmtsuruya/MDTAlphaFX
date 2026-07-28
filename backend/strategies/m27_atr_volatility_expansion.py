"""Module 27 — ATR Volatility Expansion."""

from __future__ import annotations

import statistics

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from ..core.config import Config
from .common import (
    ProfiledStrategy,
    body_size,
    median_tick_volume,
    price,
    validate_bars,
)
from .configuration import ModuleProfile
from .indicators import atr


class AtrVolatilityExpansion(ProfiledStrategy):
    module_id = 27
    module_name = "ATR Volatility Expansion"
    cluster_id = "H"

    def __init__(self, profile: ModuleProfile):
        atr_period = profile.integer("atr_period", positive=True)
        atr_lookback = profile.integer("atr_median_lookback_bars", positive=True)
        min_bars = max(
            atr_period + atr_lookback,
            profile.integer("breakout_lookback_bars", positive=True) + 1,
            profile.integer("volume_median_bars", positive=True),
        )
        super().__init__(profile, min_bars=min_bars)

    @classmethod
    def from_config(cls, config: Config) -> "AtrVolatilityExpansion":
        return cls(cls.profile_from_config(config))

    def evaluate(self, bars: list[Candle], spec: SymbolSpec) -> StrategyResult:
        if len(bars) < self.min_bars:
            return self.flat()
        validate_bars(bars)
        atr_values = atr(bars, self.profile.integer("atr_period", positive=True))
        current_atr = atr_values[-1]
        lookback = self.profile.integer("atr_median_lookback_bars", positive=True)
        ready = [value for value in atr_values[:-1] if value is not None]
        if current_atr is None or len(ready) < lookback:
            return self.flat()
        median_atr = float(statistics.median(ready[-lookback:]))
        if median_atr <= 0.0:
            return self.flat()
        ratio = current_atr / median_atr
        if ratio < float(self.profile.number("expansion_ratio", positive=True)):
            return self.flat()
        breakout_lookback = self.profile.integer(
            "breakout_lookback_bars", positive=True
        )
        prior = bars[-breakout_lookback - 1 : -1]
        prior_high = max(float(bar.high) for bar in prior)
        prior_low = min(float(bar.low) for bar in prior)
        buffer = (
            float(self.profile.number("break_buffer_atr", non_negative=True))
            * current_atr
        )
        last = bars[-1]
        if last.close > prior_high + buffer:
            direction = Direction.BUY
            level = prior_high
            stop_value = float(last.low)
        elif last.close < prior_low - buffer:
            direction = Direction.SELL
            level = prior_low
            stop_value = float(last.high)
        else:
            return self.flat()
        volume_median = median_tick_volume(
            bars, self.profile.integer("volume_median_bars", positive=True)
        )
        if volume_median is None:
            return self.flat()
        flags = (
            ratio
            >= float(self.profile.number("strong_expansion_ratio", positive=True)),
            body_size(last)
            >= float(
                self.profile.number(
                    "minimum_displacement_body_atr", non_negative=True
                )
            )
            * current_atr,
            last.tick_volume
            >= float(self.profile.number("high_volume_ratio", positive=True))
            * volume_median,
        )
        return self.result(
            bars=bars,
            spec=spec,
            direction=direction,
            zone_min=level,
            zone_max=level,
            overlay_type="ATR_VOLATILITY_EXPANSION",
            geometry=[
                {
                    "type": "range_break",
                    "time": last.time.isoformat(),
                    "level": price(level, spec),
                    "close": price(last.close, spec),
                }
            ],
            stop_anchor={"price": price(stop_value, spec), "label": "expansion candle"},
            indicators={
                "atr": current_atr,
                "atr_median": median_atr,
                "atr_ratio": ratio,
                "prior_high": prior_high,
                "prior_low": prior_low,
                "tick_volume_median": volume_median,
            },
            quality_flags=flags,
        )


__all__ = ["AtrVolatilityExpansion"]
