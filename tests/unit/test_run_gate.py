"""Offline regression tests for the Stage 0 operator-facing gate."""

from __future__ import annotations

from datetime import datetime, timedelta

from backend.contracts import Timeframe
from backend.core.timeutil import UTC
from backend.data.store import ParquetBarStore
from scripts.run_gate import GATE_1_OVERRIDES, gate_1_recorded
from tests.doubles import (
    TEST_SYMBOL,
    expand_to_m1,
    make_test_config,
    spec_for_tests,
    zigzag_series,
)


FIXTURE_START = datetime(2026, 3, 2, 8, 0, tzinfo=UTC)
FIXTURE_END = FIXTURE_START + timedelta(days=1)


def _gate_config(
    tmp_path,
    *,
    symbols: tuple[str, ...] = (TEST_SYMBOL,),
    start: datetime = FIXTURE_START,
    end: datetime = FIXTURE_END,
):
    overrides = dict(GATE_1_OVERRIDES)
    for period in ("trending", "ranging", "high_volatility"):
        overrides[f"backtest.fixtures.periods.{period}.start"] = (
            start.isoformat()
        )
        overrides[f"backtest.fixtures.periods.{period}.end"] = end.isoformat()
        overrides[f"backtest.fixtures.periods.{period}.symbols"] = list(symbols)
    for symbol in symbols:
        overrides[f"costs.commission.per_lot_per_side.{symbol}"] = 3.0
        overrides[f"symbols.max_spread_points.{symbol}"] = 500
    return make_test_config(tmp_path, overrides)


def _write_recorded_period(
    config,
    period: str,
    *,
    symbol: str = TEST_SYMBOL,
    start: datetime = FIXTURE_START,
    h4_start: datetime | None = None,
    drop_internal_m1: bool = False,
    spread: int = 20,
) -> None:
    """Create one self-contained recorder-shaped Parquet store."""
    root = config.source_dir.parent / "fixtures" / period
    store = ParquetBarStore.from_config(config, root=root)
    spec = spec_for_tests(name=symbol)
    store.write_symbol_meta(
        spec,
        requested_name=symbol,
        swap_long=-1.0,
        swap_short=-2.0,
        server_offset_minutes=180,
        account_server="Offline-Test",
    )

    m15 = zigzag_series(
        start,
        Timeframe.M15,
        base=2000.0,
        leg_bars=8,
        step=0.5,
        cycles=6,
        half_range=0.10,
        spread=spread,
    )
    store.write_bars(symbol, Timeframe.M15, m15)
    m1 = expand_to_m1(m15, Timeframe.M15)
    if drop_internal_m1:
        del m1[len(m1) // 2]
    store.write_bars(symbol, Timeframe.M1, m1)

    series_shapes = {
        Timeframe.H4: (3, 1),
        Timeframe.H1: (4, 3),
        Timeframe.M5: (8, 18),
    }
    for timeframe, (leg_bars, cycles) in series_shapes.items():
        series_start = h4_start if timeframe is Timeframe.H4 and h4_start else start
        store.write_bars(
            symbol,
            timeframe,
            zigzag_series(
                series_start,
                timeframe,
                base=2000.0,
                leg_bars=leg_bars,
                step=0.5,
                cycles=cycles,
                half_range=0.10,
                spread=spread,
            ),
        )


def test_empty_and_junk_period_directories_do_not_count(tmp_path):
    config = _gate_config(tmp_path)
    fixtures = tmp_path / "fixtures"
    for period in config.section("backtest.fixtures.periods"):
        directory = fixtures / period
        directory.mkdir(parents=True)
        (directory / "not-a-store.txt").write_text("junk", encoding="utf-8")

    qualification = gate_1_recorded(config)

    assert not qualification.complete
    assert qualification.runs == ()
    assert len(qualification.rejected) == len(qualification.expected_periods)
    assert all(
        "no readable symbol metadata" in reason
        for _period, reason in qualification.rejected
    )


def test_only_all_configured_periods_with_successful_replays_remove_synthetic(
    tmp_path,
):
    config = _gate_config(tmp_path)
    periods = tuple(config.section("backtest.fixtures.periods"))

    _write_recorded_period(config, periods[0])
    partial = gate_1_recorded(config)
    assert not partial.complete
    assert [run.period for run in partial.runs] == [periods[0]]

    for period in periods[1:]:
        _write_recorded_period(config, period)

    complete = gate_1_recorded(config)
    assert complete.complete
    assert [run.period for run in complete.runs] == list(periods)
    assert complete.rejected == ()
    assert all(run.symbol == TEST_SYMBOL for run in complete.runs)
    assert all(run.timeframe is Timeframe.M15 for run in complete.runs)
    assert all(run.rendered_report.strip() for run in complete.runs)


def test_zero_trade_period_qualifies_when_recorded_set_has_trades(tmp_path):
    """§9's trade/report gate applies to history overall, not every regime.

    §11.4 explicitly reports a zero-trade sample with no conclusions. A
    high-spread period that rejects every fill is therefore evidence that the
    broker-constraint gate worked, not a reason to discard a complete store.
    """
    config = _gate_config(tmp_path)
    periods = tuple(config.section("backtest.fixtures.periods"))
    _write_recorded_period(config, periods[0])
    _write_recorded_period(config, periods[1])
    _write_recorded_period(config, periods[2], spread=501)

    qualification = gate_1_recorded(config)

    assert qualification.complete
    assert qualification.total_trade_count > 0
    zero_trade_run = next(
        run for run in qualification.runs if run.period == periods[2]
    )
    assert zero_trade_run.trade_count == 0
    assert "NO CONCLUSIONS (§11.4)" in zero_trade_run.summary
    assert "trade count                      0" in zero_trade_run.rendered_report
    assert "below the 30-trade floor" in zero_trade_run.rendered_report


def test_all_zero_trade_periods_do_not_close_recorded_history_gate(tmp_path):
    config = _gate_config(tmp_path)
    periods = tuple(config.section("backtest.fixtures.periods"))
    for period in periods:
        _write_recorded_period(config, period, spread=501)

    qualification = gate_1_recorded(config)

    assert qualification.all_periods_qualified
    assert qualification.total_trade_count == 0
    assert not qualification.complete
    assert qualification.aggregate_failure is not None
    assert "zero trades in aggregate" in qualification.aggregate_failure


def test_directory_missing_required_timeframe_does_not_count(tmp_path):
    config = _gate_config(tmp_path)
    period = next(iter(config.section("backtest.fixtures.periods")))
    root = tmp_path / "fixtures" / period
    store = ParquetBarStore.from_config(config, root=root)
    store.write_symbol_meta(
        spec_for_tests(),
        requested_name=TEST_SYMBOL,
        swap_long=-1.0,
        swap_short=-2.0,
    )
    bars = zigzag_series(
        FIXTURE_START,
        Timeframe.M15,
        base=2000.0,
        leg_bars=8,
        step=0.5,
        cycles=6,
        half_range=0.10,
    )
    store.write_bars(TEST_SYMBOL, Timeframe.M15, bars)

    qualification = gate_1_recorded(config)

    assert not qualification.complete
    rejection = dict(qualification.rejected)[period]
    assert "missing required recorded timeframe" in rejection
    assert "M1" in rejection


def test_stale_out_of_window_bars_cannot_qualify_a_period(tmp_path):
    config = _gate_config(tmp_path)
    period = next(iter(config.section("backtest.fixtures.periods")))
    _write_recorded_period(
        config,
        period,
        start=FIXTURE_START - timedelta(days=7),
    )

    qualification = gate_1_recorded(config)

    assert not qualification.complete
    assert qualification.runs == ()
    rejection = dict(qualification.rejected)[period]
    assert "does not span configured half-open window" in rejection
    assert FIXTURE_START.isoformat() in rejection
    assert FIXTURE_END.isoformat() in rejection


def test_coarser_timeframe_may_start_at_its_next_aligned_open(tmp_path):
    start = FIXTURE_START + timedelta(hours=1)
    end = FIXTURE_END + timedelta(hours=1)
    config = _gate_config(tmp_path, start=start, end=end)
    period = next(iter(config.section("backtest.fixtures.periods")))
    _write_recorded_period(
        config,
        period,
        start=start,
        h4_start=start + timedelta(hours=3),
    )

    qualification = gate_1_recorded(config)

    assert qualification.completed_periods == (period,)
    assert [(run.period, run.symbol) for run in qualification.runs] == [
        (period, TEST_SYMBOL)
    ]


def test_internal_m1_gap_qualifies_with_visible_conservative_fallback(tmp_path):
    """§11.1 explicitly defines fallback for gaps; completeness is not a gate."""
    config = _gate_config(tmp_path)
    period = next(iter(config.section("backtest.fixtures.periods")))
    _write_recorded_period(config, period, drop_internal_m1=True)

    qualification = gate_1_recorded(config)

    assert qualification.completed_periods == (period,)
    assert "1 missing minute(s) in 1 gap run(s)" in qualification.runs[0].summary
    assert "§11.1 fallback enabled" in qualification.runs[0].summary
    assert "ambiguity" in qualification.runs[0].summary


def test_every_period_symbol_must_qualify_not_only_the_first(tmp_path):
    symbols = (TEST_SYMBOL, "EURUSD")
    config = _gate_config(tmp_path, symbols=symbols)
    period = next(iter(config.section("backtest.fixtures.periods")))
    _write_recorded_period(config, period, symbol=TEST_SYMBOL)

    missing = gate_1_recorded(config)

    assert not missing.complete
    assert missing.runs == ()
    assert "missing expected recorded symbol" in dict(missing.rejected)[period]
    assert "EURUSD" in dict(missing.rejected)[period]

    _write_recorded_period(config, period, symbol="EURUSD")
    qualified_period = gate_1_recorded(config)

    assert not qualified_period.complete
    assert qualified_period.completed_periods == (period,)
    assert [(run.period, run.symbol) for run in qualified_period.runs] == [
        (period, TEST_SYMBOL),
        (period, "EURUSD"),
    ]
