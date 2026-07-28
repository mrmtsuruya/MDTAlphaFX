"""Offline tests for the operator-facing recorded-fixture tooling."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from backend.contracts import Timeframe
from backend.core.timeutil import UTC
from scripts.record_fixtures import _month_chunks, _parse_utc, _score_windows
from tests.doubles import candle


def test_fixture_bound_z_is_parsed_as_utc():
    moment = _parse_utc(
        "2025-03-01T00:00:00Z",
        "backtest.fixtures.periods.trending.start",
    )

    assert moment == datetime(2025, 3, 1, tzinfo=UTC)
    assert moment.tzinfo is UTC


def test_fixture_bound_with_an_offset_is_normalised_to_utc():
    moment = _parse_utc(
        "2025-03-01T08:30:00+08:00",
        "backtest.fixtures.periods.trending.start",
    )

    assert moment == datetime(2025, 3, 1, 0, 30, tzinfo=UTC)
    assert moment.tzinfo is UTC


def test_fixture_bound_without_timezone_is_refused():
    with pytest.raises(SystemExit, match="has no timezone"):
        _parse_utc(
            "2025-03-01T00:00:00",
            "backtest.fixtures.periods.trending.start",
        )


def test_month_chunks_cover_the_half_open_window_once_across_year_end():
    start = datetime(2025, 12, 18, 13, 45, tzinfo=UTC)
    end = datetime(2026, 2, 3, 7, 15, tzinfo=UTC)

    chunks = list(_month_chunks(start, end))

    assert chunks == [
        (start, datetime(2026, 1, 1, tzinfo=UTC)),
        (
            datetime(2026, 1, 1, tzinfo=UTC),
            datetime(2026, 2, 1, tzinfo=UTC),
        ),
        (datetime(2026, 2, 1, tzinfo=UTC), end),
    ]
    assert all(left < right for left, right in chunks)
    assert all(chunks[i][1] == chunks[i + 1][0] for i in range(len(chunks) - 1))


def test_scored_candidate_windows_are_non_overlapping_and_drop_remainder():
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    bars = [
        candle(
            start + timedelta(hours=index),
            100.0 + index,
            101.0 + index,
            99.0 + index,
            100.5 + index,
        )
        for index in range(5)
    ]

    windows = _score_windows(
        bars,
        adx=[None, 10.0, 20.0, 30.0, 40.0],
        atr_rank=[1.0, None, 3.0, 5.0, 7.0],
        window_bars=2,
        timeframe=Timeframe.H1,
    )

    assert windows == [
        {
            "start": bars[0].time.isoformat(),
            "end": (bars[1].time + timedelta(hours=1)).isoformat(),
            "bars": 2,
            "mean_adx": 10.0,
            "mean_atr_percentile": 1.0,
        },
        {
            "start": bars[2].time.isoformat(),
            "end": (bars[3].time + timedelta(hours=1)).isoformat(),
            "bars": 2,
            "mean_adx": 25.0,
            "mean_atr_percentile": 4.0,
        },
    ]
