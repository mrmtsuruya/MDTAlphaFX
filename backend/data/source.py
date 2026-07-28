"""The narrow interface between market data and everything that consumes it.

This exists so the replay engine (§11) never imports MetaTrader5. Two
consequences, both required:

- **§10.3, "no test touches the network".** Tests bind a recorded fixture to
  this protocol. Nothing in the test path can reach a broker.
- **The `MetaTrader5` package is Windows-only.** Anything that imports it is
  unrunnable off Windows, and the backtester must not inherit that.

`m1_bars` and `has_m1` are on this protocol rather than bolted onto the store
later because §11.1's sub-bar walk is a Stage 0 requirement, not a polish pass.
A source that cannot answer "do I have M1 for this window?" forces every
ambiguous candle onto the conservative fallback silently, which is the exact
failure §11.1 is written to prevent.
"""

from __future__ import annotations

from datetime import datetime
from typing import Protocol, runtime_checkable

from ..contracts import Candle, SymbolSpec, Timeframe


@runtime_checkable
class BarSource(Protocol):
    """Read-only access to bars. Implemented by the Parquet store and by
    fixture doubles in tests."""

    def bars(
        self,
        symbol: str,
        timeframe: Timeframe,
        start: datetime,
        end: datetime,
    ) -> list[Candle]:
        """Bars with `start <= bar.time < end`, ascending, UTC.

        `spread` on each Candle is the per-bar recorded spread required by
        §11.2. A source that cannot supply it raises `DataIntegrityError`
        rather than returning zero — a zero spread is a frictionless backtest
        wearing a disguise.
        """
        ...

    def m1_bars(self, symbol: str, start: datetime, end: datetime) -> list[Candle]:
        """M1 bars for §11.1 sub-bar resolution. Same ordering and UTC rules."""
        ...

    def has_m1(self, symbol: str, start: datetime, end: datetime) -> bool:
        """True only when M1 coverage is complete across `[start, end)`.

        Partial coverage returns False. A gap in the middle of an ambiguous
        candle is exactly the case where a sub-bar walk would produce a
        confident wrong answer.
        """
        ...

    def symbol_spec(self, symbol: str) -> SymbolSpec:
        """The `SymbolSpec` resolved at §7.1 time and snapshotted alongside the
        bars. Never reconstructed from assumptions."""
        ...

    def available_symbols(self) -> list[str]:
        ...

    def coverage(
        self, symbol: str, timeframe: Timeframe
    ) -> tuple[datetime, datetime] | None:
        """(first_bar_time, last_bar_time) or None when the symbol/timeframe is
        absent. Used to fail a backtest that asks for a window the store does
        not hold, rather than silently returning a short series."""
        ...


__all__ = ["BarSource"]
