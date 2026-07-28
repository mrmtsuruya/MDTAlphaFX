"""The bar-close replay engine — §9 Stage 0, §11.

Includes the other half of the Stage 0 gate: "a trivial strategy runs
end-to-end over history and produces a metrics report."
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta

import pytest

from backend.contracts import Candle, Direction, StrategyResult, Timeframe
from backend.core.errors import ConfigError, DataIntegrityError
from backend.core.timeutil import UTC, bar_close_time
from backend.backtest.broker_rules import RejectReason
from backend.backtest.intrabar import ResolutionPath
from backend.backtest.metrics import build_report
from backend.backtest.replay import (
    EVIDENCE_STOP_KEY,
    EVIDENCE_TARGET_KEY,
    ReplayEngine,
    RunSpec,
    SkipReason,
    TerminalReason,
)
from backend.strategies.trivial import NBarBreakout
from tests.doubles import (
    TEST_SYMBOL,
    InMemoryBarSource,
    candle,
    expand_to_m1,
    make_test_config,
    real_config,
    spec_for_tests,
    zigzag_series,
)

START = datetime(2026, 3, 2, 8, 0, tzinfo=UTC)
TF = Timeframe.M15


class ScriptedStrategy:
    """A `Strategy` that fires at chosen window lengths.

    It records the windows it was handed. That recording is a *test spy*, not a
    strategy behaviour — the value `evaluate` returns is still a pure function of
    its arguments, which is what rule 1 constrains.
    """

    module_id = 0
    module_name = "SCRIPTED (test double)"
    cluster_id = "NONE"

    def __init__(
        self,
        *,
        min_bars: int,
        fire_at_length: set[int],
        direction: Direction = Direction.BUY,
        stop: float | None = None,
        target: float | None = None,
        evidence: dict | None = None,
    ):
        self.min_bars = min_bars
        self._fire_at = fire_at_length
        self._direction = direction
        self._stop = stop
        self._target = target
        self._evidence = evidence
        self.window_lengths: list[int] = []
        self.last_bar_times: list[datetime] = []
        self.specs_seen: list[int] = []

    def evaluate(self, bars: list[Candle], spec) -> StrategyResult:
        self.window_lengths.append(len(bars))
        self.last_bar_times.append(bars[-1].time)
        self.specs_seen.append(id(spec))
        if len(bars) not in self._fire_at:
            return StrategyResult(
                module_id=self.module_id,
                module_name=self.module_name,
                fired=False,
                direction=Direction.NONE,
                score=0.0,
                evidence={},
            )
        evidence = self._evidence
        if evidence is None:
            evidence = {
                EVIDENCE_STOP_KEY: self._stop,
                EVIDENCE_TARGET_KEY: self._target,
            }
        return StrategyResult(
            module_id=self.module_id,
            module_name=self.module_name,
            fired=True,
            direction=self._direction,
            score=50.0,
            evidence=evidence,
        )


def flat_bars(
    count: int,
    *,
    price: float = 2000.00,
    spread: int = 20,
    highs: dict[int, float] | None = None,
    lows: dict[int, float] | None = None,
    opens: dict[int, float] | None = None,
    spreads: dict[int, int] | None = None,
) -> list[Candle]:
    """A flat series with per-index overrides, so a test can put exactly one
    interesting bar in an otherwise inert history."""
    bars = []
    for i in range(count):
        open_ = (opens or {}).get(i, price)
        high = (highs or {}).get(i, price)
        low = (lows or {}).get(i, price)
        bars.append(
            candle(
                START + timedelta(minutes=15 * i),
                open_,
                max(open_, high, price),
                min(open_, low, price),
                price,
                spread=(spreads or {}).get(i, spread),
            )
        )
    return bars


def source_for(bars, *, m1=None, spec=None):
    spec = spec or spec_for_tests()
    return InMemoryBarSource(spec, {TF: bars}, m1)


def run_spec(bars, **kwargs):
    return RunSpec(
        symbol=TEST_SYMBOL,
        timeframe=TF,
        start=bars[0].time,
        end=bar_close_time(bars[-1].time, TF),
        **kwargs,
    )


# ============================================================== THE GATE ====


def _gate_fixture(tmp_path):
    config = make_test_config(
        tmp_path,
        {
            "backtest.gate_strategy.lookback_bars": 3,
            "backtest.gate_strategy.stop_points": 100,
            "backtest.gate_strategy.target_points": 100,
            "costs.commission.per_lot_per_side.XAUUSD": 3.0,
            "costs.slippage.market_order_points": 5,
            "costs.slippage.stop_order_points": 5,
        },
    )
    bars = zigzag_series(
        START, TF, base=2000.0, leg_bars=10, step=0.5, cycles=40, half_range=0.10
    )
    source = source_for(bars, m1=expand_to_m1(bars, TF))
    return config, bars, source


def test_gate_trivial_strategy_runs_end_to_end_and_reports(tmp_path):
    """§9 Stage 0 gate: "a trivial strategy runs end-to-end over history and
    produces a metrics report"."""
    config, bars, source = _gate_fixture(tmp_path)
    strategy = NBarBreakout.from_config(config)
    result = ReplayEngine(config, source).run(strategy, run_spec(bars))

    assert result.bars_evaluated == len(bars) - strategy.min_bars + 1
    assert len(result.trades) > 30, "the fixture must clear §11.4's trade floor"
    assert {t.terminal_reason for t in result.trades} >= {
        TerminalReason.TARGET,
        TerminalReason.STOP,
    }, "a gate fixture with only winners proves nothing"

    report = build_report(result, config)
    text = report.render()
    assert "BACKTEST REPORT" in text
    assert "expectancy per trade" in text
    assert "ambiguity rate" in text
    assert report.overall_conclusions_permitted is True


def test_gate_run_is_deterministic_to_the_byte(tmp_path):
    """Same inputs, byte-identical output. §11.3's walk-forward comparison is
    meaningless if a rerun of the same window differs — the in-sample versus
    out-of-sample ratio would be measuring engine noise."""
    config, bars, source = _gate_fixture(tmp_path)
    engine = ReplayEngine(config, source)

    first = engine.run(NBarBreakout.from_config(config), run_spec(bars))
    second = engine.run(NBarBreakout.from_config(config), run_spec(bars))

    assert json.dumps(first.to_dict(), sort_keys=True) == json.dumps(
        second.to_dict(), sort_keys=True
    )


def test_a_second_engine_over_the_same_data_agrees(tmp_path):
    """Determinism must survive a fresh engine and a fresh source, not just a
    second call on a warm one."""
    config, bars, source = _gate_fixture(tmp_path)
    first = ReplayEngine(config, source).run(
        NBarBreakout.from_config(config), run_spec(bars)
    )
    second = ReplayEngine(config, source_for(bars, m1=expand_to_m1(bars, TF))).run(
        NBarBreakout.from_config(config), run_spec(bars)
    )
    assert first.to_dict() == second.to_dict()


# ================================================ refuses to run frictionless


def test_run_refuses_to_start_on_unresolved_costs(tmp_path):
    """§11.2. Any unresolved cost must refuse before walking bars."""
    bars = flat_bars(20)
    source = source_for(bars)
    engine = ReplayEngine(
        make_test_config(
            tmp_path,
            {"costs.slippage.market_order_points": "<OPERATOR DECISION>"},
        ),
        source,
    )
    strategy = ScriptedStrategy(min_bars=2, fire_at_length=set())

    with pytest.raises(ConfigError):
        engine.run(strategy, run_spec(bars))
    assert strategy.window_lengths == [], "costs must be priced before any bar"


def test_evaluate_on_tick_is_refused(tmp_path):
    with pytest.raises(ConfigError, match="Rule 6"):
        ReplayEngine(
            make_test_config(tmp_path, {"backtest.replay.evaluate_on": "TICK"}),
            source_for(flat_bars(5)),
        )


def test_unimplemented_entry_fill_reading_is_refused(tmp_path):
    with pytest.raises(ConfigError, match="AMBIGUITY-B08"):
        ReplayEngine(
            make_test_config(tmp_path, {"backtest.replay.entry_fill": "SIGNAL_CLOSE"}),
            source_for(flat_bars(5)),
        )


def test_stacking_positions_is_refused(tmp_path):
    with pytest.raises(ConfigError, match="§7.4"):
        ReplayEngine(
            make_test_config(
                tmp_path, {"backtest.replay.concurrent_positions_per_symbol": 3}
            ),
            source_for(flat_bars(5)),
        )


# ====================================================== rule 6, bar close ====


def test_the_window_is_exactly_the_closed_bars(tmp_path):
    """Rule 6. A strategy evaluating at the close of bar i sees bars 0..i and
    nothing else — no lookahead, and no missing tail."""
    bars = flat_bars(12)
    strategy = ScriptedStrategy(min_bars=4, fire_at_length=set())
    ReplayEngine(make_test_config(tmp_path), source_for(bars)).run(
        strategy, run_spec(bars)
    )

    assert strategy.window_lengths == list(range(4, 13))
    for length, last_time in zip(strategy.window_lengths, strategy.last_bar_times):
        assert last_time == bars[length - 1].time


def test_min_bars_is_respected_before_the_first_evaluation(tmp_path):
    bars = flat_bars(10)
    strategy = ScriptedStrategy(min_bars=6, fire_at_length=set())
    ReplayEngine(make_test_config(tmp_path), source_for(bars)).run(
        strategy, run_spec(bars)
    )
    assert min(strategy.window_lengths) == 6


def test_warmup_bars_delays_the_first_evaluation(tmp_path):
    bars = flat_bars(12)
    strategy = ScriptedStrategy(min_bars=4, fire_at_length=set())
    ReplayEngine(
        make_test_config(tmp_path, {"backtest.replay.warmup_bars": 3}),
        source_for(bars),
    ).run(strategy, run_spec(bars))
    assert min(strategy.window_lengths) == 7


def test_the_strategy_sees_only_bars_and_one_spec(tmp_path):
    """Rule 1's harness side: nothing time-varying is passed beyond the window.
    The same `SymbolSpec` object is handed over every time, so a module cannot
    observe a change it might key behaviour off."""
    bars = flat_bars(10)
    strategy = ScriptedStrategy(min_bars=3, fire_at_length=set())
    ReplayEngine(make_test_config(tmp_path), source_for(bars)).run(
        strategy, run_spec(bars)
    )
    assert len(set(strategy.specs_seen)) == 1


# ============================================================ entry & fills ==


def test_entry_fills_at_the_next_bar_open_with_costs_applied(tmp_path):
    """AMBIGUITY-B08's `NEXT_BAR_OPEN`, plus §11.2's spread and slippage."""
    bars = flat_bars(8, opens={4: 2000.50}, highs={4: 2000.60}, spreads={4: 30})
    config = make_test_config(tmp_path, {"costs.slippage.market_order_points": 10})
    strategy = ScriptedStrategy(
        min_bars=4, fire_at_length={4}, stop=1998.00, target=2004.00
    )
    result = ReplayEngine(config, source_for(bars)).run(strategy, run_spec(bars))

    assert len(result.trades) == 1
    trade = result.trades[0]
    assert trade.signal_bar_time == bars[3].time
    assert trade.entry_time == bars[4].time
    # 2000.50 open + 0.30 spread (buy at ask) + 0.10 slippage.
    assert trade.entry_price == pytest.approx(2000.90)


def test_a_fill_the_live_system_would_reject_is_not_taken(tmp_path):
    """§11.2: "A backtest that fills an order the live system would reject [...]
    is measuring a strategy that cannot be traded." The skip is recorded with
    its §7.3 reason."""
    bars = flat_bars(8, spreads={4: 900})
    config = make_test_config(tmp_path, {"symbols.max_spread_points.XAUUSD": 50})
    strategy = ScriptedStrategy(
        min_bars=4, fire_at_length={4}, stop=1998.00, target=2004.00
    )
    result = ReplayEngine(config, source_for(bars)).run(strategy, run_spec(bars))

    assert result.trades == ()
    assert len(result.skipped) == 1
    assert result.skipped[0].reason is SkipReason.FILL_REJECTED
    assert RejectReason.MAX_SPREAD in result.skipped[0].reject_reasons


def test_a_stop_inside_stops_level_is_rejected(tmp_path):
    bars = flat_bars(8)
    config = make_test_config(tmp_path)
    strategy = ScriptedStrategy(
        min_bars=4, fire_at_length={4}, stop=1999.90, target=2004.00
    )
    result = ReplayEngine(
        config, source_for(bars, spec=spec_for_tests(stops_level=100))
    ).run(strategy, run_spec(bars))

    assert result.trades == ()
    assert RejectReason.STOPS_LEVEL in result.skipped[0].reject_reasons


def test_slippage_past_the_target_is_not_a_trade(tmp_path):
    """A fill that lands beyond its own target has no risk to measure R against."""
    bars = flat_bars(8)
    config = make_test_config(tmp_path, {"costs.slippage.market_order_points": 600})
    strategy = ScriptedStrategy(
        min_bars=4, fire_at_length={4}, stop=1998.00, target=2001.00
    )
    result = ReplayEngine(config, source_for(bars)).run(strategy, run_spec(bars))

    assert result.trades == ()
    assert result.skipped[0].reason is SkipReason.ENTRY_BEYOND_LEVELS


def test_a_module_that_supplies_no_levels_gets_no_invented_ones(tmp_path):
    """§5.5 is Stage 1. The harness records the gap instead of filling it."""
    bars = flat_bars(8)
    strategy = ScriptedStrategy(
        min_bars=4, fire_at_length={4}, evidence={"breakout_level": 2000.0}
    )
    result = ReplayEngine(make_test_config(tmp_path), source_for(bars)).run(
        strategy, run_spec(bars)
    )
    assert result.trades == ()
    assert result.skipped[0].reason is SkipReason.NO_PLAN


def test_inverted_levels_are_refused_as_a_plan(tmp_path):
    bars = flat_bars(8)
    strategy = ScriptedStrategy(
        min_bars=4, fire_at_length={4}, stop=2004.00, target=1998.00
    )
    result = ReplayEngine(make_test_config(tmp_path), source_for(bars)).run(
        strategy, run_spec(bars)
    )
    assert result.skipped[0].reason is SkipReason.NO_PLAN


def test_a_signal_on_the_last_bar_cannot_fill(tmp_path):
    """There is no next bar to open at, and looking ahead is not available."""
    bars = flat_bars(6)
    strategy = ScriptedStrategy(
        min_bars=4, fire_at_length={6}, stop=1998.00, target=2004.00
    )
    result = ReplayEngine(make_test_config(tmp_path), source_for(bars)).run(
        strategy, run_spec(bars)
    )
    assert result.trades == ()
    assert result.skipped[0].reason is SkipReason.NO_NEXT_BAR


def test_only_one_position_per_symbol(tmp_path):
    """§7.4. Later signals are recorded with their reason, not dropped."""
    bars = flat_bars(20, highs={10: 2004.50})
    strategy = ScriptedStrategy(
        min_bars=4, fire_at_length={4, 5, 6}, stop=1998.00, target=2004.00
    )
    result = ReplayEngine(make_test_config(tmp_path), source_for(bars)).run(
        strategy, run_spec(bars)
    )
    assert len(result.trades) == 1
    assert [s.reason for s in result.skipped] == [
        SkipReason.POSITION_OPEN,
        SkipReason.POSITION_OPEN,
    ]


# ============================================================== resolution ===


def test_a_target_hit_is_a_win_in_r(tmp_path):
    bars = flat_bars(12, highs={6: 2004.20})
    config = make_test_config(tmp_path)
    strategy = ScriptedStrategy(
        min_bars=4, fire_at_length={4}, stop=1998.00, target=2004.00
    )
    result = ReplayEngine(config, source_for(bars)).run(strategy, run_spec(bars))

    trade = result.trades[0]
    assert trade.terminal_reason is TerminalReason.TARGET
    assert trade.resolution_path is ResolutionPath.UNAMBIGUOUS
    assert trade.gross_r > 0
    assert trade.exit_time == bars[6].time


def test_a_stop_hit_is_a_loss_of_about_one_r(tmp_path):
    bars = flat_bars(12, lows={6: 1997.80})
    config = make_test_config(tmp_path)
    strategy = ScriptedStrategy(
        min_bars=4, fire_at_length={4}, stop=1998.00, target=2004.00
    )
    result = ReplayEngine(config, source_for(bars)).run(strategy, run_spec(bars))

    trade = result.trades[0]
    assert trade.terminal_reason is TerminalReason.STOP
    assert trade.gross_r == pytest.approx(-1.0)


def test_sell_target_requires_ask_to_touch_not_only_stored_bid(tmp_path):
    """§11.2 regression: spread affects the trigger, not only the later fill."""
    bars = flat_bars(9, lows={6: 1999.00}, spreads={6: 100})
    strategy = ScriptedStrategy(
        min_bars=4,
        fire_at_length={4},
        direction=Direction.SELL,
        stop=2002.00,
        target=1999.00,
    )

    result = ReplayEngine(make_test_config(tmp_path), source_for(bars)).run(
        strategy, run_spec(bars)
    )

    assert len(result.trades) == 1
    assert result.trades[0].terminal_reason is TerminalReason.DATA_END


def test_sell_exit_uses_ask_trigger_and_does_not_charge_spread_twice(tmp_path):
    """When ASK touches, its trigger price is already on the executable side."""
    bars = flat_bars(9, lows={6: 1998.00}, spreads={6: 100})
    strategy = ScriptedStrategy(
        min_bars=4,
        fire_at_length={4},
        direction=Direction.SELL,
        stop=2002.00,
        target=1999.00,
    )

    result = ReplayEngine(make_test_config(tmp_path), source_for(bars)).run(
        strategy, run_spec(bars)
    )

    trade = result.trades[0]
    assert trade.terminal_reason is TerminalReason.TARGET
    assert trade.exit_price == pytest.approx(1999.00)
    assert trade.costs.spread_price_exit == pytest.approx(1.00)


def test_sell_stop_triggers_when_ask_touches_even_if_bid_does_not(tmp_path):
    """The mirror regression: executable ASK may hit a SELL stop before BID."""
    bars = flat_bars(9, highs={6: 2000.00}, spreads={6: 100})
    strategy = ScriptedStrategy(
        min_bars=4,
        fire_at_length={4},
        direction=Direction.SELL,
        stop=2001.00,
        target=1998.00,
    )

    result = ReplayEngine(make_test_config(tmp_path), source_for(bars)).run(
        strategy, run_spec(bars)
    )

    trade = result.trades[0]
    assert trade.terminal_reason is TerminalReason.STOP
    assert trade.exit_price == pytest.approx(2001.00)


def test_costs_make_a_stop_lose_more_than_one_r(tmp_path):
    """The point of §11.2. A frictionless stop is exactly −1R; a real one is
    worse, and a backtest that reports −1.000R has not priced anything."""
    bars = flat_bars(12, lows={6: 1997.80})
    config = make_test_config(
        tmp_path,
        {
            "costs.commission.per_lot_per_side.XAUUSD": 5.0,
            "costs.slippage.stop_order_points": 20,
        },
    )
    strategy = ScriptedStrategy(
        min_bars=4, fire_at_length={4}, stop=1998.00, target=2004.00
    )
    result = ReplayEngine(config, source_for(bars)).run(strategy, run_spec(bars))
    assert result.trades[0].net_r < -1.0


def test_an_ambiguous_bar_carries_the_flag_onto_the_trade(tmp_path):
    """§11.1's flag has to survive the trip from resolver to trade record, or
    §11.4 cannot report an ambiguity rate."""
    bars = flat_bars(12, highs={6: 2004.50}, lows={6: 1997.50})
    config = make_test_config(tmp_path)
    result = ReplayEngine(config, source_for(bars, m1=[])).run(
        ScriptedStrategy(
            min_bars=4, fire_at_length={4}, stop=1998.00, target=2004.00
        ),
        run_spec(bars),
    )
    trade = result.trades[0]
    assert trade.ambiguous_fill is True
    assert trade.resolution_path is ResolutionPath.FALLBACK_NO_M1
    assert trade.terminal_reason is TerminalReason.STOP

    report = build_report(result, config)
    assert report.overall.ambiguity_rate == 1.0
    assert report.ambiguity_exceeds_warn
    assert "LOWER BOUND" in report.render()


def test_a_position_open_at_data_end_is_excluded_not_counted(tmp_path):
    """AMBIGUITY-B09. It has no terminal price the market ever offered, so it is
    reported on its own line rather than booked as a win or a loss."""
    bars = flat_bars(10)
    config = make_test_config(tmp_path)
    result = ReplayEngine(config, source_for(bars)).run(
        ScriptedStrategy(
            min_bars=4, fire_at_length={4}, stop=1998.00, target=2004.00
        ),
        run_spec(bars),
    )
    assert len(result.trades) == 1
    assert result.trades[0].terminal_reason is TerminalReason.DATA_END
    assert result.trades[0].resolved is False

    report = build_report(result, config)
    assert report.overall.trade_count == 0
    assert report.unresolved_at_data_end == 1
    assert "positions open at data end" in report.render()


# =================================================================== volume ==


def test_configured_volume_rounds_down_to_the_step(tmp_path):
    bars = flat_bars(12, highs={6: 2004.20})
    config = make_test_config(tmp_path, {"backtest.replay.volume": 0.199})
    result = ReplayEngine(config, source_for(bars)).run(
        ScriptedStrategy(
            min_bars=4, fire_at_length={4}, stop=1998.00, target=2004.00
        ),
        run_spec(bars),
    )
    assert result.volume == pytest.approx(0.19)


def test_a_volume_below_the_broker_minimum_refuses_the_run(tmp_path):
    bars = flat_bars(12)
    config = make_test_config(tmp_path, {"backtest.replay.volume": 0.001})
    with pytest.raises(ConfigError, match="§7.3"):
        ReplayEngine(config, source_for(bars)).run(
            ScriptedStrategy(min_bars=4, fire_at_length=set()), run_spec(bars)
        )


# ================================================================= coverage ==


def test_a_window_beyond_coverage_refuses_rather_than_shortening(tmp_path):
    bars = flat_bars(12)
    config = make_test_config(tmp_path)
    spec = RunSpec(
        symbol=TEST_SYMBOL,
        timeframe=TF,
        start=bars[0].time,
        end=bar_close_time(bars[-1].time, TF) + timedelta(days=5),
    )
    with pytest.raises(DataIntegrityError, match="coverage"):
        ReplayEngine(config, source_for(bars)).run(
            ScriptedStrategy(min_bars=4, fire_at_length=set()), spec
        )


def test_a_missing_timeframe_refuses(tmp_path):
    bars = flat_bars(12)
    config = make_test_config(tmp_path)
    source = InMemoryBarSource(spec_for_tests(), {Timeframe.M15: bars})
    spec = RunSpec(
        symbol=TEST_SYMBOL,
        timeframe=Timeframe.H1,
        start=bars[0].time,
        end=bar_close_time(bars[-1].time, TF),
    )
    with pytest.raises(DataIntegrityError, match="coverage"):
        ReplayEngine(config, source).run(
            ScriptedStrategy(min_bars=4, fire_at_length=set()), spec
        )
