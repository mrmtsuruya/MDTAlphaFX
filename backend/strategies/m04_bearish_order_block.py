"""Module 4 — Bearish Order Block mitigation."""

from __future__ import annotations

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from ..core.config import Config
from .common import ProfiledStrategy, body_size, price, upper_wick, validate_bars
from .configuration import ModuleProfile
from .indicators import atr
from .candidate_ranking import select_candidate
from .m03_bullish_order_block import (
    _OrderBlock,
    _order_block_geometry,
    _order_block_rank_key,
    _order_blocks,
    _zone_overlap,
)


class BearishOrderBlock(ProfiledStrategy):
    module_id = 4
    module_name = "Bearish Order Block"
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
    def from_config(cls, config: Config) -> "BearishOrderBlock":
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
            direction="BEARISH",
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
            if any(float(bar.close) > block.zone_high for bar in prior):
                continue
            if any(
                _zone_overlap(bar, block.zone_low, block.zone_high)
                and float(bar.close) < midpoint
                for bar in prior
            ):
                continue
            if not _zone_overlap(bars[current], block.zone_low, block.zone_high):
                continue
            if float(bars[current].close) >= midpoint:
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
            direction_of=lambda candidate: Direction.SELL,
            key_of=lambda candidate: _order_block_rank_key(candidate[0], bars),
        )
        if selected is None:
            return self.flat()
        block, no_earlier_overlap = selected
        flags = (
            bars[block.break_bar].tick_volume
            >= self.high_volume_ratio * block.break_volume_median,
            upper_wick(bars[current]) >= self.rejection * float(current_atr),
            no_earlier_overlap,
        )
        return self.result(
            bars=bars,
            spec=spec,
            direction=Direction.SELL,
            zone_min=block.zone_low,
            zone_max=block.zone_high,
            overlay_type="ORDER_BLOCK_MITIGATION",
            geometry=_order_block_geometry(block, bars, spec),
            stop_anchor={
                "kind": "ORDER_BLOCK_HIGH",
                "time": bars[block.candle].time.isoformat(),
                "price": price(float(bars[block.candle].high), spec),
            },
            indicators={
                "break_atr": block.break_atr,
                "break_body_atr": body_size(bars[block.break_bar])
                / block.break_atr,
                "break_volume_ratio": bars[block.break_bar].tick_volume
                / block.break_volume_median,
                "mitigation_rejection_wick_atr": upper_wick(bars[current])
                / float(current_atr),
            },
            quality_flags=flags,
        )


__all__ = ["BearishOrderBlock"]
