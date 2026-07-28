"""Module 14 — Double Bottom/Top Validation."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from .common import (
    Pivot,
    ProfiledStrategy,
    candle_body,
    confirmed_pivot_highs,
    confirmed_pivot_lows,
    latest_atr,
    lower_wick,
    median_tick_volume,
    price,
    upper_wick,
    validate_bars,
)
from .configuration import ModuleProfile


class DoubleBottomTopValidation(ProfiledStrategy):
    module_id = 14
    module_name = "Double Bottom/Top Validation"
    cluster_id = "C"

    def __init__(self, profile: ModuleProfile):
        self.atr_period = profile.integer("atr_period", positive=True)
        self.volume_period = profile.integer("volume_median_bars", positive=True)
        self.pivot_left = profile.integer("pivot_left_bars", positive=True)
        self.pivot_right = profile.integer("pivot_right_bars", positive=True)
        self.minimum_separation = profile.integer(
            "minimum_separation_bars", positive=True
        )
        self.preferred_separation = profile.integer(
            "preferred_separation_bars", positive=True
        )
        self.maximum_separation = profile.integer(
            "maximum_separation_bars", positive=True
        )
        min_bars = max(
            self.atr_period,
            self.volume_period + self.pivot_right + 1,
            self.pivot_left
            + self.maximum_separation
            + self.pivot_right
            + 1,
        )
        super().__init__(profile, min_bars=min_bars)

    def evaluate(self, bars: list[Candle], spec: SymbolSpec) -> StrategyResult:
        validate_bars(bars)
        if len(bars) < self.min_bars:
            return self.flat()
        window = bars[-self.min_bars :]
        atr_value = latest_atr(window, self.atr_period)
        if atr_value is None:
            return self.flat()
        buy = self._candidate(window, atr_value, Direction.BUY)
        sell = self._candidate(window, atr_value, Direction.SELL)
        if (buy is None) == (sell is None):
            return self.flat()
        candidate = buy if buy is not None else sell
        assert candidate is not None
        direction = Direction.BUY if buy is not None else Direction.SELL
        first: Pivot = candidate["first"]
        second: Pivot = candidate["second"]
        second_bar = window[second.index]
        second_median = median_tick_volume(window[: second.index], self.volume_period)
        rejection_wick = (
            lower_wick(second_bar)
            if direction is Direction.BUY
            else upper_wick(second_bar)
        )
        minimum_wick = (
            float(self.profile.number("minimum_rejection_wick_atr", positive=True))
            * atr_value
        )
        flags = (
            second_median is not None and second_bar.tick_volume < second_median,
            rejection_wick >= minimum_wick,
            candidate["separation"] >= self.preferred_separation,
        )
        body_low, body_high = candle_body(second_bar)
        zone_min, zone_max = (
            (float(second_bar.low), body_low)
            if direction is Direction.BUY
            else (body_high, float(second_bar.high))
        )
        level = candidate["level"]
        return self.result(
            bars=window,
            spec=spec,
            direction=direction,
            zone_min=zone_min,
            zone_max=zone_max,
            overlay_type="DOUBLE_BOTTOM_TOP",
            geometry=[
                {
                    "type": "line",
                    "role": "equal_pivot_level",
                    "start_time": first.time,
                    "end_time": second.time,
                    "price": price(level, spec),
                },
                {
                    "type": "point",
                    "role": "first_test",
                    "time": first.time,
                    "price": price(first.price, spec),
                },
                {
                    "type": "point",
                    "role": "second_test",
                    "time": second.time,
                    "price": price(second.price, spec),
                },
            ],
            stop_anchor={
                "time": second.time,
                "price": price(second.price, spec),
                "role": "second_test_extreme",
            },
            opposing_structures=[
                {
                    "time": first.time,
                    "price": price(first.price, spec),
                    "kind": "FIRST_EQUAL_PIVOT",
                }
            ],
            indicators={
                "atr": atr_value,
                "equal_level": level,
                "separation_bars": candidate["separation"],
                "second_to_first_volume_ratio": (
                    second_bar.tick_volume / window[first.index].tick_volume
                    if window[first.index].tick_volume > 0
                    else None
                ),
                "second_tick_volume_proxy": second_bar.tick_volume,
                "second_volume_median": second_median,
                "rejection_wick_atr": rejection_wick / atr_value,
            },
            quality_flags=flags,
        )

    def _candidate(
        self,
        bars: Sequence[Candle],
        atr_value: float,
        direction: Direction,
    ) -> dict[str, Any] | None:
        pivots = (
            confirmed_pivot_lows(bars, self.pivot_left, self.pivot_right)
            if direction is Direction.BUY
            else confirmed_pivot_highs(bars, self.pivot_left, self.pivot_right)
        )
        current_index = len(bars) - 1
        second_required_index = current_index - self.pivot_right
        equality = (
            float(self.profile.number("equal_level_tolerance_atr", positive=True))
            * atr_value
        )
        close_away = (
            float(self.profile.number("close_away_atr", positive=True)) * atr_value
        )
        volume_ratio = float(
            self.profile.number("second_volume_ratio", positive=True)
        )
        candidates: list[dict[str, Any]] = []
        for first_index, first in enumerate(pivots):
            for second in pivots[first_index + 1 :]:
                if second.index != second_required_index:
                    continue
                separation = second.index - first.index
                if not self.minimum_separation <= separation <= self.maximum_separation:
                    continue
                if abs(second.price - first.price) > equality:
                    continue
                first_volume = bars[first.index].tick_volume
                second_volume = bars[second.index].tick_volume
                if first_volume <= 0 or second_volume > volume_ratio * first_volume:
                    continue
                level = (first.price + second.price) / 2.0
                second_close = float(bars[second.index].close)
                closes_away = (
                    second_close >= level + close_away
                    if direction is Direction.BUY
                    else second_close <= level - close_away
                )
                if not closes_away:
                    continue
                candidates.append(
                    {
                        "first": first,
                        "second": second,
                        "separation": separation,
                        "level": level,
                    }
                )
        return max(candidates, key=lambda item: item["first"].index, default=None)


__all__ = ["DoubleBottomTopValidation"]
