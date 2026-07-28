"""Module 9 — Breaker Block Mitigation."""

from __future__ import annotations

from dataclasses import dataclass

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from ..core.config import Config
from .common import (
    ProfiledStrategy,
    body_size,
    lower_wick,
    median_tick_volume,
    price,
    upper_wick,
    validate_bars,
)
from .configuration import ModuleProfile
from .indicators import atr
from .candidate_ranking import candidate_sort_key, select_candidate
from .m03_bullish_order_block import (
    _OrderBlock,
    _order_block_geometry,
    _order_blocks,
    _zone_overlap,
)


@dataclass(frozen=True)
class _Breaker:
    block: _OrderBlock
    failure_bar: int
    direction: Direction
    failure_atr: float
    failure_volume_median: float


def _breaker_rank_key(breaker: _Breaker, bars: list[Candle]):
    block = breaker.block
    return candidate_sort_key(
        formation_index=breaker.failure_bar,
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
            (
                "FAILURE_CLOSE",
                bars[breaker.failure_bar].time.isoformat(),
                float(bars[breaker.failure_bar].close),
            ),
        ),
        source_indices=(
            block.candle,
            block.break_bar,
            block.broken_swing.index,
            breaker.failure_bar,
        ),
    )


class BreakerBlockMitigation(ProfiledStrategy):
    module_id = 9
    module_name = "Breaker Block Mitigation"
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
            + 2 * self.structure_lookback
            + self.maximum_age
            + self.pivot_left
            + self.pivot_right
            + 2
        )
        super().__init__(profile, min_bars=min_bars)

    @classmethod
    def from_config(cls, config: Config) -> "BreakerBlockMitigation":
        return cls(cls.profile_from_config(config))

    def evaluate(self, bars: list[Candle], spec: SymbolSpec) -> StrategyResult:
        if len(bars) < self.min_bars:
            return self.flat()
        validate_bars(bars)
        current = len(bars) - 1
        atr_values = atr(bars, self.atr_period)
        current_atr = atr_values[current]
        if current_atr is None or current_atr <= 0.0:
            return self.flat()

        breakers: list[_Breaker] = []
        order_block_horizon = self.structure_lookback + self.maximum_age
        for original_direction in ("BULLISH", "BEARISH"):
            blocks = _order_blocks(
                bars,
                current=current,
                direction=original_direction,
                atr_period=self.atr_period,
                volume_period=self.volume_period,
                pivot_left=self.pivot_left,
                pivot_right=self.pivot_right,
                structure_lookback=self.structure_lookback,
                maximum_age=order_block_horizon,
                break_buffer_atr=self.break_buffer,
                displacement_atr=self.displacement,
            )
            for block in blocks:
                failure_index = None
                for index in range(block.break_bar + 1, current):
                    close = float(bars[index].close)
                    failed = (
                        close < block.zone_low
                        if original_direction == "BULLISH"
                        else close > block.zone_high
                    )
                    if failed:
                        failure_index = index
                        break
                if failure_index is None or current - failure_index > self.maximum_age:
                    continue
                direction = (
                    Direction.SELL
                    if original_direction == "BULLISH"
                    else Direction.BUY
                )
                midpoint = block.zone_low + (
                    block.zone_high - block.zone_low
                ) * self.midpoint_fraction
                prior = bars[failure_index + 1 : current]
                if any(
                    _zone_overlap(bar, block.zone_low, block.zone_high)
                    for bar in prior
                ):
                    continue
                if not _zone_overlap(
                    bars[current], block.zone_low, block.zone_high
                ):
                    continue
                closes_flipped = (
                    float(bars[current].close) < midpoint
                    if direction is Direction.SELL
                    else float(bars[current].close) > midpoint
                )
                if not closes_flipped:
                    continue
                failure_atr = atr_values[failure_index]
                failure_median = median_tick_volume(
                    bars[: failure_index + 1], self.volume_period
                )
                if (
                    failure_atr is None
                    or failure_atr <= 0.0
                    or failure_median is None
                    or failure_median <= 0.0
                ):
                    continue
                breakers.append(
                    _Breaker(
                        block=block,
                        failure_bar=failure_index,
                        direction=direction,
                        failure_atr=float(failure_atr),
                        failure_volume_median=float(failure_median),
                    )
                )
        breaker = select_candidate(
            breakers,
            direction_of=lambda candidate: candidate.direction,
            key_of=lambda candidate: _breaker_rank_key(candidate, bars),
        )
        if breaker is None:
            return self.flat()
        block = breaker.block
        failure = bars[breaker.failure_bar]
        mitigation_wick = (
            upper_wick(bars[current])
            if breaker.direction is Direction.SELL
            else lower_wick(bars[current])
        )
        flags = (
            body_size(failure) >= self.displacement * breaker.failure_atr,
            failure.tick_volume
            >= self.high_volume_ratio * breaker.failure_volume_median,
            mitigation_wick >= self.rejection * float(current_atr),
        )
        geometry = _order_block_geometry(block, bars, spec)
        geometry.append(
            {
                "type": "MARKER",
                "kind": "ORDER_BLOCK_FAILURE",
                "time": failure.time.isoformat(),
                "price": price(float(failure.close), spec),
                "flipped_direction": breaker.direction.value,
            }
        )
        anchor_price = (
            float(bars[block.candle].high)
            if breaker.direction is Direction.SELL
            else float(bars[block.candle].low)
        )
        return self.result(
            bars=bars,
            spec=spec,
            direction=breaker.direction,
            zone_min=block.zone_low,
            zone_max=block.zone_high,
            overlay_type="BREAKER_BLOCK",
            geometry=geometry,
            stop_anchor={
                "kind": "BREAKER_FAR_EDGE",
                "time": bars[block.candle].time.isoformat(),
                "price": price(anchor_price, spec),
            },
            indicators={
                "failure_atr": breaker.failure_atr,
                "failure_body_atr": body_size(failure) / breaker.failure_atr,
                "failure_volume_ratio": failure.tick_volume
                / breaker.failure_volume_median,
                "mitigation_rejection_wick_atr": mitigation_wick
                / float(current_atr),
            },
            quality_flags=flags,
        )


__all__ = ["BreakerBlockMitigation"]
