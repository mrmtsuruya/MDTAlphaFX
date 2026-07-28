"""Module 13 — Supply/Demand Zone Retest."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from .common import (
    ProfiledStrategy,
    body_size,
    candle_body,
    latest_atr,
    lower_wick,
    median_tick_volume,
    price,
    upper_wick,
    validate_bars,
)
from .configuration import ModuleProfile


class SupplyDemandZoneRetest(ProfiledStrategy):
    module_id = 13
    module_name = "Supply/Demand Zone Retest"
    cluster_id = "B"

    def __init__(self, profile: ModuleProfile):
        self.atr_period = profile.integer("atr_period", positive=True)
        self.volume_period = profile.integer("volume_median_bars", positive=True)
        self.minimum_base = profile.integer("minimum_base_bars", positive=True)
        self.maximum_base = profile.integer("maximum_base_bars", positive=True)
        self.maximum_retest = profile.integer("maximum_retest_bars", positive=True)
        min_bars = max(
            self.atr_period,
            self.volume_period
            + self.maximum_base
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
        impulse = window[candidate["impulse_index"]]
        impulse_median = median_tick_volume(
            window[: candidate["impulse_index"]], self.volume_period
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
            impulse_median is not None
            and impulse.tick_volume >= high_volume_ratio * impulse_median,
            True,
            rejection_wick >= minimum_wick,
        )
        base = candidate["base"]
        zone_min, zone_max = candidate["zone"]
        return self.result(
            bars=window,
            spec=spec,
            direction=direction,
            zone_min=zone_min,
            zone_max=zone_max,
            overlay_type="SUPPLY_DEMAND_ZONE",
            geometry=[
                {
                    "type": "zone",
                    "role": "base_body_zone",
                    "start_time": base[0].time.isoformat(),
                    "end_time": current.time.isoformat(),
                    "min": price(zone_min, spec),
                    "max": price(zone_max, spec),
                },
                {
                    "type": "candle",
                    "role": "impulse",
                    "time": impulse.time.isoformat(),
                    "open": price(impulse.open, spec),
                    "close": price(impulse.close, spec),
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
            opposing_structures=(),
            indicators={
                "atr": atr_value,
                "base_candles": len(base),
                "base_range_atr": candidate["base_range"] / atr_value,
                "impulse_body_atr": body_size(impulse) / atr_value,
                "impulse_tick_volume_proxy": impulse.tick_volume,
                "impulse_volume_median": impulse_median,
                "prior_retest_count": 0,
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
        current_index = len(bars) - 1
        maximum_base_range = (
            float(self.profile.number("maximum_base_range_atr", positive=True))
            * atr_value
        )
        minimum_impulse = (
            float(self.profile.number("minimum_impulse_body_atr", positive=True))
            * atr_value
        )
        candidates: list[dict[str, Any]] = []
        first_impulse = max(
            self.volume_period + self.minimum_base,
            current_index - self.maximum_retest,
        )
        for impulse_index in range(first_impulse, current_index):
            impulse = bars[impulse_index]
            directional = (
                impulse.close > impulse.open
                if direction is Direction.BUY
                else impulse.close < impulse.open
            )
            if not directional or body_size(impulse) < minimum_impulse:
                continue
            age = current_index - impulse_index
            if age < 1 or age > self.maximum_retest:
                continue
            for base_size in range(self.minimum_base, self.maximum_base + 1):
                base_start = impulse_index - base_size
                if base_start < 0:
                    continue
                base = list(bars[base_start:impulse_index])
                combined_range = max(float(bar.high) for bar in base) - min(
                    float(bar.low) for bar in base
                )
                if combined_range > maximum_base_range:
                    continue
                bodies = [candle_body(bar) for bar in base]
                zone_min = min(body[0] for body in bodies)
                zone_max = max(body[1] for body in bodies)
                if not self._first_retest_is_current(
                    bars, impulse_index, zone_min, zone_max
                ):
                    continue
                candidates.append(
                    {
                        "base": base,
                        "base_range": combined_range,
                        "impulse_index": impulse_index,
                        "zone": (zone_min, zone_max),
                    }
                )
        return max(
            candidates,
            key=lambda item: (item["impulse_index"], len(item["base"])),
            default=None,
        )

    @staticmethod
    def _overlaps(bar: Candle, zone_min: float, zone_max: float) -> bool:
        return float(bar.low) <= zone_max and float(bar.high) >= zone_min

    def _first_retest_is_current(
        self,
        bars: Sequence[Candle],
        impulse_index: int,
        zone_min: float,
        zone_max: float,
    ) -> bool:
        current_index = len(bars) - 1
        for index in range(impulse_index + 1, current_index + 1):
            if self._overlaps(bars[index], zone_min, zone_max):
                return index == current_index
        return False


__all__ = ["SupplyDemandZoneRetest"]
