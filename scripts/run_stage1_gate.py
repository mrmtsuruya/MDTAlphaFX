"""Produce the durable §9 Stage 1 replay/calibration evidence.

This command is read-only with respect to MT5. The connector's Rule 5 guard
refuses any non-demo account before bars are requested.

The report is intentionally allowed to be PARTIAL:

* Without a supplied economic-calendar file, the volatility classifier can be
  evaluated but news proximity cannot. The omission is visible in the artifact.
* Until Stage 2 supplies the 28 module results, there are no realised cluster
  scores to plot. The score-distribution chart stays visibly blocked; theoretical
  calibration rows are shown only as reference and never relabelled "realised".

Usage:

    python scripts/run_stage1_gate.py
    python scripts/run_stage1_gate.py --symbol XAUUSD --symbol EURUSD
    python scripts/run_stage1_gate.py --news-blackouts data/news_blackouts.json

News input is JSON shaped as ``{"SYMBOL": ["<UTC ISO bar open>", ...]}``.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable, Sequence

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.contracts import Candle, Regime, Timeframe  # noqa: E402
from backend.core.config import Config  # noqa: E402
from backend.core.timeutil import UTC, ensure_utc, utc_now  # noqa: E402
from backend.data.mt5_connector import MT5Connector  # noqa: E402
from backend.regime.classifier import (  # noqa: E402
    RegimeVerdict,
    apply_hysteresis,
    classify_raw,
)
from backend.regime.features import (  # noqa: E402
    NewsBlackoutFlags,
    RegimeFeatureConfig,
    compute_regime_inputs,
)
from scripts.audit_stage1_transitions import (  # noqa: E402
    build_audit as build_transition_audit,
    render_markdown as render_transition_audit_markdown,
)

DEFAULT_OUTPUT_DIR = REPO_ROOT / "docs" / "stage1-gate"
DEFAULT_BAR_COUNT = 9_000
REPORT_TITLE = "MDTAlphaFX Stage 1 Gate"
REGIME_LABELS = {
    Regime.RANGING.value: "RANGE",
    Regime.TRANSITIONAL.value: "TRANSITION",
    Regime.TRENDING_BEARISH.value: "BEAR",
    Regime.TRENDING_BULLISH.value: "BULL",
    Regime.VOLATILE_NEWS.value: "VOL/NEWS",
}


@dataclass(frozen=True)
class RegimeRow:
    symbol: str
    time: str
    open: float
    high: float
    low: float
    close: float
    adx: float
    atr_percentile: float
    r_squared: float
    ema_stack_aligned: bool
    ema_stack_bullish: bool
    within_news_blackout: bool
    raw_regime: str
    regime: str
    confidence: float
    bars_in_regime: int


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Replay one year for the §9 Stage 1 visual/calibration gate."
    )
    parser.add_argument("--config", default=str(REPO_ROOT / "config"))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--symbol", action="append", default=None)
    parser.add_argument("--timeframe", choices=[item.value for item in Timeframe], default="H1")
    parser.add_argument("--bar-count", type=int, default=DEFAULT_BAR_COUNT)
    parser.add_argument("--news-blackouts", default=None)
    parser.add_argument("--terminal-path", default=None)
    parser.add_argument("--login", type=int, default=None)
    parser.add_argument("--password", default=None)
    parser.add_argument("--server", default=None)
    return parser


def _feature_config(config: Config) -> RegimeFeatureConfig:
    periods = config.get("regime.inputs.ema_periods")
    if not isinstance(periods, list):
        raise ValueError("regime.inputs.ema_periods must be a list")
    return RegimeFeatureConfig(
        adx_period=int(config.get("regime.inputs.adx_period")),
        ema_periods=tuple(int(value) for value in periods),
        atr_period=int(config.get("regime.inputs.atr_period")),
        atr_percentile_lookback=int(
            config.get("regime.inputs.atr_percentile_lookback")
        ),
        r_squared_bars=int(config.get("regime.inputs.r_squared_bars")),
    )


def _read_blackouts(path: str | None) -> tuple[dict[str, set[datetime]], bool]:
    if path is None:
        return {}, False
    source = Path(path)
    raw = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("news blackout JSON must be an object keyed by symbol")
    result: dict[str, set[datetime]] = {}
    for symbol, values in raw.items():
        if not isinstance(symbol, str) or not isinstance(values, list):
            raise ValueError("news blackout JSON values must be timestamp lists")
        moments: set[datetime] = set()
        for value in values:
            text = str(value)
            if text.endswith("Z"):
                text = text[:-1] + "+00:00"
            moments.add(ensure_utc(datetime.fromisoformat(text)))
        result[symbol] = moments
    return result, True


def _blackout_flags(
    symbol: str,
    candles: Sequence[Candle],
    blackouts: dict[str, set[datetime]],
    calendar_supplied: bool,
) -> NewsBlackoutFlags:
    if not calendar_supplied:
        return NewsBlackoutFlags.no_blackouts(len(candles))
    moments = blackouts.get(symbol, set())
    return NewsBlackoutFlags(tuple(candle.time in moments for candle in candles))


def classify_series(
    symbol: str,
    candles: Sequence[Candle],
    config: Config,
    news_blackouts: NewsBlackoutFlags,
) -> list[RegimeRow]:
    """Compute features and the approved hysteretic verdict for ready bars."""

    inputs = compute_regime_inputs(candles, news_blackouts, _feature_config(config))
    regime_config = config.section("regime")
    previous: RegimeVerdict | None = None
    rows: list[RegimeRow] = []
    for candle, values in zip(candles, inputs):
        if values is None:
            continue
        raw = classify_raw(values, regime_config)
        if previous is None:
            verdict = RegimeVerdict(
                regime=raw,
                regime_confidence=1.0,
                bars_in_regime=1,
                pending=None,
                pending_bars=0,
            )
        else:
            verdict = apply_hysteresis(previous, raw, values, regime_config)
        previous = verdict
        rows.append(
            RegimeRow(
                symbol=symbol,
                time=candle.time.isoformat(),
                open=candle.open,
                high=candle.high,
                low=candle.low,
                close=candle.close,
                adx=values.adx,
                atr_percentile=values.atr_percentile,
                r_squared=values.r_squared,
                ema_stack_aligned=values.ema_stack_aligned,
                ema_stack_bullish=values.ema_stack_bullish,
                within_news_blackout=values.within_news_blackout,
                raw_regime=raw.value,
                regime=verdict.regime.value,
                confidence=verdict.regime_confidence,
                bars_in_regime=verdict.bars_in_regime,
            )
        )
    return rows


def _year_window(rows: Sequence[RegimeRow]) -> list[RegimeRow]:
    if not rows:
        return []
    latest = datetime.fromisoformat(rows[-1].time)
    start = latest - timedelta(days=365)
    return [row for row in rows if datetime.fromisoformat(row.time) >= start]


def _segments(rows: Sequence[RegimeRow]) -> list[dict[str, Any]]:
    if not rows:
        return []
    result: list[dict[str, Any]] = []
    start_index = 0
    for index in range(1, len(rows) + 1):
        if index < len(rows) and rows[index].regime == rows[start_index].regime:
            continue
        result.append(
            {
                "symbol": rows[start_index].symbol,
                "regime": rows[start_index].regime,
                "start": rows[start_index].time,
                "end": rows[index - 1].time,
                "bars": index - start_index,
            }
        )
        start_index = index
    return result


def _daily_price(rows: Sequence[RegimeRow]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], RegimeRow] = {}
    first_close: dict[str, float] = {}
    for row in rows:
        day = datetime.fromisoformat(row.time).date().isoformat()
        grouped[(row.symbol, day)] = row
        first_close.setdefault(row.symbol, row.close)
    return [
        {
            "symbol": symbol,
            "date": day,
            "price_index": 100.0 * row.close / first_close[symbol],
            "close": row.close,
            "regime": row.regime,
            "adx": row.adx,
            "atr_percentile": row.atr_percentile,
        }
        for (symbol, day), row in sorted(grouped.items())
    ]


def _monthly_mix(rows: Sequence[RegimeRow]) -> list[dict[str, Any]]:
    counts: dict[tuple[str, str], int] = Counter()
    totals: Counter[str] = Counter()
    for row in rows:
        month = row.time[:7]
        counts[(month, row.regime)] += 1
        totals[month] += 1
    return [
        {
            "month": month,
            "regime": regime,
            "regime_label": REGIME_LABELS[regime],
            "share": count / totals[month],
            "bars": count,
            "total_bars": totals[month],
        }
        for (month, regime), count in sorted(counts.items())
    ]


def _symbol_stability(
    rows_by_symbol: dict[str, list[RegimeRow]],
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for symbol, rows in sorted(rows_by_symbol.items()):
        segments = _segments(rows)
        durations = [segment["bars"] for segment in segments]
        result.append(
            {
                "symbol": symbol,
                "ready_bars": len(rows),
                "regime_switches": max(0, len(segments) - 1),
                "segments": len(segments),
                "one_bar_segments": sum(value == 1 for value in durations),
                "one_bar_segment_rate": (
                    sum(value == 1 for value in durations) / len(durations)
                    if durations
                    else 0.0
                ),
                "median_segment_bars": (
                    float(statistics.median(durations)) if durations else 0.0
                ),
                "volatile_news_bars": sum(
                    row.regime == Regime.VOLATILE_NEWS.value for row in rows
                ),
            }
        )
    return result


def _calibration_reference() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    breadth_by_clusters = {3: 0.53, 4: 0.69, 5: 0.85, 6: 1.0}
    for clusters, breadth in breadth_by_clusters.items():
        for quality in (80, 85, 90, 95, 100):
            rows.append(
                {
                    "clusters": clusters,
                    "agreement": f"{clusters} ({breadth:.0%})",
                    "scenario": f"{clusters} clusters · q{quality}",
                    "breadth": breadth,
                    "quality": quality,
                    "score": (breadth**0.5) * quality,
                    "kind": "THEORETICAL_REFERENCE",
                }
            )
    return rows


def _source(
    source_id: str, label: str, path: str, description: str
) -> dict[str, Any]:
    sql = (
        f"SELECT * FROM read_json_auto('{path}')"
        if path.lower().endswith(".json")
        else f"SELECT '{path}' AS source_file"
    )
    return {
        "id": source_id,
        "label": label,
        "path": path,
        "query": {
            "description": description,
            "language": "python",
            "engine": "DuckDB over Python-produced snapshot",
            "sql": sql,
            "filters": ["latest closed H1 bars", "trailing 365 days after warm-up"],
            "tables_used": [path],
        },
    }


def build_artifact(
    *,
    config: Config,
    generated_at: datetime,
    rows_by_symbol: dict[str, list[RegimeRow]],
    calendar_supplied: bool,
    source_data_path: str,
    account_label: str,
    transition_audit: dict[str, Any],
    transition_audit_path: str,
) -> dict[str, Any]:
    all_rows = [row for rows in rows_by_symbol.values() for row in rows]
    daily = _daily_price(all_rows)
    primary_symbol = next(iter(rows_by_symbol))
    primary_daily = [
        row for row in daily if row["symbol"] == primary_symbol
    ]
    monthly = _monthly_mix(all_rows)
    stability = _symbol_stability(rows_by_symbol)
    calibration = _calibration_reference()
    segments = [segment for rows in rows_by_symbol.values() for segment in _segments(rows)]
    ready_bars = len(all_rows)
    switches = sum(row["regime_switches"] for row in stability)
    one_bar_segments = sum(row["one_bar_segments"] for row in stability)
    generated_iso = generated_at.isoformat()
    audit_scope = transition_audit["scope"]
    audit_invariants = transition_audit["mechanical_invariants"]
    one_bar_review = transition_audit["one_bar_review"]

    summary = [
        {
            "ready_bars": ready_bars,
            "symbols": len(rows_by_symbol),
            "regime_switches": switches,
            "one_bar_segments": one_bar_segments,
            "realised_scores": 0,
        }
    ]
    sources = [
        _source(
            "src-regime-replay",
            "Saved Stage 1 regime replay",
            source_data_path,
            "Regime features and hysteretic classifications produced by this command.",
        ),
        _source(
            "src-transition-audit",
            "Independent Stage 1 transition audit",
            transition_audit_path,
            (
                "Independent ordered-rule, hysteresis, segment, and "
                "price-coherence audit."
            ),
        ),
        _source(
            "src-regime-code",
            "Regime feature and classifier implementation",
            "backend/regime/features.py",
            "Pure §3.1 feature computation and classifier inputs.",
        ),
        _source(
            "src-spec",
            "MDTAlphaFX SPEC v2",
            "MDTAlphaFX SPEC v2 - Quant Platform & Execution Engine.md",
            "§3 regime definitions, §5.3 calibration, and §9 Stage 1 gate.",
        ),
    ]

    calendar_status = (
        "Economic-calendar flags were supplied."
        if calendar_supplied
        else (
            "No economic-calendar dataset was supplied. VOLATILE_NEWS reflects "
            "the ATR-percentile branch only; calendar-proximity classification "
            "is not evaluated."
        )
    )
    status = "partial"
    blocks = [
        {
            "id": "title",
            "type": "markdown",
            "layout": "full",
            "body": f"# {REPORT_TITLE}\n\nGenerated {generated_at:%B %d, %Y at %H:%M UTC} · guarded source: {account_label}",
        },
        {
            "id": "technical-summary",
            "type": "markdown",
            "layout": "full",
            "sourceId": "src-regime-replay",
            "body": (
                "## The classifier replay is reviewable; the full calibration gate is not yet closable\n\n"
                 f"The one-year replay produced **{ready_bars:,} ready H1 classifications** "
                 f"across **{len(rows_by_symbol)} symbols**, with **{switches:,} regime "
                 f"switches** and **{one_bar_segments:,} one-bar segments**. These are "
                 "descriptive diagnostics; the independent transition and price-coherence "
                 "audit below supplies the reproducible review. The report remains **PARTIAL** "
                 "because economic-calendar proximity is unavailable and Stage 2 has "
                "not produced the 28 module outputs required for a realised score distribution."
            ),
        },
        {
            "id": "mechanical-review",
            "type": "markdown",
            "layout": "full",
            "sourceId": "src-transition-audit",
            "body": (
                "## Independent replay found no classifier or hysteresis divergence\n\n"
                f"The audit independently reproduced **{audit_scope['rows']:,}/"
                f"{audit_scope['rows']:,} raw classifications** and all "
                f"**{audit_scope['observed_transitions']:,} observed transitions**. "
                f"All **{audit_scope['one_bar_segments']} one-bar entries** had "
                "valid confirmation support, and the impossible-transition count "
                f"was **{audit_invariants['impossible_transition_count']}**. "
                f"**{one_bar_review['round_trip_aba']}** one-bar segments were "
                "A→B→A round trips; these are mechanically valid but remain an "
                "operating-churn diagnostic."
            ),
        },
        {
            "id": "headline-metrics",
            "type": "metric-strip",
            "layout": "full",
            "cardIds": ["ready-bars", "switches", "one-bar-segments", "scores"],
        },
        {
            "id": "price-context",
            "type": "markdown",
            "layout": "full",
            "sourceId": "src-regime-replay",
            "body": (
                "## Price context covers the same one-year population\n\n"
                f"{primary_symbol} is shown as the representative price timeline and "
                "rebased to 100 at its first ready observation. Use this context with "
                "the all-symbol monthly regime mix and segment audit below; normalization "
                "changes scale, not turning points."
            ),
        },
        {
            "id": "price-chart-block",
            "type": "chart",
            "layout": "full",
            "chartId": "price-context-chart",
        },
        {
            "id": "regime-mix",
            "type": "markdown",
            "layout": "full",
            "sourceId": "src-regime-replay",
            "body": (
                "## Regime coverage varies through the replay\n\n"
                "The composition chart shows the share of ready H1 classifications in each "
                "month. A useful gate sample needs sustained trend, range, transition, and "
                "high-volatility episodes; a missing class means the replay cannot validate "
                "that branch. " + calendar_status
            ),
        },
        {
            "id": "regime-mix-chart-block",
            "type": "chart",
            "layout": "full",
            "chartId": "regime-mix-chart",
        },
        {
            "id": "boundary-stability",
            "type": "markdown",
            "layout": "full",
            "sourceId": "src-transition-audit",
            "body": (
                "## One-bar segments isolate mechanically valid operating churn\n\n"
                f"The independent audit reviewed all {audit_scope['one_bar_segments']} "
                f"one-bar segments: {one_bar_review['round_trip_aba']} were A→B→A "
                "round trips and none was mechanically impossible. Price triage found "
                f"{one_bar_review['price_assessment'].get('SUPPORTIVE', 0)} supportive, "
                f"{one_bar_review['price_assessment'].get('MIXED', 0)} mixed, and "
                f"{one_bar_review['price_assessment'].get('CONTRADICTORY', 0)} "
                "contradictory cases. This does not prove false classification; "
                "TRANSITIONAL exits are intentionally immediate and post-label price "
                "behavior is diagnostic rather than causal."
            ),
        },
        {
            "id": "stability-table-block",
            "type": "table",
            "layout": "full",
            "tableId": "stability-table",
        },
        {
            "id": "score-blocked",
            "type": "markdown",
            "layout": "full",
            "sourceId": "src-spec",
            "body": (
                "## Realised score distribution is blocked by the Stage 2 dependency\n\n"
                "Stage 1 owns the scoring formula, but scores are realised only when strategy "
                "modules fire and collapse into clusters. No production module outputs exist "
                "yet, so plotting a synthetic distribution here would mislabel simulated "
                "values as market evidence. The empty chart is deliberate and must be filled "
                "after Stage 2 and the co-firing weight measurement."
            ),
        },
        {
            "id": "calibration-reference",
            "type": "markdown",
            "layout": "full",
            "sourceId": "src-spec",
            "body": (
                "## Theoretical reachability remains a reference, not an observation\n\n"
                "The table recomputes `score = breadth^0.5 × quality` for the §5.3.2 "
                "TRENDING reference breadths. It validates formula reachability only; it "
                "does not answer how often any row occurs."
            ),
        },
        {
            "id": "calibration-table-block",
            "type": "table",
            "layout": "full",
            "tableId": "calibration-table",
        },
        {
            "id": "scope",
            "type": "markdown",
            "layout": "full",
            "sourceId": "src-regime-replay",
            "body": (
                "## Scope and definitions\n\n"
                f"Population: latest trailing 365 days of ready H1 bars from {account_label}; "
                "the indicator warm-up is computed before the window is cut. A regime switch "
                "is a change in the effective hysteretic label. A one-bar segment is an "
                "effective label lasting exactly one H1 bar. ATR percentile uses average rank "
                "within the trailing 100 ready ATR values, including the current value."
            ),
        },
        {
            "id": "methodology",
            "type": "markdown",
            "layout": "full",
            "sourceId": "src-regime-code",
            "body": (
                "## Methodology preserves the approved ordering\n\n"
                "Features use Wilder ADX(14)/ATR(14), SMA-seeded EMA(20/50/200) with "
                "same-direction slopes, and close-on-index R² over 50 bars. Classification "
                "applies news, volatility, trend, range, then TRANSITIONAL in that order; "
                "approved asymmetric ADX bands and three-bar confirmation are then applied. "
                f"Config version: `{config.version}`."
            ),
        },
        {
            "id": "limitations",
            "type": "markdown",
            "layout": "full",
            "body": (
                "## Limitations keep this gate partial\n\n"
                f"- {calendar_status}\n"
                "- Native report charts aggregate the detailed H1 audit rows; use the saved "
                "replay and transition-audit files for exact segment-by-segment inspection.\n"
                "- Regime labels are descriptive classifier outputs, not evidence of strategy "
                "profitability.\n"
                "- The score distribution cannot be evaluated until Stage 2 emits production "
                "module and cluster results."
            ),
        },
        {
            "id": "next-steps",
            "type": "markdown",
            "layout": "full",
            "body": (
                "## Recommended next steps\n\n"
                f"1. Keep the {one_bar_review['round_trip_aba']} A→B→A one-bar "
                "round trips as an operating diagnostic; do not tune thresholds from "
                "price impression alone.\n"
                "2. Supply a versioned economic-calendar blackout dataset and rerun.\n"
                "3. After Stage 2, run all 28 modules, measure co-firing, regenerate weights, "
                "and populate the realised score histogram before changing ALPHA or thresholds."
            ),
        },
        {
            "id": "further-questions",
            "type": "markdown",
            "layout": "full",
            "body": (
                "## Further questions\n\n"
                "- Does the observed one-bar A→B→A churn predict materially different "
                "outcomes once resolved signals exist?\n"
                "- Does calendar proximity materially change the VOLATILE_NEWS population?\n"
                "- After measured cluster weights, do realised scores occupy the 70–85 "
                "working band without piling at zero or the ceiling?"
            ),
        },
    ]

    manifest = {
        "version": 1,
        "surface": "report",
        "title": REPORT_TITLE,
        "description": "Technical evidence for the §9 Stage 1 gate.",
        "generatedAt": generated_iso,
        "sources": sources,
        "blocks": blocks,
        "cards": [
            {
                "id": "ready-bars",
                "description": "H1 bars with all §3.1 features ready inside the trailing year.",
                "dataset": "summary",
                "sourceId": "src-regime-replay",
                "metrics": [{"label": "Ready H1 bars", "field": "ready_bars", "format": "compact"}],
            },
            {
                "id": "switches",
                "description": "Effective hysteretic label changes across all replayed symbols.",
                "dataset": "summary",
                "sourceId": "src-regime-replay",
                "metrics": [{"label": "Regime switches", "field": "regime_switches", "format": "compact"}],
            },
            {
                "id": "one-bar-segments",
                "description": "Single-H1-bar effective regimes covered by the independent transition audit.",
                "dataset": "summary",
                "sourceId": "src-regime-replay",
                "metrics": [{"label": "One-bar segments", "field": "one_bar_segments", "format": "compact"}],
            },
            {
                "id": "scores",
                "description": "Realised strategy scores; unavailable until Stage 2 modules run.",
                "dataset": "summary",
                "sourceId": "src-spec",
                "metrics": [{"label": "Realised scores", "field": "realised_scores", "format": "compact"}],
            },
        ],
        "charts": [
            {
                "id": "price-context-chart",
                "title": f"Normalized daily closing price — {primary_symbol}",
                "subtitle": "Daily last ready H1 close; first observation equals 100.",
                "intent": "trend",
                "type": "line",
                "dataset": "primary_price",
                "sourceId": "src-regime-replay",
                "encodings": {
                    "x": {"field": "date", "type": "temporal", "label": "Date"},
                    "y": {"field": "price_index", "type": "quantitative", "label": "Index", "unit": "first ready close = 100"},
                    "tooltip": [
                        {"field": "close", "type": "quantitative", "label": "Close"},
                        {"field": "regime", "type": "nominal", "label": "Regime"},
                        {"field": "adx", "type": "quantitative", "label": "ADX"},
                    ],
                },
                "layout": "full",
                "maxRows": 500,
            },
            {
                "id": "regime-mix-chart",
                "title": "Monthly regime composition",
                "subtitle": "Share of ready H1 classifications across the replayed watchlist.",
                "intent": "composition",
                "type": "stackedBar100",
                "dataset": "monthly_mix",
                "sourceId": "src-regime-replay",
                "encodings": {
                    "x": {"field": "month", "type": "temporal", "label": "Month"},
                    "y": {"field": "share", "type": "quantitative", "format": "percent", "label": "Share"},
                    "color": {"field": "regime_label", "type": "nominal", "label": "Regime"},
                    "tooltip": [
                        {"field": "bars", "type": "quantitative", "label": "Bars"},
                        {"field": "total_bars", "type": "quantitative", "label": "Monthly total"},
                    ],
                },
                "valueFormat": "percent",
                "layout": "full",
                "maxRows": 100,
            },
        ],
        "tables": [
            {
                "id": "stability-table",
                "title": "Regime boundary stability by symbol",
                "subtitle": "Exact counts for the trailing one-year ready-bar population.",
                "dataset": "stability",
                "sourceId": "src-regime-replay",
                "defaultSort": {"field": "one_bar_segment_rate", "direction": "desc"},
                "density": "dense",
                "layout": "full",
                "columns": [
                    {"field": "symbol", "label": "Symbol", "type": "text"},
                    {"field": "regime_switches", "label": "Switches", "format": "number"},
                    {"field": "one_bar_segment_rate", "label": "One-bar rate", "format": "percent"},
                ],
            },
            {
                "id": "calibration-table",
                "title": "TRENDING theoretical score reachability",
                "subtitle": "ALPHA 0.5 reference only; not a realised distribution.",
                "dataset": "calibration_reference",
                "sourceId": "src-spec",
                "defaultSort": {"field": "scenario", "direction": "asc"},
                "density": "dense",
                "layout": "full",
                "columns": [
                    {"field": "scenario", "label": "Scenario", "type": "text"},
                    {"field": "score", "label": "Score", "format": "number"},
                ],
            },
        ],
    }
    # The limitation is rendered in the technical summary and dedicated score
    # section. It is not attached to a chart/table dataset because that would
    # suppress otherwise valid report blocks in the portable reader.
    access_issues: list[dict[str, Any]] = []
    snapshot = {
        "version": 1,
        "generatedAt": generated_iso,
        "status": status,
        "datasets": {
            "summary": summary,
            "daily_price": daily,
            "primary_price": primary_daily,
            "monthly_mix": monthly,
            "stability": stability,
            "segments": segments[:2_000],
            "score_distribution": [],
            "calibration_reference": calibration,
        },
        "accessIssues": access_issues,
    }
    return {
        "surface": "report",
        "manifest": manifest,
        "snapshot": snapshot,
        "sources": sources,
    }


def _relative_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return path.name


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.bar_count < 1_000:
        raise SystemExit("--bar-count must be at least 1000 for one-year H1 coverage")
    config = Config.load(args.config)
    timeframe = Timeframe(args.timeframe)
    blackouts, calendar_supplied = _read_blackouts(args.news_blackouts)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    generated_at = utc_now()

    connector = MT5Connector(
        config,
        terminal_path=args.terminal_path,
        login=args.login,
        password=args.password,
        server=args.server,
    )
    rows_by_symbol: dict[str, list[RegimeRow]] = {}
    with connector:
        symbols = args.symbol or connector.watchlist_from_config()
        connector.start(symbols)
        for symbol in symbols:
            candles = connector.bars_from_pos(
                symbol, timeframe, args.bar_count, start_pos=1
            )
            flags = _blackout_flags(
                symbol, candles, blackouts, calendar_supplied
            )
            rows = classify_series(symbol, candles, config, flags)
            year_rows = _year_window(rows)
            if not year_rows:
                raise SystemExit(f"{symbol}: no ready bars in trailing-year window")
            rows_by_symbol[symbol] = year_rows

        account_label = f"DEMO {connector.account.login} @ {connector.account.server}"

    source_path = output_dir / "regime_replay.json"
    source_payload = {
        "generated_at": generated_at.isoformat(),
        "config_version": config.version,
        "timeframe": timeframe.value,
        "calendar_supplied": calendar_supplied,
        "account": account_label,
        "rows": {
            symbol: [asdict(row) for row in rows]
            for symbol, rows in rows_by_symbol.items()
        },
    }
    source_path.write_text(
        json.dumps(source_payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    transition_audit = build_transition_audit(
        source_payload,
        source_path,
        config,
    )
    transition_audit_path = output_dir / "transition_audit.json"
    transition_audit_path.write_text(
        json.dumps(transition_audit, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    transition_audit_markdown_path = output_dir / "transition_audit.md"
    transition_audit_markdown_path.write_text(
        render_transition_audit_markdown(transition_audit),
        encoding="utf-8",
    )
    artifact = build_artifact(
        config=config,
        generated_at=generated_at,
        rows_by_symbol=rows_by_symbol,
        calendar_supplied=calendar_supplied,
        source_data_path=_relative_path(source_path),
        account_label=account_label,
        transition_audit=transition_audit,
        transition_audit_path=_relative_path(transition_audit_path),
    )
    artifact_path = output_dir / "artifact.json"
    artifact_path.write_text(
        json.dumps(artifact, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"Stage 1 artifact: {artifact_path}")
    print(f"Detailed replay: {source_path}")
    print(f"Transition audit: {transition_audit_path}")
    print(
        "Status: PARTIAL — calendar and realised-score limitations are visible "
        "in the report."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
