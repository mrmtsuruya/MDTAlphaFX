"""§7.3 broker constraints applied to simulated fills, per §11.2.

Each of the six conditions gets a test that makes it, and only it, fail — so a
rejection reason cannot be produced by the wrong rule.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from backend.core.errors import ConfigError
from backend.core.timeutil import UTC
from backend.backtest.broker_rules import (
    BrokerRules,
    Operation,
    RejectReason,
    SessionGate,
    SpreadGate,
    check_freeze_level,
    check_price_normalised,
    check_stops_level,
    check_volume,
    is_normalised,
    normalise_price,
    round_volume_down,
)
from tests.doubles import TEST_SYMBOL, candle, make_test_config, real_config, spec_for_tests

T0 = datetime(2026, 3, 2, 8, 0, tzinfo=UTC)  # Monday, inside London


def _rules(tmp_path, overrides=None) -> BrokerRules:
    return BrokerRules(make_test_config(tmp_path, overrides), TEST_SYMBOL)


def _bar(spread: int = 20):
    return candle(T0, 2000.00, 2001.00, 1999.00, 2000.50, spread=spread)


# ================================================== 3. volume rounds DOWN ===


@pytest.mark.parametrize(
    "raw, expected",
    [
        (0.10, 0.10),
        (0.109, 0.10),
        (0.199, 0.19),
        (0.1999999, 0.19),
        (1.0, 1.0),
        (0.005, 0.0),
    ],
)
def test_volume_rounds_down_never_up(raw, expected):
    """§7.2: "Rounding is **down** to `volume_step`, never up — rounding up
    silently exceeds the risk budget."

    0.199 rounding to 0.20 would be a 5% overshoot of the intended risk on every
    trade, which compounds into a materially different equity curve."""
    spec = spec_for_tests(volume_step=0.01)
    assert round_volume_down(raw, spec) == pytest.approx(expected)
    assert round_volume_down(raw, spec) <= raw


def test_volume_rounding_respects_a_coarse_step():
    spec = spec_for_tests(volume_step=0.5)
    assert round_volume_down(1.4, spec) == pytest.approx(1.0)
    assert round_volume_down(1.9, spec) == pytest.approx(1.5)


def test_volume_step_is_never_assumed():
    """A broken `SymbolSpec` must raise, not fall back on a plausible step."""
    with pytest.raises(ConfigError, match="volume_step"):
        round_volume_down(1.0, spec_for_tests(volume_step=0.0))


def test_volume_below_minimum_is_rejected():
    spec = spec_for_tests(volume_min=0.10)
    validation = check_volume(0.05, spec)
    assert not validation.accepted
    assert RejectReason.INVALID_VOLUME in validation.reasons
    assert "volume_min" in validation.detail[0]


def test_volume_above_maximum_is_rejected():
    spec = spec_for_tests(volume_max=5.0)
    validation = check_volume(6.0, spec)
    assert not validation.accepted
    assert "volume_max" in validation.detail[0]


def test_volume_off_the_step_is_rejected_not_silently_fixed():
    validation = check_volume(0.155, spec_for_tests(volume_step=0.01))
    assert not validation.accepted
    assert "rounds DOWN" in validation.detail[0]


# ================================================== 1. stops_level distance ===


def test_stop_closer_than_stops_level_is_rejected():
    """§7.3: "SL/TP distance ≥ `stops_level` points from current price"."""
    spec = spec_for_tests(stops_level=50)  # 50 points = 0.50 at point 0.01
    validation = check_stops_level(
        price=2000.00, stop_loss=1999.80, take_profit=2004.00, spec=spec
    )
    assert not validation.accepted
    assert validation.reasons == (RejectReason.STOPS_LEVEL,)
    assert "stop_loss" in validation.detail[0]


def test_take_profit_closer_than_stops_level_is_rejected():
    spec = spec_for_tests(stops_level=50)
    validation = check_stops_level(
        price=2000.00, stop_loss=1996.00, take_profit=2000.20, spec=spec
    )
    assert not validation.accepted
    assert "take_profit" in validation.detail[0]


def test_stops_level_comes_from_the_symbol_spec_not_a_constant():
    """The same levels pass at one broker's `stops_level` and fail at another's.
    Hardcoding it is a financial bug, not a style issue."""
    levels = dict(price=2000.00, stop_loss=1999.50, take_profit=2000.50)
    assert check_stops_level(spec=spec_for_tests(stops_level=10), **levels).accepted
    assert not check_stops_level(spec=spec_for_tests(stops_level=100), **levels).accepted


# =================================================== 2. freeze_level band ===


def test_modify_inside_the_freeze_band_is_rejected():
    """§7.3: "Price not within `freeze_level` of market for modify/cancel"."""
    spec = spec_for_tests(freeze_level=50)
    validation = check_freeze_level(
        price=2000.10, market_price=2000.00, spec=spec, operation=Operation.MODIFY
    )
    assert not validation.accepted
    assert validation.reasons == (RejectReason.FREEZE_LEVEL,)


def test_cancel_outside_the_freeze_band_is_allowed():
    spec = spec_for_tests(freeze_level=50)
    validation = check_freeze_level(
        price=2005.00, market_price=2000.00, spec=spec, operation=Operation.CANCEL
    )
    assert validation.accepted


def test_freeze_level_does_not_apply_to_opening():
    spec = spec_for_tests(freeze_level=5000)
    assert check_freeze_level(
        price=2000.00, market_price=2000.00, spec=spec, operation=Operation.OPEN
    ).accepted


# ================================================ 4. prices normalised ===


def test_price_not_normalised_to_digits_is_rejected():
    """§7.3: "Prices normalised to `digits`"."""
    spec = spec_for_tests(digits=2)
    validation = check_price_normalised({"stop_loss": 1998.12345}, spec)
    assert not validation.accepted
    assert validation.reasons == (RejectReason.PRICE_NOT_NORMALISED,)
    assert "stop_loss" in validation.detail[0]


def test_normalisation_uses_the_symbols_own_digits():
    five = spec_for_tests(digits=5, point=0.00001, tick_size=0.00001)
    assert is_normalised(1.10525, five)
    assert not is_normalised(1.105253, five)
    assert normalise_price(1.105253, five) == pytest.approx(1.10525)


def test_the_rejection_names_which_price_failed():
    spec = spec_for_tests(digits=2)
    validation = check_price_normalised(
        {"price": 2000.00, "stop_loss": 1998.001, "take_profit": 2004.00}, spec
    )
    assert len(validation.detail) == 1
    assert "stop_loss" in validation.detail[0]


# ==================================================== 5. max spread ===


def test_spread_above_the_ceiling_is_rejected(tmp_path):
    """§7.3: "Current spread ≤ `max_spread_points`". This is the news-spike
    guard: a fill through a 900-point spread is not a fill the live system
    would have taken."""
    gate = SpreadGate(
        make_test_config(tmp_path, {"symbols.max_spread_points.XAUUSD": 50}),
        TEST_SYMBOL,
    )
    assert gate.check(_bar(spread=40)).accepted
    rejected = gate.check(_bar(spread=900))
    assert not rejected.accepted
    assert rejected.reasons == (RejectReason.MAX_SPREAD,)


@pytest.mark.parametrize(
    "symbol,approved_limit",
    [
        ("XAUUSD", 26),
        ("EURUSD", 47),
        ("GBPUSD", 89),
        ("BTCUSD", 858),
    ],
)
def test_approved_max_spread_remains_per_symbol(symbol, approved_limit):
    """The operator-approved p99 guardrail is still resolved per symbol."""
    gate = SpreadGate(real_config(), symbol)
    assert gate.check(_bar(spread=approved_limit)).accepted
    assert not gate.check(_bar(spread=approved_limit + 1)).accepted


# ==================================================== 6. session open ===


def test_instant_outside_every_window_is_market_closed(tmp_path):
    """§7.3's sixth condition, under the only implemented reading."""
    gate = SessionGate(
        make_test_config(
            tmp_path,
            {
                "sessions.sessions": {
                    "london": {"start": "07:00", "end": "16:00"},
                }
            },
        )
    )
    assert gate.is_open(datetime(2026, 3, 2, 8, 0, tzinfo=UTC))
    closed = gate.check(datetime(2026, 3, 2, 3, 0, tzinfo=UTC))
    assert not closed.accepted
    assert closed.reasons == (RejectReason.MARKET_CLOSED,)


def test_overlapping_sessions_are_both_tagged(tmp_path):
    """`tag_overlaps` — a London/New York bar belongs to both populations for
    §11.4's session segmentation, so it carries both names."""
    gate = SessionGate(make_test_config(tmp_path))
    tags = gate.sessions_at(datetime(2026, 3, 2, 13, 0, tzinfo=UTC))
    assert "london" in tags and "new_york" in tags


def test_session_tags_are_deterministically_ordered(tmp_path):
    gate = SessionGate(make_test_config(tmp_path))
    moment = datetime(2026, 3, 2, 13, 0, tzinfo=UTC)
    assert gate.sessions_at(moment) == gate.sessions_at(moment)
    assert list(gate.sessions_at(moment)) == sorted(gate.sessions_at(moment))


def test_an_unimplemented_session_source_refuses(tmp_path):
    """AMBIGUITY-B07: the spec does not say what supplies the trading calendar.
    A value naming a reading nobody implemented must raise, not degrade."""
    with pytest.raises(ConfigError, match="AMBIGUITY-B07"):
        SessionGate(
            make_test_config(
                tmp_path, {"backtest.fills.session_source": "BROKER_SESSIONS"}
            )
        )


def test_a_session_declaring_a_timezone_is_refused(tmp_path):
    """§10.1: session windows are defined in UTC. Accepting a local zone here
    reintroduces the DST bug the rule exists to prevent."""
    with pytest.raises(ConfigError, match="timezone"):
        SessionGate(
            make_test_config(
                tmp_path,
                {
                    "sessions.sessions": {
                        "london": {
                            "start": "07:00",
                            "end": "16:00",
                            "timezone": "Europe/London",
                        }
                    }
                },
            )
        )


# ======================================================= all six together ===


def test_a_clean_fill_is_accepted(tmp_path):
    rules = _rules(tmp_path)
    validation = rules.validate_fill(
        bar=_bar(),
        price=2000.00,
        stop_loss=1998.00,
        take_profit=2004.00,
        volume=0.10,
        spec=spec_for_tests(),
        moment=T0,
    )
    assert validation.accepted, validation.detail


def test_every_failure_is_reported_not_just_the_first(tmp_path):
    """A fill can break three rules at once. Reporting only the first makes the
    operator fix them one run at a time."""
    rules = _rules(tmp_path, {"symbols.max_spread_points.XAUUSD": 30})
    validation = rules.validate_fill(
        bar=_bar(spread=500),
        price=2000.00,
        stop_loss=1999.99,
        take_profit=2004.001,
        volume=0.0,
        spec=spec_for_tests(stops_level=50, volume_min=0.01),
        moment=T0,
    )
    assert not validation.accepted
    assert RejectReason.STOPS_LEVEL in validation.reasons
    assert RejectReason.INVALID_VOLUME in validation.reasons
    assert RejectReason.PRICE_NOT_NORMALISED in validation.reasons
    assert RejectReason.MAX_SPREAD in validation.reasons


def test_disabling_constraint_enforcement_refuses_to_construct(tmp_path):
    """§11.2 requires fills to obey §7.3. A run with the check off measures a
    strategy that cannot be traded, so there is no such run."""
    with pytest.raises(ConfigError, match="§7.3"):
        _rules(tmp_path, {"backtest.fills.enforce_broker_constraints": False})


@pytest.mark.parametrize(
    "key",
    [
        "backtest.fills.reject_below_stops_level",
        "backtest.fills.reject_on_spread_exceeded",
        "backtest.fills.reject_outside_session",
    ],
)
def test_mandatory_constraint_subchecks_cannot_be_disabled(tmp_path, key):
    """The umbrella flag cannot say "enforced" while a mandatory §7.3 check is
    bypassed underneath it. Each former bypass now makes the run refuse."""
    with pytest.raises(ConfigError, match=key.rsplit(".", 1)[-1]):
        _rules(tmp_path, {key: False})


def test_freeze_level_check_needs_a_market_price(tmp_path):
    rules = _rules(tmp_path)
    with pytest.raises(ValueError, match="market_price"):
        rules.validate_fill(
            bar=_bar(),
            price=2000.00,
            stop_loss=1998.00,
            take_profit=2004.00,
            volume=0.10,
            spec=spec_for_tests(),
            moment=T0,
            operation=Operation.MODIFY,
        )
