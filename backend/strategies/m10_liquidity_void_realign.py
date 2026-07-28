"""Module 10 — Liquidity Void Re-alignment."""

from __future__ import annotations

from dataclasses import dataclass

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from ..core.config import Config
from .common import ProfiledStrategy, price, validate_bars
from .configuration import ModuleProfile
from .candidate_ranking import candidate_sort_key, select_candidate
from .m01_bullish_fvg_fill import _Gap, _gap_candidates, _gap_geometry


@dataclass(frozen=True)
class _Realignment:
    gap: _Gap
    fraction: float
    direction: Direction


def _realignment_rank_key(event: _Realignment, bars: list[Candle]):
    gap = event.gap
    if gap.direction == "BULLISH":
        lower = ("VOID_LOWER_EDGE", gap.first, float(bars[gap.first].high))
        upper = ("VOID_UPPER_EDGE", gap.third, float(bars[gap.third].low))
    else:
        lower = ("VOID_LOWER_EDGE", gap.third, float(bars[gap.third].high))
        upper = ("VOID_UPPER_EDGE", gap.first, float(bars[gap.first].low))
    return candidate_sort_key(
        formation_index=gap.third,
        raw_zone_min=gap.low,
        raw_zone_max=gap.high,
        geometry_coordinates=(
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
        ),
        source_indices=(gap.first, gap.middle, gap.third),
    )


def _rebalance_fraction(gap: _Gap, bars: list[Candle], end: int) -> float:
    width = gap.high - gap.low
    path = bars[gap.third + 1 : end + 1]
    if not path or width <= 0.0:
        return 0.0
    if gap.direction == "BULLISH":
        deepest = min(float(bar.low) for bar in path)
        return max(0.0, min(1.0, (gap.high - deepest) / width))
    highest = max(float(bar.high) for bar in path)
    return max(0.0, min(1.0, (highest - gap.low) / width))


def _resumes(gap: _Gap, bar: Candle) -> bool:
    return (
        float(bar.close) > float(bar.open)
        if gap.direction == "BULLISH"
        else float(bar.close) < float(bar.open)
    )


class LiquidityVoidRealignment(ProfiledStrategy):
    module_id = 10
    module_name = "Liquidity Void Re-alignment"
    cluster_id = "A"

    def __init__(self, profile: ModuleProfile):
        self.atr_period = profile.integer("atr_period", positive=True)
        self.volume_period = profile.integer("volume_median_bars", positive=True)
        self.maximum_rebalance = profile.integer(
            "maximum_rebalance_bars", positive=True
        )
        self.gap_min_atr = float(profile.number("gap_min_atr", non_negative=True))
        self.large_gap_atr = float(profile.number("large_gap_atr", non_negative=True))
        self.displacement = float(
            profile.number("minimum_displacement_body_atr", non_negative=True)
        )
        self.low_volume_ratio = float(
            profile.number("low_volume_ratio", non_negative=True)
        )
        self.minimum_rebalance = float(
            profile.number("minimum_rebalance_fraction", non_negative=True)
        )
        self.strong_rebalance = float(
            profile.number("strong_rebalance_fraction", non_negative=True)
        )
        min_bars = (
            max(self.atr_period, self.volume_period)
            + self.maximum_rebalance
            + 3
        )
        super().__init__(profile, min_bars=min_bars)

    @classmethod
    def from_config(cls, config: Config) -> "LiquidityVoidRealignment":
        return cls(cls.profile_from_config(config))

    def evaluate(self, bars: list[Candle], spec: SymbolSpec) -> StrategyResult:
        if len(bars) < self.min_bars:
            return self.flat()
        validate_bars(bars)
        current = len(bars) - 1
        eligible: list[_Realignment] = []
        for gap_direction, trade_direction in (
            ("BULLISH", Direction.BUY),
            ("BEARISH", Direction.SELL),
        ):
            gaps = _gap_candidates(
                bars,
                current=current,
                maximum_age=self.maximum_rebalance,
                atr_period=self.atr_period,
                volume_period=self.volume_period,
                gap_min_atr=self.gap_min_atr,
                displacement_atr=self.displacement,
                direction=gap_direction,
            )
            for gap in gaps:
                middle_volume_ratio = (
                    bars[gap.middle].tick_volume / gap.volume_median
                )
                if middle_volume_ratio > self.low_volume_ratio:
                    continue
                fraction = _rebalance_fraction(gap, bars, current)
                if fraction < self.minimum_rebalance or not _resumes(
                    gap, bars[current]
                ):
                    continue
                already_fired = False
                for index in range(gap.third + 1, current):
                    if (
                        _rebalance_fraction(gap, bars, index)
                        >= self.minimum_rebalance
                        and _resumes(gap, bars[index])
                    ):
                        already_fired = True
                        break
                if already_fired:
                    continue
                eligible.append(
                    _Realignment(
                        gap=gap,
                        fraction=fraction,
                        direction=trade_direction,
                    )
                )
        event = select_candidate(
            eligible,
            direction_of=lambda candidate: candidate.direction,
            key_of=lambda candidate: _realignment_rank_key(candidate, bars),
        )
        if event is None:
            return self.flat()
        gap = event.gap
        midpoint = (gap.low + gap.high) / 2.0
        midpoint_cleared = (
            float(bars[current].close) > midpoint
            if event.direction is Direction.BUY
            else float(bars[current].close) < midpoint
        )
        flags = (
            gap.high - gap.low >= self.large_gap_atr * gap.atr,
            event.fraction > self.strong_rebalance,
            midpoint_cleared,
        )
        geometry = _gap_geometry(gap, bars, spec)
        geometry.append(
            {
                "type": "PATH",
                "kind": "VOID_REALIGNMENT",
                "start_time": bars[gap.third].time.isoformat(),
                "end_time": bars[current].time.isoformat(),
                "rebalance_fraction": event.fraction,
            }
        )
        anchor_price = (
            float(bars[gap.first].low)
            if event.direction is Direction.BUY
            else float(bars[gap.first].high)
        )
        return self.result(
            bars=bars,
            spec=spec,
            direction=event.direction,
            zone_min=gap.low,
            zone_max=gap.high,
            overlay_type="LIQUIDITY_VOID_REALIGNMENT",
            geometry=geometry,
            stop_anchor={
                "kind": "VOID_ORIGIN",
                "time": bars[gap.first].time.isoformat(),
                "price": price(anchor_price, spec),
            },
            indicators={
                "atr": gap.atr,
                "gap_width_atr": (gap.high - gap.low) / gap.atr,
                "middle_tick_volume_ratio": bars[gap.middle].tick_volume
                / gap.volume_median,
                "rebalance_fraction": event.fraction,
                "close_vs_midpoint": float(bars[current].close) - midpoint,
                "volume_proxy": "TICK_VOLUME",
            },
            quality_flags=flags,
        )


__all__ = ["LiquidityVoidRealignment"]
