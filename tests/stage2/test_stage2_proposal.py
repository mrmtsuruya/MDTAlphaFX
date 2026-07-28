"""Focused tests for the Stage 2 co-firing proposal harness."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from backend.analysis.stage2_cofire import MODULE_IDS, CofireObservation, analyse_cofiring
from backend.analysis.stage2_proposal import (
    EffectiveRegime,
    EvaluatedObservation,
    attach_latest_closed_regimes,
    evaluate_full_prefix_population,
    neutral_cluster_proposals,
    neutral_reachability_artifact,
    pairwise_artifacts,
    pre_htf_score_ingredients,
    proposal_registry,
    score_ingredient_summary,
)
from backend.contracts import (
    Candle,
    Direction,
    Regime,
    StrategyResult,
    Timeframe,
)
from backend.core.config import Config
from backend.core.timeutil import timeframe_delta
from backend.data.store import ParquetBarStore
from backend.scoring.configuration import Stage1ScoringModel
from backend.strategies import build_strategy_registry
from scripts.run_stage2_cofire import _proposal_payload, require_evaluation_policy


REPO_ROOT = Path(__file__).resolve().parents[2]
CURRENT_MEMBERSHIP = {
    "A": (1, 2, 10),
    "B": (3, 4, 9, 12, 13),
    "C": (5, 6, 14, 15, 16),
    "D1": (8,),
    "D2": (7, 11),
    "E": (17, 18, 19, 21, 22),
    "F": (20,),
    "G": (24, 25, 26),
    "H": (23, 27, 28),
}
UTC = timezone.utc


def _bar(moment: datetime, close: float = 100.0) -> Candle:
    return Candle(
        time=moment,
        open=close,
        high=close + 1.0,
        low=close - 1.0,
        close=close,
        tick_volume=100,
        spread=1,
    )


def _result(
    module_id: int,
    direction: Direction = Direction.NONE,
    score: float = 0.0,
) -> StrategyResult:
    return StrategyResult(
        module_id=module_id,
        module_name=f"M{module_id:02d}",
        fired=direction is not Direction.NONE,
        direction=direction,
        score=score,
        evidence={},
    )


def _evaluated(
    regime: Regime,
    firing: dict[int, tuple[Direction, float]] | None = None,
) -> EvaluatedObservation:
    firing = firing or {}
    opened = datetime(2026, 1, 1, tzinfo=UTC)
    return EvaluatedObservation(
        symbol="TEST",
        bar_time=opened,
        close_time=opened + timeframe_delta(Timeframe.M15),
        cofire=CofireObservation(
            regime=regime,
            results=tuple(
                _result(module_id, *firing.get(module_id, (Direction.NONE, 0.0)))
                for module_id in MODULE_IDS
            ),
        ),
    )


def test_latest_closed_h1_attachment_uses_equal_close_but_not_future_close():
    opened = datetime(2026, 1, 1, tzinfo=UTC)
    bars = (
        _bar(opened + timedelta(minutes=30)),
        _bar(opened + timedelta(minutes=45)),
        _bar(opened + timedelta(minutes=60)),
    )
    regimes = (
        EffectiveRegime(
            close_time=opened + timedelta(hours=1),
            regime=Regime.RANGING,
        ),
        EffectiveRegime(
            close_time=opened + timedelta(hours=2),
            regime=Regime.TRENDING_BULLISH,
        ),
    )
    assert attach_latest_closed_regimes(bars, regimes) == (
        None,
        Regime.RANGING,
        Regime.RANGING,
    )


def test_pairwise_artifacts_label_zero_denominator_phi_rows_degenerate():
    analysis = analyse_cofiring(
        [],
        CURRENT_MEMBERSHIP,
        minimum_module_fires=30,
        target_cluster_count=9,
        weight_total=100,
    )
    overall, by_regime = pairwise_artifacts(analysis)
    assert overall["rows"][0]["degenerate"] is True
    assert overall["matrices"]["phi"][0][1] == 0.0
    assert overall["matrices"]["degenerate"][0][1] is True
    assert overall["matrices"]["phi"][0][0] is None
    assert (
        by_regime["regimes"][Regime.VOLATILE_NEWS.value]["rows"][0][
            "degenerate"
        ]
        is True
    )


def test_neutral_proposal_does_not_silently_inherit_regime_cluster_ids():
    config = Config.load(REPO_ROOT / "config")
    current = Stage1ScoringModel.from_config(config)
    analysis = analyse_cofiring(
        [],
        CURRENT_MEMBERSHIP,
        minimum_module_fires=30,
        target_cluster_count=9,
        weight_total=100,
    )
    clusters = neutral_cluster_proposals(analysis, weight_total=100)
    reachability = neutral_reachability_artifact(
        config=config,
        clusters=clusters,
    )
    assert [cluster.proposal_label for cluster in clusters] == [
        f"P{index:02d}" for index in range(1, 10)
    ]
    assert sum(cluster.weight for cluster in clusters) == 100
    assert reachability["denominator"] == 100
    assert reachability["status"].startswith("PRE_HTF_UNRESTRICTED")
    with pytest.raises(ValueError, match="not authorized"):
        proposal_registry(current, analysis.clusters)


def test_proposal_provenance_binds_manifest_and_verified_source_content():
    config = Config.load(REPO_ROOT / "config")
    analysis = analyse_cofiring(
        [],
        CURRENT_MEMBERSHIP,
        minimum_module_fires=30,
        target_cluster_count=9,
        weight_total=100,
    )
    clusters = neutral_cluster_proposals(analysis, weight_total=100)

    proposal = _proposal_payload(
        analysis=analysis,
        neutral_clusters=clusters,
        config=config,
        policy="FULL_PREFIX",
        observations=[],
        source_manifest_sha256="a" * 64,
        source_content_sha256="b" * 64,
    )

    assert proposal["source_manifest_sha256"] == "a" * 64
    assert proposal["source_content_sha256"] == "b" * 64


def test_pre_htf_ingredients_emit_both_sides_without_gating_or_penalty_claims():
    config = Config.load(REPO_ROOT / "config")
    analysis = analyse_cofiring(
        [],
        CURRENT_MEMBERSHIP,
        minimum_module_fires=30,
        target_cluster_count=9,
        weight_total=100,
    )
    clusters = neutral_cluster_proposals(analysis, weight_total=100)
    observation = _evaluated(
        Regime.RANGING,
        {
            1: (Direction.BUY, 80.0),
            3: (Direction.BUY, 90.0),
            5: (Direction.BUY, 95.0),
            20: (Direction.SELL, 90.0),
        },
    )
    rows = pre_htf_score_ingredients(
        observations=[observation],
        config=config,
        clusters=clusters,
    )
    assert [row["direction"] for row in rows] == ["BUY", "SELL"]
    assert len(rows[0]["agreeing_neutral_clusters"]) == 3
    assert rows[0]["regime_gating_applied"] is False
    assert rows[0]["htf_penalty_applied"] is None
    assert len(rows[1]["agreeing_neutral_clusters"]) == 1
    distribution = score_ingredient_summary(rows)
    assert distribution["candidate_rows"] == 2
    assert distribution["status"].endswith("NOT_REALISED_STAGE1")


def test_cli_fails_closed_before_selecting_unapproved_evaluation_window():
    config = Config.load(REPO_ROOT / "config")
    with pytest.raises(SystemExit, match="evaluation-window semantics"):
        require_evaluation_policy(config)


def test_full_prefix_batch_matches_direct_strategy_evaluation_on_recorded_fixture():
    """The exact batch path must remain equivalent to the existing API."""

    config = Config.load(REPO_ROOT / "config")
    period_name, raw_period = next(
        iter(config.section("backtest.fixtures.periods").items())
    )
    fixture_root = Path(config.get("engine.paths.fixtures"))
    if not fixture_root.is_absolute():
        fixture_root = REPO_ROOT / fixture_root
    start = datetime.fromisoformat(str(raw_period["start"]).replace("Z", "+00:00"))
    end = datetime.fromisoformat(str(raw_period["end"]).replace("Z", "+00:00"))
    store = ParquetBarStore.from_config(config, root=fixture_root / period_name)
    record = store.symbol_record(str(raw_period["symbols"][0]))
    all_bars = store.bars(record.resolved_name, Timeframe.M15, start, end)
    strategies = build_strategy_registry(config)
    stop = max(strategy.min_bars for strategy in strategies) + 2
    bars = all_bars[:stop]
    regimes = [Regime.RANGING] * len(bars)

    batch = evaluate_full_prefix_population(
        symbol=record.resolved_name,
        bars=bars,
        spec=record.spec,
        strategies=strategies,
        regimes=regimes,
    )
    start_index = max(strategy.min_bars for strategy in strategies) - 1
    assert len(batch) == len(bars) - start_index
    for offset, observation in enumerate(batch):
        index = start_index + offset
        direct = tuple(
            strategy.evaluate(list(bars[: index + 1]), record.spec)
            for strategy in strategies
        )
        assert tuple(
            (
                result.module_id,
                result.fired,
                result.direction,
                result.score,
            )
            for result in observation.cofire.results
        ) == tuple(
            (
                result.module_id,
                result.fired,
                result.direction,
                result.score,
            )
            for result in direct
        )


def test_declared_lookback_is_not_equivalent_to_existing_full_prefix_semantics():
    """The policy refusal is backed by a recorded-fixture signal divergence."""

    config = Config.load(REPO_ROOT / "config")
    period = config.section("backtest.fixtures.periods")["trending"]
    fixture_root = Path(config.get("engine.paths.fixtures"))
    if not fixture_root.is_absolute():
        fixture_root = REPO_ROOT / fixture_root
    start = datetime.fromisoformat(str(period["start"]).replace("Z", "+00:00"))
    end = datetime.fromisoformat(str(period["end"]).replace("Z", "+00:00"))
    store = ParquetBarStore.from_config(config, root=fixture_root / "trending")
    record = store.symbol_record(str(period["symbols"][0]))
    bars = store.bars(record.resolved_name, Timeframe.M15, start, end)
    macd = build_strategy_registry(config)[18]

    full_prefix = macd.evaluate(list(bars), record.spec)
    declared_lookback = macd.evaluate(list(bars[-macd.min_bars :]), record.spec)

    assert full_prefix.fired is False
    assert full_prefix.direction is Direction.NONE
    assert declared_lookback.fired is True
    assert declared_lookback.direction is Direction.SELL
