"""Core data contracts — spec §2.

FROZEN before any module work begins. Changing these later invalidates every
strategy module.

Import everything from this package, never from the submodules directly:

    from backend.contracts import Candle, SymbolSpec, StrategyResult

The submodule layout is an organisational convenience and is not part of the
contract. `contract_hash()` in `backend.contracts.freeze` is what guards the
contract itself.
"""

from .enums import Direction, PatternState, Regime, SignalState, Timeframe
from .execution import ExecutionReceipt, OrderIntent
from .market import Candle, ClusterResult, StrategyResult, SymbolSpec
from .outcomes import ExcursionMetrics, OutcomeRecord
from .patterns import ChartLayerState, PatternResult
from .signals import ExitPlan, GateOutcome, Signal, TimeframeState, VoteTally

# Signal forward-references PatternResult and OutcomeRecord as strings (§2).
# Resolve them now so the model is usable at import time.
Signal.model_rebuild(
    _types_namespace={
        "PatternResult": PatternResult,
        "OutcomeRecord": OutcomeRecord,
    }
)

__all__ = [
    # enums
    "Timeframe",
    "Regime",
    "Direction",
    "SignalState",
    "PatternState",
    # market
    "Candle",
    "SymbolSpec",
    "StrategyResult",
    "ClusterResult",
    # signals
    "VoteTally",
    "TimeframeState",
    "ExitPlan",
    "GateOutcome",
    "Signal",
    # execution
    "OrderIntent",
    "ExecutionReceipt",
    # outcomes
    "ExcursionMetrics",
    "OutcomeRecord",
    # patterns
    "PatternResult",
    "ChartLayerState",
]
