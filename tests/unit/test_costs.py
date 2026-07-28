"""§11.2 — cost modelling. All four costs, and the refusal to run without them."""

from __future__ import annotations

from datetime import datetime

import pytest

from backend.contracts import Direction
from backend.core.errors import ConfigError
from backend.core.timeutil import UTC
from backend.backtest.costs import (
    CostModel,
    OhlcBasis,
    OrderKind,
    SpreadCharge,
    SwapRates,
    SwapUnit,
    WeekendRollovers,
)
from tests.doubles import (
    TEST_SYMBOL,
    candle,
    make_test_config,
    real_config,
    spec_for_tests,
)

T0 = datetime(2026, 3, 2, 8, 0, tzinfo=UTC)


def _model(tmp_path, overrides=None, spec=None, swap_rates=None) -> CostModel:
    spec = spec or spec_for_tests()
    return CostModel(
        make_test_config(tmp_path, overrides), TEST_SYMBOL, spec, swap_rates
    )


# =================================================== refuses to run unpriced


def test_approved_real_cost_config_constructs_before_a_bar_is_walked():
    """The operator approved every §11.2 input; the real config is now runnable.

    Sentinel refusal remains pinned independently below by replacing each
    load-bearing key with ``<OPERATOR DECISION>`` one at a time.
    """
    model = CostModel(real_config(), TEST_SYMBOL, spec_for_tests())
    assert model._commission_per_lot_per_side == 0.0
    assert model._slippage_points[OrderKind.MARKET] == 10.0
    assert model._slippage_points[OrderKind.STOP] == 20.0
    assert model._rollover_hour == 19
    assert model._triple_weekday == "WEDNESDAY"
    assert model._weekend_rollovers is WeekendRollovers.SKIPPED
    assert model._swap_rates.unit is SwapUnit.POINTS


@pytest.mark.parametrize(
    "key",
    [
        "costs.commission.per_lot_per_side.XAUUSD",
        "costs.slippage.market_order_points",
        "costs.slippage.stop_order_points",
        "costs.swap.rollover_hour_utc",
        "costs.swap.triple_swap_weekday",
        "costs.swap.weekend_rollovers",
        "costs.swap.rates.unit",
        "costs.swap.rates.XAUUSD.long",
        "costs.swap.rates.XAUUSD.short",
    ],
)
def test_every_cost_key_is_load_bearing(tmp_path, key):
    """Leaving any one of the four costs undecided is enough to stop the run.
    Three of four priced is still a frictionless backtest in the fourth
    dimension."""
    with pytest.raises(ConfigError):
        _model(tmp_path, {key: "<OPERATOR DECISION>"})


def test_constant_spread_is_refused(tmp_path):
    with pytest.raises(ConfigError, match="per-bar recorded spread"):
        _model(tmp_path, {"costs.spread.use_constant": True})


def test_favourable_slippage_is_refused(tmp_path):
    with pytest.raises(ConfigError, match="ADVERSE_ONLY"):
        _model(tmp_path, {"costs.slippage.direction": "SYMMETRIC"})


def test_negative_slippage_is_refused(tmp_path):
    with pytest.raises(ConfigError, match="magnitude"):
        _model(tmp_path, {"costs.slippage.market_order_points": -5})


def test_both_sides_filling_on_the_same_side_is_refused(tmp_path):
    with pytest.raises(ConfigError, match="same side"):
        _model(tmp_path, {"costs.spread.sell_fills_at": "ASK"})


def test_integer_triple_swap_weekday_is_refused(tmp_path):
    """Monday=0 and Sunday=0 are both common. The off-by-one fails silently, so
    the name is required."""
    with pytest.raises(ConfigError, match="weekday name"):
        _model(tmp_path, {"costs.swap.triple_swap_weekday": 2})


# ================================================================== spread ===


def test_per_bar_spread_varies_the_fill(tmp_path):
    """§11.2: "Per-bar recorded spread from the historical store, **not a
    constant**." Two bars with different recorded spreads must fill
    differently, or the store's spread column is decoration."""
    model = _model(tmp_path)
    tight = candle(T0, 2000.00, 2000.50, 1999.50, 2000.00, spread=10)
    wide = candle(T0, 2000.00, 2000.50, 1999.50, 2000.00, spread=90)

    tight_fill = model.entry_fill(
        reference_price=2000.00,
        direction=Direction.BUY,
        order_kind=OrderKind.MARKET,
        bar=tight,
    )
    wide_fill = model.entry_fill(
        reference_price=2000.00,
        direction=Direction.BUY,
        order_kind=OrderKind.MARKET,
        bar=wide,
    )

    # point is 0.01, so 10 points is 0.10 and 90 points is 0.90.
    assert tight_fill == pytest.approx(2000.10)
    assert wide_fill == pytest.approx(2000.90)
    assert wide_fill > tight_fill


def test_buy_fills_at_ask_and_sell_at_bid(tmp_path):
    """§11.2: "Entry fills at ask (buy) or bid (sell)." Under the BID reading of
    the stored OHLC (AMBIGUITY-B01) the buy pays the whole spread and the sell
    pays none — at entry."""
    model = _model(tmp_path)
    bar = candle(T0, 2000.00, 2000.50, 1999.50, 2000.00, spread=30)

    buy = model.entry_fill(
        reference_price=2000.00,
        direction=Direction.BUY,
        order_kind=OrderKind.MARKET,
        bar=bar,
    )
    sell = model.entry_fill(
        reference_price=2000.00,
        direction=Direction.SELL,
        order_kind=OrderKind.MARKET,
        bar=bar,
    )
    assert buy == pytest.approx(2000.30)
    assert sell == pytest.approx(2000.00)


def test_round_trip_pays_one_spread_whichever_way_it_points(tmp_path):
    """Under BID/ROUND_TRIP a buy pays at entry and a sell pays at exit, so both
    directions pay exactly one spread over the round trip. A model where one
    direction is free is a model with a free lunch in it."""
    model = _model(tmp_path)
    bar = candle(T0, 2000.00, 2000.50, 1999.50, 2000.00, spread=30)

    for direction in (Direction.BUY, Direction.SELL):
        entry = abs(model.spread_adjustment(direction, bar, is_exit=False))
        exit_ = abs(model.spread_adjustment(direction, bar, is_exit=True))
        assert entry + exit_ == pytest.approx(0.30)


def test_mid_basis_splits_the_spread(tmp_path):
    """The other reading of AMBIGUITY-B01, implemented so the operator's answer
    is a config change."""
    model = _model(tmp_path, {"costs.spread.ohlc_basis": OhlcBasis.MID.value})
    bar = candle(T0, 2000.00, 2000.50, 1999.50, 2000.00, spread=30)

    buy = model.entry_fill(
        reference_price=2000.00,
        direction=Direction.BUY,
        order_kind=OrderKind.MARKET,
        bar=bar,
    )
    sell = model.entry_fill(
        reference_price=2000.00,
        direction=Direction.SELL,
        order_kind=OrderKind.MARKET,
        bar=bar,
    )
    assert buy == pytest.approx(2000.15)
    assert sell == pytest.approx(1999.85)


def test_entry_only_charging_leaves_the_exit_clean(tmp_path):
    model = _model(tmp_path, {"costs.spread.charge_on": SpreadCharge.ENTRY_ONLY.value})
    bar = candle(T0, 2000.00, 2000.50, 1999.50, 2000.00, spread=30)
    assert model.spread_adjustment(Direction.BUY, bar, is_exit=True) == 0.0


def test_negative_recorded_spread_raises(tmp_path):
    model = _model(tmp_path)
    bar = candle(T0, 2000.00, 2000.50, 1999.50, 2000.00, spread=-1)
    with pytest.raises(ConfigError, match="negative recorded spread"):
        model.spread_price(bar)


# ================================================================ slippage ===


def test_limit_orders_take_no_slippage_and_market_orders_do(tmp_path):
    """§11.2: "default 0 for limit orders, `slippage_points` for market and stop
    orders"."""
    model = _model(
        tmp_path,
        {
            "costs.slippage.market_order_points": 25,
            "costs.slippage.stop_order_points": 40,
            "costs.slippage.limit_order_points": 0,
        },
    )
    assert model.slippage_adjustment(
        Direction.BUY, OrderKind.LIMIT, is_exit=False
    ) == 0.0
    assert model.slippage_adjustment(
        Direction.BUY, OrderKind.MARKET, is_exit=False
    ) == pytest.approx(0.25)
    assert model.slippage_adjustment(
        Direction.BUY, OrderKind.STOP, is_exit=True
    ) == pytest.approx(-0.40)


@pytest.mark.parametrize("direction", [Direction.BUY, Direction.SELL])
@pytest.mark.parametrize("is_exit", [False, True])
def test_slippage_is_always_adverse(tmp_path, direction, is_exit):
    """Never in favour of the trade — on either side, in either direction.

    "Adverse" means the position holder gets a worse price: higher when buying,
    lower when selling. Opening a BUY is buying; closing it is selling."""
    model = _model(tmp_path, {"costs.slippage.market_order_points": 25})
    adjustment = model.slippage_adjustment(
        direction, OrderKind.MARKET, is_exit=is_exit
    )
    buying = (direction is Direction.BUY) != is_exit
    assert (adjustment > 0) is buying


def test_slippage_worsens_both_fills_of_a_round_trip(tmp_path):
    """The end-to-end statement: a market entry and a stop exit both move
    against a BUY."""
    model = _model(
        tmp_path,
        {"costs.slippage.market_order_points": 20, "costs.slippage.stop_order_points": 20},
    )
    bar = candle(T0, 2000.00, 2000.50, 1999.50, 2000.00, spread=0)
    entry = model.entry_fill(
        reference_price=2000.00,
        direction=Direction.BUY,
        order_kind=OrderKind.MARKET,
        bar=bar,
    )
    exit_ = model.exit_fill(
        reference_price=1998.00,
        direction=Direction.BUY,
        order_kind=OrderKind.STOP,
        bar=bar,
    )
    assert entry > 2000.00
    assert exit_ < 1998.00


# ============================================================== commission ===


def test_commission_is_per_lot_per_side(tmp_path):
    model = _model(tmp_path, {"costs.commission.per_lot_per_side.XAUUSD": 3.5})
    assert model.commission(1.0) == pytest.approx(7.0)
    assert model.commission(0.5) == pytest.approx(3.5)
    assert model.commission(1.0, sides=1) == pytest.approx(3.5)


def test_commission_scales_with_volume(tmp_path):
    model = _model(tmp_path, {"costs.commission.per_lot_per_side.XAUUSD": 3.5})
    assert model.commission(2.0) == pytest.approx(2 * model.commission(1.0))


# ==================================================================== swap ===


def test_rollovers_counted_per_night_held(tmp_path):
    model = _model(tmp_path, {"costs.swap.rollover_hour_utc": 21})
    # Monday 08:00 -> Thursday 08:00 crosses 21:00 on Mon, Tue and Wed.
    nights, triple = model.count_rollovers(
        datetime(2026, 3, 2, 8, 0, tzinfo=UTC),
        datetime(2026, 3, 5, 8, 0, tzinfo=UTC),
    )
    assert nights == 3
    assert triple == 1  # Wednesday


def test_intraday_position_pays_no_swap(tmp_path):
    model = _model(tmp_path, {"costs.swap.rates.XAUUSD.long": -5.0})
    total, nights, triple = model.swap(
        volume=1.0,
        direction=Direction.BUY,
        opened_at=datetime(2026, 3, 2, 8, 0, tzinfo=UTC),
        closed_at=datetime(2026, 3, 2, 17, 0, tzinfo=UTC),
    )
    assert (nights, triple, total) == (0, 0, 0.0)


def test_long_and_short_rates_differ(tmp_path):
    """§11.2: "long and short rates differ". A single signed number would make
    a short's carry the mirror of a long's, which brokers do not offer."""
    model = _model(
        tmp_path,
        {
            "costs.swap.rates.XAUUSD.long": -7.0,
            "costs.swap.rates.XAUUSD.short": 1.5,
            "costs.swap.rates.unit": SwapUnit.ACCOUNT_CURRENCY.value,
        },
    )
    opened = datetime(2026, 3, 2, 8, 0, tzinfo=UTC)
    closed = datetime(2026, 3, 3, 8, 0, tzinfo=UTC)
    long_swap, _, _ = model.swap(
        volume=1.0, direction=Direction.BUY, opened_at=opened, closed_at=closed
    )
    short_swap, _, _ = model.swap(
        volume=1.0, direction=Direction.SELL, opened_at=opened, closed_at=closed
    )
    assert long_swap == pytest.approx(-7.0)
    assert short_swap == pytest.approx(1.5)
    assert long_swap != -short_swap


def test_triple_night_charges_three_times(tmp_path):
    model = _model(
        tmp_path,
        {
            "costs.swap.rates.XAUUSD.long": -2.0,
            "costs.swap.rates.unit": SwapUnit.ACCOUNT_CURRENCY.value,
            "costs.swap.triple_swap_weekday": "WEDNESDAY",
        },
    )
    # Wednesday 08:00 -> Thursday 08:00 crosses only Wednesday's 21:00.
    total, nights, triple = model.swap(
        volume=1.0,
        direction=Direction.BUY,
        opened_at=datetime(2026, 3, 4, 8, 0, tzinfo=UTC),
        closed_at=datetime(2026, 3, 5, 8, 0, tzinfo=UTC),
    )
    assert (nights, triple) == (1, 1)
    assert total == pytest.approx(-6.0)


def test_weekend_rollover_policy_changes_the_bill(tmp_path):
    """AMBIGUITY-B04 — both readings implemented, neither inferred."""
    opened = datetime(2026, 3, 6, 8, 0, tzinfo=UTC)  # Friday
    closed = datetime(2026, 3, 9, 8, 0, tzinfo=UTC)  # Monday

    skipped = _model(
        tmp_path / "s",
        {"costs.swap.weekend_rollovers": WeekendRollovers.SKIPPED.value},
    )
    charged = _model(
        tmp_path / "c",
        {"costs.swap.weekend_rollovers": WeekendRollovers.CHARGED.value},
    )
    assert skipped.count_rollovers(opened, closed)[0] == 1  # Friday only
    assert charged.count_rollovers(opened, closed)[0] == 3  # Fri, Sat, Sun


def test_swap_in_points_uses_value_per_point(tmp_path):
    """§7.2's identity: value_per_point = tick_value * (point / tick_size).
    Every input comes from `SymbolSpec` — nothing about the instrument is
    assumed."""
    spec = spec_for_tests(tick_value=1.0, point=0.01, tick_size=0.01)
    model = _model(
        tmp_path,
        {
            "costs.swap.rates.XAUUSD.long": -3.0,
            "costs.swap.rates.unit": SwapUnit.POINTS.value,
        },
        spec=spec,
    )
    assert model.value_per_point == pytest.approx(1.0)
    total, _, _ = model.swap(
        volume=2.0,
        direction=Direction.BUY,
        opened_at=datetime(2026, 3, 2, 8, 0, tzinfo=UTC),
        closed_at=datetime(2026, 3, 3, 8, 0, tzinfo=UTC),
    )
    assert total == pytest.approx(-3.0 * 1.0 * 2.0)


def test_explicit_swap_rates_override_config(tmp_path):
    """The store is meant to snapshot these from `symbol_info()` (AMBIGUITY-B03).
    The injection point exists so that lands without touching this module."""
    model = _model(
        tmp_path,
        swap_rates=SwapRates(long=-9.0, short=0.0, unit=SwapUnit.ACCOUNT_CURRENCY),
    )
    total, _, _ = model.swap(
        volume=1.0,
        direction=Direction.BUY,
        opened_at=datetime(2026, 3, 2, 8, 0, tzinfo=UTC),
        closed_at=datetime(2026, 3, 3, 8, 0, tzinfo=UTC),
    )
    assert total == pytest.approx(-9.0)


def test_backwards_holding_period_raises(tmp_path):
    model = _model(tmp_path)
    with pytest.raises(ValueError, match="precedes"):
        model.count_rollovers(
            datetime(2026, 3, 3, 8, 0, tzinfo=UTC),
            datetime(2026, 3, 2, 8, 0, tzinfo=UTC),
        )


# ============================================================= round trip ===


def test_round_trip_collects_all_four_costs(tmp_path):
    model = _model(
        tmp_path,
        {
            "costs.commission.per_lot_per_side.XAUUSD": 3.0,
            "costs.slippage.market_order_points": 10,
            "costs.slippage.stop_order_points": 15,
            "costs.swap.rates.XAUUSD.long": -4.0,
            "costs.swap.rates.unit": SwapUnit.ACCOUNT_CURRENCY.value,
        },
    )
    entry_bar = candle(T0, 2000.00, 2001.00, 1999.00, 2000.50, spread=25)
    exit_bar = candle(T0, 1998.50, 1999.00, 1997.00, 1998.00, spread=40)

    costs = model.round_trip(
        volume=1.0,
        direction=Direction.BUY,
        entry_bar=entry_bar,
        exit_bar=exit_bar,
        entry_order_kind=OrderKind.MARKET,
        exit_order_kind=OrderKind.STOP,
        opened_at=datetime(2026, 3, 2, 8, 0, tzinfo=UTC),
        closed_at=datetime(2026, 3, 3, 8, 0, tzinfo=UTC),
    )

    assert costs.spread_points_entry == 25
    assert costs.spread_points_exit == 40
    assert costs.spread_price_entry == pytest.approx(0.25)
    assert costs.spread_price_exit == pytest.approx(0.0)  # BID basis: sell at bid
    assert costs.slippage_price_entry == pytest.approx(0.10)
    assert costs.slippage_price_exit == pytest.approx(0.15)
    assert costs.commission_ccy == pytest.approx(6.0)
    assert costs.swap_ccy == pytest.approx(-4.0)
    assert costs.rollover_nights == 1
    assert costs.currency_total == pytest.approx(2.0)


def test_currency_to_price_conversion_needs_a_volume(tmp_path):
    """§11.4 wants R, §11.2 states two costs in currency, and nothing in the
    spec reconciles them (AMBIGUITY-B05). The conversion is offered, and it
    refuses to guess the volume it needs."""
    model = _model(tmp_path)
    assert model.to_price(10.0, volume=1.0) == pytest.approx(0.10)
    with pytest.raises(ValueError):
        model.to_price(10.0, volume=0.0)
