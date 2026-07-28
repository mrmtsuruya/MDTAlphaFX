"""§10.1 Time — `ServerClock` round trip and the required DST-transition test.

§10.1: "Required test: session boundaries across a DST transition." The dates
asserted against are `sessions.dst_transition_test_dates` in
`config/sessions.yaml`, not literals here.

Why this test exists at all: "errors fail **silently** — a London breakout firing
at the wrong hour looks like a bad strategy, not a bug."
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from backend.core.config import Config
from backend.core.errors import ConfigError
from backend.core.timeutil import (
    UTC,
    ServerClock,
    SessionWindow,
    ensure_utc,
    utc_now,
)

CONFIG_DIR = "config"


@pytest.fixture(scope="module")
def config() -> Config:
    return Config.load(CONFIG_DIR)


@pytest.fixture(scope="module")
def sessions(config: Config) -> list[SessionWindow]:
    return [
        SessionWindow.from_config(name, spec)
        for name, spec in config.section("sessions.sessions").items()
    ]


@pytest.fixture(scope="module")
def transition_dates(config: Config) -> list[date]:
    raw = config.get("sessions.dst_transition_test_dates")
    return [date.fromisoformat(str(value)) for value in raw]


# --------------------------------------------------------- ServerClock


def test_server_clock_round_trip():
    clock = ServerClock(offset_minutes=180, measured_at=utc_now())
    server_wall = datetime(2026, 3, 29, 12, 0, 0)
    as_utc = clock.to_utc(server_wall)
    assert as_utc == datetime(2026, 3, 29, 9, 0, tzinfo=UTC)
    assert clock.from_utc(as_utc) == server_wall


@pytest.mark.parametrize("offset", [-300, -120, 0, 60, 120, 180, 240])
def test_server_clock_round_trip_is_lossless_for_every_plausible_offset(offset):
    clock = ServerClock(offset_minutes=offset, measured_at=utc_now())
    moment = datetime(2026, 7, 1, 13, 37, tzinfo=UTC)
    assert clock.to_utc(clock.from_utc(moment)) == moment


def test_server_clock_refuses_an_aware_server_time():
    """Server time is broker wall clock, not an instant with a known zone.
    Accepting an aware value invites a double conversion."""
    clock = ServerClock(offset_minutes=180, measured_at=utc_now())
    with pytest.raises(ValueError):
        clock.to_utc(datetime(2026, 3, 29, 12, 0, tzinfo=UTC))


def test_naive_datetimes_are_refused_at_the_boundary():
    """§10.1 / rule 3. A naive datetime is rejected, never assumed to be UTC."""
    with pytest.raises(ValueError):
        ensure_utc(datetime(2026, 3, 29, 12, 0))


# ------------------------------------------------- §10.1 required DST test


def test_config_declares_dst_transition_dates(transition_dates):
    assert transition_dates, (
        "sessions.dst_transition_test_dates is empty. §10.1 requires a session "
        "boundary test across a DST transition and this is where the instants "
        "come from."
    )


def test_session_windows_do_not_shift_across_dst_transitions(
    sessions, transition_dates
):
    """The core §10.1 assertion.

    For every configured session and every configured transition date, the set
    of UTC minutes-of-day the window contains is identical on the day before,
    the day of, and the day after. A window defined in a local zone would move
    by sixty minutes on one of those days; a UTC-pinned one cannot.
    """
    assert sessions, "config/sessions.yaml declares no sessions"

    for window in sessions:
        for transition in transition_dates:
            containment_by_day = []
            for offset_days in (-1, 0, 1):
                day = transition + timedelta(days=offset_days)
                midnight = datetime(day.year, day.month, day.day, tzinfo=UTC)
                containment_by_day.append(
                    tuple(
                        window.contains(midnight + timedelta(minutes=minute))
                        for minute in range(24 * 60)
                    )
                )
            before, during, after = containment_by_day
            assert before == during == after, (
                f"session '{window.name}' shifted across the DST transition on "
                f"{transition}. §10.1: session windows are defined in UTC and "
                f"must not move."
            )


def test_session_boundary_minutes_are_identical_across_transitions(
    sessions, transition_dates
):
    """The boundary itself, stated directly: open at `start`, shut one minute
    before it, on every one of the three days."""
    for window in sessions:
        for transition in transition_dates:
            for offset_days in (-1, 0, 1):
                day = transition + timedelta(days=offset_days)
                midnight = datetime(day.year, day.month, day.day, tzinfo=UTC)
                start = midnight + timedelta(minutes=window.start_minute)
                assert window.contains(start), (
                    f"'{window.name}' does not contain its own start minute on {day}"
                )
                assert not window.contains(start - timedelta(minutes=1)), (
                    f"'{window.name}' contains the minute before its start on {day}"
                )


def test_the_configured_dates_really_are_dst_transitions(transition_dates):
    """Guards against a vacuous test.

    If the configured dates were ordinary days, the assertions above would pass
    for a reason that has nothing to do with DST. This checks that a real
    civil-time clock change happens on each of them.
    """
    try:
        from zoneinfo import ZoneInfo

        zones = [ZoneInfo("America/New_York"), ZoneInfo("Europe/London")]
    except Exception as exc:  # pragma: no cover - depends on tzdata presence
        pytest.skip(f"IANA timezone data unavailable: {exc}")

    for transition in transition_dates:
        shifted = False
        for zone in zones:
            before = datetime(
                transition.year, transition.month, transition.day, tzinfo=UTC
            ).astimezone(zone)
            after = (
                datetime(transition.year, transition.month, transition.day, tzinfo=UTC)
                + timedelta(days=1)
            ).astimezone(zone)
            if before.utcoffset() != after.utcoffset():
                shifted = True
        assert shifted, (
            f"{transition} is not a DST transition in New York or London, so "
            f"the §10.1 test asserting windows do not shift is vacuous on it."
        )


# ------------------------------------------------------ session config rules


def test_a_session_declaring_a_timezone_is_rejected(config):
    """§10.1: "Session windows defined in UTC in config." Accepting a local zone
    here reintroduces exactly the bug the section exists to prevent."""
    with pytest.raises(ConfigError, match="UTC"):
        SessionWindow.from_config(
            "london", {"start": "07:00", "end": "16:00", "timezone": "Europe/London"}
        )


def test_windows_that_wrap_midnight_are_handled(sessions):
    """Sydney runs 21:00 -> 06:00, which is not a bug and must not be read as an
    empty window."""
    wrapping = [window for window in sessions if window.wraps_midnight]
    assert wrapping, "expected at least one session to wrap midnight (Sydney)"
    for window in wrapping:
        midnight = datetime(2026, 3, 8, tzinfo=UTC)
        assert window.contains(midnight + timedelta(minutes=window.start_minute))
        assert window.contains(midnight + timedelta(minutes=window.end_minute - 1))
        assert not window.contains(midnight + timedelta(minutes=window.end_minute))


def test_overlapping_sessions_both_contain_the_overlap(config, sessions):
    """`tag_overlaps: true` — a bar in both London and New York carries both."""
    assert config.get("sessions.tag_overlaps") is True
    by_name = {window.name: window for window in sessions}
    london, new_york = by_name["london"], by_name["new_york"]
    overlap_start = max(london.start_minute, new_york.start_minute)
    overlap_end = min(london.end_minute, new_york.end_minute)
    assert overlap_start < overlap_end, "expected a London/New York overlap"
    moment = datetime(2026, 10, 25, tzinfo=UTC) + timedelta(minutes=overlap_start)
    assert london.contains(moment) and new_york.contains(moment)
