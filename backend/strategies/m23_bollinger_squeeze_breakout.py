"""Module 23 — Bollinger Squeeze Breakout."""

from __future__ import annotations

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from ..core.config import Config
from .common import (
    ProfiledStrategy,
    body_size,
    latest_atr,
    median_tick_volume,
    price,
    validate_bars,
)
from .configuration import ModuleProfile
from .indicators import percentile_rank, rolling_population_std, sma


class BollingerSqueezeBreakout(ProfiledStrategy):
    module_id = 23
    module_name = "Bollinger Squeeze Breakout"
    cluster_id = "H"

    def __init__(self, profile: ModuleProfile):
        period = profile.integer("period", positive=True)
        percentile_lookback = profile.integer(
            "bandwidth_percentile_lookback", positive=True
        )
        min_bars = max(
            period + percentile_lookback,
            profile.integer("atr_period", positive=True),
            profile.integer("volume_median_bars", positive=True),
        )
        super().__init__(profile, min_bars=min_bars)

    @classmethod
    def from_config(cls, config: Config) -> "BollingerSqueezeBreakout":
        return cls(cls.profile_from_config(config))

    def evaluate(self, bars: list[Candle], spec: SymbolSpec) -> StrategyResult:
        if len(bars) < self.min_bars:
            return self.flat()
        validate_bars(bars)
        period = self.profile.integer("period", positive=True)
        deviations = float(self.profile.number("standard_deviations", positive=True))
        lookback = self.profile.integer(
            "bandwidth_percentile_lookback", positive=True
        )
        closes = [float(bar.close) for bar in bars]
        middle = sma(closes, period)
        std = rolling_population_std(closes, period)
        widths: list[float | None] = [None] * len(bars)
        upper: list[float | None] = [None] * len(bars)
        lower: list[float | None] = [None] * len(bars)
        for index, (mean, sigma) in enumerate(zip(middle, std)):
            if mean is None or sigma is None or mean == 0.0:
                continue
            upper[index] = mean + deviations * sigma
            lower[index] = mean - deviations * sigma
            widths[index] = (upper[index] - lower[index]) / abs(mean)

        previous_width = widths[-2]
        current_width = widths[-1]
        previous_upper = upper[-2]
        previous_lower = lower[-2]
        current_upper = upper[-1]
        current_lower = lower[-1]
        if any(
            value is None
            for value in (
                previous_width,
                current_width,
                previous_upper,
                previous_lower,
                current_upper,
                current_lower,
            )
        ):
            return self.flat()
        ready_widths = [value for value in widths[:-1] if value is not None]
        if len(ready_widths) < lookback:
            return self.flat()
        previous_percentile = percentile_rank(
            ready_widths[-lookback:], float(previous_width)
        )
        squeeze_limit = float(self.profile.number("squeeze_percentile"))
        if previous_percentile > squeeze_limit or current_width <= previous_width:
            return self.flat()

        last = bars[-1]
        if last.close > float(current_upper):
            direction = Direction.BUY
            band = float(current_upper)
            stop_value = float(last.low)
        elif last.close < float(current_lower):
            direction = Direction.SELL
            band = float(current_lower)
            stop_value = float(last.high)
        else:
            return self.flat()

        atr_value = latest_atr(
            bars, self.profile.integer("atr_period", positive=True)
        )
        volume_median = median_tick_volume(
            bars, self.profile.integer("volume_median_bars", positive=True)
        )
        if atr_value is None or volume_median is None or previous_width == 0.0:
            return self.flat()
        expansion = (float(current_width) - float(previous_width)) / abs(
            float(previous_width)
        )
        break_distance = abs(float(last.close) - band)
        flags = (
            expansion
            >= float(
                self.profile.number(
                    "minimum_bandwidth_expansion_fraction", non_negative=True
                )
            ),
            break_distance
            >= float(self.profile.number("minimum_break_atr", non_negative=True))
            * atr_value,
            last.tick_volume
            >= float(self.profile.number("high_volume_ratio", positive=True))
            * volume_median,
        )
        return self.result(
            bars=bars,
            spec=spec,
            direction=direction,
            zone_min=band,
            zone_max=band,
            overlay_type="BOLLINGER_SQUEEZE_BREAKOUT",
            geometry=[
                {
                    "type": "band_break",
                    "time": last.time.isoformat(),
                    "band": price(band, spec),
                    "close": price(last.close, spec),
                }
            ],
            stop_anchor={"price": price(stop_value, spec), "label": "breakout candle"},
            indicators={
                "bandwidth": current_width,
                "previous_bandwidth": previous_width,
                "previous_bandwidth_percentile": previous_percentile,
                "atr": atr_value,
                "tick_volume_median": volume_median,
            },
            quality_flags=flags,
        )


__all__ = ["BollingerSqueezeBreakout"]
