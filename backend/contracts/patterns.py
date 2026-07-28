"""Pattern-engine contracts from spec §2 / §6.4.

Advisory layer. Never enters any score (rule 10).
FROZEN. See CLAUDE.md, "Contracts are frozen".
"""

from pydantic import BaseModel

from .enums import Direction, PatternState, Timeframe


class PatternResult(BaseModel):
    """Produced by the pattern engine (§6.4). Advisory. Never enters any score."""

    formation: str  # one of the 16 in §6.4
    timeframe: Timeframe
    state: PatternState
    direction: Direction  # bias only
    confidence: float  # 0..100, the engine's own — not the §5 score
    target_r: float  # projected reward:risk from the measured move
    entry_zone: dict | None
    stop_loss: float | None
    take_profit: float | None
    blocked_by: list[str]  # populated when CONFIRMED_FILTERED
    geometry: dict  # coordinates for chart overlay


class ChartLayerState(BaseModel):
    """Persisted per (symbol, timeframe). 18 layers across 4 groups (§8.3)."""

    symbol: str
    timeframe: Timeframe
    enabled: dict[str, bool]  # layer_id -> on/off
    drawings: list[dict]  # user annotations, free-form geometry


__all__ = ["PatternResult", "ChartLayerState"]
