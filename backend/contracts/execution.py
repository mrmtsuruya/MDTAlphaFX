"""Execution contracts from spec §2 / §7.

FROZEN. See CLAUDE.md, "Contracts are frozen".

Stage 0 defines these models only. The execution engine that produces and
consumes them is Stage 5 (§7) and is NOT implemented here. The backtester
reuses `OrderIntent` so that a simulated fill is validated against the same
§7.3 constraints a live order would face (§11.2).
"""

from datetime import datetime

from pydantic import BaseModel

from .signals import ExitPlan


class OrderIntent(BaseModel):
    signal_id: str  # same key — enforces idempotency
    symbol: str
    order_type: str
    volume: float  # already rounded to volume_step
    price: float | None  # None for market orders
    stop_loss: float
    take_profit: float
    exit_plan: ExitPlan  # currency targets + trailing, managed post-fill
    magic: int = 999888
    comment: str
    origin: str  # MANUAL | AUTO — recorded, never inferred later


class ExecutionReceipt(BaseModel):
    signal_id: str
    submitted_at: datetime
    retcode: int
    order_ticket: int | None
    position_ticket: int | None
    filled_volume: float
    filled_price: float | None
    broker_comment: str


__all__ = ["OrderIntent", "ExecutionReceipt"]
