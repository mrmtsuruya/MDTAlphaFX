"""Shared pure geometry and result helpers for the approved Stage 2 profile."""

from __future__ import annotations

import math
import statistics
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, ClassVar

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from ..core.config import Config
from .configuration import ModuleProfile, load_module_profile
from .indicators import atr


@dataclass(frozen=True)
class Pivot:
    index: int
    time: str
    price: float


def candle_body(bar: Candle) -> tuple[float, float]:
    return min(float(bar.open), float(bar.close)), max(float(bar.open), float(bar.close))


def body_size(bar: Candle) -> float:
    low, high = candle_body(bar)
    return high - low


def upper_wick(bar: Candle) -> float:
    return float(bar.high) - max(float(bar.open), float(bar.close))


def lower_wick(bar: Candle) -> float:
    return min(float(bar.open), float(bar.close)) - float(bar.low)


def bar_range(bar: Candle) -> float:
    return float(bar.high - bar.low)


def median_tick_volume(bars: Sequence[Candle], period: int) -> float | None:
    if len(bars) < period:
        return None
    return float(statistics.median(bar.tick_volume for bar in bars[-period:]))


def timeframe_seconds(bars: Sequence[Candle]) -> int:
    if len(bars) < 2:
        return 0
    seconds = int((bars[-1].time - bars[-2].time).total_seconds())
    if seconds <= 0:
        raise ValueError("bars must be in strictly increasing UTC order")
    return seconds


def validate_bars(bars: Sequence[Candle]) -> None:
    previous = None
    for index, bar in enumerate(bars):
        if bar.time.tzinfo is None or bar.time.utcoffset() != timedelta(0):
            raise ValueError(f"bars[{index}].time must be timezone-aware UTC")
        if previous is not None and bar.time <= previous:
            raise ValueError("bars must be strictly increasing")
        previous = bar.time
        if bar.high < max(bar.open, bar.close) or bar.low > min(bar.open, bar.close):
            raise ValueError(f"bars[{index}] OHLC geometry is invalid")


def confirmed_pivot_highs(
    bars: Sequence[Candle], left: int, right: int
) -> list[Pivot]:
    result: list[Pivot] = []
    for index in range(left, len(bars) - right):
        value = float(bars[index].high)
        if all(value > float(bars[other].high) for other in range(index - left, index)) and all(
            value > float(bars[other].high)
            for other in range(index + 1, index + right + 1)
        ):
            result.append(Pivot(index, bars[index].time.isoformat(), value))
    return result


def confirmed_pivot_lows(
    bars: Sequence[Candle], left: int, right: int
) -> list[Pivot]:
    result: list[Pivot] = []
    for index in range(left, len(bars) - right):
        value = float(bars[index].low)
        if all(value < float(bars[other].low) for other in range(index - left, index)) and all(
            value < float(bars[other].low)
            for other in range(index + 1, index + right + 1)
        ):
            result.append(Pivot(index, bars[index].time.isoformat(), value))
    return result


def latest_atr(bars: Sequence[Candle], period: int) -> float | None:
    values = atr(bars, period)
    value = values[-1] if values else None
    if value is None or value <= 0.0:
        return None
    return float(value)


def price(value: float, spec: SymbolSpec) -> float:
    return round(float(value), spec.digits)


class ProfiledStrategy:
    """Base class preserving the frozen §4.1 public protocol."""

    module_id: ClassVar[int]
    module_name: ClassVar[str]
    cluster_id: ClassVar[str]

    def __init__(self, profile: ModuleProfile, *, min_bars: int):
        if profile.module_id != self.module_id:
            raise ValueError(
                f"profile for module {profile.module_id} cannot configure {self.module_id}"
            )
        if min_bars < 1:
            raise ValueError("min_bars must be positive")
        self.profile = profile
        self.min_bars = min_bars

    @classmethod
    def profile_from_config(cls, config: Config) -> ModuleProfile:
        return load_module_profile(config, cls.module_id)

    @classmethod
    def from_config(cls, config: Config) -> "ProfiledStrategy":
        """Construct the usual one-profile module.

        Modules with additional approved immutable context, currently Session
        ORB, override this method without changing the frozen evaluate protocol.
        """

        return cls(cls.profile_from_config(config))

    def flat(self) -> StrategyResult:
        return StrategyResult(
            module_id=self.module_id,
            module_name=self.module_name,
            fired=False,
            direction=Direction.NONE,
            score=0.0,
            evidence={},
        )

    def result(
        self,
        *,
        bars: Sequence[Candle],
        spec: SymbolSpec,
        direction: Direction,
        zone_min: float,
        zone_max: float,
        overlay_type: str,
        geometry: list[dict[str, Any]],
        stop_anchor: dict[str, Any],
        indicators: dict[str, Any],
        quality_flags: Sequence[bool],
        opposing_structures: Sequence[dict[str, Any]] = (),
    ) -> StrategyResult:
        if direction not in (Direction.BUY, Direction.SELL):
            raise ValueError("a firing strategy result requires BUY or SELL")
        flags = tuple(bool(flag) for flag in quality_flags)
        if len(flags) != 3:
            raise ValueError("the approved confidence profile requires three flags")
        low = price(min(zone_min, zone_max), spec)
        high = price(max(zone_min, zone_max), spec)
        base = float(self.profile.number("confidence_base", non_negative=True))
        bonus = float(
            self.profile.number("confidence_confirmation_bonus", non_negative=True)
        )
        cap = float(self.profile.number("confidence_cap", positive=True))
        score = min(cap, base + bonus * sum(flags))
        last = bars[-1]
        evidence = {
            "schema_version": self.profile.integer(
                "evidence_schema_version", positive=True
            ),
            "min": low,
            "max": high,
            "event_time": last.time.isoformat(),
            "overlay_type": overlay_type,
            "geometry": geometry,
            "stop_anchor": stop_anchor,
            "opposing_structures": list(opposing_structures),
            "indicators": indicators,
            "quality_flags": list(flags),
            "timeframe_seconds": timeframe_seconds(bars),
        }
        return StrategyResult(
            module_id=self.module_id,
            module_name=self.module_name,
            fired=True,
            direction=direction,
            score=score,
            evidence=evidence,
        )


__all__ = [
    "Pivot",
    "ProfiledStrategy",
    "bar_range",
    "body_size",
    "candle_body",
    "confirmed_pivot_highs",
    "confirmed_pivot_lows",
    "latest_atr",
    "lower_wick",
    "median_tick_volume",
    "price",
    "timeframe_seconds",
    "upper_wick",
    "validate_bars",
]
