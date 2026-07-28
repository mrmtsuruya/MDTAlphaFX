"""Module 26 — Keltner Channel Reversal."""

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
from .indicators import atr, ema


class KeltnerChannelReversal(ProfiledStrategy):
    module_id = 26
    module_name = "Keltner Channel Reversal"
    cluster_id = "G"

    def __init__(self, profile: ModuleProfile):
        slowdown = profile.integer("momentum_slowdown_bars", positive=True)
        min_bars = max(
            profile.integer("ema_period", positive=True),
            profile.integer("atr_period", positive=True),
            profile.integer("volume_median_bars", positive=True),
            slowdown + 1,
        )
        super().__init__(profile, min_bars=min_bars)

    @classmethod
    def from_config(cls, config: Config) -> "KeltnerChannelReversal":
        return cls(cls.profile_from_config(config))

    def evaluate(self, bars: list[Candle], spec: SymbolSpec) -> StrategyResult:
        if len(bars) < self.min_bars:
            return self.flat()
        validate_bars(bars)
        closes = [float(bar.close) for bar in bars]
        center = ema(closes, self.profile.integer("ema_period", positive=True))[-1]
        atr_value = atr(bars, self.profile.integer("atr_period", positive=True))[-1]
        if center is None or atr_value is None or atr_value <= 0.0:
            return self.flat()
        multiplier = float(self.profile.number("multiplier", positive=True))
        upper = center + multiplier * atr_value
        lower = center - multiplier * atr_value
        slowdown_bars = self.profile.integer("momentum_slowdown_bars", positive=True)
        deltas = [
            abs(current - previous)
            for previous, current in zip(closes, closes[1:])
        ]
        recent = deltas[-slowdown_bars:]
        slowing = len(recent) == slowdown_bars and all(
            recent[index] < recent[index - 1] for index in range(1, len(recent))
        )
        if not slowing:
            return self.flat()
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
        volume_median = median_tick_volume(
            bars, self.profile.integer("volume_median_bars", positive=True)
        )
        if volume_median is None:
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
            overlay_type="KELTNER_CHANNEL_REVERSAL",
            geometry=[
                {
                    "type": "keltner_rejection",
                    "time": last.time.isoformat(),
                    "center": price(center, spec),
                    "band": price(band, spec),
                    "extreme": price(extreme, spec),
                }
            ],
            stop_anchor={"price": price(extreme, spec), "label": "channel extreme"},
            indicators={
                "center": center,
                "upper": upper,
                "lower": lower,
                "atr": atr_value,
                "recent_absolute_momentum": recent,
                "tick_volume_median": volume_median,
            },
            quality_flags=flags,
        )


__all__ = ["KeltnerChannelReversal"]
