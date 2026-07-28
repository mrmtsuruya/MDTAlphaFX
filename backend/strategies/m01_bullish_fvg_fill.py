"""Module 1 — Bullish Fair Value Gap fill."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

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
from .indicators import atr
from .candidate_ranking import candidate_sort_key, select_candidate


@dataclass(frozen=True)
class _Gap:
    first: int
    middle: int
    third: int
    low: float
    high: float
    atr: float
    volume_median: float
    direction: Literal["BULLISH", "BEARISH"]


def _gap_candidates(
    bars: list[Candle],
    *,
    current: int,
    maximum_age: int,
    atr_period: int,
    volume_period: int,
    gap_min_atr: float,
    displacement_atr: float,
    direction: Literal["BULLISH", "BEARISH"],
) -> list[_Gap]:
    atr_values = atr(bars, atr_period)
    candidates: list[_Gap] = []
    first_third = max(2, current - maximum_age)
    for third in range(first_third, current):
        first = third - 2
        middle = third - 1
        atr_value = atr_values[third]
        if atr_value is None or atr_value <= 0.0:
            continue
        median = median_tick_volume(bars[:third], volume_period)
        if median is None or median <= 0.0:
            continue
        if direction == "BULLISH":
            low = float(bars[first].high)
            high = float(bars[third].low)
        else:
            low = float(bars[third].high)
            high = float(bars[first].low)
        width = high - low
        if width < gap_min_atr * atr_value:
            continue
        if body_size(bars[middle]) < displacement_atr * atr_value:
            continue
        candidates.append(
            _Gap(
                first=first,
                middle=middle,
                third=third,
                low=low,
                high=high,
                atr=float(atr_value),
                volume_median=float(median),
                direction=direction,
            )
        )
    return candidates


def _overlaps(bar: Candle, low: float, high: float) -> bool:
    return float(bar.low) <= high and float(bar.high) >= low


def _gap_geometry(gap: _Gap, bars: list[Candle], spec: SymbolSpec) -> list[dict]:
    return [
        {
            "type": "RECTANGLE",
            "kind": "FAIR_VALUE_GAP",
            "direction": gap.direction,
            "start_time": bars[gap.first].time.isoformat(),
            "formation_time": bars[gap.third].time.isoformat(),
            "end_time": bars[-1].time.isoformat(),
            "min": price(gap.low, spec),
            "max": price(gap.high, spec),
        },
        {
            "type": "MARKER",
            "kind": "FIRST_OVERLAP",
            "time": bars[-1].time.isoformat(),
            "price": price(float(bars[-1].low if gap.direction == "BULLISH" else bars[-1].high), spec),
        },
    ]


def _gap_rank_key(gap: _Gap, bars: list[Candle]):
    if gap.direction == "BULLISH":
        lower = ("GAP_LOWER_EDGE", gap.first, float(bars[gap.first].high))
        upper = ("GAP_UPPER_EDGE", gap.third, float(bars[gap.third].low))
    else:
        lower = ("GAP_LOWER_EDGE", gap.third, float(bars[gap.third].high))
        upper = ("GAP_UPPER_EDGE", gap.first, float(bars[gap.first].low))
    coordinates = [
        (lower[0], bars[lower[1]].time.isoformat(), lower[2]),
        (upper[0], bars[upper[1]].time.isoformat(), upper[2]),
        (
            "DISPLACEMENT_OPEN",
            bars[gap.middle].time.isoformat(),
            float(bars[gap.middle].open),
        ),
        (
            "DISPLACEMENT_CLOSE",
            bars[gap.middle].time.isoformat(),
            float(bars[gap.middle].close),
        ),
    ]
    return candidate_sort_key(
        formation_index=gap.third,
        raw_zone_min=gap.low,
        raw_zone_max=gap.high,
        geometry_coordinates=coordinates,
        source_indices=(gap.first, gap.middle, gap.third),
    )


class BullishFVGFill(ProfiledStrategy):
    module_id = 1
    module_name = "Bullish FVG Fill"
    cluster_id = "A"

    def __init__(self, profile: ModuleProfile):
        self.atr_period = profile.integer("atr_period", positive=True)
        self.volume_period = profile.integer("volume_median_bars", positive=True)
        self.maximum_age = profile.integer("maximum_age_bars", positive=True)
        self.gap_min_atr = float(profile.number("gap_min_atr", non_negative=True))
        self.large_gap_atr = float(profile.number("large_gap_atr", non_negative=True))
        self.displacement_atr = float(
            profile.number("minimum_displacement_body_atr", non_negative=True)
        )
        self.high_volume_ratio = float(
            profile.number("high_volume_ratio", non_negative=True)
        )
        self.midpoint_fraction = float(
            profile.number("fill_midpoint_fraction", non_negative=True)
        )
        min_bars = (
            max(self.atr_period, self.volume_period)
            + self.maximum_age
            + 3
        )
        super().__init__(profile, min_bars=min_bars)

    @classmethod
    def from_config(cls, config: Config) -> "BullishFVGFill":
        return cls(cls.profile_from_config(config))

    def evaluate(self, bars: list[Candle], spec: SymbolSpec) -> StrategyResult:
        if len(bars) < self.min_bars:
            return self.flat()
        validate_bars(bars)
        current = len(bars) - 1
        eligible: list[_Gap] = []
        for gap in _gap_candidates(
            bars,
            current=current,
            maximum_age=self.maximum_age,
            atr_period=self.atr_period,
            volume_period=self.volume_period,
            gap_min_atr=self.gap_min_atr,
            displacement_atr=self.displacement_atr,
            direction="BULLISH",
        ):
            prior = bars[gap.third + 1 : current]
            if any(_overlaps(bar, gap.low, gap.high) for bar in prior):
                continue
            if any(float(bar.close) < gap.low for bar in prior):
                continue
            if not _overlaps(bars[current], gap.low, gap.high):
                continue
            if float(bars[current].close) < gap.low:
                continue
            eligible.append(gap)
        gap = select_candidate(
            eligible,
            direction_of=lambda candidate: Direction.BUY,
            key_of=lambda candidate: _gap_rank_key(candidate, bars),
        )
        if gap is None:
            return self.flat()
        midpoint = gap.low + (gap.high - gap.low) * self.midpoint_fraction
        flags = (
            bars[gap.middle].tick_volume
            >= self.high_volume_ratio * gap.volume_median,
            gap.high - gap.low >= self.large_gap_atr * gap.atr,
            float(bars[current].close) > midpoint,
        )
        return self.result(
            bars=bars,
            spec=spec,
            direction=Direction.BUY,
            zone_min=gap.low,
            zone_max=gap.high,
            overlay_type="FVG_FILL",
            geometry=_gap_geometry(gap, bars, spec),
            stop_anchor={
                "kind": "FVG_ORIGIN_LOW",
                "time": bars[gap.first].time.isoformat(),
                "price": price(float(bars[gap.first].low), spec),
            },
            indicators={
                "atr": gap.atr,
                "gap_width_atr": (gap.high - gap.low) / gap.atr,
                "middle_volume_ratio": bars[gap.middle].tick_volume
                / gap.volume_median,
                "touch_close_vs_midpoint": float(bars[current].close) - midpoint,
            },
            quality_flags=flags,
        )


__all__ = ["BullishFVGFill"]
