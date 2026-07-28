"""The Parquet historical store: round trip, spread integrity, M1 coverage, upsert.

Stage 0 requirements being asserted here (§9): the store holds M1 bars for
§11.1's sub-bar walk, carries per-bar recorded spread for §11.2, keeps the
`SymbolSpec` that was live when the bars were recorded, and never claims M1
coverage it cannot demonstrate.

No MT5, no network (§10.3) — the store is deliberately ignorant of both.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from backend.contracts import Candle, SymbolSpec, Timeframe
from backend.core.config import Config
from backend.core.errors import ConfigError, DataIntegrityError
from backend.core.timeutil import UTC
from backend.data.source import BarSource
from backend.data.store import ParquetBarStore, iter_store_timeframes

CONFIG_DIR = "config"
START = datetime(2026, 1, 5, 10, 0, tzinfo=UTC)


def spec_double(name: str = "XAUUSD.m") -> SymbolSpec:
    """A SymbolSpec as §7.1 would have produced it. Values are arbitrary; the
    point is that they round-trip unchanged."""
    return SymbolSpec(
        name=name,
        digits=2,
        point=0.01,
        tick_size=0.01,
        tick_value=1.0,
        contract_size=100.0,
        volume_min=0.01,
        volume_max=50.0,
        volume_step=0.01,
        stops_level=35,
        freeze_level=4,
    )


def candles(
    first: datetime,
    count: int,
    timeframe: Timeframe,
    *,
    spread: int = 22,
    skip: set[int] | None = None,
    base: float = 100.0,
) -> list[Candle]:
    step = timedelta(minutes={"H4": 240, "H1": 60, "M15": 15, "M5": 5, "M1": 1}[timeframe.value])
    skip = skip or set()
    out: list[Candle] = []
    for index in range(count):
        if index in skip:
            continue
        price = base + index
        out.append(
            Candle(
                time=first + step * index,
                open=price,
                high=price + 0.8,
                low=price - 0.8,
                close=price + 0.3,
                tick_volume=100 + index,
                spread=spread + (index % 3),
            )
        )
    return out


@pytest.fixture
def store(tmp_path: Path) -> ParquetBarStore:
    built = ParquetBarStore(tmp_path / "store", m1_reference_timeframe=Timeframe.M5)
    built.write_symbol_meta(
        spec_double(),
        requested_name="XAUUSD",
        swap_long=-7.25,
        swap_short=2.5,
        server_offset_minutes=180,
        account_server="FakeBroker-Demo",
    )
    return built


# --------------------------------------------------------------- protocol


def test_store_satisfies_the_barsource_protocol(store):
    """Another agent codes against `BarSource`. The store must be a drop-in."""
    assert isinstance(store, BarSource)


def test_from_config_derives_paths_and_reference_timeframe(tmp_path):
    config = Config.load(CONFIG_DIR)
    built = ParquetBarStore.from_config(config, base_dir=tmp_path)
    assert built.root == tmp_path / config.get("engine.paths.historical_store")
    # The finest analysis timeframe is the evidence series for has_m1.
    assert built.m1_reference_timeframe == Timeframe.M5


def test_store_timeframes_include_m1_which_is_not_an_analysis_timeframe(tmp_path):
    """§11.1. A recorder deriving its list from `analysis` alone silently drops
    the sub-bar series and forces every ambiguous candle onto the fallback."""
    config = Config.load(CONFIG_DIR)
    timeframes = iter_store_timeframes(config)
    assert Timeframe.M1 in timeframes
    assert Timeframe.M1 not in [
        Timeframe(name) for name in config.get("engine.timeframes.analysis")
    ]


def test_reference_timeframe_may_not_be_m1(tmp_path):
    with pytest.raises(ConfigError):
        ParquetBarStore(tmp_path, m1_reference_timeframe=Timeframe.M1)


# -------------------------------------------------------------- round trip


def test_bars_round_trip_identically(store):
    written = candles(START, 40, Timeframe.M15)
    assert store.write_bars("XAUUSD.m", Timeframe.M15, written) == 40

    read = store.bars(
        "XAUUSD.m", Timeframe.M15, START, START + timedelta(minutes=15 * 40)
    )
    assert len(read) == len(written)
    for original, restored in zip(written, read):
        assert restored.time == original.time
        assert restored.open == original.open
        assert restored.high == original.high
        assert restored.low == original.low
        assert restored.close == original.close
        assert restored.tick_volume == original.tick_volume
        assert restored.spread == original.spread


def test_per_bar_spread_is_preserved_bar_by_bar(store):
    """§11.2: "Per-bar recorded spread from the historical store, not a
    constant." Preserving the mean is not preserving the spread."""
    written = candles(START, 30, Timeframe.M5)
    store.write_bars("XAUUSD.m", Timeframe.M5, written)
    read = store.bars("XAUUSD.m", Timeframe.M5, START, START + timedelta(hours=3))
    assert [bar.spread for bar in read] == [bar.spread for bar in written]
    assert len({bar.spread for bar in read}) > 1  # genuinely varying, not constant


def test_bars_window_is_half_open_and_ascending(store):
    store.write_bars("XAUUSD.m", Timeframe.M15, candles(START, 8, Timeframe.M15))
    read = store.bars(
        "XAUUSD.m", Timeframe.M15, START, START + timedelta(minutes=30)
    )
    assert [bar.time for bar in read] == [START, START + timedelta(minutes=15)]
    assert read == sorted(read, key=lambda bar: bar.time)


def test_bars_cross_month_partition_boundaries(store):
    """Bars are partitioned by month; a window spanning the boundary must not
    lose the seam."""
    first = datetime(2026, 1, 31, 20, 0, tzinfo=UTC)
    written = candles(first, 60, Timeframe.H1)
    store.write_bars("XAUUSD.m", Timeframe.H1, written)
    read = store.bars("XAUUSD.m", Timeframe.H1, first, first + timedelta(hours=60))
    assert [bar.time for bar in read] == [bar.time for bar in written]
    assert {path.stem for path in (store.root).rglob("*.parquet")} == {
        "2026-01",
        "2026-02",
    }


def test_symbol_spec_and_swaps_survive_the_round_trip(store):
    """A replay must use the spec that was live when the bars were recorded —
    `stops_level` and `volume_step` change, and §7.3 fills depend on them."""
    spec = store.symbol_spec("XAUUSD.m")
    assert spec == spec_double()
    assert store.swap_rates("XAUUSD.m") == (-7.25, 2.5)
    record = store.symbol_record("XAUUSD.m")
    assert record.requested_name == "XAUUSD"
    assert record.server_offset_minutes == 180
    assert record.account_server == "FakeBroker-Demo"


def test_either_the_requested_or_the_broker_name_resolves(store):
    """Which of the two is canonical is not settled by the spec, so both work."""
    store.write_bars("XAUUSD.m", Timeframe.M15, candles(START, 4, Timeframe.M15))
    by_broker = store.bars(
        "XAUUSD.m", Timeframe.M15, START, START + timedelta(hours=1)
    )
    by_requested = store.bars(
        "XAUUSD", Timeframe.M15, START, START + timedelta(hours=1)
    )
    assert by_broker == by_requested
    assert store.symbol_spec("XAUUSD") == store.symbol_spec("XAUUSD.m")


def test_unknown_symbol_raises_rather_than_returning_empty(store):
    with pytest.raises(DataIntegrityError, match="holds no symbol"):
        store.bars("SILVER", Timeframe.M15, START, START + timedelta(hours=1))


def test_available_symbols_and_coverage(store):
    written = candles(START, 20, Timeframe.M15)
    store.write_bars("XAUUSD.m", Timeframe.M15, written)
    assert store.available_symbols() == ["XAUUSD.m"]
    assert store.coverage("XAUUSD.m", Timeframe.M15) == (
        written[0].time,
        written[-1].time,
    )
    assert store.coverage("XAUUSD.m", Timeframe.H4) is None
    assert store.coverage("NOPE", Timeframe.M15) is None


def test_broker_suffix_with_a_trailing_dot_does_not_collide(tmp_path):
    """`"."` is a configured suffix candidate, and Windows strips a trailing dot
    from a directory name — "XAUUSD." would silently become "XAUUSD"."""
    built = ParquetBarStore(tmp_path, m1_reference_timeframe=Timeframe.M5)
    built.write_symbol_meta(
        spec_double("XAUUSD."), requested_name="XAUUSD", swap_long=-1.0, swap_short=1.0
    )
    built.write_symbol_meta(
        spec_double("XAUUSD"), requested_name="XAUUSD2", swap_long=-2.0, swap_short=2.0
    )
    assert built.swap_rates("XAUUSD.") == (-1.0, 1.0)
    assert built.swap_rates("XAUUSD") == (-2.0, 2.0)


# -------------------------------------------------------- spread integrity


def test_writing_a_zero_spread_is_refused(store):
    """"A zero spread is a frictionless backtest wearing a disguise." It is
    refused at the point of entry so the operator finds out while recording."""
    bad = candles(START, 3, Timeframe.M15)
    bad[1] = bad[1].model_copy(update={"spread": 0})
    with pytest.raises(DataIntegrityError, match="spread"):
        store.write_bars("XAUUSD.m", Timeframe.M15, bad)


def test_a_refused_write_persists_nothing(store):
    """A partial write leaves a store that looks complete and is not."""
    bad = candles(START, 300, Timeframe.M1)
    bad[299] = bad[299].model_copy(update={"spread": 0})
    with pytest.raises(DataIntegrityError):
        store.write_bars("XAUUSD.m", Timeframe.M1, bad)
    assert store.coverage("XAUUSD.m", Timeframe.M1) is None


def test_reading_a_null_spread_raises(store):
    """A store written by something else, or an older format, must not read back
    as free trading."""
    directory = store.root / store._safe_dirname("XAUUSD.m") / "bars" / "M15"
    directory.mkdir(parents=True, exist_ok=True)
    frame = pd.DataFrame(
        {
            "time_utc": pd.to_datetime([START], utc=True),
            "open": [1.0],
            "high": [1.5],
            "low": [0.5],
            "close": [1.2],
            "tick_volume": [10],
            "spread": [None],
        }
    )
    pq.write_table(
        pa.Table.from_pandas(
            frame,
            schema=pa.schema(
                [
                    pa.field("time_utc", pa.timestamp("us", tz="UTC")),
                    pa.field("open", pa.float64()),
                    pa.field("high", pa.float64()),
                    pa.field("low", pa.float64()),
                    pa.field("close", pa.float64()),
                    pa.field("tick_volume", pa.int64()),
                    pa.field("spread", pa.int32()),
                ]
            ),
            preserve_index=False,
        ),
        directory / "2026-01.parquet",
    )
    with pytest.raises(DataIntegrityError, match="spread"):
        store.bars("XAUUSD.m", Timeframe.M15, START, START + timedelta(hours=1))


def test_inconsistent_ohlc_is_refused(store):
    bad = candles(START, 3, Timeframe.M15)
    bad[0] = bad[0].model_copy(update={"high": bad[0].low - 1.0})
    with pytest.raises(DataIntegrityError, match="high"):
        store.write_bars("XAUUSD.m", Timeframe.M15, bad)


# -------------------------------------------------------------- §11.1 M1


def _seed_hour(store: ParquetBarStore, *, skip: set[int] | None = None) -> None:
    """One hour of M5 reference bars, and M1 bars for the same hour."""
    store.write_bars("XAUUSD.m", Timeframe.M5, candles(START, 12, Timeframe.M5))
    store.write_bars(
        "XAUUSD.m", Timeframe.M1, candles(START, 60, Timeframe.M1, skip=skip)
    )


def test_has_m1_true_on_complete_coverage(store):
    _seed_hour(store)
    assert store.has_m1("XAUUSD.m", START, START + timedelta(hours=1)) is True
    assert store.m1_gaps("XAUUSD.m", START, START + timedelta(hours=1)) == []
    assert len(store.m1_bars("XAUUSD.m", START, START + timedelta(hours=1))) == 60


def test_has_m1_false_on_a_single_missing_minute(store):
    """Partial coverage is False. §11.1: "a gap in the middle of an ambiguous
    candle is exactly the case where a sub-bar walk would produce a confident
    wrong answer.\""""
    _seed_hour(store, skip={30})
    assert store.has_m1("XAUUSD.m", START, START + timedelta(hours=1)) is False
    assert store.m1_gaps("XAUUSD.m", START, START + timedelta(hours=1)) == [
        (START + timedelta(minutes=30), START + timedelta(minutes=31))
    ]


def test_has_m1_false_on_a_contiguous_run_of_missing_minutes(store):
    _seed_hour(store, skip={20, 21, 22, 45})
    assert store.has_m1("XAUUSD.m", START, START + timedelta(hours=1)) is False
    assert store.m1_gaps("XAUUSD.m", START, START + timedelta(hours=1)) == [
        (START + timedelta(minutes=20), START + timedelta(minutes=23)),
        (START + timedelta(minutes=45), START + timedelta(minutes=46)),
    ]


def test_has_m1_true_for_a_subwindow_that_is_complete(store):
    """The realistic call: "do I have M1 inside this one ambiguous candle?\""""
    _seed_hour(store, skip={55})
    ambiguous_start = START + timedelta(minutes=15)
    assert store.has_m1("XAUUSD.m", ambiguous_start, ambiguous_start + timedelta(minutes=15))
    assert not store.has_m1("XAUUSD.m", START, START + timedelta(hours=1))


def test_has_m1_false_when_m1_is_absent_entirely(store):
    store.write_bars("XAUUSD.m", Timeframe.M5, candles(START, 12, Timeframe.M5))
    assert store.has_m1("XAUUSD.m", START, START + timedelta(hours=1)) is False


def test_has_m1_false_without_reference_bars_to_prove_the_market_was_open(store):
    """Absence of evidence is not coverage.

    With no reference-timeframe bars, nothing establishes that the broker was
    quoting in this window, so "nothing was expected therefore everything is
    present" would be a vacuous truth that lets a hole pass.
    """
    store.write_bars("XAUUSD.m", Timeframe.M1, candles(START, 60, Timeframe.M1))
    assert store.has_m1("XAUUSD.m", START, START + timedelta(hours=1)) is False


def test_has_m1_ignores_a_window_the_market_was_closed_for(store):
    """The closure case, decided from recorded evidence rather than a calendar.

    Reference bars exist for the first half hour only — that is where this broker
    was quoting. M1 covers exactly that half hour. Asking about the whole hour
    therefore expects only the first thirty minutes, and they are all present.
    """
    store.write_bars("XAUUSD.m", Timeframe.M5, candles(START, 6, Timeframe.M5))
    store.write_bars("XAUUSD.m", Timeframe.M1, candles(START, 30, Timeframe.M1))
    assert store.has_m1("XAUUSD.m", START, START + timedelta(hours=1)) is True


def test_has_m1_false_for_an_unknown_symbol(store):
    assert store.has_m1("SILVER", START, START + timedelta(hours=1)) is False


# ------------------------------------------------------------------ upsert


def test_re_recording_an_overlapping_window_does_not_duplicate(store):
    first = candles(START, 40, Timeframe.M15)
    store.write_bars("XAUUSD.m", Timeframe.M15, first)
    # Overlap the back half and extend past the end.
    overlap = candles(
        START + timedelta(minutes=15 * 20), 40, Timeframe.M15, base=500.0
    )
    store.write_bars("XAUUSD.m", Timeframe.M15, overlap)

    read = store.bars(
        "XAUUSD.m", Timeframe.M15, START, START + timedelta(minutes=15 * 60)
    )
    times = [bar.time for bar in read]
    assert len(times) == len(set(times)) == 60
    assert times == sorted(times)


def test_the_incoming_record_wins_on_a_tie(store):
    """Upsert, not append: a re-record after a broker data correction must
    replace the old bar rather than sit beside it."""
    store.write_bars("XAUUSD.m", Timeframe.M15, candles(START, 4, Timeframe.M15))
    corrected = candles(START, 4, Timeframe.M15, base=900.0, spread=51)
    store.write_bars("XAUUSD.m", Timeframe.M15, corrected)
    read = store.bars("XAUUSD.m", Timeframe.M15, START, START + timedelta(hours=1))
    assert len(read) == 4
    assert [bar.open for bar in read] == [bar.open for bar in corrected]
    assert [bar.spread for bar in read] == [bar.spread for bar in corrected]


def test_writing_the_same_window_twice_is_a_no_op_in_content(store):
    written = candles(START, 90, Timeframe.M1)
    store.write_bars("XAUUSD.m", Timeframe.M1, written)
    once = store.m1_bars("XAUUSD.m", START, START + timedelta(hours=2))
    store.write_bars("XAUUSD.m", Timeframe.M1, written)
    twice = store.m1_bars("XAUUSD.m", START, START + timedelta(hours=2))
    assert once == twice


def test_duplicate_times_within_one_batch_collapse(store):
    batch = candles(START, 3, Timeframe.M15) + candles(START, 3, Timeframe.M15)
    store.write_bars("XAUUSD.m", Timeframe.M15, batch)
    read = store.bars("XAUUSD.m", Timeframe.M15, START, START + timedelta(hours=1))
    assert len(read) == 3


def test_writing_no_bars_is_a_no_op(store):
    assert store.write_bars("XAUUSD.m", Timeframe.M15, []) == 0
    assert store.coverage("XAUUSD.m", Timeframe.M15) is None


# -------------------------------------------------------------- meta hygiene


def test_bars_without_meta_are_refused(tmp_path):
    """A store whose SymbolSpec is missing cannot reproduce §7.3 constraints, so
    it must not be silently replayable."""
    built = ParquetBarStore(tmp_path, m1_reference_timeframe=Timeframe.M5)
    built.write_symbol_meta(
        spec_double(), requested_name="XAUUSD", swap_long=-1.0, swap_short=1.0
    )
    built.write_bars("XAUUSD.m", Timeframe.M15, candles(START, 4, Timeframe.M15))
    (tmp_path / built._safe_dirname("XAUUSD.m") / "meta.json").unlink()
    fresh = ParquetBarStore(tmp_path, m1_reference_timeframe=Timeframe.M5)
    with pytest.raises(DataIntegrityError):
        fresh.symbol_spec("XAUUSD.m")


def test_a_stale_store_format_is_refused(store):
    path = store.root / store._safe_dirname("XAUUSD.m") / "meta.json"
    meta = json.loads(path.read_text(encoding="utf-8"))
    meta["store_format_version"] = 0
    path.write_text(json.dumps(meta), encoding="utf-8")
    with pytest.raises(DataIntegrityError, match="store format"):
        store.symbol_spec("XAUUSD.m")


def test_meta_without_swap_rates_is_refused(store):
    path = store.root / store._safe_dirname("XAUUSD.m") / "meta.json"
    meta = json.loads(path.read_text(encoding="utf-8"))
    meta["swap_short"] = None
    path.write_text(json.dumps(meta), encoding="utf-8")
    with pytest.raises(DataIntegrityError, match="swap"):
        store.swap_rates("XAUUSD.m")
