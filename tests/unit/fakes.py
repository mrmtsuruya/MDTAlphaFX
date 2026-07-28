"""A `MetaTrader5` module double.

Exists so §7.1 resolution, the rule 5 guard and the §10.1 offset measurement are
testable on any platform. The real package is Windows-only and would put a
broker at the end of every one of these tests, which §10.3 forbids.

The double mimics the shapes that matter and nothing else: `symbol_info()`
returning `None` for an unknown name, `trade_tick_value` populated only after
`symbol_select()`, tick times carried as server wall clock labelled UTC.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import Any

import numpy as np

from backend.core.guards import ACCOUNT_TRADE_MODE_DEMO
from backend.core.timeutil import UTC, timeframe_delta
from backend.contracts import Timeframe

# The MT5 rates dtype. Field names are the package's, not ours.
RATES_DTYPE = np.dtype(
    [
        ("time", "<i8"),
        ("open", "<f8"),
        ("high", "<f8"),
        ("low", "<f8"),
        ("close", "<f8"),
        ("tick_volume", "<i8"),
        ("spread", "<i4"),
        ("real_volume", "<i8"),
    ]
)

# Same, minus the column §11.2 depends on.
RATES_DTYPE_NO_SPREAD = np.dtype(
    [
        ("time", "<i8"),
        ("open", "<f8"),
        ("high", "<f8"),
        ("low", "<f8"),
        ("close", "<f8"),
        ("tick_volume", "<i8"),
    ]
)


class _Absent:
    """Sentinel: delete this attribute rather than set it to None."""


_ABSENT = _Absent()
ABSENT = _ABSENT


def symbol_info_double(name: str, **overrides: Any) -> SimpleNamespace:
    """A plausible `SymbolInfo`. Override or delete fields to model a broker
    that answers incompletely."""
    values: dict[str, Any] = {
        "name": name,
        "digits": 2,
        "point": 0.01,
        "trade_tick_size": 0.01,
        "trade_tick_value": 1.0,
        "trade_contract_size": 100.0,
        "volume_min": 0.01,
        "volume_max": 50.0,
        "volume_step": 0.01,
        "trade_stops_level": 0,
        "trade_freeze_level": 0,
        "swap_long": -4.5,
        "swap_short": 1.2,
        "spread": 30,
        "visible": True,
    }
    values.update(overrides)
    for key, value in list(values.items()):
        if value is _ABSENT:
            del values[key]
    return SimpleNamespace(**values)


@dataclass
class FakeMT5:
    """Enough of the MetaTrader5 module surface for the connector's paths."""

    symbols: dict[str, SimpleNamespace] = field(default_factory=dict)
    trade_mode: int = ACCOUNT_TRADE_MODE_DEMO
    login: int = 1234567
    server: str = "FakeBroker-Demo"
    currency: str = "USD"
    # Server wall clock minus UTC, the value the connector must recover.
    server_offset_minutes: int = 180
    # How stale the quote is. Large values model a closed market.
    quote_staleness_seconds: float = 0.0
    initialize_ok: bool = True
    account_info_result: Any = "default"
    rates: dict[tuple[str, int], np.ndarray] = field(default_factory=dict)
    rates_dtype: np.dtype = RATES_DTYPE
    require_select_for_tick_value: bool = False

    initialize_calls: list[dict[str, Any]] = field(default_factory=list)
    shutdown_calls: int = 0
    selected: set[str] = field(default_factory=set)
    range_calls: list[tuple[str, int, datetime, datetime]] = field(
        default_factory=list
    )

    # MT5 timeframe enum values, as the package exposes them.
    TIMEFRAME_M1: int = 1
    TIMEFRAME_M5: int = 5
    TIMEFRAME_M15: int = 15
    TIMEFRAME_H1: int = 16385
    TIMEFRAME_H4: int = 16388

    # ------------------------------------------------------------- session

    def initialize(self, **kwargs: Any) -> bool:
        self.initialize_calls.append(kwargs)
        return self.initialize_ok

    def shutdown(self) -> None:
        self.shutdown_calls += 1

    def last_error(self) -> tuple[int, str]:
        return (0, "fake: no error")

    def account_info(self) -> Any:
        if self.account_info_result != "default":
            return self.account_info_result
        return SimpleNamespace(
            login=self.login,
            server=self.server,
            trade_mode=self.trade_mode,
            currency=self.currency,
        )

    # ------------------------------------------------------------- symbols

    def symbol_info(self, name: str) -> Any:
        info = self.symbols.get(name)
        if info is None:
            return None
        if self.require_select_for_tick_value and name not in self.selected:
            unselected = SimpleNamespace(**vars(info))
            unselected.trade_tick_value = 0.0
            return unselected
        return info

    def symbol_select(self, name: str, enable: bool = True) -> bool:
        if name not in self.symbols:
            return False
        if enable:
            self.selected.add(name)
        else:
            self.selected.discard(name)
        return True

    def symbols_get(self, pattern: str = "*") -> list[SimpleNamespace]:
        needle = pattern.strip("*")
        return [info for name, info in self.symbols.items() if needle in name]

    def symbol_info_tick(self, name: str) -> Any:
        if name not in self.symbols:
            return None
        now = datetime.now(UTC)
        server_wall = (
            now
            + timedelta(minutes=self.server_offset_minutes)
            - timedelta(seconds=self.quote_staleness_seconds)
        )
        return SimpleNamespace(
            time=int(server_wall.timestamp()),
            time_msc=int(server_wall.timestamp() * 1000),
            bid=1.0,
            ask=1.0,
        )

    # ---------------------------------------------------------------- bars

    def copy_rates_range(
        self, name: str, timeframe: int, date_from: datetime, date_to: datetime
    ) -> Any:
        self.range_calls.append((name, timeframe, date_from, date_to))
        series = self.rates.get((name, timeframe))
        if series is None:
            return np.empty(0, dtype=self.rates_dtype)
        low = int(date_from.timestamp())
        high = int(date_to.timestamp())
        # copy_rates_range is inclusive at both ends.
        return series[(series["time"] >= low) & (series["time"] <= high)]

    def copy_rates_from_pos(
        self, name: str, timeframe: int, start_pos: int, count: int
    ) -> Any:
        series = self.rates.get((name, timeframe))
        if series is None:
            return np.empty(0, dtype=self.rates_dtype)
        end = len(series) - start_pos
        return series[max(0, end - count) : end]

    # ------------------------------------------------------------ fixtures

    def load_rates(
        self,
        name: str,
        timeframe: Timeframe,
        first_bar_utc: datetime,
        count: int,
        *,
        spread: int = 30,
        dtype: np.dtype | None = None,
    ) -> np.ndarray:
        """Seed a deterministic series, stored as server wall clock."""
        dtype = dtype if dtype is not None else self.rates_dtype
        step = timeframe_delta(timeframe)
        rows = []
        for index in range(count):
            bar_utc = first_bar_utc + step * index
            server_wall = bar_utc + timedelta(minutes=self.server_offset_minutes)
            base = 100.0 + index
            # `server_wall` carries the server's wall-clock digits in an object
            # labelled UTC, so `.timestamp()` is exactly the integer MT5 stores.
            row = [
                int(server_wall.timestamp()),
                base,
                base + 1.0,
                base - 1.0,
                base + 0.5,
                10 + index,
            ]
            if "spread" in (dtype.names or ()):
                row.append(spread)
            if "real_volume" in (dtype.names or ()):
                row.append(0)
            rows.append(tuple(row))
        series = np.array(rows, dtype=dtype)
        self.rates[(name, getattr(self, f"TIMEFRAME_{timeframe.value}"))] = series
        return series


__all__ = [
    "FakeMT5",
    "symbol_info_double",
    "ABSENT",
    "RATES_DTYPE",
    "RATES_DTYPE_NO_SPREAD",
]
