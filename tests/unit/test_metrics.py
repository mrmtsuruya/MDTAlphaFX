"""§11.4 — core metrics and result segmentation.

Every figure in the first block is computed by hand in the docstring, so a
regression in the arithmetic fails against a number nobody derived from the
implementation.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from backend.contracts import Direction, Timeframe
from backend.core.errors import ConfigError
from backend.core.timeutil import UTC
from backend.backtest.costs import TradeCosts
from backend.backtest.intrabar import ResolutionPath
from backend.backtest.metrics import (
    DIMENSIONS,
    build_report,
    compute_core,
    segment,
)
from backend.backtest.replay import (
    RunResult,
    SimulatedTrade,
    SkipReason,
    SkippedSignal,
    TerminalReason,
)
from tests.doubles import TEST_SYMBOL, make_test_config

T0 = datetime(2026, 3, 2, 8, 0, tzinfo=UTC)

NO_COSTS = TradeCosts(
    spread_points_entry=0,
    spread_points_exit=0,
    spread_price_entry=0.0,
    spread_price_exit=0.0,
    slippage_price_entry=0.0,
    slippage_price_exit=0.0,
    commission_ccy=0.0,
    swap_ccy=0.0,
    rollover_nights=0,
    triple_nights=0,
)


def trade(
    net_r: float,
    *,
    index: int = 0,
    path: ResolutionPath = ResolutionPath.UNAMBIGUOUS,
    sessions: tuple[str, ...] = ("london",),
    timeframe: Timeframe = Timeframe.M15,
    terminal: TerminalReason | None = None,
) -> SimulatedTrade:
    moment = T0 + timedelta(minutes=15 * index)
    if terminal is None:
        terminal = TerminalReason.TARGET if net_r > 0 else TerminalReason.STOP
    return SimulatedTrade(
        trade_id=f"T{index}",
        symbol=TEST_SYMBOL,
        timeframe=timeframe,
        module_id=0,
        module_name="SCRIPTED",
        direction=Direction.BUY,
        signal_bar_time=moment,
        entry_time=moment,
        entry_price=2000.0,
        stop_loss=1998.0,
        take_profit=2004.0,
        volume=0.1,
        exit_time=moment + timedelta(minutes=15),
        exit_price=2000.0 + net_r,
        terminal_reason=terminal,
        resolution_path=path,
        ambiguous_fill=path.is_fallback,
        gapped_exit=False,
        resolution_detail="",
        bars_held=1,
        sessions=sessions,
        risk_price=2.0,
        gross_r=net_r,
        commission_r=0.0,
        swap_r=0.0,
        net_r=net_r,
        gross_pnl_ccy=net_r * 10.0,
        net_pnl_ccy=net_r * 10.0,
        costs=NO_COSTS,
    )


def result_for(trades, skipped=()):
    return RunResult(
        symbol=TEST_SYMBOL,
        timeframe=Timeframe.M15,
        start=T0,
        end=T0 + timedelta(days=1),
        bars_evaluated=len(trades) + 10,
        volume=0.1,
        config_version="test",
        module_id=0,
        module_name="SCRIPTED",
        trades=tuple(trades),
        skipped=tuple(skipped),
    )


# ================================================ hand-computed core metrics


HAND_SET = [+2.0, -1.0, +1.0, -1.0, -1.0, +3.0]
"""Six trades, worked out by hand:

    count            6
    wins             3   (+2, +1, +3)
    losses           3   (-1, -1, -1)
    win rate         3/6                       = 0.5
    sum of R         2-1+1-1-1+3               = 3.0
    expectancy       3.0 / 6                   = 0.5 R
    gross profit     2+1+3                     = 6.0 R
    gross loss       1+1+1                     = 3.0 R
    profit factor    6.0 / 3.0                 = 2.0
    equity curve     2, 1, 2, 1, 0, 3
    running peak     2, 2, 2, 2, 2, 3
    drawdown         0, 1, 0, 1, 2, 0
    max drawdown                               = 2.0 R
    losing streaks   1, then 2                 -> longest = 2
"""


def test_core_metrics_match_the_hand_computation():
    metrics = compute_core([trade(r, index=i) for i, r in enumerate(HAND_SET)])

    assert metrics.trade_count == 6
    assert metrics.wins == 3
    assert metrics.losses == 3
    assert metrics.win_rate == pytest.approx(0.5)
    assert metrics.expectancy_r == pytest.approx(0.5)
    assert metrics.gross_profit_r == pytest.approx(6.0)
    assert metrics.gross_loss_r == pytest.approx(3.0)
    assert metrics.profit_factor == pytest.approx(2.0)
    assert metrics.max_drawdown_r == pytest.approx(2.0)
    assert metrics.longest_losing_streak == 2


def test_drawdown_is_measured_from_the_running_peak():
    """A curve that ends higher than it started still has a drawdown, and a
    metric that only looks at the endpoints would miss it."""
    metrics = compute_core(
        [trade(r, index=i) for i, r in enumerate([+5.0, -3.0, -1.0, +6.0])]
    )
    assert metrics.max_drawdown_r == pytest.approx(4.0)
    assert metrics.expectancy_r == pytest.approx(1.75)


def test_profit_factor_is_none_with_no_losses():
    """Not `inf`, not a big number. An undefined ratio printed as a number is
    read as a very good one."""
    metrics = compute_core([trade(1.0, index=0), trade(2.0, index=1)])
    assert metrics.profit_factor is None
    assert metrics.gross_loss_r == 0.0


def test_an_empty_trade_set_is_not_a_division_by_zero():
    metrics = compute_core([])
    assert metrics.trade_count == 0
    assert metrics.expectancy_r == 0.0
    assert metrics.profit_factor is None
    assert metrics.ambiguity_rate == 0.0


def test_a_scratch_is_neither_a_win_nor_a_loss():
    metrics = compute_core([trade(0.0, index=0), trade(1.0, index=1)])
    assert (metrics.wins, metrics.losses, metrics.scratches) == (1, 0, 1)
    assert metrics.win_rate == pytest.approx(0.5)


# ============================================================ ambiguity rate


def test_ambiguity_rate_counts_both_causes_separately():
    """§11.1's two fallbacks have different remedies, so the report keeps them
    apart while still summing them into one rate."""
    trades = [
        trade(1.0, index=0),
        trade(-1.0, index=1, path=ResolutionPath.FALLBACK_NO_M1),
        trade(-1.0, index=2, path=ResolutionPath.FALLBACK_IRREDUCIBLE),
        trade(1.0, index=3),
    ]
    metrics = compute_core(trades)
    assert metrics.ambiguous_no_m1 == 1
    assert metrics.ambiguous_irreducible == 1
    assert metrics.ambiguity_rate == pytest.approx(0.5)


def test_a_sub_bar_walk_is_not_ambiguity():
    """Over-flagging inflates the rate and makes a sound curve look like an
    artefact."""
    metrics = compute_core(
        [trade(1.0, index=i, path=ResolutionPath.SUB_BAR_WALK) for i in range(4)]
    )
    assert metrics.ambiguity_rate == 0.0


def test_report_states_the_curve_is_a_lower_bound_above_the_warn_rate(tmp_path):
    config = make_test_config(tmp_path, {"backtest.intrabar.ambiguity_rate_warn": 0.05})
    trades = [trade(1.0, index=i) for i in range(9)]
    trades.append(trade(-1.0, index=9, path=ResolutionPath.FALLBACK_NO_M1))
    text = build_report(result_for(trades), config).render()

    assert "10.00%" in text
    assert "LOWER BOUND, NOT AN ESTIMATE" in text


def test_report_does_not_cry_wolf_below_the_warn_rate(tmp_path):
    config = make_test_config(tmp_path, {"backtest.intrabar.ambiguity_rate_warn": 0.05})
    text = build_report(
        result_for([trade(1.0, index=i) for i in range(40)]), config
    ).render()
    assert "LOWER BOUND" not in text
    assert "ambiguity rate" in text


def test_ambiguity_appears_before_the_equity_figures(tmp_path):
    """§11.1 requires the caveat reported with every result. A caveat printed
    after the number it qualifies is a caveat nobody reads."""
    config = make_test_config(tmp_path)
    text = build_report(
        result_for([trade(1.0, index=i) for i in range(40)]), config
    ).render()
    assert text.index("AMBIGUITY") < text.index("expectancy per trade")


# ========================================================= the trade-count gate


def test_a_segment_under_the_floor_has_no_metrics_object(tmp_path):
    """§11.4: "any segment under ~30 trades is reported with its count and no
    conclusions." Structural: there is no field holding a suppressed number, so
    a caller cannot render one by accident."""
    dimension = next(d for d in DIMENSIONS if d.name == "session")
    trades = [trade(1.0, index=i, sessions=("london",)) for i in range(29)]
    report = segment(trades, dimension, 30)

    assert len(report.segments) == 1
    london = report.segments[0]
    assert london.trade_count == 29
    assert london.metrics is None
    assert london.conclusions_permitted is False
    assert "below the 30-trade floor" in london.suppressed_reason


def test_a_segment_at_the_floor_reports_metrics(tmp_path):
    dimension = next(d for d in DIMENSIONS if d.name == "session")
    trades = [trade(1.0, index=i, sessions=("london",)) for i in range(30)]
    london = segment(trades, dimension, 30).segments[0]
    assert london.conclusions_permitted is True
    assert london.metrics is not None
    assert london.metrics.trade_count == 30


def test_the_floor_is_read_from_config(tmp_path):
    dimension = next(d for d in DIMENSIONS if d.name == "session")
    trades = [trade(1.0, index=i) for i in range(10)]
    assert segment(trades, dimension, 5).segments[0].metrics is not None
    assert segment(trades, dimension, 50).segments[0].metrics is None


def test_a_suppressed_segment_prints_no_numbers(tmp_path):
    """The suppression has to survive rendering, or the structural guarantee is
    decorative."""
    config = make_test_config(tmp_path, {"backtest.metrics.min_segment_trades": 30})
    trades = [trade(2.0, index=i, sessions=("london",)) for i in range(5)]
    text = build_report(result_for(trades), config).render()

    session_block = text.split("session  [")[1]
    assert "n=5" in session_block
    assert "E=+" not in session_block
    assert "no conclusions" in session_block.lower()


def test_the_overall_figure_is_labelled_when_below_the_floor(tmp_path):
    config = make_test_config(tmp_path, {"backtest.metrics.min_segment_trades": 30})
    report = build_report(result_for([trade(1.0, index=i) for i in range(5)]), config)
    assert report.overall_conclusions_permitted is False
    assert "below the 30-trade floor" in report.render()


# =============================================================== segmentation


def test_stage_one_dimensions_are_named_and_empty(tmp_path):
    """§11.4 asks for six axes. Stage 0 can honestly fill two. The other four
    are declared unavailable with the section and stage that supply them —
    fabricating a regime label would be worse than admitting there isn't one."""
    config = make_test_config(tmp_path)
    report = build_report(
        result_for([trade(1.0, index=i) for i in range(40)]), config
    )
    by_name = {d.dimension.name: d for d in report.dimensions}

    assert set(by_name) == {
        "regime",
        "score_decile",
        "cluster_breadth",
        "contested",
        "timeframe",
        "session",
    }
    for name in ("regime", "score_decile", "cluster_breadth", "contested"):
        assert by_name[name].dimension.available is False
        assert by_name[name].segments == ()
        assert by_name[name].dimension.stage == "Stage 1"

    text = report.render()
    assert "regime  [§11.4 / §3]  — UNAVAILABLE (Stage 1)" in text


def test_stage_zero_dimensions_are_populated(tmp_path):
    config = make_test_config(tmp_path, {"backtest.metrics.min_segment_trades": 1})
    trades = [
        trade(1.0, index=i, timeframe=Timeframe.M15, sessions=("london",))
        for i in range(3)
    ]
    report = build_report(result_for(trades), config)
    by_name = {d.dimension.name: d for d in report.dimensions}

    assert [s.key for s in by_name["timeframe"].segments] == ["M15"]
    assert [s.key for s in by_name["session"].segments] == ["london"]


def test_an_overlapping_trade_counts_in_both_sessions(tmp_path):
    """A London/New York bar belongs to both populations. Forcing it into one
    would make the segments disjoint by fiat rather than by fact."""
    dimension = next(d for d in DIMENSIONS if d.name == "session")
    trades = [trade(1.0, index=i, sessions=("london", "new_york")) for i in range(4)]
    report = segment(trades, dimension, 1)

    keys = {s.key: s.trade_count for s in report.segments}
    assert keys == {"london": 4, "new_york": 4}


def test_a_trade_outside_every_session_is_labelled_not_dropped(tmp_path):
    dimension = next(d for d in DIMENSIONS if d.name == "session")
    report = segment([trade(1.0, sessions=())], dimension, 1)
    assert [s.key for s in report.segments] == ["NO_SESSION"]


def test_segment_keys_are_deterministically_ordered(tmp_path):
    dimension = next(d for d in DIMENSIONS if d.name == "session")
    trades = [
        trade(1.0, index=0, sessions=("tokyo",)),
        trade(1.0, index=1, sessions=("london",)),
        trade(1.0, index=2, sessions=("new_york",)),
    ]
    keys = [s.key for s in segment(trades, dimension, 1).segments]
    assert keys == sorted(keys)


def test_an_unknown_segmentation_axis_refuses(tmp_path):
    """A config naming an axis the code has no extractor for is a mismatch, not
    something to skip quietly."""
    config = make_test_config(
        tmp_path, {"backtest.metrics.segment_by": ["timeframe", "moon_phase"]}
    )
    with pytest.raises(ConfigError, match="moon_phase"):
        build_report(result_for([trade(1.0)]), config)


def test_only_the_configured_axes_are_reported(tmp_path):
    config = make_test_config(tmp_path, {"backtest.metrics.segment_by": ["timeframe"]})
    report = build_report(result_for([trade(1.0)]), config)
    assert [d.dimension.name for d in report.dimensions] == ["timeframe"]


# ================================================================ exclusions


def test_data_end_trades_are_excluded_from_every_figure(tmp_path):
    config = make_test_config(tmp_path, {"backtest.metrics.min_segment_trades": 1})
    trades = [
        trade(1.0, index=0),
        trade(-1.0, index=1),
        trade(5.0, index=2, terminal=TerminalReason.DATA_END),
    ]
    report = build_report(result_for(trades), config)

    assert report.overall.trade_count == 2
    assert report.overall.expectancy_r == pytest.approx(0.0)
    assert report.unresolved_at_data_end == 1


def test_skipped_signals_are_counted_in_the_report(tmp_path):
    """§10.2: "Near-misses are logged too." Without these the report cannot tell
    a strategy that never fires from one whose every fill would be refused."""
    config = make_test_config(tmp_path)
    skipped = [
        SkippedSignal(
            signal_bar_time=T0,
            direction=Direction.BUY,
            reason=SkipReason.FILL_REJECTED,
            detail="MAX_SPREAD",
        ),
        SkippedSignal(
            signal_bar_time=T0,
            direction=Direction.BUY,
            reason=SkipReason.FILL_REJECTED,
            detail="MAX_SPREAD",
        ),
    ]
    report = build_report(result_for([trade(1.0)], skipped), config)
    assert report.skipped_counts == (("FILL_REJECTED", 2),)
    assert "signals skipped: FILL_REJECTED" in report.render()


def test_the_report_carries_what_a_backtest_cannot_tell_you(tmp_path):
    """§11.5: "Stated in the UI, not just here, because the number will be
    believed"."""
    config = make_test_config(tmp_path)
    text = build_report(result_for([trade(1.0)]), config).render()
    assert "WHAT THIS CANNOT TELL YOU (§11.5)" in text
    assert "recorded, not guaranteed" in text
