"""Outcome-resolution contracts from spec §2 / §12.

FROZEN. See CLAUDE.md, "Contracts are frozen".

Stage 0 defines these models because `Signal.outcome` forward-references
`OutcomeRecord`. The resolver that populates them is Stage 5b (§12.1) and is
NOT implemented here.
"""

from datetime import datetime

from pydantic import BaseModel

from .enums import SignalState


class ExcursionMetrics(BaseModel):
    """Trade quality, independent of win/loss. All values in R (§12.2).
    Computed for every signal — taken or not."""

    mae_r: float  # max adverse excursion: worst drawdown before resolution
    mfe_r: float  # max favourable excursion: best unrealised gain reached
    mae_bar: int  # bars after lock at which MAE occurred
    mfe_bar: int
    realised_r: float  # 0.0 for untaken signals
    capture_ratio: float  # realised_r / mfe_r — how much of the move was kept
    stop_utilisation: float  # |mae_r| / 1.0 — fraction of risk budget actually used
    entry_efficiency: float  # 0..1, fill vs best price offered in the zone
    bars_to_resolution: int


class OutcomeRecord(BaseModel):
    """Terminal record for one signal. Written once, never amended (§12.1)."""

    signal_id: str
    resolved_at: datetime
    final_state: SignalState  # CLOSED_TP | CLOSED_SL | EXPIRED | TOO_LATE
    source: str  # BROKER | REPLAY — never conflated in a statistic
    counterfactual: bool  # True when the signal was never taken

    # Populated from broker deal history when source == BROKER.
    close_reason: str | None  # TP | SL | STOP_OUT | CLIENT | EXPERT
    close_price: float | None
    realised_pnl: float | None  # account currency, net of swap and commission

    excursion: ExcursionMetrics
    ambiguous_fill: bool  # resolved by §11.1 fallback rather than sub-bar walk
    config_version: str  # which scoring/level config produced this signal


__all__ = ["ExcursionMetrics", "OutcomeRecord"]
