"""Module 8 — Break of Structure (BOS)."""

from __future__ import annotations

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
from .m07_change_of_character import _latest_structure, _structure_geometry


class BreakOfStructure(ProfiledStrategy):
    module_id = 8
    module_name = "Break of Structure (BOS)"
    cluster_id = "D1"

    def __init__(self, profile: ModuleProfile):
        self.atr_period = profile.integer("atr_period", positive=True)
        self.volume_period = profile.integer("volume_median_bars", positive=True)
        self.pivot_left = profile.integer("pivot_left_bars", positive=True)
        self.pivot_right = profile.integer("pivot_right_bars", positive=True)
        self.structure_lookback = profile.integer(
            "structure_lookback_bars", positive=True
        )
        self.break_buffer = float(
            profile.number("break_buffer_atr", non_negative=True)
        )
        self.strong_break = float(
            profile.number("strong_break_atr", non_negative=True)
        )
        self.displacement = float(
            profile.number("minimum_displacement_body_atr", non_negative=True)
        )
        self.high_volume_ratio = float(
            profile.number("high_volume_ratio", non_negative=True)
        )
        min_bars = (
            max(self.atr_period, self.volume_period)
            + self.structure_lookback
            + self.pivot_left
            + self.pivot_right
            + 2
        )
        super().__init__(profile, min_bars=min_bars)

    @classmethod
    def from_config(cls, config: Config) -> "BreakOfStructure":
        return cls(cls.profile_from_config(config))

    def evaluate(self, bars: list[Candle], spec: SymbolSpec) -> StrategyResult:
        if len(bars) < self.min_bars:
            return self.flat()
        validate_bars(bars)
        current = len(bars) - 1
        current_atr = atr(bars, self.atr_period)[current]
        median = median_tick_volume(bars, self.volume_period)
        structure = _latest_structure(
            bars, self.pivot_left, self.pivot_right, self.structure_lookback
        )
        if (
            current_atr is None
            or current_atr <= 0.0
            or median is None
            or median <= 0.0
            or structure is None
        ):
            return self.flat()
        bullish_structure = (
            structure.latest_high.price > structure.prior_high.price
            and structure.latest_low.price > structure.prior_low.price
        )
        bearish_structure = (
            structure.latest_high.price < structure.prior_high.price
            and structure.latest_low.price < structure.prior_low.price
        )
        buffer = self.break_buffer * float(current_atr)
        buy_threshold = structure.latest_high.price + buffer
        sell_threshold = structure.latest_low.price - buffer
        buy = bullish_structure and float(bars[current].close) > buy_threshold
        sell = bearish_structure and float(bars[current].close) < sell_threshold
        if buy:
            prior = bars[
                structure.latest_high.index + self.pivot_right + 1 : current
            ]
            buy = not any(float(bar.close) > buy_threshold for bar in prior)
        if sell:
            prior = bars[
                structure.latest_low.index + self.pivot_right + 1 : current
            ]
            sell = not any(float(bar.close) < sell_threshold for bar in prior)
        if buy == sell:
            return self.flat()
        direction = Direction.BUY if buy else Direction.SELL
        level = structure.latest_high if buy else structure.latest_low
        stop = structure.latest_low if buy else structure.latest_high
        beyond = (
            float(bars[current].close) - level.price
            if buy
            else level.price - float(bars[current].close)
        )
        flags = (
            body_size(bars[current]) >= self.displacement * float(current_atr),
            bars[current].tick_volume >= self.high_volume_ratio * median,
            beyond >= self.strong_break * float(current_atr),
        )
        return self.result(
            bars=bars,
            spec=spec,
            direction=direction,
            zone_min=level.price,
            zone_max=level.price,
            overlay_type="STRUCTURE_BREAK",
            geometry=_structure_geometry(
                structure,
                level=level,
                bars=bars,
                spec=spec,
                event="BOS",
            ),
            stop_anchor={
                "kind": "LATEST_OPPOSING_SWING",
                "time": stop.time,
                "price": price(stop.price, spec),
            },
            indicators={
                "atr": float(current_atr),
                "break_distance_atr": beyond / float(current_atr),
                "break_body_atr": body_size(bars[current]) / float(current_atr),
                "volume_ratio": bars[current].tick_volume / median,
            },
            quality_flags=flags,
        )


__all__ = ["BreakOfStructure"]
