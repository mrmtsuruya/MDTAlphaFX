"""Isolated, cost-invalid Parquet history for Stage 2 detector co-firing.

This store deliberately is not a ``BarSource`` and does not expose M1, replay,
or cost interfaces.  Its only consumer is the analysis-only Stage 2 co-firing
pipeline, which evaluates pure detectors and never prices a fill.
"""

from __future__ import annotations

import json
import hashlib
import math
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from ..contracts import Candle, SymbolSpec, Timeframe
from ..core.errors import DataIntegrityError
from ..core.timeutil import UTC, ensure_utc, timeframe_delta, utc_now


ANALYSIS_ONLY_SUBDIRECTORY = "analysis-only-cofire"
ANALYSIS_STORE_TYPE = "MDTALPHAFX_STAGE2_ANALYSIS_ONLY_PARQUET"
ANALYSIS_STORE_FORMAT_VERSION = 1
ANALYSIS_MANIFEST_FILENAME = "manifest.json"
CAPTURE_STATUS_IN_PROGRESS = "IN_PROGRESS"
CAPTURE_STATUS_COMPLETE = "COMPLETE"
CONTENT_INVENTORY_KEY = "content_inventory"
CONTENT_SHA256_KEY = "content_sha256"
INVENTORY_SHA256_KEY = "inventory_sha256"

_META_FILENAME = "meta.json"
_BARS_DIRNAME = "bars"
_SAFE_DIR_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
)
_BAR_SCHEMA = pa.schema(
    [
        pa.field("time_utc", pa.timestamp("us", tz="UTC"), nullable=False),
        pa.field("open", pa.float64(), nullable=False),
        pa.field("high", pa.float64(), nullable=False),
        pa.field("low", pa.float64(), nullable=False),
        pa.field("close", pa.float64(), nullable=False),
        pa.field("tick_volume", pa.int64(), nullable=False),
        pa.field("spread", pa.int32(), nullable=False),
    ]
)
_BAR_COLUMNS = [field.name for field in _BAR_SCHEMA]
_BAR_SCHEMA_ID = "MDTALPHAFX_STAGE2_ANALYSIS_BAR_SCHEMA_V1"


@dataclass(frozen=True)
class AnalysisSymbolRecord:
    requested_name: str
    resolved_name: str
    spec: SymbolSpec
    swap_long: float
    swap_short: float
    recorded_at: datetime
    server_offset_minutes: int | None
    account_server: str | None
    store_format_version: int


class Stage2AnalysisParquetStore:
    """Read/write store for raw Stage 2 detector inputs only."""

    def __init__(
        self,
        root: str | Path,
        *,
        _writer: bool = False,
        _allow_legacy_writer: bool = False,
    ):
        self._root = Path(root)
        self._writer = _writer
        self._alias_cache: dict[str, str] | None = None
        payload = self._read_identity_manifest(
            require_state=not _allow_legacy_writer
        )
        if not _writer:
            self._verify_complete_manifest(payload)

    @classmethod
    def create(
        cls,
        root: str | Path,
        *,
        created_at: datetime | None = None,
    ) -> "Stage2AnalysisParquetStore":
        destination = Path(root)
        manifest_path = destination / ANALYSIS_MANIFEST_FILENAME
        if manifest_path.is_file():
            return cls(
                destination,
                _writer=True,
                _allow_legacy_writer=True,
            )
        if destination.exists() and any(destination.iterdir()):
            raise DataIntegrityError(
                f"{destination} is non-empty but has no "
                f"{ANALYSIS_MANIFEST_FILENAME}; refusing to reinterpret it as "
                "the Stage 2 analysis-only store"
            )
        destination.mkdir(parents=True, exist_ok=True)
        moment = ensure_utc(created_at) if created_at is not None else utc_now()
        payload = {
            "store_type": ANALYSIS_STORE_TYPE,
            "store_format_version": ANALYSIS_STORE_FORMAT_VERSION,
            "analysis_only": True,
            "cost_valid": False,
            "created_at_utc": moment.isoformat(),
            "capture_status": CAPTURE_STATUS_IN_PROGRESS,
            "capture_complete": False,
            "nonpositive_spread_rows": [],
        }
        _atomic_write_text(
            manifest_path,
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
        )
        return cls(destination, _writer=True)

    @classmethod
    def open(cls, root: str | Path) -> "Stage2AnalysisParquetStore":
        return cls(root)

    @property
    def store_type(self) -> str:
        """Immutable declared identity used by consumers before any data access."""

        return ANALYSIS_STORE_TYPE

    @property
    def analysis_only(self) -> bool:
        """This source can never become replay- or cost-valid."""

        return True

    @property
    def cost_valid(self) -> bool:
        """Raw zero spread makes this store intentionally cost-invalid."""

        return False

    @property
    def capture_complete(self) -> bool:
        payload = self._read_identity_manifest()
        return payload["capture_complete"] is True

    @property
    def content_sha256(self) -> str:
        payload = self._read_identity_manifest()
        _assert_capture_state(payload, self.manifest_path, require_complete=True)
        value = payload.get(CONTENT_SHA256_KEY)
        if not _is_sha256(value):
            raise DataIntegrityError(
                f"{self.manifest_path} has no valid finalized content SHA-256"
            )
        return str(value)

    @property
    def root(self) -> Path:
        return self._root

    @property
    def manifest_path(self) -> Path:
        return self._root / ANALYSIS_MANIFEST_FILENAME

    def manifest(self) -> dict[str, Any]:
        return self._read_identity_manifest()

    def begin_capture(self, metadata: Mapping[str, Any]) -> None:
        """Atomically make the destination unconsumable before any mutation."""

        self._require_writer()
        manifest = self._read_identity_manifest(require_state=False)
        capture = json.loads(json.dumps(dict(metadata), sort_keys=True))
        manifest["capture_status"] = CAPTURE_STATUS_IN_PROGRESS
        manifest["capture_complete"] = False
        manifest["capture"] = capture
        manifest["nonpositive_spread_rows"] = []
        manifest.pop(CONTENT_INVENTORY_KEY, None)
        manifest.pop(CONTENT_SHA256_KEY, None)
        manifest.pop(INVENTORY_SHA256_KEY, None)
        self._write_manifest(manifest)

    def finalize_capture(self, metadata: Mapping[str, Any]) -> str:
        """Verify persisted content and atomically publish one complete identity."""

        manifest = self._require_writer_in_progress()
        capture = json.loads(json.dumps(dict(metadata), sort_keys=True))
        inventory = self._build_content_inventory()
        anomalies = self._scan_nonpositive_rows(inventory)
        self._validate_capture_metadata(capture, inventory)
        inventory_sha256 = _canonical_sha256(inventory)
        manifest["capture"] = capture
        manifest["nonpositive_spread_rows"] = anomalies
        manifest[CONTENT_INVENTORY_KEY] = inventory
        manifest[INVENTORY_SHA256_KEY] = inventory_sha256
        manifest[CONTENT_SHA256_KEY] = inventory_sha256
        manifest["capture_status"] = CAPTURE_STATUS_COMPLETE
        manifest["capture_complete"] = True
        self._write_manifest(manifest)
        self._verify_complete_manifest(self._read_identity_manifest())
        return inventory_sha256

    @staticmethod
    def _safe_dirname(symbol: str) -> str:
        escaped = "".join(
            char if char in _SAFE_DIR_CHARS else f"~{ord(char):02X}"
            for char in symbol
        )
        if not escaped:
            raise DataIntegrityError("symbol name is empty")
        return escaped

    def _symbol_dir(self, symbol: str, *, create: bool = False) -> Path:
        self._read_identity_manifest()
        direct = self._root / self._safe_dirname(symbol)
        if create:
            direct.mkdir(parents=True, exist_ok=True)
            return direct
        if direct.is_dir():
            return direct
        alias = self._aliases().get(symbol)
        if alias is None:
            raise DataIntegrityError(
                f"analysis-only store holds no symbol {symbol!r}; known symbols: "
                f"{self.available_symbols()}"
            )
        return self._root / alias

    def _aliases(self) -> dict[str, str]:
        if self._alias_cache is not None:
            return self._alias_cache
        aliases: dict[str, str] = {}
        for directory in self._symbol_directories():
            payload = self._read_symbol_meta_path(directory / _META_FILENAME)
            for key in ("requested_name", "resolved_name"):
                name = payload[key]
                if name in aliases and aliases[name] != directory.name:
                    raise DataIntegrityError(
                        f"duplicate analysis-store symbol alias {name!r}"
                    )
                aliases[name] = directory.name
        self._alias_cache = aliases
        return aliases

    def _bars_dir(
        self, symbol: str, timeframe: Timeframe, *, create: bool = False
    ) -> Path:
        directory = (
            self._symbol_dir(symbol, create=create)
            / _BARS_DIRNAME
            / timeframe.value
        )
        if create:
            directory.mkdir(parents=True, exist_ok=True)
        return directory

    def write_symbol_meta(
        self,
        spec: SymbolSpec,
        *,
        requested_name: str,
        swap_long: float,
        swap_short: float,
        server_offset_minutes: int | None = None,
        account_server: str | None = None,
        recorded_at: datetime | None = None,
    ) -> AnalysisSymbolRecord:
        self._require_writer_in_progress()
        moment = ensure_utc(recorded_at) if recorded_at is not None else utc_now()
        record = AnalysisSymbolRecord(
            requested_name=requested_name,
            resolved_name=spec.name,
            spec=spec,
            swap_long=float(swap_long),
            swap_short=float(swap_short),
            recorded_at=moment,
            server_offset_minutes=server_offset_minutes,
            account_server=account_server,
            store_format_version=ANALYSIS_STORE_FORMAT_VERSION,
        )
        payload = {
            "store_type": ANALYSIS_STORE_TYPE,
            "store_format_version": ANALYSIS_STORE_FORMAT_VERSION,
            "analysis_only": True,
            "cost_valid": False,
            "requested_name": record.requested_name,
            "resolved_name": record.resolved_name,
            "spec": record.spec.model_dump(),
            "swap_long": record.swap_long,
            "swap_short": record.swap_short,
            "recorded_at_utc": record.recorded_at.isoformat(),
            "server_offset_minutes": record.server_offset_minutes,
            "account_server": record.account_server,
        }
        directory = self._symbol_dir(spec.name, create=True)
        _atomic_write_text(
            directory / _META_FILENAME,
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
        )
        self._alias_cache = None
        return record

    def symbol_record(self, symbol: str) -> AnalysisSymbolRecord:
        directory = self._symbol_dir(symbol)
        payload = self._read_symbol_meta_path(directory / _META_FILENAME)
        return AnalysisSymbolRecord(
            requested_name=payload["requested_name"],
            resolved_name=payload["resolved_name"],
            spec=SymbolSpec(**payload["spec"]),
            swap_long=float(payload["swap_long"]),
            swap_short=float(payload["swap_short"]),
            recorded_at=ensure_utc(datetime.fromisoformat(payload["recorded_at_utc"])),
            server_offset_minutes=payload.get("server_offset_minutes"),
            account_server=payload.get("account_server"),
            store_format_version=int(payload["store_format_version"]),
        )

    def available_symbols(self) -> list[str]:
        self._read_identity_manifest()
        names = [
            self._read_symbol_meta_path(directory / _META_FILENAME)["resolved_name"]
            for directory in self._symbol_directories()
        ]
        return sorted(names)

    def write_bars(
        self,
        symbol: str,
        timeframe: Timeframe,
        bars: Sequence[Candle],
    ) -> int:
        self._require_writer_in_progress()
        record = self.symbol_record(symbol)
        if not bars:
            return 0
        frame = self._validate_and_frame(symbol, timeframe, bars)
        directory = self._bars_dir(
            record.resolved_name, timeframe, create=True
        )
        written = 0
        for month, part in frame.groupby(
            frame["time_utc"].dt.strftime("%Y-%m"), sort=True
        ):
            path = directory / f"{month}.parquet"
            combined = part
            if path.is_file():
                existing = _read_parquet(path)
                combined = pd.concat([existing, part], ignore_index=True)
            combined = (
                combined.drop_duplicates(subset="time_utc", keep="last")
                .sort_values("time_utc")
                .reset_index(drop=True)
            )
            _atomic_write_parquet(path, combined)
            written += len(part)
        return written

    def bars(
        self,
        symbol: str,
        timeframe: Timeframe,
        start: datetime,
        end: datetime,
    ) -> list[Candle]:
        self.symbol_record(symbol)
        start_utc = ensure_utc(start)
        end_utc = ensure_utc(end)
        if end_utc <= start_utc:
            return []
        directory = self._bars_dir(symbol, timeframe)
        if not directory.is_dir():
            return []
        parts = [
            _read_parquet(directory / f"{month}.parquet")
            for month in _partition_keys(start_utc, end_utc)
            if (directory / f"{month}.parquet").is_file()
        ]
        if not parts:
            return []
        frame = pd.concat(parts, ignore_index=True)
        frame = frame[
            (frame["time_utc"] >= start_utc) & (frame["time_utc"] < end_utc)
        ].sort_values("time_utc")
        return _frame_to_candles(frame.reset_index(drop=True))

    def coverage(
        self, symbol: str, timeframe: Timeframe
    ) -> tuple[datetime, datetime] | None:
        self.symbol_record(symbol)
        directory = self._bars_dir(symbol, timeframe)
        if not directory.is_dir():
            return None
        files = sorted(directory.glob("*.parquet"))
        if not files:
            return None
        first: datetime | None = None
        last: datetime | None = None
        for path in files:
            frame = _read_parquet(path)
            if frame.empty:
                continue
            candidate_first = frame["time_utc"].min().to_pydatetime().astimezone(UTC)
            candidate_last = frame["time_utc"].max().to_pydatetime().astimezone(UTC)
            first = candidate_first if first is None else min(first, candidate_first)
            last = candidate_last if last is None else max(last, candidate_last)
        return None if first is None or last is None else (first, last)

    def _require_writer(self) -> None:
        if not self._writer:
            raise DataIntegrityError(
                "a verified Stage 2 analysis reader is immutable; use create() "
                "and begin_capture() for an authorized recorder run"
            )

    def _require_writer_in_progress(self) -> dict[str, Any]:
        self._require_writer()
        payload = self._read_identity_manifest()
        _assert_capture_state(
            payload,
            self.manifest_path,
            require_complete=False,
        )
        return payload

    def _build_content_inventory(self) -> list[dict[str, Any]]:
        """Canonical inventory of every non-manifest content file."""

        entries: list[dict[str, Any]] = []
        meta_directories: set[str] = set()
        parquet_directories: set[str] = set()
        for path in sorted(self._root.rglob("*")):
            if path.is_symlink():
                raise DataIntegrityError(
                    f"analysis-only content may not contain symlinks: {path}"
                )
            if not path.is_file() or path == self.manifest_path:
                continue
            relative = path.relative_to(self._root)
            relative_posix = relative.as_posix()
            parts = relative.parts
            payload = path.read_bytes()
            base: dict[str, Any] = {
                "path": relative_posix,
                "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
            if len(parts) == 2 and parts[1] == _META_FILENAME:
                metadata = _read_symbol_meta_file(path)
                expected_directory = self._safe_dirname(
                    str(metadata["resolved_name"])
                )
                if parts[0] != expected_directory:
                    raise DataIntegrityError(
                        f"{path} directory does not match its resolved symbol "
                        f"{metadata['resolved_name']!r}"
                    )
                base["kind"] = "symbol_meta"
                meta_directories.add(parts[0])
            elif (
                len(parts) == 4
                and parts[1] == _BARS_DIRNAME
                and parts[2] in {Timeframe.H1.value, Timeframe.M15.value}
                and path.suffix == ".parquet"
            ):
                if not _is_month_partition(path.stem):
                    raise DataIntegrityError(
                        f"{path} is not a canonical YYYY-MM Parquet partition"
                    )
                try:
                    parquet = pq.ParquetFile(path)
                except Exception as exc:
                    raise DataIntegrityError(
                        f"unreadable analysis parquet {path}: {exc}"
                    ) from exc
                if parquet.schema_arrow != _BAR_SCHEMA:
                    raise DataIntegrityError(
                        f"{path} does not carry the Stage 2 analysis-only bar schema"
                    )
                base.update(
                    {
                        "kind": "parquet",
                        "row_count": int(parquet.metadata.num_rows),
                        "schema_id": _BAR_SCHEMA_ID,
                    }
                )
                parquet_directories.add(parts[0])
            else:
                raise DataIntegrityError(
                    f"unexpected file in finalized analysis-only content: {path}"
                )
            entries.append(base)
        if parquet_directories - meta_directories:
            raise DataIntegrityError(
                "analysis Parquet directories have no matching symbol metadata: "
                f"{sorted(parquet_directories - meta_directories)}"
            )
        if meta_directories - parquet_directories:
            raise DataIntegrityError(
                "analysis symbol metadata has no Parquet content: "
                f"{sorted(meta_directories - parquet_directories)}"
            )
        return sorted(entries, key=lambda entry: entry["path"])

    def _scan_nonpositive_rows(
        self,
        inventory: Sequence[Mapping[str, Any]],
    ) -> list[dict[str, Any]]:
        resolved_by_directory: dict[str, str] = {}
        for entry in inventory:
            if entry["kind"] != "symbol_meta":
                continue
            path = self._root / Path(str(entry["path"]))
            metadata = _read_symbol_meta_file(path)
            resolved_by_directory[path.parent.name] = str(
                metadata["resolved_name"]
            )
        anomalies: list[dict[str, Any]] = []
        for entry in inventory:
            if entry["kind"] != "parquet":
                continue
            path = self._root / Path(str(entry["path"]))
            relative = path.relative_to(self._root)
            symbol = resolved_by_directory[relative.parts[0]]
            timeframe = relative.parts[2]
            frame = _read_parquet(path)
            for row in frame.loc[frame["spread"] <= 0].itertuples(index=False):
                anomalies.append(
                    {
                        "symbol": symbol,
                        "timeframe": timeframe,
                        "time_utc": (
                            row.time_utc.to_pydatetime()
                            .astimezone(UTC)
                            .isoformat()
                        ),
                        "spread": int(row.spread),
                    }
                )
        return sorted(
            anomalies,
            key=lambda row: (
                row["symbol"],
                row["timeframe"],
                row["time_utc"],
                row["spread"],
            ),
        )

    def _verify_complete_manifest(self, payload: Mapping[str, Any]) -> None:
        _assert_capture_state(
            payload,
            self.manifest_path,
            require_complete=True,
        )
        stored_inventory = payload.get(CONTENT_INVENTORY_KEY)
        if not isinstance(stored_inventory, list):
            raise DataIntegrityError(
                f"{self.manifest_path} has no finalized content inventory"
            )
        _validate_inventory_rows(stored_inventory, self.manifest_path)
        stored_inventory_sha256 = payload.get(INVENTORY_SHA256_KEY)
        stored_content_sha256 = payload.get(CONTENT_SHA256_KEY)
        canonical_stored_sha256 = _canonical_sha256(stored_inventory)
        if (
            not _is_sha256(stored_inventory_sha256)
            or stored_inventory_sha256 != canonical_stored_sha256
            or stored_content_sha256 != canonical_stored_sha256
        ):
            raise DataIntegrityError(
                f"{self.manifest_path} content inventory SHA-256 is inconsistent"
            )
        actual_inventory = self._build_content_inventory()
        if actual_inventory != stored_inventory:
            raise DataIntegrityError(
                f"{self._root} content inventory mismatch; a finalized file was "
                "changed, deleted, or added"
            )
        actual_anomalies = self._scan_nonpositive_rows(actual_inventory)
        if actual_anomalies != payload["nonpositive_spread_rows"]:
            raise DataIntegrityError(
                f"{self.manifest_path} nonpositive-spread provenance does not "
                "match persisted Parquet content"
            )
        self._validate_capture_metadata(payload.get("capture"), actual_inventory)

    def _validate_capture_metadata(
        self,
        capture: Any,
        inventory: Sequence[Mapping[str, Any]],
    ) -> None:
        if not isinstance(capture, dict):
            raise DataIntegrityError(
                f"{self.manifest_path} has no finalized capture metadata"
            )
        if (
            capture.get("analysis_only") is not True
            or capture.get("cost_valid") is not False
            or capture.get("account_mode") != "DEMO"
        ):
            raise DataIntegrityError(
                f"{self.manifest_path} capture identity is not guarded DEMO, "
                "analysis-only, and cost-invalid"
            )
        try:
            start = ensure_utc(datetime.fromisoformat(capture["requested_start"]))
            end = ensure_utc(
                datetime.fromisoformat(capture["requested_end_exclusive"])
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise DataIntegrityError(
                f"{self.manifest_path} has invalid capture bounds"
            ) from exc
        if end <= start:
            raise DataIntegrityError(
                f"{self.manifest_path} capture bounds are not a positive range"
            )
        raw_timeframes = capture.get("timeframes")
        if (
            not isinstance(raw_timeframes, list)
            or not all(isinstance(value, str) for value in raw_timeframes)
            or len(raw_timeframes) != len(set(raw_timeframes))
            or set(raw_timeframes) != {Timeframe.H1.value, Timeframe.M15.value}
        ):
            raise DataIntegrityError(
                f"{self.manifest_path} capture timeframes must be exactly H1/M15"
            )
        symbols = capture.get("symbols")
        if not isinstance(symbols, dict) or not symbols:
            raise DataIntegrityError(
                f"{self.manifest_path} capture symbols are absent"
            )

        meta_by_resolved: dict[str, dict[str, Any]] = {}
        inventory_rows: dict[tuple[str, str], int] = {}
        for entry in inventory:
            path = self._root / Path(str(entry["path"]))
            relative = path.relative_to(self._root)
            if entry["kind"] == "symbol_meta":
                metadata = _read_symbol_meta_file(path)
                meta_by_resolved[str(metadata["resolved_name"])] = metadata
            elif entry["kind"] == "parquet":
                key = (relative.parts[0], relative.parts[2])
                inventory_rows[key] = inventory_rows.get(key, 0) + int(
                    entry["row_count"]
                )

        declared_resolved: set[str] = set()
        for requested, raw_symbol in symbols.items():
            if not isinstance(raw_symbol, dict):
                raise DataIntegrityError(
                    f"{self.manifest_path} has malformed symbol capture {requested!r}"
                )
            resolved = raw_symbol.get("resolved_symbol")
            metadata = meta_by_resolved.get(resolved)
            if metadata is None or metadata["requested_name"] != requested:
                raise DataIntegrityError(
                    f"{self.manifest_path} symbol capture {requested!r} does not "
                    "match persisted metadata"
                )
            declared_resolved.add(str(resolved))
            series = raw_symbol.get("series")
            if not isinstance(series, dict) or set(series) != set(raw_timeframes):
                raise DataIntegrityError(
                    f"{self.manifest_path} symbol {requested!r} does not carry "
                    "exact H1/M15 series metadata"
                )
            directory = self._safe_dirname(str(resolved))
            for timeframe_text in raw_timeframes:
                timeframe = Timeframe(timeframe_text)
                path = self._root / directory / _BARS_DIRNAME / timeframe.value
                parts = [
                    _read_parquet(part)
                    for part in sorted(path.glob("*.parquet"))
                ]
                if not parts:
                    raise DataIntegrityError(
                        f"required finalized series is absent: {resolved} "
                        f"{timeframe.value}"
                    )
                frame = pd.concat(parts, ignore_index=True).sort_values("time_utc")
                if len(frame) != inventory_rows.get((directory, timeframe.value), 0):
                    raise DataIntegrityError(
                        f"{resolved} {timeframe.value} inventory row count mismatch"
                    )
                times = pd.to_datetime(frame["time_utc"], utc=True)
                if times.duplicated().any():
                    raise DataIntegrityError(
                        f"{resolved} {timeframe.value} contains duplicate bar opens"
                    )
                step = timeframe_delta(timeframe)
                if any((value.to_pydatetime().astimezone(UTC) - start) % step for value in times):
                    raise DataIntegrityError(
                        f"{resolved} {timeframe.value} contains an off-grid bar open"
                    )
                if ((times < start) | (times >= end)).any():
                    raise DataIntegrityError(
                        f"{resolved} {timeframe.value} contains rows outside the "
                        "approved half-open capture range"
                    )
                entry = series[timeframe.value]
                if not isinstance(entry, dict):
                    raise DataIntegrityError(
                        f"{resolved} {timeframe.value} series metadata is malformed"
                    )
                gaps = _availability_gaps_from_times(
                    [value.to_pydatetime().astimezone(UTC) for value in times],
                    timeframe,
                    start,
                    end,
                )
                expected = {
                    "bars_written": len(frame),
                    "coverage_first": times.iloc[0].to_pydatetime().astimezone(
                        UTC
                    ).isoformat(),
                    "coverage_last": times.iloc[-1].to_pydatetime().astimezone(
                        UTC
                    ).isoformat(),
                    "availability_gaps": gaps,
                    "gap_count": len(gaps),
                    "gap_rows_sha256": _canonical_sha256(gaps),
                }
                mismatches = {
                    key: (entry.get(key), value)
                    for key, value in expected.items()
                    if entry.get(key) != value
                }
                if mismatches:
                    raise DataIntegrityError(
                        f"{resolved} {timeframe.value} finalized capture metadata "
                        f"does not match persisted content: {mismatches}"
                    )
        if declared_resolved != set(meta_by_resolved):
            raise DataIntegrityError(
                f"{self.manifest_path} finalized symbol set does not match "
                "persisted metadata"
            )

    def _validate_and_frame(
        self,
        symbol: str,
        timeframe: Timeframe,
        bars: Sequence[Candle],
    ) -> pd.DataFrame:
        rows: list[dict[str, Any]] = []
        for candle in bars:
            moment = ensure_utc(candle.time)
            prices = (candle.open, candle.high, candle.low, candle.close)
            if any(not math.isfinite(float(value)) for value in prices):
                raise DataIntegrityError(
                    f"{symbol} {timeframe.value} at {moment.isoformat()} has "
                    "non-finite OHLC"
                )
            if candle.high < candle.low or candle.high < max(
                candle.open, candle.close
            ) or candle.low > min(candle.open, candle.close):
                raise DataIntegrityError(
                    f"{symbol} {timeframe.value} at {moment.isoformat()} has "
                    "inconsistent OHLC"
                )
            rows.append(
                {
                    "time_utc": moment,
                    "open": float(candle.open),
                    "high": float(candle.high),
                    "low": float(candle.low),
                    "close": float(candle.close),
                    "tick_volume": int(candle.tick_volume),
                    "spread": int(candle.spread),
                }
            )
        frame = pd.DataFrame(rows, columns=_BAR_COLUMNS)
        frame["time_utc"] = pd.to_datetime(frame["time_utc"], utc=True)
        return frame.sort_values("time_utc").reset_index(drop=True)

    def _symbol_directories(self) -> list[Path]:
        self._read_identity_manifest()
        if not self._root.is_dir():
            return []
        directories: list[Path] = []
        for directory in sorted(path for path in self._root.iterdir() if path.is_dir()):
            meta_path = directory / _META_FILENAME
            if not meta_path.is_file():
                raise DataIntegrityError(
                    f"{directory} has no {_META_FILENAME}; refusing partial "
                    "analysis-store identity"
                )
            directories.append(directory)
        return directories

    def _read_symbol_meta_path(self, path: Path) -> dict[str, Any]:
        return _read_symbol_meta_file(path)

    def _read_identity_manifest(
        self,
        *,
        require_state: bool = True,
    ) -> dict[str, Any]:
        path = self.manifest_path
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise DataIntegrityError(
                f"missing or unreadable Stage 2 analysis-store identity {path}: {exc}"
            ) from exc
        _assert_identity(payload, path)
        if require_state:
            _assert_capture_state(payload, path)
        anomalies = payload.get("nonpositive_spread_rows")
        if not isinstance(anomalies, list):
            raise DataIntegrityError(
                f"{path} must contain nonpositive_spread_rows as a list"
            )
        for row in anomalies:
            if not isinstance(row, dict) or not {
                "symbol",
                "timeframe",
                "time_utc",
                "spread",
            }.issubset(row):
                raise DataIntegrityError(
                    f"{path} contains malformed nonpositive-spread provenance"
                )
            if isinstance(row["spread"], bool) or not isinstance(row["spread"], int):
                raise DataIntegrityError(
                    f"{path} contains a non-integer raw spread value"
                )
            if row["spread"] > 0:
                raise DataIntegrityError(
                    f"{path} lists a positive spread as nonpositive"
                )
        return payload

    def _write_manifest(self, payload: Mapping[str, Any]) -> None:
        _assert_identity(payload, self.manifest_path)
        _assert_capture_state(payload, self.manifest_path)
        _atomic_write_text(
            self.manifest_path,
            json.dumps(dict(payload), indent=2, sort_keys=True) + "\n",
        )


def _assert_identity(payload: Mapping[str, Any], path: Path) -> None:
    expected = {
        "store_type": ANALYSIS_STORE_TYPE,
        "store_format_version": ANALYSIS_STORE_FORMAT_VERSION,
        "analysis_only": True,
        "cost_valid": False,
    }
    mismatches = {
        key: (payload.get(key), value)
        for key, value in expected.items()
        if payload.get(key) != value or type(payload.get(key)) is not type(value)
    }
    if mismatches:
        raise DataIntegrityError(
            f"{path} is not the approved Stage 2 analysis-only, cost-invalid "
            f"store; identity mismatches: {mismatches}"
        )


def _assert_capture_state(
    payload: Mapping[str, Any],
    path: Path,
    *,
    require_complete: bool | None = None,
) -> None:
    status = payload.get("capture_status")
    complete = payload.get("capture_complete")
    valid = (
        status == CAPTURE_STATUS_IN_PROGRESS
        and complete is False
        and type(complete) is bool
    ) or (
        status == CAPTURE_STATUS_COMPLETE
        and complete is True
        and type(complete) is bool
    )
    if not valid:
        raise DataIntegrityError(
            f"{path} has no valid transactional capture state; expected "
            "IN_PROGRESS/false or COMPLETE/true"
        )
    if require_complete is True and complete is not True:
        raise DataIntegrityError(
            f"{path} is an incomplete Stage 2 analysis capture and cannot be read"
        )
    if require_complete is False and complete is not False:
        raise DataIntegrityError(
            f"{path} is finalized; begin_capture() must mark it incomplete "
            "before any recorder mutation"
        )


def _read_symbol_meta_file(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise DataIntegrityError(
            f"unreadable analysis metadata {path}: {exc}"
        ) from exc
    _assert_identity(payload, path)
    required = (
        "requested_name",
        "resolved_name",
        "spec",
        "swap_long",
        "swap_short",
        "recorded_at_utc",
    )
    missing = [key for key in required if payload.get(key) is None]
    if missing:
        raise DataIntegrityError(
            f"{path} is missing required analysis metadata {missing}"
        )
    try:
        SymbolSpec(**payload["spec"])
        ensure_utc(datetime.fromisoformat(payload["recorded_at_utc"]))
    except (TypeError, ValueError) as exc:
        raise DataIntegrityError(
            f"{path} contains invalid symbol metadata"
        ) from exc
    return payload


def _canonical_sha256(value: Any) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(char in "0123456789abcdef" for char in value)
    )


def _validate_inventory_rows(rows: Sequence[Any], path: Path) -> None:
    if not all(isinstance(row, dict) for row in rows):
        raise DataIntegrityError(f"{path} contains a malformed inventory row")
    if rows != sorted(rows, key=lambda row: row.get("path", "")):
        raise DataIntegrityError(f"{path} content inventory is not canonical")
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            raise DataIntegrityError(f"{path} contains a malformed inventory row")
        kind = row.get("kind")
        relative = row.get("path")
        if (
            kind not in {"symbol_meta", "parquet"}
            or not isinstance(relative, str)
            or not relative
            or relative in seen
            or "\\" in relative
            or relative.startswith("/")
            or ".." in Path(relative).parts
            or isinstance(row.get("bytes"), bool)
            or not isinstance(row.get("bytes"), int)
            or row["bytes"] < 0
            or not _is_sha256(row.get("sha256"))
        ):
            raise DataIntegrityError(f"{path} contains a malformed inventory row")
        seen.add(relative)
        if kind == "parquet" and (
            isinstance(row.get("row_count"), bool)
            or not isinstance(row.get("row_count"), int)
            or row["row_count"] < 0
            or row.get("schema_id") != _BAR_SCHEMA_ID
        ):
            raise DataIntegrityError(
                f"{path} contains malformed Parquet inventory identity"
            )


def _is_month_partition(value: str) -> bool:
    if len(value) != 7 or value[4] != "-":
        return False
    try:
        datetime.strptime(value, "%Y-%m")
    except ValueError:
        return False
    return True


def _missing_slot_count(duration: timedelta, step: timedelta) -> int:
    complete, remainder = divmod(duration, step)
    return int(complete) + int(remainder > timedelta(0))


def _availability_gaps_from_times(
    times: Sequence[datetime],
    timeframe: Timeframe,
    start: datetime,
    end: datetime,
) -> list[dict[str, str | int]]:
    step = timeframe_delta(timeframe)
    ordered = sorted({ensure_utc(value) for value in times})
    intervals: list[tuple[datetime, datetime]] = []
    if not ordered:
        intervals.append((start, end))
    else:
        if ordered[0] > start:
            intervals.append((start, ordered[0]))
        for previous, current in zip(ordered, ordered[1:]):
            expected_next = previous + step
            if current > expected_next:
                intervals.append((expected_next, current))
        trailing_start = ordered[-1] + step
        if trailing_start < end:
            intervals.append((trailing_start, end))
    return [
        {
            "start_utc": gap_start.isoformat(),
            "end_utc": gap_end.isoformat(),
            "missing_slot_count": _missing_slot_count(
                gap_end - gap_start,
                step,
            ),
        }
        for gap_start, gap_end in intervals
    ]


def _partition_keys(start: datetime, end: datetime) -> list[str]:
    keys: list[str] = []
    year, month = start.year, start.month
    while (year, month) <= (end.year, end.month):
        keys.append(f"{year:04d}-{month:02d}")
        month += 1
        if month > 12:
            month = 1
            year += 1
    return keys


def _read_parquet(path: Path) -> pd.DataFrame:
    try:
        table = pq.read_table(path)
    except Exception as exc:
        raise DataIntegrityError(f"unreadable analysis parquet {path}: {exc}") from exc
    if table.schema != _BAR_SCHEMA:
        raise DataIntegrityError(
            f"{path} does not carry the Stage 2 analysis-only bar schema"
        )
    frame = table.to_pandas()
    frame["time_utc"] = pd.to_datetime(frame["time_utc"], utc=True)
    return frame[_BAR_COLUMNS]


def _frame_to_candles(frame: pd.DataFrame) -> list[Candle]:
    return [
        Candle(
            time=row.time_utc.to_pydatetime().astimezone(UTC),
            open=float(row.open),
            high=float(row.high),
            low=float(row.low),
            close=float(row.close),
            tick_volume=int(row.tick_volume),
            spread=int(row.spread),
        )
        for row in frame.itertuples(index=False)
    ]


def _atomic_write_parquet(path: Path, frame: pd.DataFrame) -> None:
    table = pa.Table.from_pandas(
        frame[_BAR_COLUMNS], schema=_BAR_SCHEMA, preserve_index=False
    )
    temporary = path.with_name(path.name + ".tmp")
    pq.write_table(table, temporary)
    os.replace(temporary, path)


def _atomic_write_text(path: Path, text: str) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, path)


__all__ = [
    "ANALYSIS_MANIFEST_FILENAME",
    "ANALYSIS_ONLY_SUBDIRECTORY",
    "ANALYSIS_STORE_FORMAT_VERSION",
    "ANALYSIS_STORE_TYPE",
    "CAPTURE_STATUS_COMPLETE",
    "CAPTURE_STATUS_IN_PROGRESS",
    "CONTENT_INVENTORY_KEY",
    "CONTENT_SHA256_KEY",
    "INVENTORY_SHA256_KEY",
    "AnalysisSymbolRecord",
    "Stage2AnalysisParquetStore",
]
