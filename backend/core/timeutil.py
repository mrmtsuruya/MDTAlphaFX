"""§10.1 Time.

"MT5 server time ≠ UTC ≠ local, and the server's DST schedule may not match the
local one. [...] errors fail silently — a London breakout firing at the wrong
hour looks like a bad strategy, not a bug."

Rules enforced here:

- Store and compute in UTC. Every datetime crossing a boundary in this system
  is timezone-aware and UTC. `ensure_utc` is the chokepoint.
- Resolve the server offset explicitly at startup; do not infer it per-call.
  `ServerClock` is constructed once, from a measured offset, and is immutable.
- Session windows are defined in UTC in config, never derived from a local
  timezone at runtime.

Named `timeutil` rather than `time` so it cannot shadow the stdlib module.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from ..contracts import Timeframe
from .errors import ConfigError

UTC = timezone.utc

# Bar durations. These are definitions of the timeframe names in the §2
# contract, not tunable parameters — there is no configuration under which M15
# is not fifteen minutes.
_TIMEFRAME_MINUTES: dict[Timeframe, int] = {
    Timeframe.H4: 240,
    Timeframe.H1: 60,
    Timeframe.M15: 15,
    Timeframe.M5: 5,
    Timeframe.M1: 1,
}


def timeframe_minutes(tf: Timeframe) -> int:
    return _TIMEFRAME_MINUTES[tf]


def timeframe_delta(tf: Timeframe) -> timedelta:
    return timedelta(minutes=_TIMEFRAME_MINUTES[tf])


def ensure_utc(dt: datetime) -> datetime:
    """Return `dt` as an aware UTC datetime.

    A naive datetime is rejected rather than assumed to be UTC. Assuming is how
    a server-time value silently becomes a UTC value two hours out.
    """
    if dt.tzinfo is None:
        raise ValueError(
            "naive datetime crossed a UTC boundary. §10.1: all times are UTC "
            "internally and must be explicitly localised at the point they "
            "enter the system — never assumed."
        )
    return dt.astimezone(UTC)


def utc_now() -> datetime:
    return datetime.now(UTC)


def floor_to_bar(dt: datetime, tf: Timeframe) -> datetime:
    """Floor a UTC instant to the open of its containing bar.

    Anchored on the UTC epoch day, which matches how MT5 aligns intraday bars.
    Bar alignment for H4 is broker-dependent in the general case; this
    implementation assumes midnight-UTC anchoring and is asserted against
    recorded fixtures rather than trusted (see AMBIGUITY-004).
    """
    dt = ensure_utc(dt)
    minutes = _TIMEFRAME_MINUTES[tf]
    day_start = dt.replace(hour=0, minute=0, second=0, microsecond=0)
    elapsed = int((dt - day_start).total_seconds() // 60)
    return day_start + timedelta(minutes=(elapsed // minutes) * minutes)


def bar_close_time(bar_open: datetime, tf: Timeframe) -> datetime:
    """The instant a bar closes. Evaluation happens here, not on tick (rule 6)."""
    return ensure_utc(bar_open) + timeframe_delta(tf)


@dataclass(frozen=True)
class ServerClock:
    """MT5 server time ↔ UTC, resolved once at startup.

    `offset_minutes` is server minus UTC. It is measured by the connector at
    startup by comparing the terminal's reported server time against UTC, and
    then frozen. It is never recomputed per-call, because a per-call
    recomputation makes a DST transition invisible: the offset simply changes
    underneath and every session window shifts by an hour with no error.
    """

    offset_minutes: int
    measured_at: datetime
    server_timezone_hint: str | None = None

    def to_utc(self, server_time: datetime) -> datetime:
        """Convert a naive server-time value to aware UTC."""
        if server_time.tzinfo is not None:
            raise ValueError(
                "server_time must be naive — it is broker wall-clock, not an "
                "instant with a known zone. Pass the raw MT5 value."
            )
        return server_time.replace(tzinfo=UTC) - timedelta(minutes=self.offset_minutes)

    def from_utc(self, utc_time: datetime) -> datetime:
        """Convert aware UTC to naive server wall-clock."""
        shifted = ensure_utc(utc_time) + timedelta(minutes=self.offset_minutes)
        return shifted.replace(tzinfo=None)


@dataclass(frozen=True)
class SessionWindow:
    """A trading session, defined in UTC in config (§10.1).

    `start_minute` and `end_minute` are minutes past UTC midnight. A window
    where end <= start wraps past midnight (Sydney/Tokyo overlap).
    """

    name: str
    start_minute: int
    end_minute: int

    @property
    def wraps_midnight(self) -> bool:
        return self.end_minute <= self.start_minute

    def contains(self, dt: datetime) -> bool:
        dt = ensure_utc(dt)
        minute = dt.hour * 60 + dt.minute
        if self.wraps_midnight:
            return minute >= self.start_minute or minute < self.end_minute
        return self.start_minute <= minute < self.end_minute

    @classmethod
    def from_config(cls, name: str, spec: dict) -> SessionWindow:
        """Build from a `{"start": "07:00", "end": "16:00"}` config mapping.

        Times are UTC. A config that carries a timezone name is rejected — the
        spec says session windows are defined in UTC, and accepting a local
        zone here reintroduces the DST bug §10.1 exists to prevent.
        """
        if "timezone" in spec or "tz" in spec:
            raise ConfigError(
                f"session '{name}' declares a timezone. §10.1: session windows "
                f"are defined in UTC in config. Convert at authoring time."
            )
        try:
            return cls(
                name=name,
                start_minute=_parse_hhmm(spec["start"]),
                end_minute=_parse_hhmm(spec["end"]),
            )
        except KeyError as exc:
            raise ConfigError(f"session '{name}' missing key {exc}") from exc


def _parse_hhmm(value: str) -> int:
    try:
        hours, minutes = value.split(":")
        h, m = int(hours), int(minutes)
    except (ValueError, AttributeError) as exc:
        raise ConfigError(f"expected 'HH:MM', got {value!r}") from exc
    if not (0 <= h <= 23 and 0 <= m <= 59):
        raise ConfigError(f"time out of range: {value!r}")
    return h * 60 + m


def local_wall_clock(dt: datetime, tz_name: str) -> datetime:
    """Convert UTC to a named zone. **Display boundary only.**

    Nothing upstream of a renderer may call this. Rule 3.
    """
    return ensure_utc(dt).astimezone(ZoneInfo(tz_name))


__all__ = [
    "UTC",
    "timeframe_minutes",
    "timeframe_delta",
    "ensure_utc",
    "utc_now",
    "floor_to_bar",
    "bar_close_time",
    "ServerClock",
    "SessionWindow",
    "local_wall_clock",
]
