"""Market-data contracts from spec §2.

FROZEN. See CLAUDE.md, "Contracts are frozen".
"""

from datetime import datetime

from pydantic import BaseModel

from .enums import Direction


class Candle(BaseModel):
    time: datetime  # UTC
    open: float
    high: float
    low: float
    close: float
    tick_volume: int
    spread: int


class SymbolSpec(BaseModel):
    """Resolved once at startup. Never assume these values."""

    name: str  # broker-resolved, e.g. "XAUUSD.m"
    digits: int
    point: float
    tick_size: float
    tick_value: float  # in account currency
    contract_size: float
    volume_min: float
    volume_max: float
    volume_step: float
    stops_level: int  # min SL/TP distance in points
    freeze_level: int


class StrategyResult(BaseModel):
    module_id: int  # 1..28
    module_name: str
    fired: bool
    direction: Direction
    score: float  # 0..100, module's own confidence
    evidence: dict  # levels/coords for chart overlay


class ClusterResult(BaseModel):
    cluster_id: str  # "A".."H"
    cluster_name: str
    fired: bool
    direction: Direction
    score: float  # best or mean of firing members
    contributing_modules: list[int]


__all__ = ["Candle", "SymbolSpec", "StrategyResult", "ClusterResult"]
