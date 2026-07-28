"""§11.1 — intrabar resolution. The central fidelity problem.

    "A candle records where price went, never in what order. When both stop and
    target fall inside one candle's range, OHLC cannot say which was reached
    first."

Resolution order, most to least trusted (§11.1):

1. **Sub-bar walk — required.** Drop to M1 bars inside the ambiguous candle and
   walk them in sequence. The same ambiguity test recurses at M1; if a single
   *M1* candle spans both levels, that is irreducible and there is nothing
   finer in the store to appeal to.
2. **Conservative fallback.** Where M1 is unavailable — gaps, weekends, deep
   history — assume the **stop is hit first** and record the loss. The result
   is flagged `AMBIGUOUS_FILL`.
3. **Never** resolve by assuming the favourable order, and never silently.

Every result carries `path`, so the two causes of ambiguity stay
distinguishable in metrics: a fallback because the store has no M1 for that
window (`FALLBACK_NO_M1` — fixable, download more data) is a different problem
from a fallback because one M1 candle really did span both levels
(`FALLBACK_IRREDUCIBLE` — not fixable at this data resolution). Collapsing them
into one "ambiguity rate" hides which one you have.

Gap fills
---------
A bar may **open beyond a level**. That is not the §11.1 ambiguity: only one
level is crossed at the open, so the order is known. What is *not* known is the
fill price, and **§11.1 does not answer it** — it discusses only which level was
reached first.

The engine's behaviour is therefore driven by `backtest.intrabar.gap_fill`,
which selects between two readings, both implemented here:

- ``GAPPED_PRICE`` — the fill is the bar's **open**, not the level. A gap
  through the stop loses **more** than the stop distance, because there was no
  price at the stop to trade against. A gap through the target pays more than
  the target for the same reason.
- ``LEVEL_PRICE`` — the fill is the level. This understates gap risk and is
  offered only because a naive backtest is a common baseline to compare against.

The configured value is **not** derived from the spec. See AMBIGUITY-B06 in the
Stage 0 handover. Every gapped fill sets `result.gapped`, so the fraction of a
result set that depends on this reading is always countable.

Purity
------
`IntrabarResolver` reads config once at construction and bars through the
`BarSource` protocol. It reads no clock and holds no mutable state, so the same
inputs produce the same output forever (§11.3's determinism requirement, and
§12.1's "no language model participates in resolution — `high >= level` is
exact, reproducible and free").
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from collections.abc import Callable

from ..contracts import Candle, Direction, Timeframe
from ..core.config import Config
from ..core.errors import ConfigError, DataIntegrityError
from ..core.timeutil import ensure_utc, timeframe_delta
from ..data.source import BarSource

# The flag §11.1 names. Written onto `OutcomeRecord.ambiguous_fill` (§2) and
# into the metrics report.
AMBIGUOUS_FILL_FLAG = "AMBIGUOUS_FILL"


class Resolution(str, Enum):
    """Which level price reached first, over the bar under test."""

    STOP_FIRST = "STOP_FIRST"
    TARGET_FIRST = "TARGET_FIRST"
    NEITHER = "NEITHER"


class ResolutionPath(str, Enum):
    """How the answer was arrived at. Never collapsed into a single boolean —
    §11.1's two causes of ambiguity have different remedies."""

    UNAMBIGUOUS = "UNAMBIGUOUS"
    """Only one level lay inside the bar (or the bar opened through one). OHLC
    is sufficient; no assumption was made."""

    SUB_BAR_WALK = "SUB_BAR_WALK"
    """Both levels lay inside the bar and M1 resolved the order. Trusted."""

    FALLBACK_NO_M1 = "FALLBACK_NO_M1"
    """Both levels lay inside the bar and the store has no complete M1 coverage
    for it. Conservative fallback taken. Fixable by acquiring M1 data."""

    FALLBACK_IRREDUCIBLE = "FALLBACK_IRREDUCIBLE"
    """A single M1 candle spanned both levels. Conservative fallback taken.
    Not fixable at this data resolution."""

    @property
    def is_fallback(self) -> bool:
        return self in (
            ResolutionPath.FALLBACK_NO_M1,
            ResolutionPath.FALLBACK_IRREDUCIBLE,
        )


class GapFill(str, Enum):
    GAPPED_PRICE = "GAPPED_PRICE"
    LEVEL_PRICE = "LEVEL_PRICE"


@dataclass(frozen=True)
class IntrabarResult:
    """One bar's verdict. Immutable, and always carries how it was reached."""

    resolution: Resolution
    path: ResolutionPath
    fill_price: float | None
    fill_time: datetime | None
    fill_bar: Candle | None
    """Original stored bar that decided the result (parent or exact M1)."""
    gapped: bool
    detail: str
    """Journal-ready sentence naming the failing or deciding condition. Rule 8
    is about gate rejections, but the same principle applies: an assumption the
    reader cannot see is an assumption they will forget was made."""

    @property
    def ambiguous_fill(self) -> bool:
        """Matches `OutcomeRecord.ambiguous_fill` (§2). True exactly when the
        conservative fallback decided this, rather than evidence."""
        return self.path.is_fallback

    @property
    def resolved(self) -> bool:
        return self.resolution is not Resolution.NEITHER


class _Verdict(str, Enum):
    """Internal — what one candle's OHLC alone can say."""

    NEITHER = "NEITHER"
    STOP = "STOP"
    TARGET = "TARGET"
    BOTH = "BOTH"


class IntrabarResolver:
    """Resolves one bar at a time. The caller walks bars; this decides them.

    §12.1: "One resolver, three callers. The backtester, the live
    counterfactual tracker and the outcome checker are the same component. If
    they diverge, at least two of them are wrong." Nothing in this class knows
    which caller it has.
    """

    def __init__(self, config: Config, source: BarSource):
        self._source = source

        # §11.1 marks the sub-bar walk "(required)". A config that switches it
        # off disables a required behaviour, and the only alternatives §11.1
        # permits are the conservative fallback (which would then be taken on
        # every ambiguous bar, silently mislabelled as a data problem) or
        # assuming the favourable order (prohibited outright). Refuse instead.
        if config.get("backtest.intrabar.require_sub_bar_walk") is not True:
            raise ConfigError(
                "backtest.intrabar.require_sub_bar_walk is not true. §11.1 marks "
                "the sub-bar walk as required; there is no supported behaviour "
                "with it disabled."
            )

        fallback = config.get("backtest.intrabar.fallback")
        if fallback != Resolution.STOP_FIRST.value:
            raise ConfigError(
                f"backtest.intrabar.fallback is {fallback!r}. §11.1 permits only "
                f"'STOP_FIRST' — 'Never resolve by assuming the favourable "
                f"order, and never silently.'"
            )

        if config.get("backtest.intrabar.irreducible_takes_fallback") is not True:
            raise ConfigError(
                "backtest.intrabar.irreducible_takes_fallback is not true. An M1 "
                "candle spanning both levels has no finer evidence to appeal to; "
                "the only §11.1-permitted treatment is the conservative fallback."
            )

        try:
            self._gap_fill = GapFill(config.get("backtest.intrabar.gap_fill"))
        except ValueError as exc:
            raise ConfigError(
                f"backtest.intrabar.gap_fill must be one of "
                f"{[g.value for g in GapFill]}. §11.1 is silent on gap fill "
                f"treatment (AMBIGUITY-B06) — the value is an operator reading, "
                f"not an inference."
            ) from exc

        sub_bar = config.get("engine.timeframes.sub_bar")
        if sub_bar != Timeframe.M1.value:
            raise ConfigError(
                f"engine.timeframes.sub_bar is {sub_bar!r}. The `BarSource` "
                f"protocol exposes `m1_bars`/`has_m1` and nothing finer, so M1 "
                f"is the only sub-bar timeframe this resolver can walk."
            )
        self._sub_bar_timeframe = Timeframe.M1

    # ------------------------------------------------------------------ API

    def resolve(
        self,
        *,
        symbol: str,
        bar: Candle,
        timeframe: Timeframe,
        direction: Direction,
        stop: float,
        target: float,
        price_adjustment: Callable[[Candle], float] | None = None,
    ) -> IntrabarResult:
        """Decide what this bar did to an open position.

        `direction` is the position's direction. For BUY the stop is below the
        target; for SELL, above. A pair that does not satisfy that ordering is a
        caller bug and raises rather than being silently reinterpreted.
        """
        _validate_levels(direction, stop, target)

        executable_bar = _adjust_bar(bar, price_adjustment)
        verdict, level, gapped = _read_bar(
            executable_bar, direction, stop, target
        )

        if verdict is _Verdict.NEITHER:
            return IntrabarResult(
                resolution=Resolution.NEITHER,
                path=ResolutionPath.UNAMBIGUOUS,
                fill_price=None,
                fill_time=None,
                fill_bar=None,
                gapped=False,
                detail="neither level inside the bar's range",
            )

        if verdict is not _Verdict.BOTH:
            resolution = (
                Resolution.STOP_FIRST
                if verdict is _Verdict.STOP
                else Resolution.TARGET_FIRST
            )
            return IntrabarResult(
                resolution=resolution,
                path=ResolutionPath.UNAMBIGUOUS,
                fill_price=self._fill_at(level, executable_bar.open, gapped),
                fill_time=ensure_utc(bar.time),
                fill_bar=bar,
                gapped=gapped,
                detail=(
                    f"{resolution.value} — only that level lay inside the bar"
                    + (
                        f"; bar opened through it, gap_fill="
                        f"{self._gap_fill.value}"
                        if gapped
                        else ""
                    )
                ),
            )

        # Both levels inside one candle. §11.1 begins here.
        if timeframe is self._sub_bar_timeframe:
            # Already at the finest resolution the store holds. This *is* the
            # irreducible case by definition.
            return self._fallback(
                bar,
                stop,
                gapped_open=False,
                path=ResolutionPath.FALLBACK_IRREDUCIBLE,
                detail=(
                    f"a single {self._sub_bar_timeframe.value} candle at "
                    f"{ensure_utc(bar.time).isoformat()} spans both stop and "
                    f"target — irreducible at this data resolution; conservative "
                    f"fallback applied, flagged {AMBIGUOUS_FILL_FLAG}"
                ),
            )

        window_start = ensure_utc(bar.time)
        window_end = window_start + timeframe_delta(timeframe)

        if not self._source.has_m1(symbol, window_start, window_end):
            return self._fallback(
                bar,
                stop,
                gapped_open=False,
                path=ResolutionPath.FALLBACK_NO_M1,
                detail=(
                    f"stop and target both inside the {timeframe.value} candle at "
                    f"{window_start.isoformat()} and the store has no complete M1 "
                    f"coverage for [{window_start.isoformat()}, "
                    f"{window_end.isoformat()}); conservative fallback applied, "
                    f"flagged {AMBIGUOUS_FILL_FLAG}"
                ),
            )

        sub_bars = self._source.m1_bars(symbol, window_start, window_end)
        if not sub_bars:
            # `has_m1` said yes and `m1_bars` returned nothing. That is a broken
            # source, not an ambiguous market — degrading quietly to the
            # fallback would bury a store bug inside the ambiguity rate.
            raise DataIntegrityError(
                f"BarSource.has_m1({symbol}, {window_start.isoformat()}, "
                f"{window_end.isoformat()}) is True but m1_bars returned no bars. "
                f"The source contradicts itself; refusing to resolve."
            )

        return self._walk(
            sub_bars,
            direction,
            stop,
            target,
            price_adjustment=price_adjustment,
        )

    # -------------------------------------------------------------- internals

    def _walk(
        self,
        sub_bars: list[Candle],
        direction: Direction,
        stop: float,
        target: float,
        *,
        price_adjustment: Callable[[Candle], float] | None,
    ) -> IntrabarResult:
        """Walk M1 candles in sequence. First one to touch a level decides."""
        for sub in sub_bars:
            executable_sub = _adjust_bar(sub, price_adjustment)
            verdict, level, gapped = _read_bar(
                executable_sub, direction, stop, target
            )

            if verdict is _Verdict.NEITHER:
                continue

            if verdict is _Verdict.BOTH:
                return self._fallback(
                    sub,
                    stop,
                    gapped_open=False,
                    path=ResolutionPath.FALLBACK_IRREDUCIBLE,
                    detail=(
                        f"sub-bar walk reached the M1 candle at "
                        f"{ensure_utc(sub.time).isoformat()}, which itself spans "
                        f"both stop and target — irreducible; conservative "
                        f"fallback applied, flagged {AMBIGUOUS_FILL_FLAG}"
                    ),
                )

            resolution = (
                Resolution.STOP_FIRST
                if verdict is _Verdict.STOP
                else Resolution.TARGET_FIRST
            )
            return IntrabarResult(
                resolution=resolution,
                path=ResolutionPath.SUB_BAR_WALK,
                fill_price=self._fill_at(level, executable_sub.open, gapped),
                fill_time=ensure_utc(sub.time),
                fill_bar=sub,
                gapped=gapped,
                detail=(
                    f"sub-bar walk: {resolution.value} at the M1 candle "
                    f"{ensure_utc(sub.time).isoformat()}"
                ),
            )

        # The parent bar's range contained both levels but no M1 candle inside it
        # touched either. The two series disagree about what happened in the same
        # window; that is a store integrity problem, not an ambiguity.
        raise DataIntegrityError(
            "sub-bar walk completed without touching either level, but the "
            "parent bar's range contains both. The M1 series does not cover the "
            "parent candle's extremes — the store is inconsistent."
        )

    def _fallback(
        self,
        bar: Candle,
        stop: float,
        *,
        gapped_open: bool,
        path: ResolutionPath,
        detail: str,
    ) -> IntrabarResult:
        """§11.1 step 2 — assume the stop was hit first and record the loss.

        The fill is the stop price. The fallback is an assumption about
        *ordering*, and inventing a worse price on top of it would compound one
        assumption with another.
        """
        return IntrabarResult(
            resolution=Resolution.STOP_FIRST,
            path=path,
            fill_price=stop,
            fill_time=ensure_utc(bar.time),
            fill_bar=bar,
            gapped=gapped_open,
            detail=detail,
        )

    def _fill_at(self, level: float, bar_open: float, gapped: bool) -> float:
        if not gapped or self._gap_fill is GapFill.LEVEL_PRICE:
            return level
        return bar_open


def _adjust_bar(
    bar: Candle,
    adjustment: Callable[[Candle], float] | None,
) -> Candle:
    """Project stored OHLC onto the executable side used for trigger checks.

    Applying spread only after `_read_bar` can declare a stop or target touched
    on BID/MID even though the executable BID/ASK side never reached it.
    """
    if adjustment is None:
        return bar
    delta = adjustment(bar)
    if delta == 0.0:
        return bar
    return bar.model_copy(
        update={
            "open": bar.open + delta,
            "high": bar.high + delta,
            "low": bar.low + delta,
            "close": bar.close + delta,
        }
    )


def _validate_levels(direction: Direction, stop: float, target: float) -> None:
    if direction is Direction.BUY:
        if not stop < target:
            raise ValueError(
                f"BUY position requires stop < target, got stop={stop} "
                f"target={target}"
            )
    elif direction is Direction.SELL:
        if not target < stop:
            raise ValueError(
                f"SELL position requires target < stop, got stop={stop} "
                f"target={target}"
            )
    else:
        raise ValueError(
            f"cannot resolve a position with direction {direction.value}"
        )


def _read_bar(
    bar: Candle,
    direction: Direction,
    stop: float,
    target: float,
) -> tuple[_Verdict, float | None, bool]:
    """What one candle's OHLC alone says.

    Returns ``(verdict, level, gapped)`` — the *level* that was touched, never a
    gap-adjusted price. Turning a level into a fill price is the gap-fill
    policy's job and lives on the resolver, so the reading in play is applied in
    exactly one place.

    Touching counts as hitting: §12.1 states the test as ``high >= level``.

    The open is examined before the range. A bar that opens beyond a level
    crossed it before it could trade anywhere else in its range, so the order is
    known even though both levels may lie inside the range. Only one of the two
    open-gap tests can fire, because `_validate_levels` has already established
    that stop and target sit on opposite sides.
    """
    if direction is Direction.BUY:
        if bar.open <= stop:
            return _Verdict.STOP, stop, bar.open < stop
        if bar.open >= target:
            return _Verdict.TARGET, target, bar.open > target
        hit_stop = bar.low <= stop
        hit_target = bar.high >= target
    else:
        if bar.open >= stop:
            return _Verdict.STOP, stop, bar.open > stop
        if bar.open <= target:
            return _Verdict.TARGET, target, bar.open < target
        hit_stop = bar.high >= stop
        hit_target = bar.low <= target

    if hit_stop and hit_target:
        return _Verdict.BOTH, None, False
    if hit_stop:
        return _Verdict.STOP, stop, False
    if hit_target:
        return _Verdict.TARGET, target, False
    return _Verdict.NEITHER, None, False


__all__ = [
    "AMBIGUOUS_FILL_FLAG",
    "Resolution",
    "ResolutionPath",
    "GapFill",
    "IntrabarResult",
    "IntrabarResolver",
]
