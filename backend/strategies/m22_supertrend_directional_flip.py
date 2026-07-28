"""Module 22 — Supertrend Directional Flip."""

from __future__ import annotations

from dataclasses import dataclass

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from .common import (
    ProfiledStrategy,
    body_size,
    median_tick_volume,
    price,
    validate_bars,
)
from .configuration import ModuleProfile
from .indicators import atr


@dataclass(frozen=True)
class _SupertrendPoint:
    direction: Direction
    line: float
    trigger_band: float
    atr: float


class SupertrendDirectionalFlip(ProfiledStrategy):
    module_id = 22
    module_name = "Supertrend Directional Flip"
    cluster_id = "E"

    def __init__(self, profile: ModuleProfile):
        self.atr_period = profile.integer("atr_period", positive=True)
        self.multiplier = float(profile.number("multiplier", positive=True))
        self.minimum_body_atr = float(
            profile.number("minimum_displacement_body_atr", non_negative=True)
        )
        self.minimum_close_beyond_band_atr = float(
            profile.number("minimum_close_beyond_band_atr", non_negative=True)
        )
        self.volume_period = profile.integer("volume_median_bars", positive=True)
        self.high_volume_ratio = float(
            profile.number("high_volume_ratio", non_negative=True)
        )
        super().__init__(
            profile,
            min_bars=max(self.atr_period + 1, self.volume_period + 1),
        )

    def _series(self, bars: list[Candle]) -> list[_SupertrendPoint | None]:
        atr_values = atr(bars, self.atr_period)
        result: list[_SupertrendPoint | None] = [None] * len(bars)
        final_upper: float | None = None
        final_lower: float | None = None
        prior_direction: Direction | None = None

        for index, (bar, atr_value) in enumerate(zip(bars, atr_values)):
            if atr_value is None:
                continue
            midpoint = (float(bar.high) + float(bar.low)) / 2.0
            basic_upper = midpoint + self.multiplier * atr_value
            basic_lower = midpoint - self.multiplier * atr_value
            if final_upper is None or final_lower is None or index == 0:
                final_upper = basic_upper
                final_lower = basic_lower
                prior_direction = Direction.SELL
                result[index] = _SupertrendPoint(
                    prior_direction, final_upper, final_upper, atr_value
                )
                continue

            previous_close = float(bars[index - 1].close)
            previous_upper = final_upper
            previous_lower = final_lower
            final_upper = (
                basic_upper
                if basic_upper < previous_upper or previous_close > previous_upper
                else previous_upper
            )
            final_lower = (
                basic_lower
                if basic_lower > previous_lower or previous_close < previous_lower
                else previous_lower
            )
            assert prior_direction is not None
            if (
                prior_direction is Direction.SELL
                and float(bar.close) > final_upper
            ):
                direction = Direction.BUY
            elif (
                prior_direction is Direction.BUY
                and float(bar.close) < final_lower
            ):
                direction = Direction.SELL
            else:
                direction = prior_direction
            trigger_band = (
                final_upper if direction is Direction.BUY else final_lower
            )
            line = final_lower if direction is Direction.BUY else final_upper
            result[index] = _SupertrendPoint(
                direction, line, trigger_band, atr_value
            )
            prior_direction = direction
        return result

    def evaluate(
        self, bars: list[Candle], spec: SymbolSpec
    ) -> StrategyResult:
        validate_bars(bars)
        if len(bars) < self.min_bars:
            return self.flat()

        points = self._series(bars)
        previous = points[-2]
        current = points[-1]
        if (
            previous is None
            or current is None
            or previous.direction is current.direction
        ):
            return self.flat()

        if current.direction is Direction.BUY:
            close_beyond = float(bars[-1].close) - current.trigger_band
        else:
            close_beyond = current.trigger_band - float(bars[-1].close)
        volume_median = median_tick_volume(bars[:-1], self.volume_period)
        high_volume = (
            volume_median is not None
            and volume_median > 0.0
            and float(bars[-1].tick_volume)
            >= self.high_volume_ratio * volume_median
        )
        event_time = bars[-1].time.isoformat()
        return self.result(
            bars=bars,
            spec=spec,
            direction=current.direction,
            zone_min=current.line,
            zone_max=current.line,
            overlay_type="HAIRLINE",
            geometry=[
                {
                    "type": "hairline",
                    "time": event_time,
                    "price": price(current.line, spec),
                }
            ],
            stop_anchor={
                "type": "SUPERTREND_BAND",
                "time": event_time,
                "price": price(current.line, spec),
            },
            opposing_structures=[
                {
                    "type": "TRIGGER_BAND",
                    "time": event_time,
                    "price": price(current.trigger_band, spec),
                }
            ],
            indicators={
                "supertrend": current.line,
                "trigger_band": current.trigger_band,
                "atr": current.atr,
                "close_beyond_band_atr": close_beyond / current.atr,
                "body_atr": body_size(bars[-1]) / current.atr,
                "tick_volume": int(bars[-1].tick_volume),
                "tick_volume_median": volume_median,
                "volume_proxy": "TICK_VOLUME",
            },
            quality_flags=(
                body_size(bars[-1]) >= self.minimum_body_atr * current.atr,
                close_beyond
                >= self.minimum_close_beyond_band_atr * current.atr,
                high_volume,
            ),
        )


__all__ = ["SupertrendDirectionalFlip"]
