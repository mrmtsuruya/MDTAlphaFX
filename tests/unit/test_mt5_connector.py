"""§7.1 symbol resolution, rule 5, and the §10.1 startup offset measurement.

Nothing here imports `MetaTrader5` or opens a socket (§10.3). The connector takes
an injected module double, which is the whole reason its real import is lazy.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta

import pytest

from backend.contracts import Timeframe
from backend.core.config import Config
from backend.core.errors import (
    DataIntegrityError,
    LiveAccountError,
    SymbolResolutionError,
)
from backend.core.guards import (
    ACCOUNT_TRADE_MODE_CONTEST,
    ACCOUNT_TRADE_MODE_REAL,
    LIVE_ACCOUNT_OVERRIDE_ENV,
)
from backend.core.timeutil import UTC
from backend.data.mt5_connector import MT5Connector

from .fakes import ABSENT, RATES_DTYPE_NO_SPREAD, FakeMT5, symbol_info_double

CONFIG_DIR = "config"


@pytest.fixture
def config() -> Config:
    return Config.load(CONFIG_DIR)


def make_fake(*names: str, **kwargs) -> FakeMT5:
    fake = FakeMT5(**kwargs)
    for name in names:
        fake.symbols[name] = symbol_info_double(name)
    return fake


# ------------------------------------------------------ lazy import (§10.3)


def test_module_imports_without_metatrader5_present():
    """The connector must be importable on a machine with no MT5 package.

    The package is Windows-only. A module-scope import would make the replay
    engine, the store and every test unrunnable off Windows.
    """
    assert "MetaTrader5" not in sys.modules
    import backend.data.mt5_connector  # noqa: F401
    import backend.data.source  # noqa: F401
    import backend.data.store  # noqa: F401

    assert "MetaTrader5" not in sys.modules


def test_pytest_refuses_uninjected_mt5_before_loading_or_initialising(
    config, monkeypatch
):
    """§10.3 blocks the real connector path even when MT5 would report demo."""
    import backend.data.mt5_connector as connector_module

    fake_demo = make_fake("EURUSD")
    load_calls = 0

    def load_real_module_path():
        nonlocal load_calls
        load_calls += 1
        return fake_demo

    monkeypatch.setattr(connector_module, "load_mt5_module", load_real_module_path)

    with pytest.raises(LiveAccountError, match="initialise MetaTrader5"):
        MT5Connector(config).connect()

    assert load_calls == 0
    assert fake_demo.initialize_calls == []


def test_pytest_allows_the_explicit_injected_module_seam(config):
    """The network guard preserves deterministic fake-module unit tests."""
    fake = make_fake("EURUSD")

    with MT5Connector(config, mt5_module=fake) as connector:
        assert connector.account.is_demo

    assert len(fake.initialize_calls) == 1


def test_non_test_runtime_still_loads_and_initialises_demo_mt5(config, monkeypatch):
    """Outside pytest, normal lazy loading and the demo-account guard still run."""
    import backend.core.guards as guards_module
    import backend.data.mt5_connector as connector_module

    fake_demo = make_fake("EURUSD")
    monkeypatch.setattr(guards_module, "_running_under_pytest", lambda: False)
    monkeypatch.setattr(connector_module, "load_mt5_module", lambda: fake_demo)

    with MT5Connector(config) as connector:
        assert connector.account.is_demo

    assert len(fake_demo.initialize_calls) == 1
    assert fake_demo.shutdown_calls == 1


# ------------------------------------------------------------------- §7.1


def test_resolves_bare_base_name(config):
    fake = make_fake("EURUSD")
    with MT5Connector(config, mt5_module=fake) as connector:
        resolved = connector.resolve_symbol("EURUSD")
    assert resolved.name == "EURUSD"
    assert resolved.requested_name == "EURUSD"
    assert resolved.tried == ("EURUSD",)


@pytest.mark.parametrize("suffix", [".m", "m", ".raw", ".ecn", ".pro", "_i"])
def test_resolves_each_configured_suffix_variant(config, suffix):
    """§7.1: "suffix variants: XAUUSD, XAUUSD.m, XAUUSDm"."""
    broker_name = f"XAUUSD{suffix}"
    fake = make_fake(broker_name)
    with MT5Connector(config, mt5_module=fake) as connector:
        resolved = connector.resolve_symbol("XAUUSD")
    assert resolved.name == broker_name
    assert resolved.spec.name == broker_name
    # The bare name was probed first and missed.
    assert resolved.tried[0] == "XAUUSD"
    assert resolved.tried[-1] == broker_name


def test_first_hit_wins_in_configured_order(config):
    """Ordering is config, not luck: `""` precedes `".m"` in suffix_candidates."""
    fake = make_fake("GBPUSD", "GBPUSD.m")
    with MT5Connector(config, mt5_module=fake) as connector:
        assert connector.resolve_symbol("GBPUSD").name == "GBPUSD"


def test_unresolvable_symbol_raises_and_lists_what_it_tried(config):
    fake = make_fake("EURUSD.xyz")
    with MT5Connector(config, mt5_module=fake) as connector:
        with pytest.raises(SymbolResolutionError) as excinfo:
            connector.resolve_symbol("EURUSD")
    message = str(excinfo.value)
    assert "§7.1" in message
    assert "EURUSD.m" in message  # the ladder it walked
    assert "EURUSD.xyz" in message  # the near-match diagnostic


@pytest.mark.parametrize(
    "field",
    [
        "digits",
        "point",
        "trade_tick_size",
        "trade_tick_value",
        "trade_contract_size",
        "volume_min",
        "volume_max",
        "volume_step",
        "trade_stops_level",
        "trade_freeze_level",
    ],
)
def test_missing_symbol_info_field_raises(config, field):
    """§7.1: "Fail loudly if any field is missing." No field has a default."""
    fake = FakeMT5()
    fake.symbols["EURUSD"] = symbol_info_double("EURUSD", **{field: ABSENT})
    with MT5Connector(config, mt5_module=fake) as connector:
        with pytest.raises(SymbolResolutionError) as excinfo:
            connector.resolve_symbol("EURUSD")
    assert field in str(excinfo.value)


@pytest.mark.parametrize(
    "field",
    [
        "point",
        "trade_tick_size",
        "trade_tick_value",
        "trade_contract_size",
        "volume_min",
        "volume_max",
        "volume_step",
    ],
)
def test_zero_where_zero_is_invalid_raises(config, field):
    """A zero point, tick_value or volume_step is an absence wearing a number —
    §7.2 divides by every one of them."""
    fake = FakeMT5()
    fake.symbols["EURUSD"] = symbol_info_double("EURUSD", **{field: 0.0})
    with MT5Connector(config, mt5_module=fake) as connector:
        with pytest.raises(SymbolResolutionError) as excinfo:
            connector.resolve_symbol("EURUSD")
    assert field in str(excinfo.value)


@pytest.mark.parametrize("field", ["trade_stops_level", "trade_freeze_level"])
def test_zero_stops_and_freeze_levels_are_accepted(config, field):
    """Zero is the honest answer on most ECN accounts: "no minimum distance".
    Rejecting it would refuse working symbols."""
    fake = FakeMT5()
    fake.symbols["EURUSD"] = symbol_info_double("EURUSD", **{field: 0})
    with MT5Connector(config, mt5_module=fake) as connector:
        resolved = connector.resolve_symbol("EURUSD")
    assert resolved.spec.stops_level >= 0
    assert resolved.spec.freeze_level >= 0


@pytest.mark.parametrize("field", ["swap_long", "swap_short"])
def test_missing_swap_rate_raises(config, field):
    """costs.yaml declares swap.source: SYMBOL_INFO, so there is no other
    source. Zero would be a cost §11.2 silently never charges."""
    fake = FakeMT5()
    fake.symbols["EURUSD"] = symbol_info_double("EURUSD", **{field: ABSENT})
    with MT5Connector(config, mt5_module=fake) as connector:
        with pytest.raises(SymbolResolutionError) as excinfo:
            connector.resolve_symbol("EURUSD")
    assert field in str(excinfo.value)


def test_swap_rates_are_snapshotted_next_to_the_spec(config):
    fake = FakeMT5()
    fake.symbols["XAUUSD.m"] = symbol_info_double(
        "XAUUSD.m", swap_long=-7.25, swap_short=2.5
    )
    with MT5Connector(config, mt5_module=fake) as connector:
        resolved = connector.resolve_symbol("XAUUSD")
    assert resolved.swap_long == -7.25
    assert resolved.swap_short == 2.5


def test_symbol_is_selected_so_tick_value_is_populated(config):
    """`trade_tick_value` is documented as populated only for symbols in Market
    Watch. Unselected it reads zero, which would size an unbounded position."""
    fake = make_fake("EURUSD", require_select_for_tick_value=True)
    with MT5Connector(config, mt5_module=fake) as connector:
        resolved = connector.resolve_symbol("EURUSD")
    assert "EURUSD" in fake.selected
    assert resolved.spec.tick_value > 0


def test_broker_values_are_taken_from_symbol_info_not_assumed(config):
    """Every SymbolSpec field must trace back to symbol_info(), never a default."""
    fake = FakeMT5()
    fake.symbols["BTCUSD"] = symbol_info_double(
        "BTCUSD",
        digits=1,
        point=0.1,
        trade_tick_size=0.1,
        trade_tick_value=0.1,
        trade_contract_size=1.0,
        volume_min=0.01,
        volume_max=5.0,
        volume_step=0.01,
        trade_stops_level=1500,
        trade_freeze_level=25,
    )
    with MT5Connector(config, mt5_module=fake) as connector:
        spec = connector.resolve_symbol("BTCUSD").spec
    assert (spec.digits, spec.point, spec.tick_size) == (1, 0.1, 0.1)
    assert (spec.stops_level, spec.freeze_level) == (1500, 25)
    assert spec.volume_max == 5.0


def test_resolve_watchlist_covers_every_configured_name(config):
    fake = make_fake("XAUUSD.m", "EURUSD.m", "GBPUSD.m", "BTCUSD.m")
    with MT5Connector(config, mt5_module=fake) as connector:
        resolved = connector.resolve_watchlist()
    assert sorted(resolved) == ["BTCUSD.m", "EURUSD.m", "GBPUSD.m", "XAUUSD.m"]
    # Either name resolves back to the same record.
    assert connector.resolved("XAUUSD") is connector.resolved("XAUUSD.m")


# --------------------------------------------------------- rule 5 (§10.3)


def test_demo_account_passes(config):
    fake = make_fake("EURUSD")
    with MT5Connector(config, mt5_module=fake) as connector:
        assert connector.account.is_demo
        assert connector.account.trade_mode_name == "DEMO"


@pytest.mark.parametrize(
    "mode", [ACCOUNT_TRADE_MODE_REAL, ACCOUNT_TRADE_MODE_CONTEST]
)
def test_non_demo_account_raises_before_any_other_call(config, monkeypatch, mode):
    """Rule 5. The guard runs immediately after login, so no symbol or bar call
    happens on a live account at all."""
    monkeypatch.delenv(LIVE_ACCOUNT_OVERRIDE_ENV, raising=False)
    fake = make_fake("EURUSD", trade_mode=mode)
    with pytest.raises(LiveAccountError):
        MT5Connector(config, mt5_module=fake).connect()
    # And the session was closed on the way out rather than left open.
    assert fake.shutdown_calls == 1


def test_override_env_var_permits_a_live_account(config, monkeypatch):
    """"overridable only by a deliberately-set environment variable" (§10.3)."""
    monkeypatch.setenv(LIVE_ACCOUNT_OVERRIDE_ENV, "1")
    fake = make_fake("EURUSD", trade_mode=ACCOUNT_TRADE_MODE_REAL)
    # assert_no_network_in_tests() refuses this combination under pytest, which
    # is itself the §10.3 protection. Prove the guard fires, then prove the
    # override works outside the test-runner check.
    with pytest.raises(LiveAccountError, match="pytest"):
        MT5Connector(config, mt5_module=fake).connect()

    from backend.core.guards import AccountIdentity, assert_demo_account

    assert_demo_account(
        AccountIdentity(
            login=1, server="s", trade_mode=ACCOUNT_TRADE_MODE_REAL, currency="USD"
        )
    )


def test_override_is_read_per_call_not_cached(config, monkeypatch):
    from backend.core.guards import AccountIdentity, assert_demo_account

    identity = AccountIdentity(
        login=1, server="s", trade_mode=ACCOUNT_TRADE_MODE_REAL, currency="USD"
    )
    monkeypatch.setenv(LIVE_ACCOUNT_OVERRIDE_ENV, "1")
    assert_demo_account(identity)
    monkeypatch.delenv(LIVE_ACCOUNT_OVERRIDE_ENV)
    with pytest.raises(LiveAccountError):
        assert_demo_account(identity)


def test_account_info_without_trade_mode_is_refused(config):
    """Rule 5 cannot be evaluated without trade_mode, so the session is refused
    rather than assumed demo."""
    from types import SimpleNamespace

    fake = make_fake("EURUSD")
    fake.account_info_result = SimpleNamespace(
        login=1, server="s", trade_mode=None, currency="USD"
    )
    with pytest.raises(Exception) as excinfo:
        MT5Connector(config, mt5_module=fake).connect()
    assert "trade_mode" in str(excinfo.value)


# ---------------------------------------------------------- session hygiene


def test_connect_is_idempotent(config):
    fake = make_fake("EURUSD")
    connector = MT5Connector(config, mt5_module=fake)
    connector.connect()
    connector.connect()
    assert len(fake.initialize_calls) == 1
    connector.close()
    connector.close()
    assert fake.shutdown_calls == 1


def test_partial_credentials_are_refused(config):
    fake = make_fake("EURUSD")
    connector = MT5Connector(config, mt5_module=fake, login=1, password="x")
    with pytest.raises(Exception, match="partial MT5 credentials"):
        connector.connect()


# ----------------------------------------------------------- §10.1 offset


def test_server_offset_is_measured_and_rounded_to_whole_minutes(config):
    fake = make_fake("EURUSD", server_offset_minutes=180)
    with MT5Connector(config, mt5_module=fake) as connector:
        connector.resolve_watchlist(["EURUSD"])
        clock = connector.measure_server_clock()
    assert clock.offset_minutes == 180
    assert clock.server_timezone_hint == "UTC+03:00"
    assert clock.measured_at.tzinfo is not None


def test_negative_server_offset_is_measured(config):
    fake = make_fake("EURUSD", server_offset_minutes=-300)
    with MT5Connector(config, mt5_module=fake) as connector:
        connector.resolve_watchlist(["EURUSD"])
        clock = connector.measure_server_clock()
    assert clock.offset_minutes == -300
    assert clock.server_timezone_hint == "UTC-05:00"


def test_offset_is_frozen_not_recomputed(config):
    """§10.1: "do not infer it per-call". A recomputation is how a DST
    transition becomes invisible."""
    fake = make_fake("EURUSD", server_offset_minutes=120)
    with MT5Connector(config, mt5_module=fake) as connector:
        connector.resolve_watchlist(["EURUSD"])
        first = connector.measure_server_clock()
        fake.server_offset_minutes = 180  # the server "changes" underneath
        second = connector.measure_server_clock()
    assert second is first
    assert connector_offset(connector) == 120


def connector_offset(connector: MT5Connector) -> int:
    return connector.server_clock.offset_minutes


def test_stale_quote_refuses_to_produce_an_offset(config):
    """A quote stale beyond the configured tolerance cannot tell "the server is
    ahead" from "the market closed". The engine will not guess."""
    tolerance = float(
        config.get("engine.time.server_offset_measure_tolerance_seconds")
    )
    fake = make_fake(
        "EURUSD", server_offset_minutes=180, quote_staleness_seconds=tolerance + 25
    )
    with MT5Connector(config, mt5_module=fake) as connector:
        connector.resolve_watchlist(["EURUSD"])
        with pytest.raises(DataIntegrityError) as excinfo:
            connector.measure_server_clock()
    assert "§10.1" in str(excinfo.value)
    assert "market is closed" in str(excinfo.value)


def test_bars_require_a_measured_clock(config):
    fake = make_fake("EURUSD")
    with MT5Connector(config, mt5_module=fake) as connector:
        connector.resolve_symbol("EURUSD")
        with pytest.raises(Exception, match="server clock has not been measured"):
            connector.bars(
                "EURUSD",
                Timeframe.M15,
                datetime(2026, 1, 5, tzinfo=UTC),
                datetime(2026, 1, 6, tzinfo=UTC),
            )


# ----------------------------------------------------------------- bars


def test_bar_times_are_converted_from_server_time_to_utc(config):
    """The rate `time` field is server wall clock labelled UTC. It must come back
    as the true UTC instant, through the frozen ServerClock."""
    offset = 180
    first_utc = datetime(2026, 1, 5, 8, 0, tzinfo=UTC)
    fake = make_fake("EURUSD", server_offset_minutes=offset)
    fake.load_rates("EURUSD", Timeframe.M15, first_utc, 8, spread=17)

    with MT5Connector(config, mt5_module=fake) as connector:
        connector.resolve_symbol("EURUSD")
        connector.measure_server_clock()
        bars = connector.bars(
            "EURUSD",
            Timeframe.M15,
            first_utc,
            first_utc + timedelta(minutes=15 * 8),
        )

    assert len(bars) == 8
    assert bars[0].time == first_utc
    assert bars[-1].time == first_utc + timedelta(minutes=15 * 7)
    assert all(bar.time.tzinfo is not None for bar in bars)
    assert all(bar.spread == 17 for bar in bars)


def test_bars_window_is_half_open(config):
    """`copy_rates_range` is inclusive at both ends; BarSource is not."""
    first_utc = datetime(2026, 1, 5, 8, 0, tzinfo=UTC)
    fake = make_fake("EURUSD")
    fake.load_rates("EURUSD", Timeframe.M15, first_utc, 4)
    with MT5Connector(config, mt5_module=fake) as connector:
        connector.resolve_symbol("EURUSD")
        connector.measure_server_clock()
        bars = connector.bars(
            "EURUSD", Timeframe.M15, first_utc, first_utc + timedelta(minutes=30)
        )
    assert [bar.time for bar in bars] == [
        first_utc,
        first_utc + timedelta(minutes=15),
    ]


def test_request_bounds_are_converted_to_server_wall_clock(config):
    """The other half of the §10.1 conversion, and the half that fails silently.

    `copy_rates_range` compares against integers built from the *server's* wall
    clock. A UTC bound handed over unconverted shifts the window by the offset
    and returns real bars for the wrong hours — no error, wrong data. The bound
    must also be *aware* UTC, or the MT5 package applies the local machine
    timezone instead.
    """
    offset = 180
    start_utc = datetime(2026, 1, 5, 8, 0, tzinfo=UTC)
    end_utc = datetime(2026, 1, 5, 12, 0, tzinfo=UTC)
    fake = make_fake("EURUSD", server_offset_minutes=offset)
    fake.load_rates("EURUSD", Timeframe.M15, start_utc, 16)

    with MT5Connector(config, mt5_module=fake) as connector:
        connector.resolve_symbol("EURUSD")
        connector.measure_server_clock()
        connector.bars("EURUSD", Timeframe.M15, start_utc, end_utc)

    _, _, date_from, date_to = fake.range_calls[-1]
    assert date_from.tzinfo is not None and date_to.tzinfo is not None
    assert date_from.replace(tzinfo=None) == datetime(2026, 1, 5, 11, 0)
    assert date_to.replace(tzinfo=None) == datetime(2026, 1, 5, 15, 0)


def test_no_bars_are_returned_for_an_empty_or_inverted_window(config):
    start_utc = datetime(2026, 1, 5, 8, 0, tzinfo=UTC)
    fake = make_fake("EURUSD")
    fake.load_rates("EURUSD", Timeframe.M15, start_utc, 8)
    with MT5Connector(config, mt5_module=fake) as connector:
        connector.resolve_symbol("EURUSD")
        connector.measure_server_clock()
        assert connector.bars("EURUSD", Timeframe.M15, start_utc, start_utc) == []
        assert (
            connector.bars(
                "EURUSD", Timeframe.M15, start_utc, start_utc - timedelta(hours=1)
            )
            == []
        )


def test_missing_spread_column_raises(config):
    """§11.2 makes per-bar spread mandatory. There is no substitute for it."""
    first_utc = datetime(2026, 1, 5, 8, 0, tzinfo=UTC)
    fake = make_fake("EURUSD")
    fake.rates_dtype = RATES_DTYPE_NO_SPREAD
    fake.load_rates(
        "EURUSD", Timeframe.M15, first_utc, 4, dtype=RATES_DTYPE_NO_SPREAD
    )
    with MT5Connector(config, mt5_module=fake) as connector:
        connector.resolve_symbol("EURUSD")
        connector.measure_server_clock()
        with pytest.raises(DataIntegrityError, match="spread"):
            connector.bars(
                "EURUSD", Timeframe.M15, first_utc, first_utc + timedelta(hours=2)
            )
