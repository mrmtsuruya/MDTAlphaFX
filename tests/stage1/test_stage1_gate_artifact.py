from datetime import datetime

from backend.core.config import Config
from backend.core.timeutil import UTC
from scripts.run_stage1_gate import RegimeRow, build_artifact


def test_gate_artifact_preserves_replay_and_transition_source_provenance() -> None:
    row = RegimeRow(
        symbol="XAUUSD",
        time="2026-01-02T10:00:00+00:00",
        open=2600.0,
        high=2610.0,
        low=2595.0,
        close=2605.0,
        adx=28.0,
        atr_percentile=0.5,
        r_squared=0.8,
        ema_stack_aligned=True,
        ema_stack_bullish=True,
        within_news_blackout=False,
        raw_regime="TRENDING_BULLISH",
        regime="TRENDING_BULLISH",
        confidence=0.9,
        bars_in_regime=1,
    )
    audit = {
        "scope": {
            "rows": 1,
            "observed_transitions": 0,
            "one_bar_segments": 1,
        },
        "mechanical_invariants": {"impossible_transition_count": 0},
        "one_bar_review": {
            "round_trip_aba": 0,
            "price_assessment": {
                "SUPPORTIVE": 1,
                "MIXED": 0,
                "CONTRADICTORY": 0,
            },
        },
    }

    artifact = build_artifact(
        config=Config.load("config"),
        generated_at=datetime(2026, 1, 2, 12, tzinfo=UTC),
        rows_by_symbol={"XAUUSD": [row]},
        calendar_supplied=False,
        source_data_path="docs/stage1-gate/regime_replay.json",
        account_label="guarded demo",
        transition_audit=audit,
        transition_audit_path="docs/stage1-gate/transition_audit.json",
    )

    blocks = {block["id"]: block for block in artifact["manifest"]["blocks"]}
    assert blocks["technical-summary"]["sourceId"] == "src-regime-replay"
    assert blocks["price-context"]["sourceId"] == "src-regime-replay"
    assert blocks["regime-mix"]["sourceId"] == "src-regime-replay"
    assert blocks["mechanical-review"]["sourceId"] == "src-transition-audit"
    assert blocks["boundary-stability"]["sourceId"] == "src-transition-audit"

    sources = {source["id"] for source in artifact["manifest"]["sources"]}
    assert "src-regime-replay" in sources
    assert "src-transition-audit" in sources
