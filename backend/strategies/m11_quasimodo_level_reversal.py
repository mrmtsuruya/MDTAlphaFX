"""Module 11 — Quasimodo Level Reversal."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from .common import (
    Pivot,
    ProfiledStrategy,
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


class QuasimodoLevelReversal(ProfiledStrategy):
    module_id = 11
    module_name = "Quasimodo Level Reversal"
    cluster_id = "D2"

    def __init__(self, profile: ModuleProfile):
        self.atr_period = profile.integer("atr_period", positive=True)
        self.volume_period = profile.integer("volume_median_bars", positive=True)
        self.pivot_left = profile.integer("pivot_left_bars", positive=True)
        self.pivot_right = profile.integer("pivot_right_bars", positive=True)
        self.structure_lookback = profile.integer(
            "structure_lookback_bars", positive=True
        )
        self.maximum_return = profile.integer("maximum_return_bars", positive=True)
        min_bars = max(
            self.atr_period,
            self.volume_period + 1,
            self.pivot_left
            + self.pivot_right
            + self.structure_lookback
            + self.maximum_return
            + 1,
        )
        super().__init__(profile, min_bars=min_bars)

    def evaluate(
        self, bars: list[Candle], spec: SymbolSpec
    ) -> StrategyResult:
        validate_bars(bars)
        if len(bars) < self.min_bars:
            return self.flat()
        window = bars[-self.min_bars :]
        atr_value = latest_atr(window, self.atr_period)
        if atr_value is None:
            return self.flat()

        bearish = self._bearish_candidate(window, atr_value)
        bullish = self._bullish_candidate(window, atr_value)
        if (bearish is None) == (bullish is None):
            return self.flat()
        candidate = bearish if bearish is not None else bullish
        assert candidate is not None
        direction = Direction.SELL if bearish is not None else Direction.BUY

        current = window[-1]
        volume_median = median_tick_volume(window[:-1], self.volume_period)
        high_volume_ratio = float(
            self.profile.number("high_volume_ratio", positive=True)
        )
        minimum_wick = (
            float(self.profile.number("minimum_rejection_wick_atr", positive=True))
            * atr_value
        )
        rejection_wick = (
            upper_wick(current)
            if direction is Direction.SELL
            else lower_wick(current)
        )
        strong_overextension = float(
            self.profile.number("strong_overextension_atr", positive=True)
        )
        flags = (
            candidate["overextension"] >= strong_overextension * atr_value,
            rejection_wick >= minimum_wick,
            volume_median is not None
            and current.tick_volume >= high_volume_ratio * volume_median,
        )
        shoulder: Pivot = candidate["shoulder"]
        extreme: Pivot = candidate["extreme"]
        intervening: Pivot = candidate["intervening"]
        zone_min, zone_max = candidate["zone"]
        geometry = [
            {
                "type": "point",
                "role": "left_shoulder",
                "time": shoulder.time,
                "price": price(shoulder.price, spec),
            },
            {
                "type": "point",
                "role": "overextended_extreme",
                "time": extreme.time,
                "price": price(extreme.price, spec),
            },
            {
                "type": "point",
                "role": "intervening_swing",
                "time": intervening.time,
                "price": price(intervening.price, spec),
            },
            {
                "type": "zone",
                "role": "shoulder_return",
                "start_time": shoulder.time,
                "end_time": current.time.isoformat(),
                "min": price(zone_min, spec),
                "max": price(zone_max, spec),
            },
        ]
        return self.result(
            bars=window,
            spec=spec,
            direction=direction,
            zone_min=zone_min,
            zone_max=zone_max,
            overlay_type="QUASIMODO",
            geometry=geometry,
            stop_anchor={
                "time": extreme.time,
                "price": price(extreme.price, spec),
                "role": "overextended_extreme",
            },
            opposing_structures=[
                {
                    "time": intervening.time,
                    "price": price(intervening.price, spec),
                    "kind": "INTERVENING_SWING",
                }
            ],
            indicators={
                "atr": atr_value,
                "overextension_atr": candidate["overextension"] / atr_value,
                "rejection_wick_atr": rejection_wick / atr_value,
                "tick_volume_proxy": current.tick_volume,
                "volume_median": volume_median,
            },
            quality_flags=flags,
        )

    def _bearish_candidate(
        self, bars: Sequence[Candle], atr_value: float
    ) -> dict[str, Any] | None:
        history = bars[:-1]
        highs = confirmed_pivot_highs(history, self.pivot_left, self.pivot_right)
        lows = confirmed_pivot_lows(history, self.pivot_left, self.pivot_right)
        overextension = (
            float(self.profile.number("overextension_atr", positive=True)) * atr_value
        )
        tolerance = (
            float(self.profile.number("shoulder_tolerance_atr", positive=True))
            * atr_value
        )
        candidates: list[dict[str, Any]] = []
        for shoulder in highs:
            for extreme in highs:
                if extreme.index <= shoulder.index or extreme.price - shoulder.price < overextension:
                    continue
                if extreme.index - shoulder.index > self.structure_lookback:
                    continue
                for intervening in lows:
                    if not shoulder.index < intervening.index < extreme.index:
                        continue
                    first_break = extreme.index + self.pivot_right + 1
                    for break_index in range(first_break, len(history)):
                        if float(history[break_index].close) >= intervening.price:
                            continue
                        if break_index - shoulder.index > self.structure_lookback:
                            break
                        if not self._first_return_is_current(
                            bars,
                            break_index,
                            shoulder.price - tolerance,
                            shoulder.price + tolerance,
                        ):
                            break
                        candidates.append(
                            {
                                "shoulder": shoulder,
                                "extreme": extreme,
                                "intervening": intervening,
                                "break_index": break_index,
                                "overextension": extreme.price - shoulder.price,
                                "zone": (
                                    shoulder.price - tolerance,
                                    shoulder.price + tolerance,
                                ),
                            }
                        )
                        break
        return max(
            candidates,
            key=lambda item: (
                item["break_index"],
                item["extreme"].index,
                item["shoulder"].index,
            ),
            default=None,
        )

    def _bullish_candidate(
        self, bars: Sequence[Candle], atr_value: float
    ) -> dict[str, Any] | None:
        history = bars[:-1]
        lows = confirmed_pivot_lows(history, self.pivot_left, self.pivot_right)
        highs = confirmed_pivot_highs(history, self.pivot_left, self.pivot_right)
        overextension = (
            float(self.profile.number("overextension_atr", positive=True)) * atr_value
        )
        tolerance = (
            float(self.profile.number("shoulder_tolerance_atr", positive=True))
            * atr_value
        )
        candidates: list[dict[str, Any]] = []
        for shoulder in lows:
            for extreme in lows:
                if extreme.index <= shoulder.index or shoulder.price - extreme.price < overextension:
                    continue
                if extreme.index - shoulder.index > self.structure_lookback:
                    continue
                for intervening in highs:
                    if not shoulder.index < intervening.index < extreme.index:
                        continue
                    first_break = extreme.index + self.pivot_right + 1
                    for break_index in range(first_break, len(history)):
                        if float(history[break_index].close) <= intervening.price:
                            continue
                        if break_index - shoulder.index > self.structure_lookback:
                            break
                        if not self._first_return_is_current(
                            bars,
                            break_index,
                            shoulder.price - tolerance,
                            shoulder.price + tolerance,
                        ):
                            break
                        candidates.append(
                            {
                                "shoulder": shoulder,
                                "extreme": extreme,
                                "intervening": intervening,
                                "break_index": break_index,
                                "overextension": shoulder.price - extreme.price,
                                "zone": (
                                    shoulder.price - tolerance,
                                    shoulder.price + tolerance,
                                ),
                            }
                        )
                        break
        return max(
            candidates,
            key=lambda item: (
                item["break_index"],
                item["extreme"].index,
                item["shoulder"].index,
            ),
            default=None,
        )

    def _first_return_is_current(
        self,
        bars: Sequence[Candle],
        break_index: int,
        zone_min: float,
        zone_max: float,
    ) -> bool:
        current_index = len(bars) - 1
        age = current_index - break_index
        if age < 1 or age > self.maximum_return:
            return False
        for index in range(break_index + 1, current_index + 1):
            bar = bars[index]
            if float(bar.low) <= zone_max and float(bar.high) >= zone_min:
                return index == current_index
        return False


__all__ = ["QuasimodoLevelReversal"]
