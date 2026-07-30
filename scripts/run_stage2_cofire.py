"""Run the Stage 2 analysis-only co-firing and proposal harness.

The command accepts only the authorized registry-derived common evaluation
window and emits proposal evidence without applying it to production config.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.analysis.stage2_cofire import analyse_cofiring  # noqa: E402
from backend.analysis.stage2_proposal import (  # noqa: E402
    attach_latest_closed_regimes,
    canonical_json_bytes,
    classify_closed_h1,
    common_window_bars,
    evaluate_common_window_population,
    fire_count_artifact,
    neutral_cluster_proposals,
    neutral_reachability_artifact,
    observation_digest,
    pairwise_artifacts,
    pre_htf_score_ingredients,
    score_ingredient_summary,
)
from backend.contracts import Regime, Timeframe  # noqa: E402
from backend.core.config import Config  # noqa: E402
from backend.core.errors import ConfigError  # noqa: E402
from backend.core.timeutil import ensure_utc, timeframe_delta  # noqa: E402
from backend.data.stage2_analysis_store import (  # noqa: E402
    ANALYSIS_ONLY_SUBDIRECTORY,
    Stage2AnalysisParquetStore,
)
from backend.strategies import build_strategy_registry  # noqa: E402
from backend.strategies.configuration import (  # noqa: E402
    EVALUATION_WINDOW_POLICY,
    validate_strategy_config,
)


DEFAULT_OUTPUT_DIR = REPO_ROOT / "docs" / "stage2-gate" / "cofiring-proposal"
EVALUATION_POLICY_KEY = "strategies.co_firing.evaluation_window_policy"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Generate deterministic Stage 2 co-firing matrices and a "
            "proposal-only cluster/calibration artifact."
        )
    )
    parser.add_argument("--config", default=str(REPO_ROOT / "config"))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    return parser


def _parse_utc(value: str, key: str) -> datetime:
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise SystemExit(f"{key} must be ISO-8601 UTC, got {value!r}") from exc
    if parsed.tzinfo is None:
        raise SystemExit(f"{key} must carry an explicit UTC offset")
    return ensure_utc(parsed)


def require_evaluation_policy(config: Config) -> str:
    """Require the exact authorized common-window policy."""

    try:
        value = config.get(EVALUATION_POLICY_KEY)
    except ConfigError as exc:
        raise SystemExit(
            "The approved Stage 2 evaluation-window policy is missing; "
            "no proposal was written."
        ) from exc
    if value != EVALUATION_WINDOW_POLICY:
        raise SystemExit(
            f"{EVALUATION_POLICY_KEY}={value!r}; required "
            f"{EVALUATION_WINDOW_POLICY!r}. No proposal was written."
        )
    return str(value)


def _assert_approved_cofire_settings(config: Config) -> dict[str, Any]:
    values = config.section("strategies.co_firing")
    expected = {
        "observation": "SYMBOL_TIMEFRAME_BAR_CLOSE",
        "agreement": "SAME_DIRECTION_SIMULTANEOUS",
        "conflict": "OPPOSITE_DIRECTION_SIMULTANEOUS",
        "distance": "ONE_MINUS_POSITIVE_PHI",
        "linkage": "AVERAGE",
        "insufficient_module_policy": "RETAIN_CURRENT_MEMBERSHIP",
        "weight_policy": "EQUAL_INDEPENDENT_EVIDENCE",
        "apply_proposal_to_config": False,
    }
    mismatches = {
        key: {"actual": values.get(key), "expected": expected_value}
        for key, expected_value in expected.items()
        if values.get(key) != expected_value
        or type(values.get(key)) is not type(expected_value)
    }
    if mismatches:
        raise SystemExit(f"approved Stage 2 co-firing settings changed: {mismatches}")
    if values["apply_proposal_to_config"] is not False:
        raise SystemExit("apply_proposal_to_config must be exactly false")
    for key in (
        "minimum_module_fires",
        "target_cluster_count",
        "weight_total",
    ):
        value = values.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise SystemExit(f"strategies.co_firing.{key} must be a positive integer")
    return values


def _current_membership(config: Config) -> dict[str, tuple[int, ...]]:
    return {
        cluster_id: tuple(int(value) for value in raw["modules"])
        for cluster_id, raw in config.section("clusters.clusters").items()
    }


def _analysis_root(config: Config) -> Path:
    destination = Path(str(config.get("strategies.history.destination")))
    if not destination.is_absolute():
        destination = (REPO_ROOT / destination).resolve()
    return destination / ANALYSIS_ONLY_SUBDIRECTORY


def _gap_rows(bars: Sequence[Any], timeframe: Timeframe) -> list[dict[str, Any]]:
    delta = timeframe_delta(timeframe)
    result = []
    for left, right in zip(bars, bars[1:]):
        actual = right.time - left.time
        if actual != delta:
            result.append(
                {
                    "after": left.time.isoformat(),
                    "before": right.time.isoformat(),
                    "expected_seconds": int(delta.total_seconds()),
                    "actual_seconds": int(actual.total_seconds()),
                }
            )
    return result


def _file_sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(payload)
    os.replace(temporary, path)


def _write_json(path: Path, payload: Any) -> None:
    _write_bytes(
        path,
        json.dumps(
            payload,
            ensure_ascii=False,
            allow_nan=False,
            indent=2,
            sort_keys=True,
        ).encode("utf-8")
        + b"\n",
    )


def _proposal_payload(
    *,
    analysis: Any,
    neutral_clusters: Sequence[Any],
    config: Config,
    policy: str,
    observations: Sequence[Any],
    source_manifest_sha256: str,
    source_content_sha256: str,
) -> dict[str, Any]:
    return {
        "status": "PROPOSAL_ONLY_NOT_APPLIED",
        "label": "correlation-derived membership, outcome-uninformed equal weights",
        "config_version": config.version,
        "evaluation_window_policy": policy,
        "observation_count": len(observations),
        "observation_sha256": observation_digest(observations),
        "source_manifest_sha256": source_manifest_sha256,
        "source_content_sha256": source_content_sha256,
        "apply_proposal_to_config": False,
        "insufficient_modules": list(analysis.insufficient_modules),
        "clusters": [
            {
                **asdict(cluster),
                "modules": list(cluster.modules),
                "insufficient_modules": list(cluster.insufficient_modules),
            }
            for cluster in neutral_clusters
        ],
        "cluster_id_mapping": None,
        "cluster_id_mapping_status": "BLOCKED_PENDING_AUTHORIZATION",
        "stage1_reachability_status": "BLOCKED_PENDING_CLUSTER_ID_MAPPING",
        "realised_stage1_distribution_status": (
            "BLOCKED_PENDING_CLUSTER_ID_MAPPING_AND_HTF_POLICY"
        ),
    }


def _proposal_markdown(
    proposal: dict[str, Any],
    coverage: dict[str, Any],
    distribution: dict[str, Any],
) -> str:
    rows = "\n".join(
        "| {cluster_id} | {modules} | {weight} | {provisional} |".format(
            cluster_id=cluster["proposal_label"],
            modules=", ".join(str(value) for value in cluster["modules"]),
            weight=cluster["weight"],
            provisional="YES" if cluster["provisional"] else "NO",
        )
        for cluster in proposal["clusters"]
    )
    symbols = ", ".join(sorted(coverage["symbols"]))
    return (
        "# Stage 2 co-firing cluster and calibration proposal\n\n"
        f"Status: **{proposal['status']}**\n\n"
        "This artifact is detector co-firing evidence only. It contains no "
        "outcomes, fills, costs, M1 replay, backtest, order placement, AUTO "
        "execution, or production configuration mutation.\n\n"
        f"- Population: {proposal['observation_count']:,} eligible M15 closes "
        f"across {symbols}\n"
        f"- Evaluation window: `{proposal['evaluation_window_policy']}`\n"
        "- Regime attachment: latest closed effective H1 verdict at each M15 close\n"
        "- News boundary: no economic-calendar file supplied; ATR branch only\n"
        f"- Candidate score rows: "
        f"{distribution['candidate_rows']:,} pre-HTF unrestricted ingredients\n"
        f"- Source manifest SHA-256: `{proposal['source_manifest_sha256']}`\n"
        f"- Source content SHA-256: `{proposal['source_content_sha256']}`\n"
        f"- Observation SHA-256: `{proposal['observation_sha256']}`\n"
        "- Production config applied: **NO**\n\n"
        "- A–H regime-ID mapping: **BLOCKED — not authorized**\n"
        "- Realised Stage 1 distribution: **BLOCKED — no authorized A–H "
        "mapping or H4 penalty policy**\n\n"
        "## Proposed membership and equal weights\n\n"
        "| Cluster | Modules | Weight | Contains insufficient module |\n"
        "|---|---|---:|---|\n"
        f"{rows}\n\n"
        "P01–P09 are neutral deterministic labels sorted by member tuple; they "
        "do not inherit the regime meaning of A–H. Weights are deliberately "
        "outcome-uninformed and total exactly 100. "
        "Any cluster, weight, alpha, or threshold application requires a later "
        "explicit operator authorization.\n"
    )


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    config = Config.load(args.config)
    validate_strategy_config(config)
    cofire = _assert_approved_cofire_settings(config)

    # Fail before opening history or creating output directories. This is an
    # unresolved semantic decision, not an operational retry condition.
    policy = require_evaluation_policy(config)

    history = config.section("strategies.history")
    start = _parse_utc(str(history["start"]), "strategies.history.start")
    end = _parse_utc(str(history["end"]), "strategies.history.end")
    if end <= start:
        raise SystemExit("strategies.history.end must be after start")
    if Timeframe(str(history["co_firing_timeframe"])) is not Timeframe.M15:
        raise SystemExit("approved co-firing timeframe must remain M15")
    if Timeframe(str(history["regime_timeframe"])) is not Timeframe.H1:
        raise SystemExit("approved regime timeframe must remain H1")
    raw_timeframes = tuple(Timeframe(value) for value in history["raw_timeframes"])
    if set(raw_timeframes) != {Timeframe.H1, Timeframe.M15}:
        raise SystemExit("approved raw timeframes must remain exactly H1 and M15")

    store = Stage2AnalysisParquetStore.open(_analysis_root(config))
    source_manifest = store.manifest()
    if (
        source_manifest.get("analysis_only") is not True
        or source_manifest.get("cost_valid") is not False
    ):
        raise SystemExit("co-firing requires the analysis-only, cost-invalid store")
    source_manifest_sha256 = _file_sha256(store.manifest_path)
    source_content_sha256 = store.content_sha256
    if source_manifest.get("content_sha256") != source_content_sha256:
        raise SystemExit(
            "verified Stage 2 source content identity changed after open"
        )
    strategies = build_strategy_registry(config)

    observations = []
    coverage_symbols: dict[str, Any] = {}
    requested_symbols = tuple(str(value) for value in history["symbols"])
    for requested in requested_symbols:
        record = store.symbol_record(requested)
        h1 = store.bars(record.resolved_name, Timeframe.H1, start, end)
        m15 = store.bars(record.resolved_name, Timeframe.M15, start, end)
        if not h1 or not m15:
            raise SystemExit(
                f"required Stage 2 series is empty: {record.resolved_name}"
            )
        h1_coverage = store.coverage(record.resolved_name, Timeframe.H1)
        m15_coverage = store.coverage(record.resolved_name, Timeframe.M15)
        if h1_coverage is None or m15_coverage is None:
            raise SystemExit(
                f"required Stage 2 coverage missing: {record.resolved_name}"
            )
        h1_regimes = classify_closed_h1(h1, config)
        attached = attach_latest_closed_regimes(m15, h1_regimes)
        symbol_observations = evaluate_common_window_population(
            symbol=record.resolved_name,
            bars=m15,
            spec=record.spec,
            strategies=strategies,
            regimes=attached,
        )
        if not symbol_observations:
            raise SystemExit(
                f"no common eligible M15 population: {record.resolved_name}"
            )
        observations.extend(symbol_observations)
        coverage_symbols[record.resolved_name] = {
            "requested_symbol": requested,
            "H1": {
                "bars": len(h1),
                "coverage_first": h1_coverage[0].isoformat(),
                "coverage_last": h1_coverage[1].isoformat(),
                "gaps": _gap_rows(h1, Timeframe.H1),
                "effective_regime_rows": len(h1_regimes),
            },
            "M15": {
                "bars": len(m15),
                "coverage_first": m15_coverage[0].isoformat(),
                "coverage_last": m15_coverage[1].isoformat(),
                "gaps": _gap_rows(m15, Timeframe.M15),
                "eligible_observations": len(symbol_observations),
            },
        }
    observations.sort(key=lambda row: (row.symbol, row.close_time))

    analysis = analyse_cofiring(
        [row.cofire for row in observations],
        _current_membership(config),
        minimum_module_fires=int(cofire["minimum_module_fires"]),
        target_cluster_count=int(cofire["target_cluster_count"]),
        weight_total=int(cofire["weight_total"]),
    )
    if sum(cluster.weight for cluster in analysis.clusters) != int(
        cofire["weight_total"]
    ):
        raise AssertionError("proposal weights do not total the approved value")

    neutral_clusters = neutral_cluster_proposals(
        analysis,
        weight_total=int(cofire["weight_total"]),
    )
    score_rows = pre_htf_score_ingredients(
        observations=observations,
        config=config,
        clusters=neutral_clusters,
    )
    distribution = score_ingredient_summary(score_rows)
    overall_pairs, regime_pairs = pairwise_artifacts(analysis)
    coverage = {
        "requested_start": start.isoformat(),
        "requested_end_exclusive": end.isoformat(),
        "calendar_supplied": False,
        "symbols": coverage_symbols,
        "source_nonpositive_spread_rows": source_manifest[
            "nonpositive_spread_rows"
        ],
        "source_content_sha256": source_content_sha256,
    }
    proposal = _proposal_payload(
        analysis=analysis,
        neutral_clusters=neutral_clusters,
        config=config,
        policy=policy,
        observations=observations,
        source_manifest_sha256=source_manifest_sha256,
        source_content_sha256=source_content_sha256,
    )
    reachability = neutral_reachability_artifact(
        config=config,
        clusters=neutral_clusters,
    )
    fires = fire_count_artifact(observations)

    output = Path(args.output_dir).resolve()
    artifacts = {
        "coverage.json": coverage,
        "fire-counts.json": fires,
        "pairwise-overall.json": overall_pairs,
        "pairwise-by-regime.json": regime_pairs,
        "cluster-proposal.json": proposal,
        "pre-htf-unrestricted-reachability.json": reachability,
        "pre-htf-score-ingredient-summary.json": distribution,
    }
    for name, payload in artifacts.items():
        _write_json(output / name, payload)
    score_lines = b"".join(canonical_json_bytes(row) for row in score_rows)
    _write_bytes(output / "pre-htf-score-ingredients.jsonl", score_lines)
    _write_bytes(
        output / "PROPOSAL.md",
        _proposal_markdown(proposal, coverage, distribution).encode("utf-8"),
    )

    source_files = (
        REPO_ROOT / "backend" / "analysis" / "stage2_cofire.py",
        REPO_ROOT / "backend" / "analysis" / "stage2_proposal.py",
        REPO_ROOT / "scripts" / "run_stage2_cofire.py",
    )
    output_files = sorted(
        path for path in output.iterdir() if path.name != "manifest.json"
    )
    manifest = {
        "status": "PROPOSAL_ONLY_NOT_APPLIED",
        "config_version": config.version,
        "evaluation_window_policy": policy,
        "apply_proposal_to_config": False,
        "source_manifest_path": str(store.manifest_path),
        "source_manifest_sha256": source_manifest_sha256,
        "source_content_sha256": source_content_sha256,
        "observation_sha256": proposal["observation_sha256"],
        "implementation_sha256": {
            str(path.relative_to(REPO_ROOT)).replace("\\", "/"): _file_sha256(path)
            for path in source_files
        },
        "artifact_sha256": {
            path.name: _file_sha256(path) for path in output_files
        },
    }
    _write_json(output / "manifest.json", manifest)

    print("MDTAlphaFX — Stage 2 co-firing proposal")
    print(f"observations: {len(observations):,}")
    print(f"pre-HTF unrestricted score ingredient rows: {len(score_rows):,}")
    print(f"insufficient modules: {list(analysis.insufficient_modules)}")
    print(f"proposal: {output / 'PROPOSAL.md'}")
    print("Stage 1 reachability/distribution: BLOCKED (A–H mapping and H4 policy)")
    print("production configuration changed: NO")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
