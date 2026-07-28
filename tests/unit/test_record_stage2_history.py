"""Deterministic availability provenance for the Stage 2 history recorder."""

from __future__ import annotations

from datetime import datetime, timedelta

from backend.contracts import Timeframe
from backend.core.timeutil import UTC
from scripts.record_stage2_history import (
    _availability_gaps,
    _gap_rows_sha256,
    _series_manifest_entry,
)
from tests.doubles import candle


START = datetime(2025, 7, 28, tzinfo=UTC)


def _bar(moment: datetime):
    return candle(moment, 1.0, 1.1, 0.9, 1.05, spread=12)


def test_availability_gaps_include_leading_interior_and_trailing_intervals():
    end = START + timedelta(hours=10)
    bars = [
        _bar(START + timedelta(hours=7)),
        _bar(START + timedelta(hours=1)),
        _bar(START + timedelta(hours=5)),
        _bar(START + timedelta(hours=2)),
    ]

    assert _availability_gaps(bars, Timeframe.H1, START, end) == [
        {
            "start_utc": "2025-07-28T00:00:00+00:00",
            "end_utc": "2025-07-28T01:00:00+00:00",
            "missing_slot_count": 1,
        },
        {
            "start_utc": "2025-07-28T03:00:00+00:00",
            "end_utc": "2025-07-28T05:00:00+00:00",
            "missing_slot_count": 2,
        },
        {
            "start_utc": "2025-07-28T06:00:00+00:00",
            "end_utc": "2025-07-28T07:00:00+00:00",
            "missing_slot_count": 1,
        },
        {
            "start_utc": "2025-07-28T08:00:00+00:00",
            "end_utc": "2025-07-28T10:00:00+00:00",
            "missing_slot_count": 2,
        },
    ]


def test_no_bars_is_one_whole_range_availability_gap():
    end = START + timedelta(hours=1)

    assert _availability_gaps([], Timeframe.M15, START, end) == [
        {
            "start_utc": "2025-07-28T00:00:00+00:00",
            "end_utc": "2025-07-28T01:00:00+00:00",
            "missing_slot_count": 4,
        }
    ]


def test_contiguous_half_open_series_has_no_availability_gaps():
    end = START + timedelta(hours=1)
    bars = [_bar(START + timedelta(minutes=15 * index)) for index in range(4)]

    assert _availability_gaps(bars, Timeframe.M15, START, end) == []
    assert (
        _gap_rows_sha256([])
        == "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
    )


def test_gap_hash_is_independent_of_row_and_key_enumeration_order():
    rows = [
        {
            "missing_slot_count": 2,
            "end_utc": "2025-07-28T05:00:00+00:00",
            "start_utc": "2025-07-28T03:00:00+00:00",
        },
        {
            "end_utc": "2025-07-28T01:00:00+00:00",
            "start_utc": "2025-07-28T00:00:00+00:00",
            "missing_slot_count": 1,
        },
    ]

    assert _gap_rows_sha256(rows) == _gap_rows_sha256(list(reversed(rows)))


def test_series_manifest_labels_and_hashes_canonical_availability_gaps():
    end = START + timedelta(hours=4)
    bars = [_bar(START), _bar(START + timedelta(hours=2))]

    entry = _series_manifest_entry(
        bars_written=2,
        coverage=(bars[0].time, bars[-1].time),
        bars=bars,
        timeframe=Timeframe.H1,
        start=START,
        end=end,
    )

    assert entry["coverage_first"] == "2025-07-28T00:00:00+00:00"
    assert entry["coverage_last"] == "2025-07-28T02:00:00+00:00"
    assert entry["availability_gaps"] == [
        {
            "start_utc": "2025-07-28T01:00:00+00:00",
            "end_utc": "2025-07-28T02:00:00+00:00",
            "missing_slot_count": 1,
        },
        {
            "start_utc": "2025-07-28T03:00:00+00:00",
            "end_utc": "2025-07-28T04:00:00+00:00",
            "missing_slot_count": 1,
        },
    ]
    assert entry["gap_count"] == 2
    assert entry["gap_rows_sha256"] == _gap_rows_sha256(
        entry["availability_gaps"]
    )
