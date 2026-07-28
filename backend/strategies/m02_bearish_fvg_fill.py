"""Module 2 — Bearish Fair Value Gap fill."""

from __future__ import annotations

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from ..core.config import Config
from .common import ProfiledStrategy, price, validate_bars
from .configuration import ModuleProfile
from .candidate_ranking import select_candidate
from .m01_bullish_fvg_fill import (
    _gap_candidates,
    _gap_geometry,
    _gap_rank_key,
    _overlaps,
)


class BearishFVGFill(ProfiledStrategy):
    module_id = 2
    module_name = "Bearish FVG Fill"
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
    def from_config(cls, config: Config) -> "BearishFVGFill":
        return cls(cls.profile_from_config(config))

    def evaluate(self, bars: list[Candle], spec: SymbolSpec) -> StrategyResult:
        if len(bars) < self.min_bars:
            return self.flat()
        validate_bars(bars)
        current = len(bars) - 1
        eligible = []
        for gap in _gap_candidates(
            bars,
            current=current,
            maximum_age=self.maximum_age,
            atr_period=self.atr_period,
            volume_period=self.volume_period,
            gap_min_atr=self.gap_min_atr,
            displacement_atr=self.displacement_atr,
            direction="BEARISH",
        ):
            prior = bars[gap.third + 1 : current]
            if any(_overlaps(bar, gap.low, gap.high) for bar in prior):
                continue
            if any(float(bar.close) > gap.high for bar in prior):
                continue
            if not _overlaps(bars[current], gap.low, gap.high):
                continue
            if float(bars[current].close) > gap.high:
                continue
            eligible.append(gap)
        gap = select_candidate(
            eligible,
            direction_of=lambda candidate: Direction.SELL,
            key_of=lambda candidate: _gap_rank_key(candidate, bars),
        )
        if gap is None:
            return self.flat()
        midpoint = gap.low + (gap.high - gap.low) * self.midpoint_fraction
        flags = (
            bars[gap.middle].tick_volume
            >= self.high_volume_ratio * gap.volume_median,
            gap.high - gap.low >= self.large_gap_atr * gap.atr,
            float(bars[current].close) < midpoint,
        )
        return self.result(
            bars=bars,
            spec=spec,
            direction=Direction.SELL,
            zone_min=gap.low,
            zone_max=gap.high,
            overlay_type="FVG_FILL",
            geometry=_gap_geometry(gap, bars, spec),
            stop_anchor={
                "kind": "FVG_ORIGIN_HIGH",
                "time": bars[gap.first].time.isoformat(),
                "price": price(float(bars[gap.first].high), spec),
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


__all__ = ["BearishFVGFill"]
