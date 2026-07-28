"""Module 28 — Session Open Range Breakout."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec, Timeframe
from ..core.config import Config
from ..core.timeutil import SessionWindow, timeframe_minutes
from .common import (
    ProfiledStrategy,
    body_size,
    median_tick_volume,
    price,
    timeframe_seconds,
    validate_bars,
)
from .configuration import ModuleProfile
from .indicators import atr


class SessionOpenRangeBreakout(ProfiledStrategy):
    module_id = 28
    module_name = "Session Open Range Breakout"
    cluster_id = "H"

    def __init__(
        self, profile: ModuleProfile, sessions: tuple[SessionWindow, ...]
    ):
        if not sessions:
            raise ValueError("module 28 requires at least one approved session")
        self.sessions = sessions
        opening_minutes = profile.integer("opening_range_minutes", positive=True)
        applicable = profile.texts("applicable_timeframes")
        minimum_tf = min(timeframe_minutes(Timeframe(value)) for value in applicable)
        range_bars = opening_minutes // minimum_tf
        min_bars = max(
            profile.integer("atr_period", positive=True),
            profile.integer("volume_median_bars", positive=True),
            range_bars + 1,
        )
        super().__init__(profile, min_bars=min_bars)

    @classmethod
    def from_config(cls, config: Config) -> "SessionOpenRangeBreakout":
        profile = cls.profile_from_config(config)
        session_specs = config.section("sessions.sessions")
        selected = []
        for name in profile.texts("sessions"):
            raw = session_specs.get(name)
            if not isinstance(raw, Mapping):
                raise ValueError(f"approved session {name!r} is missing")
            selected.append(SessionWindow.from_config(name, dict(raw)))
        return cls(profile, tuple(selected))

    def _active_session(
        self, current: datetime
    ) -> tuple[SessionWindow, datetime, datetime] | None:
        minute = current.hour * 60 + current.minute
        day = current.replace(hour=0, minute=0, second=0, microsecond=0)
        for session in self.sessions:
            start = day + timedelta(minutes=session.start_minute)
            end = day + timedelta(minutes=session.end_minute)
            if session.wraps_midnight:
                if minute < session.end_minute:
                    start -= timedelta(days=1)
                else:
                    end += timedelta(days=1)
            if start <= current < end:
                return session, start, end
        return None

    def evaluate(self, bars: list[Candle], spec: SymbolSpec) -> StrategyResult:
        if len(bars) < self.min_bars:
            return self.flat()
        validate_bars(bars)
        seconds = timeframe_seconds(bars)
        applicable_minutes = {
            timeframe_minutes(Timeframe(value))
            for value in self.profile.texts("applicable_timeframes")
        }
        if seconds // 60 not in applicable_minutes:
            return self.flat()
        active = self._active_session(bars[-1].time)
        if active is None:
            return self.flat()
        session, start, end = active
        range_end = start + timedelta(
            minutes=self.profile.integer("opening_range_minutes", positive=True)
        )
        current = bars[-1]
        if current.time < range_end:
            return self.flat()
        opening_bars = [bar for bar in bars if start <= bar.time < range_end]
        expected = self.profile.integer("opening_range_minutes", positive=True) // (
            seconds // 60
        )
        if len(opening_bars) != expected:
            return self.flat()
        range_high = max(float(bar.high) for bar in opening_bars)
        range_low = min(float(bar.low) for bar in opening_bars)
        atr_values = atr(bars, self.profile.integer("atr_period", positive=True))
        current_atr = atr_values[-1]
        if current_atr is None or current_atr <= 0.0:
            return self.flat()
        buffer_ratio = float(
            self.profile.number("break_buffer_atr", non_negative=True)
        )

        # Fire once: any earlier qualifying close in this session consumes it.
        index_by_time = {bar.time: index for index, bar in enumerate(bars)}
        for previous in bars:
            if not range_end <= previous.time < current.time:
                continue
            previous_atr = atr_values[index_by_time[previous.time]]
            if previous_atr is None:
                continue
            previous_buffer = buffer_ratio * previous_atr
            if (
                previous.close > range_high + previous_buffer
                or previous.close < range_low - previous_buffer
            ):
                return self.flat()

        buffer = buffer_ratio * current_atr
        breaks_high = current.close > range_high + buffer
        breaks_low = current.close < range_low - buffer
        if breaks_high == breaks_low:
            return self.flat()
        if breaks_high:
            direction = Direction.BUY
            level = range_high
            stop_value = range_low
        else:
            direction = Direction.SELL
            level = range_low
            stop_value = range_high
        volume_median = median_tick_volume(
            bars, self.profile.integer("volume_median_bars", positive=True)
        )
        if volume_median is None:
            return self.flat()
        break_distance = abs(float(current.close) - level)
        flags = (
            break_distance
            >= float(self.profile.number("strong_break_atr", non_negative=True))
            * current_atr,
            body_size(current)
            >= float(
                self.profile.number(
                    "minimum_displacement_body_atr", non_negative=True
                )
            )
            * current_atr,
            current.tick_volume
            >= float(self.profile.number("high_volume_ratio", positive=True))
            * volume_median,
        )
        return self.result(
            bars=bars,
            spec=spec,
            direction=direction,
            zone_min=level,
            zone_max=level,
            overlay_type="SESSION_OPEN_RANGE_BREAKOUT",
            geometry=[
                {
                    "type": "opening_range",
                    "session": session.name,
                    "start": start.isoformat(),
                    "end": range_end.isoformat(),
                    "high": price(range_high, spec),
                    "low": price(range_low, spec),
                },
                {
                    "type": "range_break",
                    "time": current.time.isoformat(),
                    "level": price(level, spec),
                    "close": price(current.close, spec),
                },
            ],
            stop_anchor={"price": price(stop_value, spec), "label": "opposite range edge"},
            indicators={
                "session": session.name,
                "session_end": end.isoformat(),
                "opening_range_high": range_high,
                "opening_range_low": range_low,
                "atr": current_atr,
                "tick_volume_median": volume_median,
            },
            quality_flags=flags,
        )


__all__ = ["SessionOpenRangeBreakout"]
