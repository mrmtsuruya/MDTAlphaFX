"""Module 24 — Bollinger Outer Reversion."""

from __future__ import annotations

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
from .indicators import rolling_population_std, sma


class BollingerOuterReversion(ProfiledStrategy):
    module_id = 24
    module_name = "Bollinger Outer Reversion"
    cluster_id = "G"

    def __init__(self, profile: ModuleProfile):
        min_bars = max(
            profile.integer("period", positive=True),
            profile.integer("atr_period", positive=True),
            profile.integer("volume_median_bars", positive=True),
        )
        super().__init__(profile, min_bars=min_bars)

    @classmethod
    def from_config(cls, config: Config) -> "BollingerOuterReversion":
        return cls(cls.profile_from_config(config))

    def evaluate(self, bars: list[Candle], spec: SymbolSpec) -> StrategyResult:
        if len(bars) < self.min_bars:
            return self.flat()
        validate_bars(bars)
        period = self.profile.integer("period", positive=True)
        deviations = float(self.profile.number("standard_deviations", positive=True))
        closes = [float(bar.close) for bar in bars]
        middle = sma(closes, period)[-1]
        sigma = rolling_population_std(closes, period)[-1]
        atr_value = latest_atr(
            bars, self.profile.integer("atr_period", positive=True)
        )
        volume_median = median_tick_volume(
            bars, self.profile.integer("volume_median_bars", positive=True)
        )
        if (
            middle is None
            or sigma is None
            or atr_value is None
            or volume_median is None
        ):
            return self.flat()
        upper = middle + deviations * sigma
        lower = middle - deviations * sigma
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
        overshoot = abs(extreme - band)
        flags = (
            overshoot
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
            overlay_type="BOLLINGER_OUTER_REVERSION",
            geometry=[
                {
                    "type": "outer_band_rejection",
                    "time": last.time.isoformat(),
                    "band": price(band, spec),
                    "extreme": price(extreme, spec),
                }
            ],
            stop_anchor={"price": price(extreme, spec), "label": "rejection extreme"},
            indicators={
                "middle": middle,
                "upper": upper,
                "lower": lower,
                "atr": atr_value,
                "tick_volume_median": volume_median,
            },
            quality_flags=flags,
        )


__all__ = ["BollingerOuterReversion"]
