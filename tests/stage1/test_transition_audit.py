"""Deterministic checks for the read-only Stage 1 transition evidence audit."""

from __future__ import annotations

from scripts.audit_stage1_transitions import (
    AuditVerdict,
    assess_price,
    independent_hysteresis_step,
    independent_raw,
    segment_bounds,
)


PARAMS = {
    "atr_percentile_volatile_above": 90.0,
    "r_squared_trend_above": 0.60,
    "atr_percentile_range_below": 60.0,
    "adx_trend_enter": 27.0,
    "adx_trend_exit": 22.0,
    "adx_range_enter": 20.0,
    "adx_range_exit": 25.0,
    "regime_confirm_bars": 3,
    "transitional_exempt_from_confirmation": True,
}


def row(
    *,
    adx: float = 30.0,
    atr_percentile: float = 50.0,
    r_squared: float = 0.8,
    aligned: bool = True,
    bullish: bool = True,
    news: bool = False,
) -> dict:
    return {
        "adx": adx,
        "atr_percentile": atr_percentile,
        "r_squared": r_squared,
        "ema_stack_aligned": aligned,
        "ema_stack_bullish": bullish,
        "within_news_blackout": news,
    }


def test_independent_raw_preserves_ordered_news_and_volatility_priority():
    textbook_bull = row(news=True)
    assert independent_raw(textbook_bull, PARAMS) == "VOLATILE_NEWS"

    volatility_wins = row(atr_percentile=91.0)
    assert independent_raw(volatility_wins, PARAMS) == "VOLATILE_NEWS"


def test_independent_raw_covers_trend_range_and_transitional_branches():
    assert independent_raw(row(), PARAMS) == "TRENDING_BULLISH"
    assert independent_raw(row(bullish=False), PARAMS) == "TRENDING_BEARISH"
    assert (
        independent_raw(
            row(adx=19.0, atr_percentile=59.0, r_squared=0.1, aligned=False),
            PARAMS,
        )
        == "RANGING"
    )
    assert (
        independent_raw(
            row(adx=24.0, atr_percentile=50.0, r_squared=0.1, aligned=False),
            PARAMS,
        )
        == "TRANSITIONAL"
    )


def test_independent_hysteresis_requires_three_closed_bars():
    previous = AuditVerdict("RANGING", 1.0, 8, None, 0)
    trend_row = row()

    first = independent_hysteresis_step(
        previous, "TRENDING_BULLISH", trend_row, PARAMS
    )
    second = independent_hysteresis_step(
        first, "TRENDING_BULLISH", trend_row, PARAMS
    )
    third = independent_hysteresis_step(
        second, "TRENDING_BULLISH", trend_row, PARAMS
    )

    assert (first.regime, first.confidence, first.pending_bars) == (
        "RANGING",
        2 / 3,
        1,
    )
    assert (second.regime, second.confidence, second.pending_bars) == (
        "RANGING",
        1 / 3,
        2,
    )
    assert (third.regime, third.confidence, third.bars_in_regime) == (
        "TRENDING_BULLISH",
        1.0,
        1,
    )


def test_independent_hysteresis_holds_adx_only_dead_band_but_not_uncertainty():
    previous = AuditVerdict("TRENDING_BULLISH", 1.0, 12, None, 0)

    held = independent_hysteresis_step(
        previous,
        "TRANSITIONAL",
        row(adx=24.0),
        PARAMS,
    )
    uncertain = independent_hysteresis_step(
        previous,
        "TRANSITIONAL",
        row(adx=24.0, aligned=False),
        PARAMS,
    )

    assert held.regime == "TRENDING_BULLISH"
    assert held.bars_in_regime == 13
    assert uncertain.regime == "TRANSITIONAL"
    assert uncertain.bars_in_regime == 1


def test_segment_bounds_include_one_bar_and_sustained_segments():
    rows = [
        {"regime": "TRANSITIONAL"},
        {"regime": "TRANSITIONAL"},
        {"regime": "RANGING"},
        {"regime": "TRANSITIONAL"},
        {"regime": "TRANSITIONAL"},
        {"regime": "TRANSITIONAL"},
    ]
    assert segment_bounds(rows) == [(0, 1), (2, 2), (3, 5)]


def test_price_triage_is_diagnostic_and_transitional_is_not_scored():
    supportive_bull = {
        "status": "READY",
        "net_move_range_units": 1.2,
        "path_efficiency": 0.8,
        "median_bar_range_ratio": 1.0,
        "maximum_bar_range_ratio": 1.2,
    }
    opposing_bull = {**supportive_bull, "net_move_range_units": -0.8}

    assert (
        assess_price("TRENDING_BULLISH", 5, supportive_bull)["status"]
        == "SUPPORTIVE"
    )
    assert (
        assess_price("TRENDING_BULLISH", 5, opposing_bull)["status"]
        == "CONTRADICTORY"
    )
    assert (
        assess_price("TRANSITIONAL", 5, supportive_bull)["status"]
        == "NOT_SCORED"
    )
