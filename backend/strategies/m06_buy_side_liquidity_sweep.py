"""Module 6 — Buy-Side Liquidity Sweep."""

from __future__ import annotations

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from ..core.config import Config
from .common import (
    ProfiledStrategy,
    bar_range,
    median_tick_volume,
    price,
    upper_wick,
    validate_bars,
)
from .configuration import ModuleProfile
from .indicators import atr
from .candidate_ranking import select_candidate
from .m05_sell_side_liquidity_sweep import (
    _LiquidityPair,
    _liquidity_pair_rank_key,
    _liquidity_pairs,
    _sweep_geometry,
)


class BuySideLiquiditySweep(ProfiledStrategy):
    module_id = 6
    module_name = "Buy-Side Liquidity Sweep"
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
    def from_config(cls, config: Config) -> "BuySideLiquiditySweep":
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
            direction="BUY_SIDE",
            left=self.pivot_left,
            right=self.pivot_right,
            structure_lookback=self.structure_lookback,
            minimum_separation=self.minimum_separation,
            maximum_separation=self.maximum_separation,
            tolerance=self.equal_tolerance * float(current_atr),
        )
        eligible: list[_LiquidityPair] = []
        for pair in pairs:
            threshold = pair.level + self.minimum_pierce * float(current_atr)
            if not (
                float(bars[current].high) > threshold
                and float(bars[current].close) < pair.level
            ):
                continue
            prior = bars[pair.second.index + self.pivot_right + 1 : current]
            if any(
                float(bar.high) > threshold and float(bar.close) < pair.level
                for bar in prior
            ):
                continue
            eligible.append(pair)
        candle = bars[current]
        zone_low = max(float(candle.open), float(candle.close))
        zone_high = float(candle.high)
        pair = select_candidate(
            eligible,
            direction_of=lambda candidate: Direction.SELL,
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
            upper_wick(candle) >= self.minimum_wick * float(current_atr),
            candle.tick_volume >= self.high_volume_ratio * median,
            range_value > 0.0
            and float(candle.close)
            <= float(candle.high) - self.close_half * range_value,
        )
        return self.result(
            bars=bars,
            spec=spec,
            direction=Direction.SELL,
            zone_min=zone_low,
            zone_max=zone_high,
            overlay_type="LIQUIDITY_SWEEP",
            geometry=_sweep_geometry(pair, bars, spec, zone_low, zone_high),
            stop_anchor={
                "kind": "SWEEP_HIGH",
                "time": candle.time.isoformat(),
                "price": price(float(candle.high), spec),
            },
            indicators={
                "atr": float(current_atr),
                "equal_level_distance_atr": abs(
                    pair.first.price - pair.second.price
                )
                / float(current_atr),
                "pierce_atr": (float(candle.high) - pair.level)
                / float(current_atr),
                "rejection_wick_atr": upper_wick(candle) / float(current_atr),
                "volume_ratio": candle.tick_volume / median,
            },
            quality_flags=flags,
        )


__all__ = ["BuySideLiquiditySweep"]
