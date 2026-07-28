"""The Stage 2 recovery store is isolated, analysis-only, and cost-invalid."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from backend.contracts import SymbolSpec, Timeframe
from backend.backtest.replay import ReplayEngine
from backend.core.errors import DataIntegrityError
from backend.core.timeutil import UTC
from backend.data.source import BarSource
from backend.data.stage2_analysis_store import (
    ANALYSIS_MANIFEST_FILENAME,
    ANALYSIS_ONLY_SUBDIRECTORY,
    ANALYSIS_STORE_FORMAT_VERSION,
    ANALYSIS_STORE_TYPE,
    CAPTURE_STATUS_COMPLETE,
    CAPTURE_STATUS_IN_PROGRESS,
    CONTENT_INVENTORY_KEY,
    CONTENT_SHA256_KEY,
    Stage2AnalysisParquetStore,
)
from backend.data.store import ParquetBarStore
from scripts.record_stage2_history import (
    _analysis_store_root,
    _series_manifest_entry,
)
from tests.doubles import candle, make_test_config


START = datetime(2025, 10, 30, 12, 0, tzinfo=UTC)


def _spec(name: str = "GBPUSD.m") -> SymbolSpec:
    return SymbolSpec(
        name=name,
        digits=5,
        point=0.00001,
        tick_size=0.00001,
        tick_value=1.0,
        contract_size=100_000.0,
        volume_min=0.01,
        volume_max=100.0,
        volume_step=0.01,
        stops_level=10,
        freeze_level=5,
    )


def _bars(*spreads: int):
    return [
        candle(
            START + timedelta(hours=index),
            1.3000 + index * 0.001,
            1.3010 + index * 0.001,
            1.2990 + index * 0.001,
            1.3005 + index * 0.001,
            spread=spread,
            tick_volume=100 + index,
        )
        for index, spread in enumerate(spreads)
    ]


def _m15_bars(*spreads: int):
    return [
        candle(
            START + timedelta(minutes=15 * index),
            1.3000 + index * 0.001,
            1.3010 + index * 0.001,
            1.2990 + index * 0.001,
            1.3005 + index * 0.001,
            spread=spread,
            tick_volume=100 + index,
        )
        for index, spread in enumerate(spreads)
    ]


def _seed_store(root: Path) -> Stage2AnalysisParquetStore:
    store = Stage2AnalysisParquetStore.create(
        root, created_at=datetime(2026, 7, 28, tzinfo=UTC)
    )
    store.write_symbol_meta(
        _spec(),
        requested_name="GBPUSD",
        swap_long=-4.25,
        swap_short=1.5,
        server_offset_minutes=180,
        account_server="FakeBroker-Demo",
        recorded_at=datetime(2026, 7, 28, 1, 2, 3, tzinfo=UTC),
    )
    return store


def _capture_metadata(
    store: Stage2AnalysisParquetStore,
    *,
    end: datetime,
) -> dict:
    series = {}
    for timeframe in (Timeframe.H1, Timeframe.M15):
        bars = store.bars("GBPUSD.m", timeframe, START, end)
        coverage = store.coverage("GBPUSD.m", timeframe)
        assert bars and coverage is not None
        series[timeframe.value] = _series_manifest_entry(
            bars_written=len(bars),
            coverage=coverage,
            bars=bars,
            timeframe=timeframe,
            start=START,
            end=end,
        )
    return {
        "generated_at_utc": datetime(2026, 7, 28, tzinfo=UTC).isoformat(),
        "config_version": "test-config",
        "analysis_only": True,
        "cost_valid": False,
        "account_login": 123,
        "account_server": "FakeBroker-Demo",
        "account_mode": "DEMO",
        "server_offset_minutes": 180,
        "requested_start": START.isoformat(),
        "requested_end_exclusive": end.isoformat(),
        "availability_gap_semantics": (
            "NO_BAR_OBSERVED; NOT CLASSIFIED AS MARKET_CLOSED_OR_MISSING"
        ),
        "timeframes": ["H1", "M15"],
        "symbols": {
            "GBPUSD": {
                "resolved_symbol": "GBPUSD.m",
                "series": series,
            }
        },
    }


def _seed_complete_store(root: Path) -> Stage2AnalysisParquetStore:
    writer = _seed_store(root)
    writer.write_bars("GBPUSD.m", Timeframe.H1, _bars(17, 0, 19))
    writer.write_bars("GBPUSD.m", Timeframe.M15, _m15_bars(7, 8, 9))
    writer.finalize_capture(
        _capture_metadata(writer, end=START + timedelta(hours=3))
    )
    return Stage2AnalysisParquetStore.open(root)


def test_create_writes_explicit_analysis_only_cost_invalid_identity(tmp_path):
    store = Stage2AnalysisParquetStore.create(
        tmp_path / "analysis", created_at=datetime(2026, 7, 28, tzinfo=UTC)
    )

    assert store.manifest() == {
        "analysis_only": True,
        "capture_complete": False,
        "capture_status": CAPTURE_STATUS_IN_PROGRESS,
        "cost_valid": False,
        "created_at_utc": "2026-07-28T00:00:00+00:00",
        "nonpositive_spread_rows": [],
        "store_format_version": ANALYSIS_STORE_FORMAT_VERSION,
        "store_type": ANALYSIS_STORE_TYPE,
    }
    assert store.manifest_path.name == ANALYSIS_MANIFEST_FILENAME


def test_zero_and_negative_spread_round_trip_and_are_all_manifested(tmp_path):
    store = _seed_store(tmp_path / "analysis")
    raw = _bars(17, 0, -3)

    assert store.write_bars("GBPUSD", Timeframe.H1, list(reversed(raw))) == 3
    store.write_bars("GBPUSD", Timeframe.M15, _m15_bars(11, 12, 13))
    store.finalize_capture(
        _capture_metadata(store, end=START + timedelta(hours=3))
    )

    reader = Stage2AnalysisParquetStore.open(store.root)
    restored = reader.bars(
        "GBPUSD.m", Timeframe.H1, START, START + timedelta(hours=3)
    )
    assert [bar.time for bar in restored] == [bar.time for bar in raw]
    assert [bar.spread for bar in restored] == [17, 0, -3]
    assert reader.manifest()["nonpositive_spread_rows"] == [
        {
            "spread": 0,
            "symbol": "GBPUSD.m",
            "time_utc": "2025-10-30T13:00:00+00:00",
            "timeframe": "H1",
        },
        {
            "spread": -3,
            "symbol": "GBPUSD.m",
            "time_utc": "2025-10-30T14:00:00+00:00",
            "timeframe": "H1",
        },
    ]


def test_reader_surface_is_deterministic_and_does_not_masquerade_as_barsource(
    tmp_path,
):
    store = _seed_store(tmp_path / "analysis")
    store.write_bars("GBPUSD.m", Timeframe.H1, _bars(12, 13, 14))
    store.write_bars("GBPUSD.m", Timeframe.M15, _m15_bars(12, 13, 14))
    store.finalize_capture(
        _capture_metadata(store, end=START + timedelta(hours=3))
    )
    store = Stage2AnalysisParquetStore.open(store.root)

    record = store.symbol_record("GBPUSD")
    assert record.requested_name == "GBPUSD"
    assert record.resolved_name == "GBPUSD.m"
    assert record.spec == _spec()
    assert store.available_symbols() == ["GBPUSD.m"]
    assert store.coverage("GBPUSD", Timeframe.H1) == (
        START,
        START + timedelta(hours=2),
    )
    assert [
        bar.time
        for bar in store.bars(
            "GBPUSD",
            Timeframe.H1,
            START + timedelta(hours=1),
            START + timedelta(hours=3),
        )
    ] == [START + timedelta(hours=1), START + timedelta(hours=2)]
    assert not isinstance(store, BarSource)
    assert not hasattr(store, "m1_bars")
    assert not hasattr(store, "has_m1")
    assert not hasattr(store, "symbol_spec")
    assert store.analysis_only is True
    assert store.cost_valid is False
    assert store.store_type == ANALYSIS_STORE_TYPE
    with pytest.raises(AttributeError):
        store.analysis_only = False


def test_month_upsert_is_atomic_and_refreshes_anomaly_provenance(tmp_path):
    store = _seed_store(tmp_path / "analysis")
    store.write_bars("GBPUSD.m", Timeframe.H1, _bars(10, 0, 12))
    corrected = _bars(10, 19, 12)[1]

    store.write_bars("GBPUSD.m", Timeframe.H1, [corrected])

    restored = store.bars(
        "GBPUSD.m", Timeframe.H1, START, START + timedelta(hours=3)
    )
    assert [bar.spread for bar in restored] == [10, 19, 12]
    assert store.manifest()["nonpositive_spread_rows"] == []
    assert not list(store.root.rglob("*.tmp"))


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("store_type", "PARQUET_BAR_STORE"),
        ("store_format_version", 999),
        ("analysis_only", False),
        ("cost_valid", True),
    ],
)
def test_wrong_root_identity_is_refused_on_open_and_on_read(
    tmp_path, key, value
):
    store = _seed_store(tmp_path / "analysis")
    path = store.manifest_path
    manifest = json.loads(path.read_text(encoding="utf-8"))
    manifest[key] = value
    path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(DataIntegrityError, match="identity mismatches"):
        Stage2AnalysisParquetStore.open(store.root)
    with pytest.raises(DataIntegrityError, match="identity mismatches"):
        store.available_symbols()


def test_missing_root_identity_and_nonempty_unidentified_root_are_refused(tmp_path):
    with pytest.raises(DataIntegrityError, match="identity"):
        Stage2AnalysisParquetStore.open(tmp_path / "missing")

    unidentified = tmp_path / "unidentified"
    unidentified.mkdir()
    (unidentified / "existing-strict-data.txt").write_text(
        "must not be reinterpreted", encoding="utf-8"
    )
    with pytest.raises(DataIntegrityError, match="non-empty"):
        Stage2AnalysisParquetStore.create(unidentified)


def test_wrong_symbol_identity_is_refused(tmp_path):
    store = _seed_store(tmp_path / "analysis")
    meta_path = store.root / "GBPUSD~2Em" / "meta.json"
    metadata = json.loads(meta_path.read_text(encoding="utf-8"))
    metadata["cost_valid"] = True
    meta_path.write_text(json.dumps(metadata), encoding="utf-8")

    with pytest.raises(DataIntegrityError, match="identity mismatches"):
        store.symbol_record("GBPUSD.m")


def test_finalize_capture_preserves_identity_and_binds_content(tmp_path):
    store = _seed_store(tmp_path / "analysis")
    store.write_bars("GBPUSD.m", Timeframe.H1, _bars(0, 12, 13))
    store.write_bars("GBPUSD.m", Timeframe.M15, _m15_bars(11, 12, 13))
    content_sha256 = store.finalize_capture(
        _capture_metadata(store, end=START + timedelta(hours=3))
    )

    manifest = Stage2AnalysisParquetStore.open(store.root).manifest()
    assert manifest["capture_status"] == CAPTURE_STATUS_COMPLETE
    assert manifest["capture_complete"] is True
    assert manifest["analysis_only"] is True
    assert manifest["cost_valid"] is False
    assert manifest["nonpositive_spread_rows"][0]["spread"] == 0
    assert manifest["capture"]["symbols"]["GBPUSD"]["resolved_symbol"] == "GBPUSD.m"
    assert manifest[CONTENT_SHA256_KEY] == content_sha256
    assert manifest["inventory_sha256"] == content_sha256
    assert len(manifest[CONTENT_INVENTORY_KEY]) == 3


def test_open_refuses_incomplete_capture_but_writer_can_repair_it(tmp_path):
    writer = _seed_store(tmp_path / "analysis")
    writer.begin_capture(
        {
            "analysis_only": True,
            "cost_valid": False,
            "account_mode": "DEMO",
            "symbols": {},
            "timeframes": ["H1", "M15"],
        }
    )

    with pytest.raises(DataIntegrityError, match="incomplete"):
        Stage2AnalysisParquetStore.open(writer.root)

    writer.write_bars("GBPUSD.m", Timeframe.H1, _bars(11, 12, 13))
    writer.write_bars("GBPUSD.m", Timeframe.M15, _m15_bars(11, 12, 13))
    writer.finalize_capture(
        _capture_metadata(writer, end=START + timedelta(hours=3))
    )
    assert Stage2AnalysisParquetStore.open(writer.root).capture_complete is True


def test_open_detects_same_schema_parquet_value_tamper(tmp_path):
    reader = _seed_complete_store(tmp_path / "analysis")
    path = next(reader.root.rglob("bars/H1/*.parquet"))
    table = pq.read_table(path)
    close_index = table.schema.get_field_index("close")
    changed = table.column("close").to_pylist()
    changed[0] += 0.00001
    table = table.set_column(
        close_index,
        table.schema.field(close_index),
        pa.array(changed, type=pa.float64()),
    )
    pq.write_table(table, path)

    with pytest.raises(DataIntegrityError, match="inventory mismatch"):
        Stage2AnalysisParquetStore.open(reader.root)


def test_open_detects_symbol_meta_tamper(tmp_path):
    reader = _seed_complete_store(tmp_path / "analysis")
    path = reader.root / "GBPUSD~2Em" / "meta.json"
    metadata = json.loads(path.read_text(encoding="utf-8"))
    metadata["swap_long"] = -999.0
    path.write_text(json.dumps(metadata), encoding="utf-8")

    with pytest.raises(DataIntegrityError, match="inventory mismatch"):
        Stage2AnalysisParquetStore.open(reader.root)


def test_open_detects_finalized_file_deletion(tmp_path):
    reader = _seed_complete_store(tmp_path / "analysis")
    next(reader.root.rglob("bars/H1/*.parquet")).unlink()

    with pytest.raises(DataIntegrityError, match="inventory mismatch"):
        Stage2AnalysisParquetStore.open(reader.root)


def test_open_detects_finalized_file_addition(tmp_path):
    reader = _seed_complete_store(tmp_path / "analysis")
    (reader.root / "unexpected.txt").write_text("tamper", encoding="utf-8")

    with pytest.raises(DataIntegrityError, match="unexpected file"):
        Stage2AnalysisParquetStore.open(reader.root)


def test_replay_explicitly_refuses_declared_analysis_store_before_use(tmp_path):
    store = Stage2AnalysisParquetStore.create(tmp_path / "analysis")

    with pytest.raises(
        DataIntegrityError,
        match="declared analysis-only/cost-invalid",
    ):
        ReplayEngine(make_test_config(tmp_path), store)


def test_strict_cost_valid_store_still_rejects_zero_spread(tmp_path):
    strict = ParquetBarStore(
        tmp_path / "strict", m1_reference_timeframe=Timeframe.M5
    )
    strict.write_symbol_meta(
        _spec(),
        requested_name="GBPUSD",
        swap_long=-4.25,
        swap_short=1.5,
    )

    with pytest.raises(DataIntegrityError, match="spread"):
        strict.write_bars("GBPUSD.m", Timeframe.H1, _bars(0))
    assert strict.coverage("GBPUSD.m", Timeframe.H1) is None


def test_recorder_uses_a_distinct_subdirectory_and_leaves_strict_root_alone(
    tmp_path,
):
    approved = tmp_path / "approved-stage2-history"
    approved.mkdir()
    sentinel = approved / "strict-partial-audit.txt"
    sentinel.write_text("unchanged", encoding="utf-8")

    isolated = _analysis_store_root(approved)

    assert isolated == approved / ANALYSIS_ONLY_SUBDIRECTORY
    assert isolated != approved
    assert sentinel.read_text(encoding="utf-8") == "unchanged"
