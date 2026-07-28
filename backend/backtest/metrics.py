"""§11.4 — result segmentation and the core metrics.

    "A single expectancy figure hides everything that matters."

Core metrics, per §11.4: expectancy per trade in R, profit factor, win rate,
maximum drawdown, longest losing streak, trade count, and ambiguity rate.

Segmentation, per §11.4: by **regime** at signal time, **score decile**,
**cluster breadth**, **contested vs uncontested**, **timeframe**, and
**session**.

**Stage 0 can honestly fill two of those six.** Regime is §3, score and breadth
are §5.2, contested is §5.2.1 — all Stage 1. A Stage 0 trade record carries no
such fields, and inventing them would produce a segmentation that looks
populated and means nothing. So the machinery is generic and the four Stage 1
dimensions are registered as **unavailable**: the report names them, says which
spec section supplies them and which stage builds it, and emits no numbers.
Adding them later is registering an extractor, not rewriting this module.

**Trade count gates the rest.** §11.4: "any segment under ~30 trades is
reported with its count and no conclusions." That is enforced *structurally* —
a `SegmentReport` below the floor has `metrics is None`. There is no field to
read a suppressed expectancy out of, so a caller cannot accidentally render one
and a reader cannot accidentally believe one. The floor comes from
`backtest.metrics.min_segment_trades`.

**Ambiguity rate is prominent.** §11.1: "Above ~5%, the equity curve is
substantially an artefact of the assumption and should be read as a lower
bound, not an estimate." Above `backtest.intrabar.ambiguity_rate_warn` the
report says exactly that, at the top, before any equity figure.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable, Sequence

from ..core.config import Config
from ..core.errors import ConfigError
from .intrabar import ResolutionPath
from .replay import RunResult, SimulatedTrade


@dataclass(frozen=True)
class CoreMetrics:
    """§11.4's core set. Every field is derived; none is estimated."""

    trade_count: int
    wins: int
    losses: int
    scratches: int
    win_rate: float
    expectancy_r: float
    gross_profit_r: float
    gross_loss_r: float
    profit_factor: float | None
    """None when there are no losing trades. Not `inf`, not a large number — an
    undefined ratio reported as a number is read as a very good one."""
    max_drawdown_r: float
    longest_losing_streak: int
    ambiguity_rate: float
    ambiguous_no_m1: int
    ambiguous_irreducible: int
    gapped_exits: int
    net_pnl_ccy: float


def compute_core(trades: Sequence[SimulatedTrade]) -> CoreMetrics:
    """Compute §11.4's core metrics over already-filtered trades.

    R is `net_r` — gross price movement less commission, plus swap. Both the
    gross and the net figures live on `SimulatedTrade`; this uses net because a
    frictionless expectancy is the number §11.2 exists to prevent anyone
    quoting.
    """
    count = len(trades)
    if count == 0:
        return CoreMetrics(
            trade_count=0,
            wins=0,
            losses=0,
            scratches=0,
            win_rate=0.0,
            expectancy_r=0.0,
            gross_profit_r=0.0,
            gross_loss_r=0.0,
            profit_factor=None,
            max_drawdown_r=0.0,
            longest_losing_streak=0,
            ambiguity_rate=0.0,
            ambiguous_no_m1=0,
            ambiguous_irreducible=0,
            gapped_exits=0,
            net_pnl_ccy=0.0,
        )

    wins = sum(1 for t in trades if t.net_r > 0)
    losses = sum(1 for t in trades if t.net_r < 0)
    scratches = count - wins - losses

    gross_profit = sum(t.net_r for t in trades if t.net_r > 0)
    gross_loss = -sum(t.net_r for t in trades if t.net_r < 0)

    equity = 0.0
    peak = 0.0
    max_dd = 0.0
    streak = 0
    longest_streak = 0
    for trade in trades:
        equity += trade.net_r
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)
        if trade.net_r < 0:
            streak += 1
            longest_streak = max(longest_streak, streak)
        else:
            streak = 0

    no_m1 = sum(
        1 for t in trades if t.resolution_path is ResolutionPath.FALLBACK_NO_M1
    )
    irreducible = sum(
        1 for t in trades if t.resolution_path is ResolutionPath.FALLBACK_IRREDUCIBLE
    )

    return CoreMetrics(
        trade_count=count,
        wins=wins,
        losses=losses,
        scratches=scratches,
        win_rate=wins / count,
        expectancy_r=sum(t.net_r for t in trades) / count,
        gross_profit_r=gross_profit,
        gross_loss_r=gross_loss,
        profit_factor=(gross_profit / gross_loss) if gross_loss > 0 else None,
        max_drawdown_r=max_dd,
        longest_losing_streak=longest_streak,
        ambiguity_rate=(no_m1 + irreducible) / count,
        ambiguous_no_m1=no_m1,
        ambiguous_irreducible=irreducible,
        gapped_exits=sum(1 for t in trades if t.gapped_exit),
        net_pnl_ccy=sum(t.net_pnl_ccy for t in trades),
    )


# --------------------------------------------------------------- dimensions


@dataclass(frozen=True)
class Dimension:
    """One §11.4 segmentation axis.

    `extract` returns the keys a trade belongs to. It is a *list* because a
    trade can belong to more than one bucket on the same axis — a bar inside the
    London/New York overlap is in both session populations, and forcing it into
    one would make the session segments disjoint by fiat rather than by fact.
    """

    name: str
    spec_section: str
    available: bool
    stage: str
    extract: Callable[[SimulatedTrade], list[str]] | None = None
    unavailable_because: str = ""


def _timeframe_of(trade: SimulatedTrade) -> list[str]:
    return [trade.timeframe.value]


def _sessions_of(trade: SimulatedTrade) -> list[str]:
    return list(trade.sessions) or ["NO_SESSION"]


#: The six §11.4 axes. Order is the spec's, and it is fixed so the report reads
#: the same way every run.
DIMENSIONS: tuple[Dimension, ...] = (
    Dimension(
        name="regime",
        spec_section="§11.4 / §3",
        available=False,
        stage="Stage 1",
        unavailable_because=(
            "regime at signal time comes from the Tier 1 classifier (§3), which "
            "is Stage 1. A Stage 0 trade record carries no regime and one will "
            "not be invented for it."
        ),
    ),
    Dimension(
        name="score_decile",
        spec_section="§11.4 / §5.2",
        available=False,
        stage="Stage 1",
        unavailable_because=(
            "the confluence score is §5.2, Stage 1. Without it there are no "
            "deciles, and §11.4's whole point here — choosing both thresholds "
            "from evidence — cannot be exercised yet."
        ),
    ),
    Dimension(
        name="cluster_breadth",
        spec_section="§11.4 / §5.1",
        available=False,
        stage="Stage 1",
        unavailable_because=(
            "breadth is clusters-agreeing over clusters-available (§5.2), Stage "
            "1. Stage 0 runs a single module, so there is no cluster to be "
            "broad across."
        ),
    ),
    Dimension(
        name="contested",
        spec_section="§11.4 / §5.2.1",
        available=False,
        stage="Stage 1",
        unavailable_because=(
            "the two-sided vote tally is §5.2.1, Stage 1. One module cannot "
            "contest itself."
        ),
    ),
    Dimension(
        name="timeframe",
        spec_section="§11.4",
        available=True,
        stage="Stage 0",
        extract=_timeframe_of,
    ),
    Dimension(
        name="session",
        spec_section="§11.4 / §10.1",
        available=True,
        stage="Stage 0",
        extract=_sessions_of,
    ),
)

_BY_NAME = {d.name: d for d in DIMENSIONS}


# ------------------------------------------------------------------ segments


@dataclass(frozen=True)
class SegmentReport:
    """One bucket on one axis.

    `metrics is None` below the trade-count floor. That is the §11.4 rule made
    structural: there is no suppressed number hiding behind a flag, because
    there is no field to hold one.
    """

    dimension: str
    key: str
    trade_count: int
    metrics: CoreMetrics | None
    conclusions_permitted: bool
    suppressed_reason: str | None


@dataclass(frozen=True)
class DimensionReport:
    dimension: Dimension
    segments: tuple[SegmentReport, ...]


def segment(
    trades: Sequence[SimulatedTrade],
    dimension: Dimension,
    min_trades: int,
) -> DimensionReport:
    if not dimension.available or dimension.extract is None:
        return DimensionReport(dimension=dimension, segments=())

    buckets: dict[str, list[SimulatedTrade]] = {}
    for trade in trades:
        for key in dimension.extract(trade):
            buckets.setdefault(key, []).append(trade)

    segments = []
    for key in sorted(buckets):
        bucket = buckets[key]
        permitted = len(bucket) >= min_trades
        segments.append(
            SegmentReport(
                dimension=dimension.name,
                key=key,
                trade_count=len(bucket),
                metrics=compute_core(bucket) if permitted else None,
                conclusions_permitted=permitted,
                suppressed_reason=(
                    None
                    if permitted
                    else (
                        f"{len(bucket)} trades, below the {min_trades}-trade "
                        f"floor (§11.4). No conclusions."
                    )
                ),
            )
        )
    return DimensionReport(dimension=dimension, segments=tuple(segments))


# ------------------------------------------------------------------- report


@dataclass(frozen=True)
class MetricsReport:
    symbol: str
    module_name: str
    config_version: str
    min_segment_trades: int
    ambiguity_rate_warn: float

    overall: CoreMetrics
    overall_conclusions_permitted: bool
    dimensions: tuple[DimensionReport, ...]

    unresolved_at_data_end: int
    excluded_note: str
    skipped_counts: tuple[tuple[str, int], ...]

    @property
    def ambiguity_exceeds_warn(self) -> bool:
        return self.overall.ambiguity_rate > self.ambiguity_rate_warn

    def render(self) -> str:
        lines: list[str] = []
        w = lines.append

        w("=" * 74)
        w(f"BACKTEST REPORT — {self.symbol} — {self.module_name}")
        w(f"config_version: {self.config_version}")
        w("=" * 74)
        w("")

        # §11.1 requires the ambiguity rate reported on every result, and its
        # consequence stated. It goes first, above the equity figures it
        # qualifies — a caveat printed after the number it qualifies is a
        # caveat nobody reads.
        w("AMBIGUITY (§11.1)")
        w("-" * 74)
        w(
            f"  ambiguity rate            {self.overall.ambiguity_rate:>8.2%}   "
            f"(warn above {self.ambiguity_rate_warn:.2%})"
        )
        w(
            f"    resolved by fallback, no M1        "
            f"{self.overall.ambiguous_no_m1:>6d}   fixable: acquire M1 history"
        )
        w(
            f"    resolved by fallback, irreducible  "
            f"{self.overall.ambiguous_irreducible:>6d}   not fixable at M1 "
            f"resolution"
        )
        w(f"    exits filled through a gap         {self.overall.gapped_exits:>6d}")
        if self.ambiguity_exceeds_warn:
            w("")
            w("  *** THE EQUITY CURVE BELOW IS A LOWER BOUND, NOT AN ESTIMATE. ***")
            w(
                f"  {self.overall.ambiguity_rate:.2%} of trades were resolved by "
                f"assuming the stop was hit"
            )
            w(
                "  first, because the evidence could not say. Above the "
                f"{self.ambiguity_rate_warn:.0%} threshold §11.1 states the"
            )
            w("  curve is substantially an artefact of that assumption.")
        else:
            w("")
            w(
                "  Below the warn threshold: the curve is an estimate, with the "
                "usual caveats"
            )
            w("  of §11.5 — recorded spread is not guaranteed spread.")
        w("")

        w("CORE METRICS (§11.4)")
        w("-" * 74)
        w(f"  trade count               {self.overall.trade_count:>8d}")
        if not self.overall_conclusions_permitted:
            w("")
            w(
                f"  *** {self.overall.trade_count} trades is below the "
                f"{self.min_segment_trades}-trade floor (§11.4). ***"
            )
            w("  The figures below are reported for completeness. They do not")
            w("  support a conclusion, and §12.5 forbids acting on them.")
        w(f"  expectancy per trade      {self.overall.expectancy_r:>8.3f} R")
        pf = self.overall.profit_factor
        w(
            "  profit factor             "
            + (f"{pf:>8.3f}" if pf is not None else "     n/a")
            + ("" if pf is not None else "   (no losing trades)")
        )
        w(f"  win rate                  {self.overall.win_rate:>8.2%}")
        w(
            f"  wins / losses / scratches {self.overall.wins:>4d} / "
            f"{self.overall.losses} / {self.overall.scratches}"
        )
        w(f"  maximum drawdown          {self.overall.max_drawdown_r:>8.3f} R")
        w(f"  longest losing streak     {self.overall.longest_losing_streak:>8d}")
        w(f"  gross profit / loss       {self.overall.gross_profit_r:>8.3f} R / "
          f"{self.overall.gross_loss_r:.3f} R")
        w(f"  net P&L (account ccy)     {self.overall.net_pnl_ccy:>8.2f}")
        w("")

        if self.unresolved_at_data_end or self.skipped_counts:
            w("NOT COUNTED ABOVE")
            w("-" * 74)
            if self.unresolved_at_data_end:
                w(
                    f"  positions open at data end  "
                    f"{self.unresolved_at_data_end:>6d}   {self.excluded_note}"
                )
            for reason, count in self.skipped_counts:
                w(f"  signals skipped: {reason:<26} {count:>6d}")
            w("")

        w("SEGMENTATION (§11.4)")
        w("-" * 74)
        w(
            f"  Trade count gates the rest. Segments under "
            f"{self.min_segment_trades} trades report their"
        )
        w("  count and nothing else.")
        w("")
        for dim_report in self.dimensions:
            dim = dim_report.dimension
            if not dim.available:
                w(f"  {dim.name}  [{dim.spec_section}]  — UNAVAILABLE ({dim.stage})")
                for line in _wrap(dim.unavailable_because, 68):
                    w(f"      {line}")
                w("")
                continue
            w(f"  {dim.name}  [{dim.spec_section}]")
            if not dim_report.segments:
                w("      (no trades)")
                w("")
                continue
            for seg in dim_report.segments:
                if seg.metrics is None:
                    w(f"      {seg.key:<18} n={seg.trade_count:<5d} {seg.suppressed_reason}")
                else:
                    m = seg.metrics
                    pf_text = f"{m.profit_factor:.2f}" if m.profit_factor is not None else "n/a"
                    w(
                        f"      {seg.key:<18} n={seg.trade_count:<5d} "
                        f"E={m.expectancy_r:+.3f}R  PF={pf_text:<6} "
                        f"win={m.win_rate:.1%}  maxDD={m.max_drawdown_r:.2f}R  "
                        f"amb={m.ambiguity_rate:.1%}"
                    )
            w("")

        w("WHAT THIS CANNOT TELL YOU (§11.5)")
        w("-" * 74)
        w("  - Historical spread is recorded, not guaranteed; real slippage in")
        w("    fast markets exceeds any model.")
        w("  - Survivorship and symbol selection: testing on the pairs you")
        w("    already like is not evidence.")
        w("  - Regime coverage: a year containing no sustained range says")
        w("    nothing about ranging performance.")
        w("  - Every parameter chosen after looking at this data is fitted to")
        w("    it, walk-forward or not.")
        w("=" * 74)
        return "\n".join(lines)


def _wrap(text: str, width: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current: list[str] = []
    for word in words:
        if current and sum(len(x) + 1 for x in current) + len(word) > width:
            lines.append(" ".join(current))
            current = []
        current.append(word)
    if current:
        lines.append(" ".join(current))
    return lines


def build_report(
    result: RunResult,
    config: Config,
    dimensions: Iterable[Dimension] = DIMENSIONS,
) -> MetricsReport:
    """Turn one `RunResult` into the §11.4 report."""
    min_trades = config.get("backtest.metrics.min_segment_trades")
    if not isinstance(min_trades, int) or isinstance(min_trades, bool) or min_trades < 1:
        raise ConfigError(
            f"backtest.metrics.min_segment_trades must be a positive integer, "
            f"got {min_trades!r}."
        )
    warn = config.get("backtest.intrabar.ambiguity_rate_warn")
    if isinstance(warn, bool) or not isinstance(warn, (int, float)):
        raise ConfigError(
            f"backtest.intrabar.ambiguity_rate_warn must be a fraction, got "
            f"{warn!r}."
        )

    # §11.4's segment list is declared in config; a name the code cannot supply
    # an extractor for is a config/spec mismatch, not something to skip quietly.
    declared = config.get("backtest.metrics.segment_by")
    unknown = [name for name in declared if name not in _BY_NAME]
    if unknown:
        raise ConfigError(
            f"backtest.metrics.segment_by names dimensions with no registered "
            f"extractor: {unknown}. §11.4's axes are "
            f"{[d.name for d in DIMENSIONS]}."
        )

    resolved = [t for t in result.trades if t.resolved]
    unresolved = [t for t in result.trades if not t.resolved]

    overall = compute_core(resolved)

    ordered = [d for d in dimensions if d.name in declared]

    skip_counts: dict[str, int] = {}
    for skip in result.skipped:
        skip_counts[skip.reason.value] = skip_counts.get(skip.reason.value, 0) + 1

    return MetricsReport(
        symbol=result.symbol,
        module_name=result.module_name,
        config_version=result.config_version,
        min_segment_trades=min_trades,
        ambiguity_rate_warn=float(warn),
        overall=overall,
        overall_conclusions_permitted=overall.trade_count >= min_trades,
        dimensions=tuple(segment(resolved, d, min_trades) for d in ordered),
        unresolved_at_data_end=len(unresolved),
        excluded_note=(
            "still open when the bar data ran out; no terminal price the market "
            "ever offered, so excluded from every figure above (AMBIGUITY-B09)"
        ),
        skipped_counts=tuple(sorted(skip_counts.items())),
    )


__all__ = [
    "CoreMetrics",
    "compute_core",
    "Dimension",
    "DIMENSIONS",
    "SegmentReport",
    "DimensionReport",
    "segment",
    "MetricsReport",
    "build_report",
]
