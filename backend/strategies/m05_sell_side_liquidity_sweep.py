"""Module 5 — Sell-Side Liquidity Sweep."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from ..core.config import Config
from .common import (
    Pivot,
    ProfiledStrategy,
    bar_range,
    confirmed_pivot_highs,
    confirmed_pivot_lows,
    lower_wick,
    median_tick_volume,
    price,
    upper_wick,
    validate_bars,
)
from .configuration import ModuleProfile
from .indicators import atr
from .candidate_ranking import candidate_sort_key, select_candidate


@dataclass(frozen=True)
class _LiquidityPair:
    first: Pivot
    second: Pivot
    level: float
    direction: Literal["SELL_SIDE", "BUY_SIDE"]


def _liquidity_pairs(
    bars: list[Candle],
    *,
    direction: Literal["SELL_SIDE", "BUY_SIDE"],
    left: int,
    right: int,
    structure_lookback: int,
    minimum_separation: int,
    maximum_separation: int,
    tolerance: float,
) -> list[_LiquidityPair]:
    pivots = (
        confirmed_pivot_lows(bars, left, right)
        if direction == "SELL_SIDE"
        else confirmed_pivot_highs(bars, left, right)
    )
    current = len(bars) - 1
    pivots = [
        pivot for pivot in pivots if pivot.index >= current - structure_lookback
    ]
    result: list[_LiquidityPair] = []
    for second_position, second in enumerate(pivots):
        for first in pivots[:second_position]:
            separation = second.index - first.index
            if not minimum_separation <= separation <= maximum_separation:
                continue
            if abs(second.price - first.price) > tolerance:
                continue
            result.append(
                _LiquidityPair(
                    first=first,
                    second=second,
                    level=(first.price + second.price) / 2.0,
                    direction=direction,
                )
            )
    return result


def _sweep_geometry(
    pair: _LiquidityPair,
    bars: list[Candle],
    spec: SymbolSpec,
    zone_low: float,
    zone_high: float,
) -> list[dict]:
    return [
        {
            "type": "HORIZONTAL_RAY",
            "kind": "EQUAL_LIQUIDITY",
            "direction": pair.direction,
            "start_time": pair.first.time,
            "through_time": pair.second.time,
            "end_time": bars[-1].time.isoformat(),
            "price": price(pair.level, spec),
        },
        {
            "type": "WICK",
            "kind": "LIQUIDITY_SWEEP",
            "time": bars[-1].time.isoformat(),
            "min": price(zone_low, spec),
            "max": price(zone_high, spec),
        },
    ]


def _liquidity_pair_rank_key(
    pair: _LiquidityPair,
    bars: list[Candle],
    *,
    current: int,
    zone_low: float,
    zone_high: float,
):
    sweep_price = (
        float(bars[current].low)
        if pair.direction == "SELL_SIDE"
        else float(bars[current].high)
    )
    return candidate_sort_key(
        formation_index=current,
        raw_zone_min=zone_low,
        raw_zone_max=zone_high,
        geometry_coordinates=(
            ("EQUAL_LEVEL_FIRST", pair.first.time, pair.first.price),
            ("EQUAL_LEVEL_SECOND", pair.second.time, pair.second.price),
            (
                "SWEEP_EXTREME",
                bars[current].time.isoformat(),
                sweep_price,
            ),
            (
                "SWEEP_CLOSE",
                bars[current].time.isoformat(),
                float(bars[current].close),
            ),
        ),
        source_indices=(pair.first.index, pair.second.index, current),
    )


class SellSideLiquiditySweep(ProfiledStrategy):
    module_id = 5
    module_name = "Sell-Side Liquidity Sweep"
    cluster_id = "C"

    def __init__(self, profile: ModuleProfile):
        self.atr_period = profile.integer("atr_period", positive=True)
        self.volume_period = profile.integer("volume_median_bars", positive=True)
        self.pivot_left = profile.integer("pivot_left_bars", positive=True)
        self.pivot_right = profile.integer("pivot_right_bars", positive=True)
        self.structure_lookback = profile.integer(
            "structure_lookback_bars", positive=True
        )
        self.minimum_separation = profile.integer(
            "minimum_separation_bars", positive=True
        )
        self.maximum_separation = profile.integer(
            "maximum_separation_bars", positive=True
        )
        self.equal_tolerance = float(
            profile.number("equal_level_tolerance_atr", non_negative=True)
        )
        self.minimum_pierce = float(
            profile.number("minimum_pierce_atr", non_negative=True)
        )
        self.minimum_wick = float(
            profile.number("minimum_rejection_wick_atr", non_negative=True)
        )
        self.high_volume_ratio = float(
            profile.number("high_volume_ratio", non_negative=True)
        )
        self.close_half = float(
            profile.number("close_half_fraction", non_negative=True)
        )
        min_bars = (
            max(self.atr_period, self.volume_period)
            + self.maximum_separation
            + self.pivot_left
            + self.pivot_right
            + 2
        )
        super().__init__(profile, min_bars=min_bars)

    @classmethod
    def from_config(cls, config: Config) -> "SellSideLiquiditySweep":
        return cls(cls.profile_from_config(config))

    def evaluate(self, bars: list[Candle], spec: SymbolSpec) -> StrategyResult:
        if len(bars) < self.min_bars:
            return self.flat()
        validate_bars(bars)
        current = len(bars) - 1
        current_atr = atr(bars, self.atr_period)[current]
        median = median_tick_volume(bars, self.volume_period)
        if current_atr is None or current_atr <= 0.0 or median is None or median <= 0.0:
            return self.flat()
        pairs = _liquidity_pairs(
            bars,
            direction="SELL_SIDE",
            left=self.pivot_left,
            right=self.pivot_right,
            structure_lookback=self.structure_lookback,
            minimum_separation=self.minimum_separation,
            maximum_separation=self.maximum_separation,
            tolerance=self.equal_tolerance * float(current_atr),
        )
        eligible: list[_LiquidityPair] = []
        for pair in pairs:
            threshold = pair.level - self.minimum_pierce * float(current_atr)
            if not (
                float(bars[current].low) < threshold
                and float(bars[current].close) > pair.level
            ):
                continue
            prior = bars[pair.second.index + self.pivot_right + 1 : current]
            if any(
                float(bar.low) < threshold and float(bar.close) > pair.level
                for bar in prior
            ):
                continue
            eligible.append(pair)
        candle = bars[current]
        zone_low = float(candle.low)
        zone_high = min(float(candle.open), float(candle.close))
        pair = select_candidate(
            eligible,
            direction_of=lambda candidate: Direction.BUY,
            key_of=lambda candidate: _liquidity_pair_rank_key(
                candidate,
                bars,
                current=current,
                zone_low=zone_low,
                zone_high=zone_high,
            ),
        )
        if pair is None:
            return self.flat()
        range_value = bar_range(candle)
        flags = (
            lower_wick(candle) >= self.minimum_wick * float(current_atr),
            candle.tick_volume >= self.high_volume_ratio * median,
            range_value > 0.0
            and float(candle.close)
            >= float(candle.low) + self.close_half * range_value,
        )
        return self.result(
            bars=bars,
            spec=spec,
            direction=Direction.BUY,
            zone_min=zone_low,
            zone_max=zone_high,
            overlay_type="LIQUIDITY_SWEEP",
            geometry=_sweep_geometry(pair, bars, spec, zone_low, zone_high),
            stop_anchor={
                "kind": "SWEEP_LOW",
                "time": candle.time.isoformat(),
                "price": price(float(candle.low), spec),
            },
            indicators={
                "atr": float(current_atr),
                "equal_level_distance_atr": abs(
                    pair.first.price - pair.second.price
                )
                / float(current_atr),
                "pierce_atr": (pair.level - float(candle.low))
                / float(current_atr),
                "rejection_wick_atr": lower_wick(candle) / float(current_atr),
                "volume_ratio": candle.tick_volume / median,
            },
            quality_flags=flags,
        )


__all__ = ["SellSideLiquiditySweep"]
