"""§11.2 — cost modelling. All four costs are mandatory.

    "Frictionless backtests are the most common source of strategies that work
    in testing and lose in production."

| Cost       | Treatment                                                          |
|------------|--------------------------------------------------------------------|
| Spread     | Per-bar recorded spread from the store, **not a constant**. Entry
               fills at ask (buy) or bid (sell).                                |
| Commission | Per-lot, per-side, from broker config.                             |
| Swap       | Per position per rollover; long and short rates differ.            |
| Slippage   | 0 for limit orders, `slippage_points` for market and stop orders.  |

**The run refuses to start rather than running frictionless.** `CostModel` reads
and validates every key it will ever need in its constructor, before a single
bar is walked. Several of those keys are `"<OPERATOR DECISION>"` sentinels that
`Config.get` raises on — that is the intended behaviour, not a defect. A
backtest that cannot price its own friction produces a number that looks like
an edge and is not one, and the only safe failure mode is refusing to produce
it at all.

**Slippage is `ADVERSE_ONLY`.** Never in favour of the trade, in either
direction, on entry or on exit. A model that slips favourably is not modelling
slippage; it is manufacturing edge.

Units
-----
Spread and slippage move a *price*, so they are absorbed into the fill and are
already inside any R computed from that fill. Commission and swap are
*currency* amounts per lot, so they cannot be absorbed into a price without a
position size. `to_price` converts them using §7.2's `value_per_point`
identity, given an explicit volume — the caller supplies it, this module never
invents one.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum

from ..contracts import Candle, Direction, SymbolSpec
from ..core.config import Config
from ..core.errors import ConfigError
from ..core.timeutil import ensure_utc

_WEEKDAY_NAMES = (
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
)
_WEEKEND = ("SATURDAY", "SUNDAY")


class OrderKind(str, Enum):
    """Which slippage row of §11.2's table applies."""

    MARKET = "MARKET"
    LIMIT = "LIMIT"
    STOP = "STOP"


class PriceSide(str, Enum):
    BID = "BID"
    ASK = "ASK"


class OhlcBasis(str, Enum):
    """What the stored OHLC represents. See AMBIGUITY-B01 — the spec is silent
    and the answer moves every fill by up to a full spread."""

    BID = "BID"
    MID = "MID"


class SpreadCharge(str, Enum):
    """Whether the exit pays the opposing side of the spread. AMBIGUITY-B02."""

    ROUND_TRIP = "ROUND_TRIP"
    ENTRY_ONLY = "ENTRY_ONLY"


class SwapUnit(str, Enum):
    POINTS = "POINTS"
    ACCOUNT_CURRENCY = "ACCOUNT_CURRENCY"


class WeekendRollovers(str, Enum):
    CHARGED = "CHARGED"
    SKIPPED = "SKIPPED"


@dataclass(frozen=True)
class SwapRates:
    """Long and short rates, per lot per night. §11.2: "long and short rates
    differ" — so they are two numbers, never one signed number.

    Sign convention is the broker's: negative is a charge, positive a credit.
    Nothing here flips a sign, because a positive carry is real and silently
    negating it would hide it.
    """

    long: float
    short: float
    unit: SwapUnit


@dataclass(frozen=True)
class TradeCosts:
    """Every cost of one round trip, each in its own unit.

    Kept apart rather than netted into one number because they answer different
    questions: spread and slippage say whether the *fill* was realistic, and
    commission and swap say whether the *account* survives the strategy.
    """

    spread_points_entry: int
    spread_points_exit: int
    spread_price_entry: float
    spread_price_exit: float
    slippage_price_entry: float
    slippage_price_exit: float
    commission_ccy: float
    swap_ccy: float
    rollover_nights: int
    triple_nights: int

    @property
    def currency_total(self) -> float:
        return self.commission_ccy + self.swap_ccy


class CostModel:
    """Prices friction for one symbol. Constructed once per run, before it.

    Reads config eagerly so an unresolved operator decision fails at
    construction, not two thousand bars into a replay.
    """

    def __init__(
        self,
        config: Config,
        symbol: str,
        spec: SymbolSpec,
        swap_rates: SwapRates | None = None,
    ):
        self._symbol = symbol
        self._spec = spec

        # -------------------------------------------------------- spread
        if config.get("costs.spread.use_constant") is not False:
            raise ConfigError(
                "costs.spread.use_constant is not false. §11.2 requires the "
                "per-bar recorded spread from the historical store, not a "
                "constant. The store carries `Candle.spread` precisely so this "
                "can be false."
            )
        self._buy_side = _enum(
            PriceSide, config.get("costs.spread.buy_fills_at"), "costs.spread.buy_fills_at"
        )
        self._sell_side = _enum(
            PriceSide,
            config.get("costs.spread.sell_fills_at"),
            "costs.spread.sell_fills_at",
        )
        if self._buy_side is self._sell_side:
            raise ConfigError(
                "costs.spread.buy_fills_at and sell_fills_at are the same side. "
                "§11.2: 'Entry fills at ask (buy) or bid (sell).'"
            )
        self._ohlc_basis = _enum(
            OhlcBasis, config.get("costs.spread.ohlc_basis"), "costs.spread.ohlc_basis"
        )
        self._spread_charge = _enum(
            SpreadCharge, config.get("costs.spread.charge_on"), "costs.spread.charge_on"
        )

        # ---------------------------------------------------- commission
        # Per lot, per side. Symbol-scoped: the rate on gold is not the rate on
        # a major, and one rate for both is a modelling error the aggregate hides.
        self._commission_per_lot_per_side = _as_float(
            config.get(f"costs.commission.per_lot_per_side.{symbol}"),
            f"costs.commission.per_lot_per_side.{symbol}",
        )

        # ------------------------------------------------------ slippage
        direction_policy = config.get("costs.slippage.direction")
        if direction_policy != "ADVERSE_ONLY":
            raise ConfigError(
                f"costs.slippage.direction is {direction_policy!r}. Only "
                f"'ADVERSE_ONLY' is implemented — slippage in favour of the "
                f"trade is not slippage, it is manufactured edge."
            )
        self._slippage_points = {
            OrderKind.LIMIT: _as_float(
                config.get("costs.slippage.limit_order_points"),
                "costs.slippage.limit_order_points",
            ),
            OrderKind.MARKET: _as_float(
                config.get("costs.slippage.market_order_points"),
                "costs.slippage.market_order_points",
            ),
            OrderKind.STOP: _as_float(
                config.get("costs.slippage.stop_order_points"),
                "costs.slippage.stop_order_points",
            ),
        }
        for kind, points in self._slippage_points.items():
            if points < 0:
                raise ConfigError(
                    f"costs.slippage for {kind.value} is negative ({points}). "
                    f"Slippage is a magnitude; its sign is decided by the trade "
                    f"direction, never by config."
                )

        # ---------------------------------------------------------- swap
        rollover_hour = config.get("costs.swap.rollover_hour_utc")
        if not isinstance(rollover_hour, int) or not 0 <= rollover_hour <= 23:
            raise ConfigError(
                f"costs.swap.rollover_hour_utc must be an integer hour 0..23 in "
                f"UTC (rule 3), got {rollover_hour!r}."
            )
        self._rollover_hour = rollover_hour

        triple_weekday = config.get("costs.swap.triple_swap_weekday")
        if not isinstance(triple_weekday, str) or triple_weekday.upper() not in _WEEKDAY_NAMES:
            raise ConfigError(
                f"costs.swap.triple_swap_weekday must be a weekday name in "
                f"{list(_WEEKDAY_NAMES)}, got {triple_weekday!r}. An integer is "
                f"rejected deliberately: Monday=0 and Sunday=0 are both common "
                f"conventions and the off-by-one fails silently."
            )
        self._triple_weekday = triple_weekday.upper()

        self._weekend_rollovers = _enum(
            WeekendRollovers,
            config.get("costs.swap.weekend_rollovers"),
            "costs.swap.weekend_rollovers",
        )

        self._swap_rates = swap_rates or _swap_rates_from_config(config, symbol)

    # ------------------------------------------------------------- helpers

    @property
    def value_per_point(self) -> float:
        """Value of one point, for one lot, in account currency.

        §7.2's identity verbatim. Every field comes from `SymbolSpec`, resolved
        from `symbol_info()` at startup — nothing here is assumed.
        """
        return self._spec.tick_value * (self._spec.point / self._spec.tick_size)

    def spread_price(self, bar: Candle) -> float:
        """The bar's recorded spread, in price units. §11.2: per bar, not
        constant."""
        if bar.spread < 0:
            raise ConfigError(
                f"negative recorded spread ({bar.spread}) on the bar at "
                f"{ensure_utc(bar.time).isoformat()}."
            )
        return bar.spread * self._spec.point

    def to_price(self, currency_amount: float, volume: float) -> float:
        """Convert an account-currency amount into price units for `volume` lots.

        Needed because §11.4 asks for expectancy in **R** while §11.2 states
        commission and swap in **account currency**, and neither section says how
        the two meet (AMBIGUITY-B05). This conversion is offered so both can be
        reported; it does not decide which the headline figure is.

        Two steps, and both matter: `value_per_point` converts currency to
        *points*, and `spec.point` converts points to *price*. Stopping after the
        first step returns a number that looks like a price and is off by a
        factor of 1/point — a hundredfold on a 2-digit symbol.
        """
        if volume <= 0:
            raise ValueError("volume must be positive to convert currency to price")
        points = currency_amount / (volume * self.value_per_point)
        return points * self._spec.point

    # -------------------------------------------------------------- fills

    def fill_side(self, direction: Direction, *, is_exit: bool) -> PriceSide:
        """Which side of the spread this leg trades on.

        A BUY position is opened by buying (ask) and closed by selling (bid).
        The exit is the opposing leg, so it is derived by inversion rather than
        configured separately — two independent knobs would let a config express
        a trade that pays no spread at all.
        """
        effective = direction
        if is_exit:
            effective = Direction.SELL if direction is Direction.BUY else Direction.BUY
        return self._buy_side if effective is Direction.BUY else self._sell_side

    def spread_adjustment(
        self, direction: Direction, bar: Candle, *, is_exit: bool
    ) -> float:
        """Signed price adjustment from the spread, for one leg."""
        if is_exit and self._spread_charge is SpreadCharge.ENTRY_ONLY:
            return 0.0

        full = self.spread_price(bar)
        side = self.fill_side(direction, is_exit=is_exit)

        if self._ohlc_basis is OhlcBasis.BID:
            # Stored prices are bid. The bid side needs no adjustment; the ask
            # side is a full spread above it.
            return full if side is PriceSide.ASK else 0.0

        # Stored prices are mid. Each side is half a spread away.
        half = full / 2.0
        return half if side is PriceSide.ASK else -half

    def slippage_adjustment(
        self, direction: Direction, order_kind: OrderKind, *, is_exit: bool
    ) -> float:
        """Signed price adjustment from slippage. Always against the trade.

        §11.2 tabulates slippage by *order type*, so the mapping to an exit
        follows from what the exit order is: a stop-loss is a stop order, a
        take-profit is a limit order. See AMBIGUITY-B05 note (b).
        """
        magnitude = self._slippage_points[order_kind] * self._spec.point
        if magnitude == 0.0:
            return 0.0

        # Adverse means "a worse price for the position holder". Opening a BUY
        # adverse is higher; closing that same BUY adverse is lower.
        buying = (direction is Direction.BUY) != is_exit
        return magnitude if buying else -magnitude

    def entry_fill(
        self,
        *,
        reference_price: float,
        direction: Direction,
        order_kind: OrderKind,
        bar: Candle,
    ) -> float:
        return reference_price + self.spread_adjustment(
            direction, bar, is_exit=False
        ) + self.slippage_adjustment(direction, order_kind, is_exit=False)

    def exit_fill(
        self,
        *,
        reference_price: float,
        direction: Direction,
        order_kind: OrderKind,
        bar: Candle,
    ) -> float:
        return reference_price + self.spread_adjustment(
            direction, bar, is_exit=True
        ) + self.slippage_adjustment(direction, order_kind, is_exit=True)

    # --------------------------------------------------------- commission

    def commission(self, volume: float, *, sides: int = 2) -> float:
        """Per lot, per side. A round trip is two sides."""
        if volume <= 0:
            raise ValueError("volume must be positive")
        return self._commission_per_lot_per_side * volume * sides

    # --------------------------------------------------------------- swap

    def count_rollovers(
        self, opened_at: datetime, closed_at: datetime
    ) -> tuple[int, int]:
        """(nights, triple_nights) crossed by a position held over `(open, close]`.

        Rollover instants are `rollover_hour_utc:00` UTC (rule 3 — the hour is
        configured in UTC, never in server time, because a server-time hour
        moves under DST and the swap bill silently changes with it).
        """
        opened_at = ensure_utc(opened_at)
        closed_at = ensure_utc(closed_at)
        if closed_at < opened_at:
            raise ValueError("closed_at precedes opened_at")

        nights = 0
        triple = 0
        cursor = opened_at.replace(
            hour=self._rollover_hour, minute=0, second=0, microsecond=0
        )
        if cursor <= opened_at:
            cursor += timedelta(days=1)

        while cursor <= closed_at:
            weekday = _WEEKDAY_NAMES[cursor.weekday()]
            skip = (
                weekday in _WEEKEND
                and self._weekend_rollovers is WeekendRollovers.SKIPPED
            )
            if not skip:
                nights += 1
                if weekday == self._triple_weekday:
                    triple += 1
            cursor += timedelta(days=1)

        return nights, triple

    def swap(
        self,
        *,
        volume: float,
        direction: Direction,
        opened_at: datetime,
        closed_at: datetime,
    ) -> tuple[float, int, int]:
        """Total swap in account currency, plus the night counts behind it.

        A triple night is charged three times, so the effective count is
        `nights + 2 * triple_nights`.
        """
        if volume <= 0:
            raise ValueError("volume must be positive")
        nights, triple = self.count_rollovers(opened_at, closed_at)
        charged = nights + 2 * triple

        rate = (
            self._swap_rates.long
            if direction is Direction.BUY
            else self._swap_rates.short
        )
        if self._swap_rates.unit is SwapUnit.POINTS:
            per_lot_per_night = rate * self.value_per_point
        else:
            per_lot_per_night = rate

        return per_lot_per_night * volume * charged, nights, triple

    # -------------------------------------------------------- round trips

    def round_trip(
        self,
        *,
        volume: float,
        direction: Direction,
        entry_bar: Candle,
        exit_bar: Candle,
        entry_order_kind: OrderKind,
        exit_order_kind: OrderKind,
        opened_at: datetime,
        closed_at: datetime,
    ) -> TradeCosts:
        swap_ccy, nights, triple = self.swap(
            volume=volume,
            direction=direction,
            opened_at=opened_at,
            closed_at=closed_at,
        )
        return TradeCosts(
            spread_points_entry=entry_bar.spread,
            spread_points_exit=exit_bar.spread,
            spread_price_entry=abs(
                self.spread_adjustment(direction, entry_bar, is_exit=False)
            ),
            spread_price_exit=abs(
                self.spread_adjustment(direction, exit_bar, is_exit=True)
            ),
            slippage_price_entry=abs(
                self.slippage_adjustment(direction, entry_order_kind, is_exit=False)
            ),
            slippage_price_exit=abs(
                self.slippage_adjustment(direction, exit_order_kind, is_exit=True)
            ),
            commission_ccy=self.commission(volume),
            swap_ccy=swap_ccy,
            rollover_nights=nights,
            triple_nights=triple,
        )


# --------------------------------------------------------------- config glue


def _enum(enum_cls, value, key: str):
    try:
        return enum_cls(value)
    except ValueError as exc:
        raise ConfigError(
            f"{key} is {value!r}; expected one of "
            f"{[member.value for member in enum_cls]}."
        ) from exc


def _as_float(value, key: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ConfigError(f"{key} must be a number, got {value!r}.")
    if math.isnan(value) or math.isinf(value):
        raise ConfigError(f"{key} is not finite.")
    return float(value)


def _swap_rates_from_config(config: Config, symbol: str) -> SwapRates:
    """Fall back to `costs.swap.rates.<symbol>`.

    `costs.swap.source: SYMBOL_INFO` says these come from the broker and are
    snapshotted with the bars — but `SymbolSpec` (§2, frozen) has no swap fields
    and `BarSource` has no accessor, so Stage 0 cannot reach them. See
    AMBIGUITY-B03. Until that is settled the rates are read from config, and the
    keys are unresolved sentinels, so this raises rather than returning zero.
    A zero swap is a frictionless backtest wearing a disguise.
    """
    unit = _enum(SwapUnit, config.get("costs.swap.rates.unit"), "costs.swap.rates.unit")
    return SwapRates(
        long=_as_float(
            config.get(f"costs.swap.rates.{symbol}.long"),
            f"costs.swap.rates.{symbol}.long",
        ),
        short=_as_float(
            config.get(f"costs.swap.rates.{symbol}.short"),
            f"costs.swap.rates.{symbol}.short",
        ),
        unit=unit,
    )


__all__ = [
    "OrderKind",
    "PriceSide",
    "OhlcBasis",
    "SpreadCharge",
    "SwapUnit",
    "WeekendRollovers",
    "SwapRates",
    "TradeCosts",
    "CostModel",
]
