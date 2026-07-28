"""Module 3 — Bullish Order Block mitigation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from ..core.config import Config
from .common import (
    Pivot,
    ProfiledStrategy,
    body_size,
    candle_body,
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
class _OrderBlock:
    candle: int
    break_bar: int
    zone_low: float
    zone_high: float
    broken_swing: Pivot
    break_atr: float
    break_volume_median: float
    direction: Literal["BULLISH", "BEARISH"]


def _order_blocks(
    bars: list[Candle],
    *,
    current: int,
    direction: Literal["BULLISH", "BEARISH"],
    atr_period: int,
    volume_period: int,
    pivot_left: int,
    pivot_right: int,
    structure_lookback: int,
    maximum_age: int,
    break_buffer_atr: float,
    displacement_atr: float,
) -> list[_OrderBlock]:
    atr_values = atr(bars, atr_period)
    result: list[_OrderBlock] = []
    for break_bar in range(max(1, current - maximum_age), current):
        atr_value = atr_values[break_bar]
        if atr_value is None or atr_value <= 0.0:
            continue
        history = bars[: break_bar + 1]
        pivots = (
            confirmed_pivot_highs(history, pivot_left, pivot_right)
            if direction == "BULLISH"
            else confirmed_pivot_lows(history, pivot_left, pivot_right)
        )
        pivots = [
            pivot
            for pivot in pivots
            if pivot.index >= break_bar - structure_lookback
        ]
        if not pivots:
            continue
        swing = pivots[-1]
        break_close = float(bars[break_bar].close)
        threshold = break_buffer_atr * atr_value
        crossed = (
            break_close > swing.price + threshold
            if direction == "BULLISH"
            else break_close < swing.price - threshold
        )
        if not crossed or body_size(bars[break_bar]) < displacement_atr * atr_value:
            continue
        wanted_bearish = direction == "BULLISH"
        block_index = None
        lower = max(0, break_bar - structure_lookback)
        for index in range(break_bar - 1, lower - 1, -1):
            bearish = float(bars[index].close) < float(bars[index].open)
            if bearish == wanted_bearish:
                block_index = index
                break
        if block_index is None:
            continue
        median = median_tick_volume(bars[: break_bar + 1], volume_period)
        if median is None or median <= 0.0:
            continue
        zone_low, zone_high = candle_body(bars[block_index])
        result.append(
            _OrderBlock(
                candle=block_index,
                break_bar=break_bar,
                zone_low=zone_low,
                zone_high=zone_high,
                broken_swing=swing,
                break_atr=float(atr_value),
                break_volume_median=float(median),
                direction=direction,
            )
        )
    return result


def _zone_overlap(bar: Candle, low: float, high: float) -> bool:
    return float(bar.low) <= high and float(bar.high) >= low


def _order_block_geometry(
    block: _OrderBlock, bars: list[Candle], spec: SymbolSpec
) -> list[dict]:
    return [
        {
            "type": "RECTANGLE",
            "kind": "ORDER_BLOCK_BODY",
            "direction": block.direction,
            "start_time": bars[block.candle].time.isoformat(),
            "end_time": bars[-1].time.isoformat(),
            "min": price(block.zone_low, spec),
            "max": price(block.zone_high, spec),
        },
        {
            "type": "HORIZONTAL_BREAK",
            "kind": "STRUCTURE_BREAK",
            "start_time": block.broken_swing.time,
            "end_time": bars[block.break_bar].time.isoformat(),
            "price": price(block.broken_swing.price, spec),
        },
    ]


def _order_block_rank_key(block: _OrderBlock, bars: list[Candle]):
    return candidate_sort_key(
        formation_index=block.break_bar,
        raw_zone_min=block.zone_low,
        raw_zone_max=block.zone_high,
        geometry_coordinates=(
            (
                "ORDER_BLOCK_BODY_MIN",
                bars[block.candle].time.isoformat(),
                block.zone_low,
            ),
            (
                "ORDER_BLOCK_BODY_MAX",
                bars[block.candle].time.isoformat(),
                block.zone_high,
            ),
            (
                "BROKEN_SWING",
                block.broken_swing.time,
                block.broken_swing.price,
            ),
            (
                "BREAK_CLOSE",
                bars[block.break_bar].time.isoformat(),
                float(bars[block.break_bar].close),
            ),
        ),
        source_indices=(
            block.candle,
            block.break_bar,
            block.broken_swing.index,
        ),
    )


class BullishOrderBlock(ProfiledStrategy):
    module_id = 3
    module_name = "Bullish Order Block"
    cluster_id = "B"

    def __init__(self, profile: ModuleProfile):
        self.atr_period = profile.integer("atr_period", positive=True)
        self.volume_period = profile.integer("volume_median_bars", positive=True)
        self.pivot_left = profile.integer("pivot_left_bars", positive=True)
        self.pivot_right = profile.integer("pivot_right_bars", positive=True)
        self.structure_lookback = profile.integer(
            "structure_lookback_bars", positive=True
        )
        self.maximum_age = profile.integer("maximum_age_bars", positive=True)
        self.break_buffer = float(
            profile.number("break_buffer_atr", non_negative=True)
        )
        self.displacement = float(
            profile.number("minimum_displacement_body_atr", non_negative=True)
        )
        self.rejection = float(
            profile.number("minimum_rejection_wick_atr", non_negative=True)
        )
        self.high_volume_ratio = float(
            profile.number("high_volume_ratio", non_negative=True)
        )
        self.midpoint_fraction = float(
            profile.number("mitigation_midpoint_fraction", non_negative=True)
        )
        min_bars = (
            max(self.atr_period, self.volume_period)
            + self.structure_lookback
            + self.maximum_age
            + self.pivot_left
            + self.pivot_right
            + 2
        )
        super().__init__(profile, min_bars=min_bars)

    @classmethod
    def from_config(cls, config: Config) -> "BullishOrderBlock":
        return cls(cls.profile_from_config(config))

    def evaluate(self, bars: list[Candle], spec: SymbolSpec) -> StrategyResult:
        if len(bars) < self.min_bars:
            return self.flat()
        validate_bars(bars)
        current = len(bars) - 1
        current_atr = atr(bars, self.atr_period)[current]
        if current_atr is None or current_atr <= 0.0:
            return self.flat()
        eligible: list[tuple[_OrderBlock, bool]] = []
        for block in _order_blocks(
            bars,
            current=current,
            direction="BULLISH",
            atr_period=self.atr_period,
            volume_period=self.volume_period,
            pivot_left=self.pivot_left,
            pivot_right=self.pivot_right,
            structure_lookback=self.structure_lookback,
            maximum_age=self.maximum_age,
            break_buffer_atr=self.break_buffer,
            displacement_atr=self.displacement,
        ):
            midpoint = block.zone_low + (
                block.zone_high - block.zone_low
            ) * self.midpoint_fraction
            prior = bars[block.break_bar + 1 : current]
            if any(float(bar.close) < block.zone_low for bar in prior):
                continue
            if any(
                _zone_overlap(bar, block.zone_low, block.zone_high)
                and float(bar.close) > midpoint
                for bar in prior
            ):
                continue
            if not _zone_overlap(bars[current], block.zone_low, block.zone_high):
                continue
            if float(bars[current].close) <= midpoint:
                continue
            eligible.append(
                (
                    block,
                    not any(
                        _zone_overlap(bar, block.zone_low, block.zone_high)
                        for bar in prior
                    ),
                )
            )
        selected = select_candidate(
            eligible,
            direction_of=lambda candidate: Direction.BUY,
            key_of=lambda candidate: _order_block_rank_key(candidate[0], bars),
        )
        if selected is None:
            return self.flat()
        block, no_earlier_overlap = selected
        flags = (
            bars[block.break_bar].tick_volume
            >= self.high_volume_ratio * block.break_volume_median,
            lower_wick(bars[current]) >= self.rejection * float(current_atr),
            no_earlier_overlap,
        )
        return self.result(
            bars=bars,
            spec=spec,
            direction=Direction.BUY,
            zone_min=block.zone_low,
            zone_max=block.zone_high,
            overlay_type="ORDER_BLOCK_MITIGATION",
            geometry=_order_block_geometry(block, bars, spec),
            stop_anchor={
                "kind": "ORDER_BLOCK_LOW",
                "time": bars[block.candle].time.isoformat(),
                "price": price(float(bars[block.candle].low), spec),
            },
            indicators={
                "break_atr": block.break_atr,
                "break_body_atr": body_size(bars[block.break_bar])
                / block.break_atr,
                "break_volume_ratio": bars[block.break_bar].tick_volume
                / block.break_volume_median,
                "mitigation_rejection_wick_atr": lower_wick(bars[current])
                / float(current_atr),
            },
            quality_flags=flags,
        )


__all__ = ["BullishOrderBlock"]
