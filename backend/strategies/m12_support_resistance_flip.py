"""Module 12 — Support/Resistance Flip."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from .common import (
    Pivot,
    ProfiledStrategy,
    body_size,
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


class SupportResistanceFlip(ProfiledStrategy):
    module_id = 12
    module_name = "Support/Resistance Flip"
    cluster_id = "B"

    def __init__(self, profile: ModuleProfile):
        self.atr_period = profile.integer("atr_period", positive=True)
        self.volume_period = profile.integer("volume_median_bars", positive=True)
        self.pivot_left = profile.integer("pivot_left_bars", positive=True)
        self.pivot_right = profile.integer("pivot_right_bars", positive=True)
        self.minimum_separation = profile.integer(
            "minimum_separation_bars", positive=True
        )
        self.maximum_separation = profile.integer(
            "maximum_separation_bars", positive=True
        )
        self.maximum_retest = profile.integer("maximum_retest_bars", positive=True)
        min_bars = max(
            self.atr_period,
            self.volume_period + 1,
            self.pivot_left
            + self.maximum_separation
            + self.pivot_right
            + self.maximum_retest
            + 2,
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
        current = window[-1]
        break_bar = window[candidate["break_index"]]
        break_median = median_tick_volume(
            window[: candidate["break_index"]], self.volume_period
        )
        displacement_threshold = (
            float(
                self.profile.number(
                    "minimum_displacement_body_atr", positive=True
                )
            )
            * atr_value
        )
        high_volume_ratio = float(
            self.profile.number("high_volume_ratio", positive=True)
        )
        rejection_wick = (
            lower_wick(current)
            if direction is Direction.BUY
            else upper_wick(current)
        )
        minimum_wick = (
            float(self.profile.number("minimum_rejection_wick_atr", positive=True))
            * atr_value
        )
        flags = (
            body_size(break_bar) >= displacement_threshold,
            break_median is not None
            and break_bar.tick_volume >= high_volume_ratio * break_median,
            rejection_wick >= minimum_wick,
        )
        first: Pivot = candidate["first"]
        second: Pivot = candidate["second"]
        level = candidate["level"]
        zone_min, zone_max = candidate["zone"]
        return self.result(
            bars=window,
            spec=spec,
            direction=direction,
            zone_min=zone_min,
            zone_max=zone_max,
            overlay_type="SUPPORT_RESISTANCE_FLIP",
            geometry=[
                {
                    "type": "line",
                    "role": "key_level",
                    "start_time": first.time,
                    "end_time": current.time.isoformat(),
                    "price": price(level, spec),
                },
                {
                    "type": "point",
                    "role": "second_pivot",
                    "time": second.time,
                    "price": price(second.price, spec),
                },
                {
                    "type": "point",
                    "role": "break",
                    "time": break_bar.time.isoformat(),
                    "price": price(break_bar.close, spec),
                },
            ],
            stop_anchor={
                "time": current.time.isoformat(),
                "price": price(
                    current.low if direction is Direction.BUY else current.high,
                    spec,
                ),
                "role": "retest_extreme",
            },
            opposing_structures=[
                {
                    "time": first.time,
                    "price": price(first.price, spec),
                    "kind": "KEY_LEVEL_PIVOT",
                },
                {
                    "time": second.time,
                    "price": price(second.price, spec),
                    "kind": "KEY_LEVEL_PIVOT",
                },
            ],
            indicators={
                "atr": atr_value,
                "key_level": level,
                "break_body_atr": body_size(break_bar) / atr_value,
                "break_tick_volume_proxy": break_bar.tick_volume,
                "break_volume_median": break_median,
                "retest_wick_atr": rejection_wick / atr_value,
            },
            quality_flags=flags,
        )

    def _candidate(
        self,
        bars: Sequence[Candle],
        atr_value: float,
        direction: Direction,
    ) -> dict[str, Any] | None:
        history = bars[:-1]
        pivots = (
            confirmed_pivot_highs(history, self.pivot_left, self.pivot_right)
            if direction is Direction.BUY
            else confirmed_pivot_lows(history, self.pivot_left, self.pivot_right)
        )
        equality = (
            float(self.profile.number("equal_level_tolerance_atr", positive=True))
            * atr_value
        )
        break_buffer = (
            float(self.profile.number("break_buffer_atr", positive=True)) * atr_value
        )
        zone_half = equality
        candidates: list[dict[str, Any]] = []
        for first_index, first in enumerate(pivots):
            for second in pivots[first_index + 1 :]:
                separation = second.index - first.index
                if not self.minimum_separation <= separation <= self.maximum_separation:
                    continue
                if abs(second.price - first.price) > equality:
                    continue
                level = (first.price + second.price) / 2.0
                first_break = second.index + self.pivot_right + 1
                for break_index in range(first_break, len(history)):
                    close = float(history[break_index].close)
                    broken = (
                        close > level + break_buffer
                        if direction is Direction.BUY
                        else close < level - break_buffer
                    )
                    if not broken:
                        continue
                    zone = (level - zone_half, level + zone_half)
                    if self._first_retest_is_current(bars, break_index, *zone):
                        candidates.append(
                            {
                                "first": first,
                                "second": second,
                                "level": level,
                                "break_index": break_index,
                                "zone": zone,
                            }
                        )
                    break
        return max(
            candidates,
            key=lambda item: (
                item["break_index"],
                item["second"].index,
                item["first"].index,
            ),
            default=None,
        )

    def _first_retest_is_current(
        self,
        bars: Sequence[Candle],
        break_index: int,
        zone_min: float,
        zone_max: float,
    ) -> bool:
        current_index = len(bars) - 1
        age = current_index - break_index
        if age < 1 or age > self.maximum_retest:
            return False
        for index in range(break_index + 1, current_index + 1):
            bar = bars[index]
            if float(bar.low) <= zone_max and float(bar.high) >= zone_min:
                return index == current_index
        return False


__all__ = ["SupportResistanceFlip"]
