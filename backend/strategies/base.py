"""§4.1 Module interface.

The protocol below is copied from the spec and **must not be modified** — every
one of the 28 Stage 2 modules is written against it.

The three rules that constrain implementers, restated because they are the ones
agents break:

1. **Pure function of a bar window.** No I/O, no globals, no network, no clock
   reads, no randomness. `evaluate` given the same bars and spec returns the
   same result, forever.

2. **Never read or infer the regime.** Tier 1 gates modules externally. A
   module that checks regime internally smears Tier 1 across 28 files and
   destroys testability (rule 2).

3. **Declare `min_bars` honestly.** Under-declaring produces silent garbage on
   short windows — the module returns a confident result computed from an
   indicator that has not warmed up.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from ..contracts import Candle, StrategyResult, SymbolSpec


@runtime_checkable
class Strategy(Protocol):
    module_id: int
    module_name: str
    cluster_id: str
    min_bars: int  # lookback required

    def evaluate(self, bars: list[Candle], spec: SymbolSpec) -> StrategyResult:
        """Pure function. No I/O. No regime awareness. No global state."""
        ...


class InsufficientBars(Exception):
    """Raised by the harness, not by modules, when a window is shorter than the
    module's declared `min_bars`. Modules are never handed a short window."""


def check_window(strategy: Strategy, bars: list[Candle]) -> None:
    """Harness-side precondition. Keeps the `min_bars` contract honest without
    requiring every module to re-implement the check."""
    if len(bars) < strategy.min_bars:
        raise InsufficientBars(
            f"module {strategy.module_id} ({strategy.module_name}) declares "
            f"min_bars={strategy.min_bars}, got {len(bars)}"
        )


__all__ = ["Strategy", "InsufficientBars", "check_window"]
