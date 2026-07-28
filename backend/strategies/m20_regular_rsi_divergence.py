"""Module 20 — Regular RSI Divergence."""

from __future__ import annotations

from dataclasses import dataclass

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from .common import (
    Pivot,
    ProfiledStrategy,
    candle_body,
    confirmed_pivot_highs,
    confirmed_pivot_lows,
    latest_atr,
    lower_wick,
    price,
    upper_wick,
    validate_bars,
)
from .configuration import ModuleProfile
from .indicators import rsi


@dataclass(frozen=True)
class _Divergence:
    direction: Direction
    prior: Pivot
    latest: Pivot
    prior_rsi: float
    latest_rsi: float
    price_extension: float
    rsi_divergence: float


class RegularRsiDivergence(ProfiledStrategy):
    module_id = 20
    module_name = "RSI Divergence (Regular)"
    cluster_id = "F"

    def __init__(self, profile: ModuleProfile):
        self.rsi_period = profile.integer("rsi_period", positive=True)
        self.atr_period = profile.integer("atr_period", positive=True)
        self.pivot_left = profile.integer("pivot_left_bars", positive=True)
        self.pivot_right = profile.integer("pivot_right_bars", positive=True)
        self.minimum_separation = profile.integer(
            "minimum_separation_bars", positive=True
        )
        self.maximum_separation = profile.integer(
            "maximum_separation_bars", positive=True
        )
        if self.minimum_separation > self.maximum_separation:
            raise ValueError("minimum separation cannot exceed maximum separation")
        self.minimum_price_extension_atr = float(
            profile.number("minimum_price_extension_atr", non_negative=True)
        )
        self.minimum_rsi_divergence = float(
            profile.number("minimum_rsi_divergence_points", non_negative=True)
        )
        self.strong_rsi_divergence = float(
            profile.number("strong_rsi_divergence_points", non_negative=True)
        )
        self.overbought = float(profile.number("overbought", non_negative=True))
        self.oversold = float(profile.number("oversold", non_negative=True))
        self.minimum_rejection_wick_atr = float(
            profile.number("minimum_rejection_wick_atr", non_negative=True)
        )
        search_history = (
            self.maximum_separation + self.pivot_left + self.pivot_right + 1
        )
        super().__init__(
            profile,
            min_bars=max(search_history, self.rsi_period + 1, self.atr_period),
        )

    def _prior(self, pivots: list[Pivot], latest: Pivot) -> Pivot | None:
        for candidate in reversed(pivots[:-1]):
            separation = latest.index - candidate.index
            if separation < self.minimum_separation:
                continue
            if separation > self.maximum_separation:
                break
            return candidate
        return None

    def _bearish(
        self,
        pivots: list[Pivot],
        rsi_values: list[float | None],
        atr_value: float,
        confirmation_index: int,
    ) -> _Divergence | None:
        if not pivots or pivots[-1].index != confirmation_index:
            return None
        latest = pivots[-1]
        prior = self._prior(pivots, latest)
        if prior is None:
            return None
        prior_rsi = rsi_values[prior.index]
        latest_rsi = rsi_values[latest.index]
        if prior_rsi is None or latest_rsi is None:
            return None
        price_extension = latest.price - prior.price
        rsi_divergence = prior_rsi - latest_rsi
        if (
            price_extension < self.minimum_price_extension_atr * atr_value
            or rsi_divergence < self.minimum_rsi_divergence
        ):
            return None
        return _Divergence(
            Direction.SELL,
            prior,
            latest,
            prior_rsi,
            latest_rsi,
            price_extension,
            rsi_divergence,
        )

    def _bullish(
        self,
        pivots: list[Pivot],
        rsi_values: list[float | None],
        atr_value: float,
        confirmation_index: int,
    ) -> _Divergence | None:
        if not pivots or pivots[-1].index != confirmation_index:
            return None
        latest = pivots[-1]
        prior = self._prior(pivots, latest)
        if prior is None:
            return None
        prior_rsi = rsi_values[prior.index]
        latest_rsi = rsi_values[latest.index]
        if prior_rsi is None or latest_rsi is None:
            return None
        price_extension = prior.price - latest.price
        rsi_divergence = latest_rsi - prior_rsi
        if (
            price_extension < self.minimum_price_extension_atr * atr_value
            or rsi_divergence < self.minimum_rsi_divergence
        ):
            return None
        return _Divergence(
            Direction.BUY,
            prior,
            latest,
            prior_rsi,
            latest_rsi,
            price_extension,
            rsi_divergence,
        )

    def evaluate(
        self, bars: list[Candle], spec: SymbolSpec
    ) -> StrategyResult:
        validate_bars(bars)
        if len(bars) < self.min_bars:
            return self.flat()

        atr_value = latest_atr(bars, self.atr_period)
        if atr_value is None:
            return self.flat()
        rsi_values = rsi([float(bar.close) for bar in bars], self.rsi_period)
        confirmation_index = len(bars) - 1 - self.pivot_right
        bearish = self._bearish(
            confirmed_pivot_highs(bars, self.pivot_left, self.pivot_right),
            rsi_values,
            atr_value,
            confirmation_index,
        )
        bullish = self._bullish(
            confirmed_pivot_lows(bars, self.pivot_left, self.pivot_right),
            rsi_values,
            atr_value,
            confirmation_index,
        )
        if (bearish is None) == (bullish is None):
            return self.flat()
        match = bearish if bearish is not None else bullish
        assert match is not None

        pivot_bar = bars[match.latest.index]
        if match.direction is Direction.SELL:
            zone_min = max(float(pivot_bar.open), float(pivot_bar.close))
            zone_max = float(pivot_bar.high)
            rejection_wick = upper_wick(pivot_bar)
            extreme_confirmation = match.prior_rsi >= self.overbought
        else:
            zone_min = float(pivot_bar.low)
            zone_max = min(float(pivot_bar.open), float(pivot_bar.close))
            rejection_wick = lower_wick(pivot_bar)
            extreme_confirmation = match.prior_rsi <= self.oversold

        return self.result(
            bars=bars,
            spec=spec,
            direction=match.direction,
            zone_min=zone_min,
            zone_max=zone_max,
            overlay_type="DIVERGENCE",
            geometry=[
                {
                    "type": "divergence_line",
                    "points": [
                        {
                            "time": match.prior.time,
                            "price": price(match.prior.price, spec),
                        },
                        {
                            "time": match.latest.time,
                            "price": price(match.latest.price, spec),
                        },
                    ],
                },
                {
                    "type": "rejection_zone",
                    "time": pivot_bar.time.isoformat(),
                    "min": price(zone_min, spec),
                    "max": price(zone_max, spec),
                },
            ],
            stop_anchor={
                "type": "PIVOT_EXTREME",
                "time": match.latest.time,
                "price": price(match.latest.price, spec),
            },
            opposing_structures=[
                {
                    "type": "PRIOR_PIVOT",
                    "time": match.prior.time,
                    "price": price(match.prior.price, spec),
                }
            ],
            indicators={
                "atr": atr_value,
                "prior_rsi": match.prior_rsi,
                "latest_rsi": match.latest_rsi,
                "price_extension_atr": match.price_extension / atr_value,
                "rsi_divergence_points": match.rsi_divergence,
                "pivot_body": list(candle_body(pivot_bar)),
            },
            quality_flags=(
                extreme_confirmation,
                match.rsi_divergence >= self.strong_rsi_divergence,
                rejection_wick >= self.minimum_rejection_wick_atr * atr_value,
            ),
        )


__all__ = ["RegularRsiDivergence"]
