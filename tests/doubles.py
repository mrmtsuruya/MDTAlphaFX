"""Test doubles. §10.3: "No test touches the network."

Nothing in here imports `MetaTrader5`, opens a socket or reads a clock. Bars are
synthetic candles held in memory behind the `BarSource` protocol, which is the
only access the backtest layer has to market data — so binding this double is
sufficient to guarantee the whole replay path is offline.

`make_test_config` deserves a note. Tests do **not** edit `config/*.yaml`: those
files carry `"<OPERATOR DECISION>"` sentinels for values the spec reserves for
the operator (Appendix B), and resolving them in the repo would defeat the point
of the sentinel. Instead the real config is copied to a temp directory and the
sentinels the test needs are overridden there. The values chosen are **test
fixtures**, not proposed defaults — a commission of 0.0 in a test asserts that
the plumbing carries a number, not that gold trades free.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import IntEnum
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import yaml

from backend.contracts import Candle, SymbolSpec, Timeframe
from backend.core.config import Config
from backend.core.errors import DataIntegrityError, SymbolResolutionError
from backend.core.timeutil import UTC, timeframe_minutes

REPO_ROOT = Path(__file__).resolve().parents[1]
REAL_CONFIG_DIR = REPO_ROOT / "config"

TEST_SYMBOL = "XAUUSD"


class MockTradeRetcode(IntEnum):
    """The MT5 ``TRADE_RETCODE_*`` values exercised by the mock broker.

    These values were verified against the installed MetaTrader5 package.  They
    are repeated here intentionally: importing that Windows package from a test
    double would defeat §10.3's offline-test boundary.
    """

    REQUOTE = 10004
    DONE = 10009
    DONE_PARTIAL = 10010
    INVALID_VOLUME = 10014
    INVALID_STOPS = 10016
    MARKET_CLOSED = 10018
    NO_MONEY = 10019
    PRICE_OFF = 10021


@dataclass(frozen=True)
class ScriptedOrderResponse:
    """One deterministic response consumed by :class:`MockBroker`."""

    retcode: MockTradeRetcode
    volume: float | None = None
    price: float | None = None
    bid: float = 0.0
    ask: float = 0.0
    comment: str | None = None
    retcode_external: int = 0


@dataclass(frozen=True)
class MockOrderSendResult:
    """Attribute-compatible subset of MetaTrader5's ``OrderSendResult``."""

    retcode: int
    deal: int
    order: int
    volume: float
    price: float
    bid: float
    ask: float
    comment: str
    request_id: int
    retcode_external: int
    request: dict[str, Any]


class MockBroker:
    """Reusable, scripted ``order_send()`` double for §10.3 and Stage 5.

    Responses are consumed in order.  Exhausting the script or leaving entries
    unused fails loudly, so a test cannot accidentally pass after making too
    many or too few broker calls.
    """

    TRADE_RETCODE_REQUOTE = int(MockTradeRetcode.REQUOTE)
    TRADE_RETCODE_DONE = int(MockTradeRetcode.DONE)
    TRADE_RETCODE_DONE_PARTIAL = int(MockTradeRetcode.DONE_PARTIAL)
    TRADE_RETCODE_INVALID_VOLUME = int(MockTradeRetcode.INVALID_VOLUME)
    TRADE_RETCODE_INVALID_STOPS = int(MockTradeRetcode.INVALID_STOPS)
    TRADE_RETCODE_MARKET_CLOSED = int(MockTradeRetcode.MARKET_CLOSED)
    TRADE_RETCODE_NO_MONEY = int(MockTradeRetcode.NO_MONEY)
    TRADE_RETCODE_PRICE_OFF = int(MockTradeRetcode.PRICE_OFF)

    def __init__(
        self,
        responses: Sequence[
            ScriptedOrderResponse | MockTradeRetcode | str | int
        ],
    ) -> None:
        self._responses = tuple(_normalise_broker_response(item) for item in responses)
        self._cursor = 0
        self.calls: list[dict[str, Any]] = []
        self.results: list[MockOrderSendResult] = []

    @property
    def remaining(self) -> int:
        return len(self._responses) - self._cursor

    def order_send(self, request: Mapping[str, Any]) -> MockOrderSendResult:
        """Consume and return the next response without importing or calling MT5."""
        if self._cursor >= len(self._responses):
            raise AssertionError(
                "MockBroker response script exhausted: order_send() was called "
                f"{self._cursor + 1} time(s) for {len(self._responses)} response(s)"
            )

        if not isinstance(request, Mapping):
            raise TypeError("MockBroker.order_send() expects an MT5 request mapping")
        snapshot = dict(request)
        self.calls.append(snapshot)

        scripted = self._responses[self._cursor]
        self._cursor += 1
        request_id = self._cursor
        successful = scripted.retcode in {
            MockTradeRetcode.DONE,
            MockTradeRetcode.DONE_PARTIAL,
        }

        requested_volume = _request_number(snapshot, "volume")
        requested_price = _request_number(snapshot, "price")
        if scripted.volume is not None:
            filled_volume = float(scripted.volume)
        elif scripted.retcode is MockTradeRetcode.DONE:
            filled_volume = requested_volume
        elif scripted.retcode is MockTradeRetcode.DONE_PARTIAL:
            filled_volume = requested_volume / 2.0
        else:
            filled_volume = 0.0

        if scripted.price is not None:
            filled_price = float(scripted.price)
        elif successful:
            filled_price = requested_price
        else:
            filled_price = 0.0

        result = MockOrderSendResult(
            retcode=int(scripted.retcode),
            deal=(700_000 + request_id) if successful else 0,
            order=(800_000 + request_id) if successful else 0,
            volume=filled_volume,
            price=filled_price,
            bid=float(scripted.bid),
            ask=float(scripted.ask),
            comment=scripted.comment or scripted.retcode.name,
            request_id=request_id,
            retcode_external=int(scripted.retcode_external),
            request=snapshot,
        )
        self.results.append(result)
        return result

    def assert_script_consumed(self) -> None:
        if self.remaining:
            raise AssertionError(
                f"MockBroker has {self.remaining} unconsumed scripted response(s)"
            )


def _normalise_broker_response(
    item: ScriptedOrderResponse | MockTradeRetcode | str | int,
) -> ScriptedOrderResponse:
    if isinstance(item, ScriptedOrderResponse):
        return item
    try:
        if isinstance(item, str):
            retcode = MockTradeRetcode[item.removeprefix("TRADE_RETCODE_").upper()]
        else:
            retcode = MockTradeRetcode(item)
    except (KeyError, ValueError) as exc:
        supported = ", ".join(member.name for member in MockTradeRetcode)
        raise ValueError(
            f"unsupported mock broker response {item!r}; supported: {supported}"
        ) from exc
    return ScriptedOrderResponse(retcode=retcode)


def _request_number(request: Mapping[str, Any], key: str) -> float:
    value = request.get(key, 0.0)
    if value is None:
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise TypeError(f"order request {key!r} must be numeric, got {value!r}") from exc


def spec_for_tests(**overrides: Any) -> SymbolSpec:
    """A `SymbolSpec` shaped like a gold CFD.

    Every field is stated explicitly because §7.1 forbids assuming any of them;
    a test that omitted one would be relying on a default that does not exist in
    production either.
    """
    base = dict(
        name=TEST_SYMBOL,
        digits=2,
        point=0.01,
        tick_size=0.01,
        tick_value=1.0,
        contract_size=100.0,
        volume_min=0.01,
        volume_max=100.0,
        volume_step=0.01,
        stops_level=10,
        freeze_level=5,
    )
    base.update(overrides)
    return SymbolSpec(**base)


def candle(
    time: datetime,
    open_: float,
    high: float,
    low: float,
    close: float,
    *,
    spread: int = 20,
    tick_volume: int = 100,
) -> Candle:
    return Candle(
        time=time,
        open=open_,
        high=high,
        low=low,
        close=close,
        tick_volume=tick_volume,
        spread=spread,
    )


def m1_series(
    start: datetime,
    closes: Sequence[float],
    *,
    highs: Sequence[float] | None = None,
    lows: Sequence[float] | None = None,
    spread: int = 20,
) -> list[Candle]:
    """One-minute candles at consecutive minutes.

    When `highs`/`lows` are omitted each candle is a doji at its close, which
    makes an M1 walk assert on ordering alone rather than on range arithmetic.
    """
    bars = []
    for i, close in enumerate(closes):
        high = highs[i] if highs is not None else close
        low = lows[i] if lows is not None else close
        open_ = closes[i - 1] if i else close
        bars.append(
            candle(
                start + timedelta(minutes=i),
                open_,
                max(high, open_, close),
                min(low, open_, close),
                close,
                spread=spread,
            )
        )
    return bars


class InMemoryBarSource:
    """`BarSource` over synthetic candles.

    `has_m1` is honest about partial coverage: it returns True only when every
    minute of the requested window has a bar. §11.1's fallback exists for gaps,
    and a double that claimed complete coverage over a hole would let the
    sub-bar walk produce a confident wrong answer — the exact failure the
    protocol's docstring warns about.
    """

    def __init__(
        self,
        spec: SymbolSpec,
        series: dict[Timeframe, Sequence[Candle]],
        m1: Sequence[Candle] | None = None,
        *,
        symbol: str = TEST_SYMBOL,
        spread_available: bool = True,
    ):
        self._spec = spec
        self._symbol = symbol
        self._series = {tf: list(bars) for tf, bars in series.items()}
        stored_m1 = list(m1) if m1 is not None else list(self._series.get(Timeframe.M1, []))
        self._m1 = sorted(stored_m1, key=lambda b: b.time)
        self._spread_available = spread_available
        self.m1_calls: list[tuple[datetime, datetime]] = []
        self.has_m1_calls: list[tuple[datetime, datetime]] = []

    # ------------------------------------------------------------- protocol

    def bars(
        self,
        symbol: str,
        timeframe: Timeframe,
        start: datetime,
        end: datetime,
    ) -> list[Candle]:
        self._check_symbol(symbol)
        if not self._spread_available:
            raise DataIntegrityError(
                "the store holds no per-bar spread for this window; §11.2 "
                "requires it and a zero spread is a frictionless backtest "
                "wearing a disguise"
            )
        return [
            b
            for b in self._series.get(timeframe, [])
            if _aware(start) <= _aware(b.time) < _aware(end)
        ]

    def m1_bars(self, symbol: str, start: datetime, end: datetime) -> list[Candle]:
        self._check_symbol(symbol)
        self.m1_calls.append((_aware(start), _aware(end)))
        return [b for b in self._m1 if _aware(start) <= _aware(b.time) < _aware(end)]

    def has_m1(self, symbol: str, start: datetime, end: datetime) -> bool:
        self._check_symbol(symbol)
        start, end = _aware(start), _aware(end)
        self.has_m1_calls.append((start, end))
        expected = int((end - start).total_seconds() // 60)
        if expected <= 0:
            return False
        present = {_aware(b.time) for b in self._m1 if start <= _aware(b.time) < end}
        return len(present) == expected

    def symbol_spec(self, symbol: str) -> SymbolSpec:
        self._check_symbol(symbol)
        return self._spec

    def available_symbols(self) -> list[str]:
        return [self._symbol]

    def coverage(
        self, symbol: str, timeframe: Timeframe
    ) -> tuple[datetime, datetime] | None:
        self._check_symbol(symbol)
        bars = self._series.get(timeframe)
        if not bars:
            return None
        return _aware(bars[0].time), _aware(bars[-1].time)

    # -------------------------------------------------------------- helpers

    def _check_symbol(self, symbol: str) -> None:
        if symbol != self._symbol:
            raise SymbolResolutionError(
                f"this double holds {self._symbol!r}, asked for {symbol!r}"
            )


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


# ------------------------------------------------------------------- config

#: Sentinels the backtest layer reads, resolved to test fixtures. Frictionless
#: by default so a test asserting on R arithmetic is not also asserting on a
#: commission schedule; individual tests override what they are measuring.
DEFAULT_TEST_OVERRIDES: dict[str, Any] = {
    "costs.commission.per_lot_per_side.XAUUSD": 0.0,
    "costs.slippage.market_order_points": 0,
    "costs.slippage.stop_order_points": 0,
    "costs.swap.rollover_hour_utc": 21,
    "costs.swap.triple_swap_weekday": "WEDNESDAY",
    "costs.swap.weekend_rollovers": "SKIPPED",
    "costs.swap.rates.unit": "POINTS",
    "costs.swap.rates.XAUUSD.long": 0.0,
    "costs.swap.rates.XAUUSD.short": 0.0,
    "symbols.max_spread_points.XAUUSD": 500,
    "backtest.replay.volume": 0.10,
}


def make_test_config(
    tmp_path: Path,
    overrides: dict[str, Any] | None = None,
    *,
    include_defaults: bool = True,
) -> Config:
    """Copy `config/` to `tmp_path` and resolve the sentinels a test needs.

    Keys are the same dotted paths `Config.get` takes, so a test overriding
    `costs.slippage.market_order_points` is naming the key the code reads.
    """
    merged: dict[str, Any] = {}
    if include_defaults:
        merged.update(DEFAULT_TEST_OVERRIDES)
    if overrides:
        merged.update(overrides)

    target = tmp_path / "config"
    target.mkdir(parents=True, exist_ok=True)

    loaded: dict[str, Any] = {}
    for path in sorted(REAL_CONFIG_DIR.glob("*.yaml")):
        loaded[path.stem] = yaml.safe_load(path.read_text(encoding="utf-8")) or {}

    for dotted, value in merged.items():
        namespace, _, rest = dotted.partition(".")
        if namespace not in loaded:
            raise KeyError(f"no config file for namespace {namespace!r}")
        _assign(loaded[namespace], rest.split("."), value)

    for stem, data in loaded.items():
        (target / f"{stem}.yaml").write_text(
            yaml.safe_dump(data, sort_keys=True, allow_unicode=True), encoding="utf-8"
        )

    return Config.load(target)


def _assign(node: dict[str, Any], path: list[str], value: Any) -> None:
    for part in path[:-1]:
        nxt = node.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            node[part] = nxt
        node = nxt
    node[path[-1]] = value


def real_config() -> Config:
    """The repository's currently approved configuration."""
    return Config.load(REAL_CONFIG_DIR)


# ------------------------------------------------------- synthetic price data


def zigzag_series(
    start: datetime,
    timeframe: Timeframe,
    *,
    base: float,
    leg_bars: int,
    step: float,
    cycles: int,
    half_range: float,
    spread: int = 20,
) -> list[Candle]:
    """A deterministic saw-tooth: `leg_bars` up at `step`, then `leg_bars` down.

    Deliberately not random. §11.3's walk-forward analysis is only meaningful if
    a rerun of the same window produces the same numbers, and a fixture seeded
    from a global RNG is the easiest way to lose that without noticing.

    `half_range` keeps each bar's high/low band narrow enough that no single bar
    spans both a 1R stop and its target, so this fixture exercises the
    unambiguous path and any ambiguity it reports is a bug.
    """
    minutes = timeframe_minutes(timeframe)
    closes: list[float] = []
    price = base
    for _ in range(cycles):
        for _ in range(leg_bars):
            price += step
            closes.append(round(price, 2))
        for _ in range(leg_bars):
            price -= step
            closes.append(round(price, 2))

    bars: list[Candle] = []
    for i, close in enumerate(closes):
        open_ = closes[i - 1] if i else base
        bars.append(
            candle(
                start + timedelta(minutes=minutes * i),
                round(open_, 2),
                round(max(open_, close) + half_range, 2),
                round(min(open_, close) - half_range, 2),
                close,
                spread=spread,
            )
        )
    return bars


def expand_to_m1(bars: Iterable[Candle], timeframe: Timeframe) -> list[Candle]:
    """Fabricate complete M1 coverage under each parent bar.

    Each parent becomes `n` M1 candles that open at the parent's open, print the
    parent's high then its low in the middle, and close at the parent's close —
    so a walk over them never disagrees with the parent about the extremes it
    reached, which is the store-consistency invariant `IntrabarResolver` raises
    on.
    """
    n = timeframe_minutes(timeframe)
    out: list[Candle] = []
    for parent in bars:
        base_time = _aware(parent.time)
        for k in range(n):
            if k == 0:
                o, h, l, c = parent.open, parent.high, parent.open, parent.high
            elif k == 1:
                o, h, l, c = parent.high, parent.high, parent.low, parent.low
            else:
                o, h, l, c = parent.low, parent.close, parent.low, parent.close
            out.append(
                candle(
                    base_time + timedelta(minutes=k),
                    o,
                    max(o, h, l, c),
                    min(o, h, l, c),
                    c,
                    spread=parent.spread,
                )
            )
    return out


__all__ = [
    "REPO_ROOT",
    "REAL_CONFIG_DIR",
    "TEST_SYMBOL",
    "DEFAULT_TEST_OVERRIDES",
    "MockTradeRetcode",
    "ScriptedOrderResponse",
    "MockOrderSendResult",
    "MockBroker",
    "spec_for_tests",
    "candle",
    "m1_series",
    "InMemoryBarSource",
    "make_test_config",
    "real_config",
    "zigzag_series",
    "expand_to_m1",
]
