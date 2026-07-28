"""MT5 session, §7.1 symbol resolution, and the §10.1 startup offset measurement.

This is the **only** module in the system that knows the `MetaTrader5` package
exists. §1: "The Python engine is the only component that talks to MT5."

**The import is lazy and that is load-bearing.** `MetaTrader5` is a Windows-only
binary package. If this module imported it at module scope, then

- nothing that transitively imports it could be unit-tested off Windows, and
- the replay engine (§11) would inherit a Windows dependency it has no use for.

So the package is resolved inside `load_mt5_module()`, at connect time, and the
connector accepts an injected module for tests. Importing this file on Linux
with no `MetaTrader5` present is expected to work, and there is a test asserting
it does.

Responsibilities, in the order `start()` performs them:

1. **Session.** `initialize()` / optional `login()`, idempotent, context-manager
   friendly.
2. **Rule 5 guard, before anything else.** `account_info()` is read immediately
   after the session opens and `assert_demo_account()` runs before any symbol or
   bar call. Nothing touches a non-demo account without the deliberate override.
3. **§7.1 symbol resolution.** Probe the base name and each configured suffix;
   the first `symbol_info()` hit wins. Every `SymbolSpec` field is validated —
   a missing or impossible value raises `SymbolResolutionError`. Never assume
   `digits`, `point`, `tick_value`, `volume_step`, `stops_level` or
   `freeze_level`.
4. **§10.1 server offset, measured once.** Compare the terminal's reported quote
   time against UTC, round to whole minutes, freeze into a `ServerClock`. Never
   recomputed per call — a per-call recomputation makes a DST transition
   invisible.

Bar timestamps
--------------
The MT5 Python package stores bar and tick times as integers that are the
*server's wall clock* labelled as if it were UTC. Two consequences, both handled
here and neither obvious:

- Request bounds must be converted UTC → server wall clock, then handed to the
  package as *aware UTC* datetimes so its own timestamp conversion is the
  identity. Passing a naive datetime makes the package apply the **local machine
  timezone**, which silently shifts every window on any machine that is not on
  server time.
- Returned bar times are converted server wall clock → UTC through the frozen
  `ServerClock`.

This module is a faithful adapter: it reports what the terminal said. It does
not repair, interpolate or sanitise bar data. The integrity boundary — including
the rejection of a zero spread — is `backend.data.store`, so that a diagnostic
tool such as `scripts/probe_symbols.py` can still *see* a broker reporting zero
spread rather than having the exception hide it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable, Sequence

from ..contracts import Candle, SymbolSpec, Timeframe
from ..core.config import Config
from ..core.errors import (
    DataIntegrityError,
    MDTAlphaFXError,
    SymbolResolutionError,
)
from ..core.guards import AccountIdentity, assert_demo_account, assert_no_network_in_tests
from ..core.timeutil import UTC, ServerClock, ensure_utc, utc_now

# --------------------------------------------------------------------------
# Structural constants. These are names and enum lookups, not parameters —
# there is no configuration under which MT5's M15 constant lives under a
# different attribute, and none of them is a threshold.
# --------------------------------------------------------------------------

# Timeframe -> the attribute on the MetaTrader5 module that carries its enum
# value. Resolved with getattr rather than hardcoding the integers, so a package
# that renames or drops one fails loudly instead of fetching the wrong series.
_MT5_TIMEFRAME_ATTR: dict[Timeframe, str] = {
    Timeframe.H4: "TIMEFRAME_H4",
    Timeframe.H1: "TIMEFRAME_H1",
    Timeframe.M15: "TIMEFRAME_M15",
    Timeframe.M5: "TIMEFRAME_M5",
    Timeframe.M1: "TIMEFRAME_M1",
}

# SymbolSpec field (§2) -> the attribute name on an MT5 SymbolInfo. The two
# vocabularies differ; mapping them in one table is what stops a typo in a
# far-away call site from silently reading the wrong broker value.
_SPEC_FIELD_SOURCE: dict[str, str] = {
    "name": "name",
    "digits": "digits",
    "point": "point",
    "tick_size": "trade_tick_size",
    "tick_value": "trade_tick_value",
    "contract_size": "trade_contract_size",
    "volume_min": "volume_min",
    "volume_max": "volume_max",
    "volume_step": "volume_step",
    "stops_level": "trade_stops_level",
    "freeze_level": "trade_freeze_level",
}

# Fields where zero is not a value but an absence. Every one of them divides or
# scales something in §7.2 lot sizing: a zero `point` or `tick_size` divides by
# zero, a zero `tick_value` sizes an unbounded position, a zero `volume_step`
# rounds to nothing.
_SPEC_MUST_BE_POSITIVE = frozenset(
    {
        "point",
        "tick_size",
        "tick_value",
        "contract_size",
        "volume_min",
        "volume_max",
        "volume_step",
    }
)

# Fields where zero is a legitimate broker answer. `stops_level` and
# `freeze_level` are zero on most ECN accounts and mean "no minimum distance";
# rejecting zero here would make the connector refuse working symbols.
_SPEC_MUST_BE_NON_NEGATIVE = frozenset({"digits", "stops_level", "freeze_level"})

# Swap rates are snapshotted next to the SymbolSpec because costs.yaml declares
# `swap.source: SYMBOL_INFO` — they are resolved from the broker, never written
# into config, and a replay must use the rates that were live when the bars were
# recorded.
_SWAP_FIELD_SOURCE: dict[str, str] = {
    "swap_long": "swap_long",
    "swap_short": "swap_short",
}

# Report shaping only: how many near-miss symbol names to list when resolution
# fails. Not a threshold on anything the engine decides.
_MAX_NEAR_MATCHES = 25


def load_mt5_module() -> Any:
    """Import `MetaTrader5` on demand.

    Kept out of module scope so this file imports cleanly on Linux and in CI.
    """
    try:
        import MetaTrader5 as mt5  # noqa: N813  (upstream package name)
    except ImportError as exc:  # pragma: no cover - Windows-only path
        raise MDTAlphaFXError(
            "the MetaTrader5 package is not importable. It is a Windows-only "
            "binary package; the connector is the only module that needs it and "
            "imports it lazily for exactly this reason. Install it on the "
            "Windows host, or inject a module double for tests."
        ) from exc
    return mt5


def mt5_timeframe(mt5_module: Any, timeframe: Timeframe) -> Any:
    """The MT5 enum value for a §2 `Timeframe`."""
    attribute = _MT5_TIMEFRAME_ATTR[timeframe]
    try:
        return getattr(mt5_module, attribute)
    except AttributeError as exc:
        raise MDTAlphaFXError(
            f"the MetaTrader5 module has no attribute '{attribute}'. The "
            f"timeframe enum this build exposes does not match the §2 contract."
        ) from exc


@dataclass(frozen=True)
class ResolvedSymbol:
    """One §7.1 resolution result: the broker's real name, its spec, its swaps.

    Immutable because it is the record of what the broker said at startup. If a
    value needs to change, the correct action is to re-resolve and record a new
    snapshot, not to edit this one — a replay is only interpretable against the
    spec that was live when the bars were recorded.
    """

    requested_name: str
    spec: SymbolSpec
    swap_long: float
    swap_short: float
    resolved_at: datetime
    tried: tuple[str, ...]

    @property
    def name(self) -> str:
        """The broker-resolved name, e.g. "XAUUSD.m"."""
        return self.spec.name


class MT5Connector:
    """One MT5 session. Idempotent, context-manager friendly.

    Usage on Windows:

        cfg = Config.load("config")
        with MT5Connector(cfg) as mt5c:
            mt5c.start()                       # connect + resolve + clock
            bars = mt5c.bars("XAUUSD.m", Timeframe.M15, start, end)

    Usage in tests: pass `mt5_module=<double>`. Nothing else changes.
    """

    def __init__(
        self,
        config: Config,
        *,
        mt5_module: Any | None = None,
        terminal_path: str | None = None,
        login: int | None = None,
        password: str | None = None,
        server: str | None = None,
    ) -> None:
        self._config = config
        self._injected_module = mt5_module
        self._mt5: Any | None = mt5_module
        self._terminal_path = terminal_path
        self._login = login
        self._password = password
        self._server = server

        self._connected = False
        self._account: AccountIdentity | None = None
        self._clock: ServerClock | None = None
        self._resolved: dict[str, ResolvedSymbol] = {}
        self._aliases: dict[str, str] = {}

    # ------------------------------------------------------------- session

    def __enter__(self) -> "MT5Connector":
        self.connect()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    @property
    def connected(self) -> bool:
        return self._connected

    def connect(self) -> "MT5Connector":
        """Open the terminal session and run the rule 5 guard. Idempotent."""
        if self._connected:
            return self

        # §10.3. Under pytest, only the explicit injected-module seam is
        # permitted. Refuse before importing MetaTrader5 or opening a terminal
        # session, including when the logged-in account would be demo.
        assert_no_network_in_tests(
            mt5_module_injected=self._injected_module is not None
        )

        if self._mt5 is None:
            self._mt5 = load_mt5_module()

        kwargs: dict[str, Any] = {}
        if self._terminal_path is not None:
            kwargs["path"] = self._terminal_path
        # Credentials are all-or-nothing. A partial set means the operator meant
        # to supply them and mistyped one, which must not silently fall through
        # to "attach to whatever account happens to be logged in".
        supplied = [v is not None for v in (self._login, self._password, self._server)]
        if any(supplied) and not all(supplied):
            raise MDTAlphaFXError(
                "partial MT5 credentials: login, password and server must be "
                "supplied together or not at all. Supplying none attaches to the "
                "account already logged into the running terminal."
            )
        if all(supplied):
            kwargs.update(
                login=self._login, password=self._password, server=self._server
            )

        if not self._mt5.initialize(**kwargs):
            raise MDTAlphaFXError(
                f"MetaTrader5.initialize() failed: {self._describe_last_error()}"
            )

        self._connected = True

        # Rule 5, immediately after login and before ANY other call.
        try:
            self._account = self._read_account_identity()
            assert_demo_account(self._account)
        except Exception:
            self.close()
            raise

        return self

    def close(self) -> None:
        """Shut the session down. Idempotent, safe to call twice."""
        if not self._connected:
            return
        self._connected = False
        try:
            if self._mt5 is not None:
                self._mt5.shutdown()
        finally:
            if self._injected_module is None:
                self._mt5 = None

    def start(
        self, watchlist: Sequence[str] | None = None
    ) -> dict[str, ResolvedSymbol]:
        """Full startup: connect, guard, resolve §7.1, freeze the §10.1 clock.

        Returns the resolution map keyed by broker-resolved name. The ordering
        is not incidental — the offset measurement needs a resolved symbol to
        quote, and every bar call needs the frozen clock.
        """
        self.connect()
        names = list(watchlist) if watchlist is not None else self.watchlist_from_config()
        self.resolve_watchlist(names)
        self.measure_server_clock()
        return dict(self._resolved)

    @property
    def account(self) -> AccountIdentity:
        if self._account is None:
            raise MDTAlphaFXError("not connected: account identity is unresolved")
        return self._account

    def _require_module(self) -> Any:
        if self._mt5 is None or not self._connected:
            raise MDTAlphaFXError(
                "MT5Connector is not connected. Call connect() or start() first."
            )
        return self._mt5

    def _describe_last_error(self) -> str:
        try:
            return str(self._mt5.last_error())  # type: ignore[union-attr]
        except Exception:  # pragma: no cover - diagnostics must never mask
            return "<last_error() unavailable>"

    def _read_account_identity(self) -> AccountIdentity:
        info = self._mt5.account_info()  # type: ignore[union-attr]
        if info is None:
            raise MDTAlphaFXError(
                f"account_info() returned None after initialize(): "
                f"{self._describe_last_error()}. Rule 5 cannot be evaluated, so "
                f"the session is refused."
            )
        missing = [
            field
            for field in ("login", "server", "trade_mode", "currency")
            if getattr(info, field, None) is None
        ]
        if missing:
            raise MDTAlphaFXError(
                f"account_info() is missing {missing}. Rule 5 cannot be "
                f"evaluated without trade_mode, so the session is refused."
            )
        return AccountIdentity(
            login=int(info.login),
            server=str(info.server),
            trade_mode=int(info.trade_mode),
            currency=str(info.currency),
        )

    # ------------------------------------------------------- §7.1 symbols

    def watchlist_from_config(self) -> list[str]:
        """`symbols.watchlist`. `watchlist_pending` is deliberately excluded —
        it holds an unresolved operator decision and reading it raises."""
        watchlist = self._config.get("symbols.watchlist")
        if not isinstance(watchlist, list) or not watchlist:
            raise MDTAlphaFXError("symbols.watchlist must be a non-empty list")
        return [str(name) for name in watchlist]

    def suffix_candidates(self) -> list[str]:
        candidates = self._config.get("symbols.suffix_candidates")
        if not isinstance(candidates, list) or not candidates:
            raise MDTAlphaFXError(
                "symbols.suffix_candidates must be a non-empty list. §7.1 "
                "resolution has nothing to probe without it."
            )
        return [str(suffix) for suffix in candidates]

    def resolve_watchlist(
        self, watchlist: Sequence[str] | None = None
    ) -> dict[str, ResolvedSymbol]:
        """Resolve every name, keyed by the broker-resolved name."""
        names = list(watchlist) if watchlist is not None else self.watchlist_from_config()
        for base in names:
            self.resolve_symbol(base)
        return dict(self._resolved)

    def resolve_symbol(self, base_name: str) -> ResolvedSymbol:
        """§7.1. Probe base name then each suffix; first `symbol_info()` wins.

        Raises `SymbolResolutionError` when nothing resolves, or when the
        broker's answer is incomplete. There is no fallback and no default:
        "Never assume digits, point value, or lot step."
        """
        cached = self._resolved.get(self._aliases.get(base_name, base_name))
        if cached is not None:
            return cached

        mt5 = self._require_module()
        tried: list[str] = []
        for suffix in self.suffix_candidates():
            candidate = f"{base_name}{suffix}"
            tried.append(candidate)
            info = mt5.symbol_info(candidate)
            if info is None:
                # Some builds only expose a symbol after it is added to Market
                # Watch. Select, then ask again — and only then give up on it.
                try:
                    selected = bool(mt5.symbol_select(candidate, True))
                except Exception:
                    selected = False
                if not selected:
                    continue
                info = mt5.symbol_info(candidate)
                if info is None:
                    continue
            else:
                # Selection is not cosmetic: `trade_tick_value` is documented to
                # be populated only for symbols in Market Watch, and a zero
                # tick_value would size an unbounded position in §7.2.
                try:
                    mt5.symbol_select(candidate, True)
                except Exception:
                    pass
                refreshed = mt5.symbol_info(candidate)
                if refreshed is not None:
                    info = refreshed

            resolved = self._build_resolved_symbol(base_name, info, tuple(tried))
            self._resolved[resolved.name] = resolved
            self._aliases[base_name] = resolved.name
            self._aliases[resolved.name] = resolved.name
            return resolved

        raise SymbolResolutionError(
            f"§7.1: could not resolve '{base_name}'. Tried {tried}. "
            f"Near matches on this broker: {self._near_matches(base_name)}. "
            f"Add the correct suffix to symbols.suffix_candidates, or correct "
            f"the watchlist entry. The engine will not guess a symbol name."
        )

    def _near_matches(self, base_name: str) -> list[str]:
        """Diagnostics only. Never used to resolve — only to help the operator."""
        try:
            found = self._mt5.symbols_get(f"*{base_name}*")  # type: ignore[union-attr]
        except Exception:
            return []
        if not found:
            return []
        names = sorted(str(getattr(sym, "name", sym)) for sym in found)
        return names[:_MAX_NEAR_MATCHES]

    def _build_resolved_symbol(
        self, requested: str, info: Any, tried: tuple[str, ...]
    ) -> ResolvedSymbol:
        values: dict[str, Any] = {}
        missing: list[str] = []
        invalid: list[str] = []

        for field, source in _SPEC_FIELD_SOURCE.items():
            raw = getattr(info, source, None)
            if raw is None:
                missing.append(f"{field} (symbol_info.{source})")
                continue
            values[field] = raw

        if missing:
            raise SymbolResolutionError(
                f"§7.1: symbol_info('{getattr(info, 'name', requested)}') is "
                f"missing required SymbolSpec fields: {missing}. "
                f"Fail loudly — never assume digits, point value, or lot step."
            )

        name = str(values["name"]).strip()
        if not name:
            raise SymbolResolutionError(
                f"§7.1: symbol_info() for '{requested}' returned an empty name."
            )
        values["name"] = name

        # Errors name both vocabularies — the §2 contract field and the
        # symbol_info attribute it came from — so a rejection is traceable back
        # to the broker call without reading this file.
        for field in sorted(_SPEC_MUST_BE_POSITIVE):
            source = _SPEC_FIELD_SOURCE[field]
            try:
                numeric = float(values[field])
            except (TypeError, ValueError):
                invalid.append(
                    f"{field} (symbol_info.{source})={values[field]!r} (not numeric)"
                )
                continue
            if not (numeric > 0.0):
                invalid.append(
                    f"{field} (symbol_info.{source})={numeric!r} (must be > 0)"
                )
            values[field] = numeric

        for field in sorted(_SPEC_MUST_BE_NON_NEGATIVE):
            source = _SPEC_FIELD_SOURCE[field]
            try:
                integral = int(values[field])
            except (TypeError, ValueError):
                invalid.append(
                    f"{field} (symbol_info.{source})={values[field]!r} "
                    f"(not an integer)"
                )
                continue
            if integral < 0:
                invalid.append(
                    f"{field} (symbol_info.{source})={integral!r} (must be >= 0)"
                )
            values[field] = integral

        if invalid:
            raise SymbolResolutionError(
                f"§7.1: symbol_info('{name}') returned unusable values: "
                f"{invalid}. A zero point, tick_size, tick_value, contract_size "
                f"or volume_step is an absence wearing a number — §7.2 lot "
                f"sizing divides by every one of them. Refusing the symbol."
            )

        if values["volume_min"] > values["volume_max"]:
            raise SymbolResolutionError(
                f"§7.1: symbol_info('{name}') reports volume_min "
                f"{values['volume_min']} > volume_max {values['volume_max']}."
            )

        swaps: dict[str, float] = {}
        swap_missing: list[str] = []
        for field, source in _SWAP_FIELD_SOURCE.items():
            raw = getattr(info, source, None)
            if raw is None:
                swap_missing.append(f"{field} (symbol_info.{source})")
                continue
            try:
                swaps[field] = float(raw)
            except (TypeError, ValueError):
                swap_missing.append(f"{field}={raw!r} (not numeric)")
        if swap_missing:
            raise SymbolResolutionError(
                f"§7.1: symbol_info('{name}') is missing swap rates "
                f"{swap_missing}. costs.yaml declares swap.source: SYMBOL_INFO, "
                f"so §11.2 has no other source for them. Zero is not a default — "
                f"a zero swap is a cost the backtest will not charge."
            )

        return ResolvedSymbol(
            requested_name=requested,
            spec=SymbolSpec(**values),
            swap_long=swaps["swap_long"],
            swap_short=swaps["swap_short"],
            resolved_at=utc_now(),
            tried=tried,
        )

    @property
    def resolved_symbols(self) -> dict[str, ResolvedSymbol]:
        return dict(self._resolved)

    def resolved(self, name: str) -> ResolvedSymbol:
        """Look up a resolution by either the requested or the broker name."""
        key = self._aliases.get(name, name)
        try:
            return self._resolved[key]
        except KeyError as exc:
            raise SymbolResolutionError(
                f"'{name}' has not been resolved. Call resolve_symbol() or "
                f"start() before asking for its spec."
            ) from exc

    # ------------------------------------------------------- §10.1 clock

    @property
    def server_clock(self) -> ServerClock:
        if self._clock is None:
            raise MDTAlphaFXError(
                "the server clock has not been measured. §10.1: resolve the "
                "server offset explicitly at startup. Call measure_server_clock()."
            )
        return self._clock

    def measure_server_clock(
        self, probe_symbols: Sequence[str] | None = None
    ) -> ServerClock:
        """§10.1. Measure server-vs-UTC once, round to minutes, freeze.

        The measurement compares the terminal's most recently updated quote time
        against UTC read at the same instant. The residual after rounding to a
        whole minute is the staleness of that quote, and it is checked against
        `engine.time.server_offset_measure_tolerance_seconds`: a quote that is
        stale by more than the tolerance cannot distinguish "the server is two
        hours ahead" from "the market closed two hours ago", so the measurement
        is refused rather than guessed.

        Idempotent by design. §10.1 says do not infer the offset per-call, and a
        recomputation is exactly how a DST transition becomes invisible — the
        offset simply changes underneath and every session window shifts an hour
        with no error raised.
        """
        if self._clock is not None:
            return self._clock

        mt5 = self._require_module()
        tolerance = float(
            self._config.get("engine.time.server_offset_measure_tolerance_seconds")
        )

        names = list(probe_symbols) if probe_symbols else list(self._resolved)
        if not names:
            raise MDTAlphaFXError(
                "§10.1: no symbol to quote for the server-offset measurement. "
                "Resolve the watchlist (§7.1) before measuring the clock."
            )

        best_delta: float | None = None
        best_symbol: str | None = None
        failures: list[str] = []

        for name in names:
            tick = mt5.symbol_info_tick(name)
            read_at = utc_now()
            if tick is None:
                failures.append(f"{name}: symbol_info_tick() returned None")
                continue
            server_epoch = _tick_epoch_seconds(tick)
            if server_epoch is None:
                failures.append(f"{name}: tick carries no usable time")
                continue
            # The integer is the server's wall clock labelled as UTC. Reading it
            # back with tz=UTC recovers the wall clock exactly, with no local
            # timezone anywhere in the path.
            server_wall = datetime.fromtimestamp(server_epoch, tz=UTC)
            delta_seconds = (server_wall - read_at).total_seconds()
            # A stale quote lags, so it understates the offset. The freshest
            # quote is the one with the largest delta.
            if best_delta is None or delta_seconds > best_delta:
                best_delta = delta_seconds
                best_symbol = name

        if best_delta is None or best_symbol is None:
            raise DataIntegrityError(
                f"§10.1: no symbol produced a usable quote time, so the server "
                f"offset cannot be measured. Probes: {failures}. The spec does "
                f"not specify a fallback and the engine will not assume UTC — "
                f"an assumed offset shifts every session window silently."
            )

        offset_minutes = int(round(best_delta / 60.0))
        residual = abs(best_delta - offset_minutes * 60.0)
        if residual > tolerance:
            raise DataIntegrityError(
                f"§10.1: server offset measurement rejected. Freshest quote "
                f"({best_symbol}) implies {best_delta:.1f}s, which is "
                f"{residual:.1f}s away from the nearest whole minute "
                f"({offset_minutes} min) — beyond the configured tolerance of "
                f"{tolerance:.1f}s (engine.time."
                f"server_offset_measure_tolerance_seconds). The usual cause is "
                f"that the market is closed and every quote is stale, in which "
                f"case the offset genuinely cannot be measured from quote times. "
                f"The engine will not guess it."
            )

        self._clock = ServerClock(
            offset_minutes=offset_minutes,
            measured_at=utc_now(),
            server_timezone_hint=_offset_hint(offset_minutes),
        )
        return self._clock

    # --------------------------------------------------------------- bars

    def bars(
        self,
        symbol: str,
        timeframe: Timeframe,
        start: datetime,
        end: datetime,
    ) -> list[Candle]:
        """Bars with `start <= bar.time < end`, ascending, UTC.

        `copy_rates_range` is inclusive at both ends, so the upper bound is
        filtered here to match the `BarSource` contract's half-open window.
        """
        mt5 = self._require_module()
        clock = self.server_clock
        name = self._broker_name(symbol)

        start_utc = ensure_utc(start)
        end_utc = ensure_utc(end)
        if end_utc <= start_utc:
            return []

        rates = mt5.copy_rates_range(
            name,
            mt5_timeframe(mt5, timeframe),
            _as_server_bound(clock, start_utc),
            _as_server_bound(clock, end_utc),
        )
        candles = self._rates_to_candles(name, timeframe, rates)
        return [candle for candle in candles if start_utc <= candle.time < end_utc]

    def bars_from_pos(
        self,
        symbol: str,
        timeframe: Timeframe,
        count: int,
        start_pos: int = 0,
    ) -> list[Candle]:
        """The most recent `count` bars, offset `start_pos` from the current bar.

        Used by the probe and recorder scripts, where "the last N bars" is a more
        honest request than a date range against unknown history depth.
        """
        mt5 = self._require_module()
        self.server_clock  # fail here rather than mid-conversion
        name = self._broker_name(symbol)
        rates = mt5.copy_rates_from_pos(
            name, mt5_timeframe(mt5, timeframe), int(start_pos), int(count)
        )
        return self._rates_to_candles(name, timeframe, rates)

    def _broker_name(self, symbol: str) -> str:
        """Accept either the requested or the broker-resolved name."""
        return self._aliases.get(symbol, symbol)

    def _rates_to_candles(
        self, name: str, timeframe: Timeframe, rates: Any
    ) -> list[Candle]:
        if rates is None:
            raise DataIntegrityError(
                f"copy_rates for {name} {timeframe.value} returned None: "
                f"{self._describe_last_error()}"
            )
        if len(rates) == 0:
            return []

        fields = _rate_field_names(rates)
        # §11.2 makes spread mandatory, not optional. A rates array without the
        # column cannot be repaired downstream, and substituting zero is the
        # frictionless backtest §11.2 exists to prevent.
        if fields is not None and "spread" not in fields:
            raise DataIntegrityError(
                f"copy_rates for {name} {timeframe.value} returned no 'spread' "
                f"column (fields: {sorted(fields)}). §11.2 requires per-bar "
                f"recorded spread; there is no substitute for it."
            )

        clock = self.server_clock
        candles: list[Candle] = []
        for rate in rates:
            server_wall = datetime.fromtimestamp(int(rate["time"]), tz=UTC).replace(
                tzinfo=None
            )
            candles.append(
                Candle(
                    time=clock.to_utc(server_wall),
                    open=float(rate["open"]),
                    high=float(rate["high"]),
                    low=float(rate["low"]),
                    close=float(rate["close"]),
                    tick_volume=int(rate["tick_volume"]),
                    spread=int(rate["spread"]),
                )
            )
        candles.sort(key=lambda candle: candle.time)
        return candles

    # -------------------------------------------------------- diagnostics

    def probe_symbol_names(self, names: Iterable[str]) -> dict[str, ResolvedSymbol | str]:
        """Try to resolve each name, recording the failure text instead of raising.

        For `scripts/probe_symbols.py`, whose entire job is to report what a
        broker does and does not expose. Nothing in the engine path uses this —
        §7.1 resolution failure is fatal there.
        """
        report: dict[str, ResolvedSymbol | str] = {}
        for name in names:
            try:
                report[name] = self.resolve_symbol(name)
            except SymbolResolutionError as exc:
                report[name] = str(exc)
        return report

    def current_spread_points(self, symbol: str) -> int | None:
        """`symbol_info().spread` in points, or None when unavailable.

        A single instantaneous sample. It informs `max_spread_points` but does
        not settle it — see the distribution in `scripts/probe_symbols.py`.
        """
        mt5 = self._require_module()
        info = mt5.symbol_info(self._broker_name(symbol))
        if info is None:
            return None
        spread = getattr(info, "spread", None)
        return None if spread is None else int(spread)


def _tick_epoch_seconds(tick: Any) -> float | None:
    """Server quote time in epoch seconds, preferring millisecond precision.

    `time_msc` matters: the integer `time` field quantises to a whole second,
    which alone can consume most of a 5-second measurement tolerance.
    """
    time_msc = getattr(tick, "time_msc", None)
    if time_msc:
        return float(time_msc) / 1000.0
    seconds = getattr(tick, "time", None)
    if seconds:
        return float(seconds)
    return None


def _offset_hint(offset_minutes: int) -> str:
    sign = "+" if offset_minutes >= 0 else "-"
    magnitude = abs(offset_minutes)
    return f"UTC{sign}{magnitude // 60:02d}:{magnitude % 60:02d}"


def _as_server_bound(clock: ServerClock, moment: datetime) -> datetime:
    """A UTC instant as the aware value `copy_rates_range` actually wants.

    Two conversions, in this order:

    1. UTC -> server wall clock, because the terminal compares against integers
       built from its own wall clock.
    2. Label that wall clock as UTC, because the MT5 package converts an aware
       datetime to a POSIX timestamp. Labelling it UTC makes that conversion the
       identity. A *naive* datetime here would be interpreted in the local
       machine timezone, which silently shifts the window on any machine not
       running on server time.
    """
    return clock.from_utc(moment).replace(tzinfo=UTC)


def _rate_field_names(rates: Any) -> set[str] | None:
    """Column names of an MT5 rates array, or None if they cannot be read."""
    dtype = getattr(rates, "dtype", None)
    names = getattr(dtype, "names", None)
    if names is None:
        return None
    return set(names)


__all__ = [
    "MT5Connector",
    "ResolvedSymbol",
    "load_mt5_module",
    "mt5_timeframe",
]
