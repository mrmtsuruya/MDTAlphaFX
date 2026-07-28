"""§7.3 broker constraint checklist, applied to simulated fills.

    §11.2: "Fills obey §7.3. A backtest that fills an order the live system
    would reject on `stops_level`, `volume_min` or a closed session is measuring
    a strategy that cannot be traded."

The six conditions of §7.3, each with its own named rejection reason so a
rejected fill says *which* rule stopped it:

1. SL/TP distance ≥ `stops_level` points from current price → `STOPS_LEVEL`
2. Price not within `freeze_level` of market for modify/cancel → `FREEZE_LEVEL`
3. Volume rounded to `volume_step`, within `[volume_min, volume_max]`
   → `INVALID_VOLUME`
4. Prices normalised to `digits` → `PRICE_NOT_NORMALISED`
5. Current spread ≤ `max_spread_points` → `MAX_SPREAD`
6. Symbol trading session currently open → `MARKET_CLOSED`

**Scope.** This is fill *validation* only. Order placement, lot sizing from
risk %, portfolio guards and the execution manager are Stage 5 (§7.2, §7.4,
§9). Nothing here decides *whether* to trade or *how much* — it only answers
whether a proposed fill is one the live system would have accepted.

**Volume rounds DOWN.** §7.2: "Rounding is down to `volume_step`, never up —
rounding up silently exceeds the risk budget." `round_volume_down` mirrors
§7.2's `math.floor(raw / step)` exactly, and is the only rounding this module
performs.

**Never assume a broker value.** `digits`, `point`, `volume_step`,
`volume_min`, `volume_max`, `stops_level` and `freeze_level` all come from the
`SymbolSpec` resolved by §7.1. `max_spread_points` is not a `symbol_info()`
field — §7.3 requires it but the spec gives no default and Appendix B does not
list it, so it lives in `config/symbols.yaml` as a per-symbol operator decision
and reading it raises until set.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from ..contracts import Candle, SymbolSpec
from ..core.config import Config
from ..core.errors import ConfigError
from ..core.timeutil import SessionWindow, ensure_utc


class RejectReason(str, Enum):
    """One member per §7.3 condition. Named, never a bare boolean — a fill that
    fails silently is indistinguishable from a strategy that did not fire."""

    STOPS_LEVEL = "STOPS_LEVEL"
    FREEZE_LEVEL = "FREEZE_LEVEL"
    INVALID_VOLUME = "INVALID_VOLUME"
    PRICE_NOT_NORMALISED = "PRICE_NOT_NORMALISED"
    MAX_SPREAD = "MAX_SPREAD"
    MARKET_CLOSED = "MARKET_CLOSED"


class Operation(str, Enum):
    """§7.3's second condition applies to modify/cancel, not to opening."""

    OPEN = "OPEN"
    MODIFY = "MODIFY"
    CANCEL = "CANCEL"


class SessionSource(str, Enum):
    """Where §7.3's "symbol trading session currently open" comes from.

    See AMBIGUITY-B07: the spec never says, and `SymbolSpec` (§2, frozen)
    carries no session fields. Only `SESSION_WINDOW_UNION` is implemented.
    """

    SESSION_WINDOW_UNION = "SESSION_WINDOW_UNION"


@dataclass(frozen=True)
class FillValidation:
    """Result of putting a proposed fill through §7.3.

    `reasons` is a list, not an early-exit single value: a fill can violate
    three conditions at once, and reporting only the first makes the operator
    fix them one run at a time.
    """

    accepted: bool
    reasons: tuple[RejectReason, ...] = ()
    detail: tuple[str, ...] = ()

    def __bool__(self) -> bool:  # pragma: no cover - convenience only
        return self.accepted


@dataclass
class _Failures:
    reasons: list[RejectReason] = field(default_factory=list)
    detail: list[str] = field(default_factory=list)

    def add(self, reason: RejectReason, message: str) -> None:
        self.reasons.append(reason)
        self.detail.append(f"{reason.value}: {message}")

    def result(self) -> FillValidation:
        return FillValidation(
            accepted=not self.reasons,
            reasons=tuple(self.reasons),
            detail=tuple(self.detail),
        )


# --------------------------------------------------------------------- volume


def round_volume_down(volume: float, spec: SymbolSpec) -> float:
    """Round to `volume_step`, **downwards**. §7.2.

    Rounding up silently exceeds the risk budget, which is a financial bug
    rather than a rounding preference. Mirrors §7.2's implementation, including
    its 8-decimal tidy-up of binary float residue.
    """
    if spec.volume_step <= 0:
        raise ConfigError(
            f"SymbolSpec for {spec.name} has volume_step={spec.volume_step}. "
            f"This comes from symbol_info() (§7.1) and must be positive."
        )
    if volume < 0:
        raise ValueError("volume must not be negative")
    steps = math.floor(round(volume / spec.volume_step, 8))
    return round(steps * spec.volume_step, 8)


def check_volume(volume: float, spec: SymbolSpec) -> FillValidation:
    """§7.3 condition 3. The caller passes an already-rounded volume; a volume
    that is not a whole number of steps is a rejection, not something this
    function quietly fixes."""
    failures = _Failures()
    rounded = round_volume_down(volume, spec)

    if abs(rounded - volume) > 0:
        failures.add(
            RejectReason.INVALID_VOLUME,
            f"{volume} is not a whole multiple of volume_step {spec.volume_step} "
            f"(rounds DOWN to {rounded})",
        )
    if volume < spec.volume_min:
        failures.add(
            RejectReason.INVALID_VOLUME,
            f"{volume} is below volume_min {spec.volume_min}",
        )
    if volume > spec.volume_max:
        failures.add(
            RejectReason.INVALID_VOLUME,
            f"{volume} is above volume_max {spec.volume_max}",
        )
    return failures.result()


# ---------------------------------------------------------------------- price


def normalise_price(price: float, spec: SymbolSpec) -> float:
    """§7.3 condition 4 — round a price to the symbol's `digits`."""
    return round(price, spec.digits)


def is_normalised(price: float, spec: SymbolSpec) -> bool:
    return price == normalise_price(price, spec)


def check_price_normalised(prices: dict[str, float], spec: SymbolSpec) -> FillValidation:
    """§7.3 condition 4, over a named set of prices so the rejection can say
    *which* price was not normalised."""
    failures = _Failures()
    for name, price in prices.items():
        if not is_normalised(price, spec):
            failures.add(
                RejectReason.PRICE_NOT_NORMALISED,
                f"{name}={price!r} is not normalised to {spec.digits} digits "
                f"(would be {normalise_price(price, spec)!r})",
            )
    return failures.result()


def check_stops_level(
    *,
    price: float,
    stop_loss: float | None,
    take_profit: float | None,
    spec: SymbolSpec,
) -> FillValidation:
    """§7.3 condition 1 — SL/TP at least `stops_level` points from price."""
    failures = _Failures()
    for name, level in (("stop_loss", stop_loss), ("take_profit", take_profit)):
        if level is None:
            continue
        distance_points = abs(price - level) / spec.point
        if distance_points < spec.stops_level:
            failures.add(
                RejectReason.STOPS_LEVEL,
                f"{name} is {distance_points:.1f} points from {price!r}, "
                f"below stops_level {spec.stops_level}",
            )
    return failures.result()


def check_freeze_level(
    *,
    price: float,
    market_price: float,
    spec: SymbolSpec,
    operation: Operation,
) -> FillValidation:
    """§7.3 condition 2 — modify/cancel is refused inside the freeze band.

    Opening is unaffected, so `Operation.OPEN` always passes. The condition is
    implemented here rather than in Stage 5 because §11.2 requires simulated
    fills to obey §7.3, and a backtest that amends a stop the live system would
    have frozen is measuring a strategy that cannot be traded.
    """
    failures = _Failures()
    if operation is Operation.OPEN:
        return failures.result()
    distance_points = abs(price - market_price) / spec.point
    if distance_points < spec.freeze_level:
        failures.add(
            RejectReason.FREEZE_LEVEL,
            f"{operation.value} at {price!r} is {distance_points:.1f} points "
            f"from market {market_price!r}, inside freeze_level "
            f"{spec.freeze_level}",
        )
    return failures.result()


# -------------------------------------------------------------- session gate


class SessionGate:
    """§7.3 condition 6 and §11.4's `session` segmentation, from one source.

    A bar is tagged with **every** window that contains it (`tag_overlaps`), so
    a London/New York overlap bar carries both — §11.4 segments by session and
    an overlap belongs to both populations.

    **What this does not know.** `SESSION_WINDOW_UNION` carries no weekend and
    no holiday calendar. The union of the four configured windows covers the
    whole 24 hours, so this gate would call 03:00 on a Saturday "open". In a
    replay that rarely bites, because the store holds no weekend bars — but it
    would bite on a Sunday-open gap bar, and it is not a substitute for the
    broker's trading sessions. See AMBIGUITY-B07.
    """

    def __init__(self, config: Config):
        source = config.get("backtest.fills.session_source")
        try:
            self._source = SessionSource(source)
        except ValueError as exc:
            raise ConfigError(
                f"backtest.fills.session_source is {source!r}; only "
                f"{[s.value for s in SessionSource]} is implemented. §7.3 does "
                f"not say what supplies the trading calendar (AMBIGUITY-B07) — "
                f"the engine will not invent one."
            ) from exc

        raw = config.section("sessions.sessions")
        # Sorted so tags, and therefore metric segment keys, are deterministic.
        self._windows = tuple(
            SessionWindow.from_config(name, spec) for name, spec in sorted(raw.items())
        )
        if not self._windows:
            raise ConfigError("sessions.sessions is empty")
        self._tag_overlaps = config.get("sessions.tag_overlaps")

    @property
    def windows(self) -> tuple[SessionWindow, ...]:
        return self._windows

    def sessions_at(self, moment: datetime) -> tuple[str, ...]:
        moment = ensure_utc(moment)
        hits = tuple(w.name for w in self._windows if w.contains(moment))
        if not self._tag_overlaps and len(hits) > 1:
            return hits[:1]
        return hits

    def is_open(self, moment: datetime) -> bool:
        return bool(self.sessions_at(moment))

    def check(self, moment: datetime) -> FillValidation:
        """§7.3 condition 6."""
        failures = _Failures()
        if not self.is_open(moment):
            failures.add(
                RejectReason.MARKET_CLOSED,
                f"{ensure_utc(moment).isoformat()} falls outside every "
                f"configured session window "
                f"({', '.join(w.name for w in self._windows)})",
            )
        return failures.result()


# ----------------------------------------------------------------- max spread


class SpreadGate:
    """§7.3 condition 5 — current spread ≤ `max_spread_points`.

    Per symbol: a ceiling that is sane for EURUSD is nonsense for BTCUSD. The
    key is an unresolved operator decision until set, so a run that has not
    decided its spread ceiling refuses rather than filling through a 900-point
    news spread.
    """

    def __init__(self, config: Config, symbol: str):
        value = config.get(f"symbols.max_spread_points.{symbol}")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ConfigError(
                f"symbols.max_spread_points.{symbol} must be a number of points, "
                f"got {value!r}."
            )
        self._max_points = float(value)
        self._symbol = symbol

    @property
    def max_points(self) -> float:
        return self._max_points

    def check(self, bar: Candle) -> FillValidation:
        failures = _Failures()
        if bar.spread > self._max_points:
            failures.add(
                RejectReason.MAX_SPREAD,
                f"recorded spread {bar.spread} on the bar at "
                f"{ensure_utc(bar.time).isoformat()} exceeds max_spread_points "
                f"{self._max_points:g} for {self._symbol}",
            )
        return failures.result()


# ------------------------------------------------------------ the whole check


class BrokerRules:
    """All six §7.3 conditions behind one call, for the replay engine."""

    def __init__(self, config: Config, symbol: str):
        self._enforce = config.get("backtest.fills.enforce_broker_constraints")
        if self._enforce is not True:
            raise ConfigError(
                "backtest.fills.enforce_broker_constraints is not true. §11.2 "
                "requires simulated fills to obey §7.3; a run with it disabled "
                "measures a strategy that cannot be traded."
            )

        # These used to be treated as optional feature flags even while the
        # umbrella switch above was true. That let a config claim broker
        # constraints were enforced while silently bypassing three of §7.3's
        # mandatory checks. Keep the keys so config remains explicit, but refuse
        # every value except the literal boolean True.
        mandatory_checks = {
            "backtest.fills.reject_outside_session": config.get(
                "backtest.fills.reject_outside_session"
            ),
            "backtest.fills.reject_below_stops_level": config.get(
                "backtest.fills.reject_below_stops_level"
            ),
            "backtest.fills.reject_on_spread_exceeded": config.get(
                "backtest.fills.reject_on_spread_exceeded"
            ),
        }
        disabled = [
            key for key, enabled in mandatory_checks.items() if enabled is not True
        ]
        if disabled:
            raise ConfigError(
                "mandatory §7.3 broker checks are not true: "
                + ", ".join(disabled)
                + ". §11.2 requires every simulated fill to obey stops_level, "
                "the spread ceiling and the trading session; these checks cannot "
                "be disabled while broker-constraint enforcement is enabled."
            )

        self._reject_outside_session = True
        self._reject_below_stops_level = True
        self._reject_on_spread = True
        self.sessions = SessionGate(config)
        self.spread = SpreadGate(config, symbol)

    def validate_fill(
        self,
        *,
        bar: Candle,
        price: float,
        stop_loss: float,
        take_profit: float,
        volume: float,
        spec: SymbolSpec,
        moment: datetime,
        operation: Operation = Operation.OPEN,
        market_price: float | None = None,
    ) -> FillValidation:
        """Run every §7.3 condition and collect every failure.

        `moment` is when the fill would occur — the bar's own open time for an
        entry at `NEXT_BAR_OPEN`. UTC, always (rule 3).
        """
        failures = _Failures()

        def absorb(validation: FillValidation) -> None:
            failures.reasons.extend(validation.reasons)
            failures.detail.extend(validation.detail)

        if self._reject_below_stops_level:
            absorb(
                check_stops_level(
                    price=price,
                    stop_loss=stop_loss,
                    take_profit=take_profit,
                    spec=spec,
                )
            )
        absorb(check_volume(volume, spec))
        absorb(
            check_price_normalised(
                {"price": price, "stop_loss": stop_loss, "take_profit": take_profit},
                spec,
            )
        )
        if self._reject_on_spread:
            absorb(self.spread.check(bar))
        if self._reject_outside_session:
            absorb(self.sessions.check(moment))
        if operation is not Operation.OPEN:
            if market_price is None:
                raise ValueError(
                    "market_price is required to check freeze_level on a "
                    f"{operation.value} operation"
                )
            absorb(
                check_freeze_level(
                    price=price,
                    market_price=market_price,
                    spec=spec,
                    operation=operation,
                )
            )

        return failures.result()


__all__ = [
    "RejectReason",
    "Operation",
    "SessionSource",
    "FillValidation",
    "round_volume_down",
    "check_volume",
    "normalise_price",
    "is_normalised",
    "check_price_normalised",
    "check_stops_level",
    "check_freeze_level",
    "SessionGate",
    "SpreadGate",
    "BrokerRules",
]
