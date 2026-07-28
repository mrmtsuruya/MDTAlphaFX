"""Typed adapters from versioned YAML into the Stage 1 scoring model.

The scoring functions stay pure and accept explicit typed inputs. This module is
the startup boundary that converts ``config/clusters.yaml`` and
``config/regime.yaml`` into those inputs and executes §5.1's load-bearing
invariants before any score can be produced.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite
from types import MappingProxyType
from typing import Any

from ..contracts import Regime, Timeframe
from ..core.config import Config
from .gate import assert_thresholds_ordered
from .types import ClusterDef, ClusterRegistry, ClusterState


_CLUSTER_IDS = frozenset({"A", "B", "C", "D1", "D2", "E", "F", "G", "H"})
_REGIME_ROWS = {
    "TRENDING": (Regime.TRENDING_BULLISH, Regime.TRENDING_BEARISH),
    "RANGING": (Regime.RANGING,),
    "VOLATILE_NEWS": (Regime.VOLATILE_NEWS,),
    "TRANSITIONAL": (Regime.TRANSITIONAL,),
}
_RESOLUTION_RULES = {
    "fires_if": "ANY_MEMBER",
    "direction": "MAJORITY_OF_FIRING_MEMBERS",
    "tie_resolves_to": "NONE",
    "score": "MAX_OF_AGREEING_MEMBERS",
}
_EXPECTED_DENOMINATOR_KEYS = {
    "TRENDING_WITH_TREND",
    "TRENDING_COUNTER_TREND",
    "RANGING",
    "TRANSITIONAL",
}


def _mapping(value: Any, name: str) -> Mapping[Any, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be a mapping")
    return value


def _positive_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _module_list(value: Any, name: str) -> tuple[int, ...]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise ValueError(f"{name} must be a sequence of module ids")
    modules = tuple(_positive_int(item, name) for item in value)
    if not modules:
        raise ValueError(f"{name} cannot be empty")
    return modules


def _finite_number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be numeric")
    number = float(value)
    if not isfinite(number):
        raise ValueError(f"{name} must be finite")
    return number


def _timeframe(value: Any, name: str) -> Timeframe:
    try:
        return value if isinstance(value, Timeframe) else Timeframe(str(value))
    except ValueError as exc:
        raise ValueError(f"{name} is not a supported timeframe") from exc


def _freeze(value: Any) -> Any:
    if isinstance(value, Mapping):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_freeze(item) for item in value)
    return value


def build_cluster_registry(section: Mapping[str, Any]) -> ClusterRegistry:
    """Parse ``clusters.yaml`` and execute every §5.1 startup assertion."""

    invariants = _mapping(section.get("invariants"), "clusters.invariants")
    if invariants.get("weights_must_total") != 100:
        raise ValueError("clusters.invariants.weights_must_total must be 100")
    if invariants.get("modules_must_partition") != [1, 28]:
        raise ValueError(
            "clusters.invariants.modules_must_partition must be [1, 28]"
        )

    raw_clusters = _mapping(section.get("clusters"), "clusters.clusters")
    if set(raw_clusters) != _CLUSTER_IDS:
        raise ValueError(
            "clusters.clusters ids must be exactly A, B, C, D1, D2, E, F, G, H"
        )
    clusters: list[ClusterDef] = []
    for cluster_id, raw_definition in raw_clusters.items():
        definition = _mapping(
            raw_definition, f"clusters.clusters.{cluster_id}"
        )
        name = definition.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"clusters.clusters.{cluster_id}.name cannot be empty")
        clusters.append(
            ClusterDef(
                cluster_id=str(cluster_id),
                name=name,
                weight=_positive_int(
                    definition.get("weight"),
                    f"clusters.clusters.{cluster_id}.weight",
                ),
                modules=_module_list(
                    definition.get("modules"),
                    f"clusters.clusters.{cluster_id}.modules",
                ),
            )
        )

    raw_pillars = _mapping(section.get("pillars"), "clusters.pillars")
    pillar_of_module: dict[int, int] = {}
    for raw_pillar_id, raw_definition in raw_pillars.items():
        pillar_id = _positive_int(raw_pillar_id, "clusters pillar id")
        definition = _mapping(
            raw_definition, f"clusters.pillars.{pillar_id}"
        )
        for module_id in _module_list(
            definition.get("modules"),
            f"clusters.pillars.{pillar_id}.modules",
        ):
            if module_id in pillar_of_module:
                raise ValueError(
                    f"module {module_id} appears in more than one pillar"
                )
            pillar_of_module[module_id] = pillar_id

    resolution = _mapping(section.get("resolution"), "clusters.resolution")
    for key, expected in _RESOLUTION_RULES.items():
        if resolution.get(key) != expected:
            raise ValueError(
                f"clusters.resolution.{key} must be {expected!r}"
            )

    registry = ClusterRegistry(
        clusters=tuple(clusters),
        pillar_of_module=pillar_of_module,
    )
    registry.assert_invariants()
    return registry


def build_regime_cluster_map(
    section: Mapping[str, Any],
    registry: ClusterRegistry,
) -> dict[Regime, dict[str, ClusterState]]:
    """Parse §3.4's shared TRENDING row into all five typed enum rows."""

    raw_map = _mapping(section.get("cluster_map"), "regime.cluster_map")
    if set(raw_map) != set(_REGIME_ROWS):
        raise ValueError(
            "regime.cluster_map rows must be TRENDING, RANGING, "
            "VOLATILE_NEWS and TRANSITIONAL"
        )

    cluster_ids = {definition.cluster_id for definition in registry.clusters}
    result: dict[Regime, dict[str, ClusterState]] = {}
    source_rows: dict[str, dict[str, ClusterState]] = {}
    for row_name, regimes in _REGIME_ROWS.items():
        raw_row = _mapping(raw_map[row_name], f"regime.cluster_map.{row_name}")
        if set(raw_row) != cluster_ids:
            raise ValueError(
                f"regime.cluster_map.{row_name} must contain every cluster "
                "exactly once"
            )
        try:
            typed_row = {
                str(cluster_id): ClusterState(value)
                for cluster_id, value in raw_row.items()
            }
        except (TypeError, ValueError) as exc:
            raise ValueError(
                f"regime.cluster_map.{row_name} contains an invalid state"
            ) from exc
        source_rows[row_name] = typed_row
        for regime in regimes:
            result[regime] = dict(typed_row)

    if any(
        state is not ClusterState.SUPPRESSED
        for state in source_rows["VOLATILE_NEWS"].values()
    ):
        raise ValueError(
            "VOLATILE_NEWS must suppress every cluster and generate no signals"
        )

    weights = {
        definition.cluster_id: definition.weight
        for definition in registry.clusters
    }
    actual_denominators = {
        "TRENDING_WITH_TREND": sum(
            weights[cluster_id]
            for cluster_id, state in source_rows["TRENDING"].items()
            if state is ClusterState.ENABLED
        ),
        "TRENDING_COUNTER_TREND": sum(
            weights[cluster_id]
            for cluster_id, state in source_rows["TRENDING"].items()
            if state is ClusterState.COUNTER_ONLY
        ),
        "RANGING": sum(
            weights[cluster_id]
            for cluster_id, state in source_rows["RANGING"].items()
            if state is ClusterState.ENABLED
        ),
        "TRANSITIONAL": sum(
            weights[cluster_id]
            for cluster_id, state in source_rows["TRANSITIONAL"].items()
            if state is ClusterState.ENABLED
        ),
    }
    raw_expected = _mapping(
        section.get("expected_denominators"),
        "regime.expected_denominators",
    )
    if set(raw_expected) != _EXPECTED_DENOMINATOR_KEYS:
        raise ValueError(
            "regime.expected_denominators has missing or unknown rows"
        )
    expected = {
        key: _positive_int(value, f"regime.expected_denominators.{key}")
        for key, value in raw_expected.items()
    }
    if actual_denominators != expected:
        raise ValueError(
            "regime cluster-map denominators do not match the approved "
            f"calibration: actual={actual_denominators}, expected={expected}"
        )
    return result


def build_scoring_runtime_config(
    scoring: Mapping[str, Any],
    regime: Mapping[str, Any],
    engine: Mapping[str, Any],
) -> Mapping[str, Any]:
    """Merge split YAML namespaces into the one policy view Stage 1 consumes."""

    assert_thresholds_ordered(dict(scoring))

    thresholds = _mapping(scoring.get("thresholds"), "scoring.thresholds")
    validity = _mapping(scoring.get("validity"), "scoring.validity")
    tally = _mapping(scoring.get("tally"), "scoring.tally")
    regime_policy = _mapping(
        regime.get("regime_policy"), "regime.regime_policy"
    )
    regime_timeframes = _mapping(
        regime.get("per_timeframe"), "regime.per_timeframe"
    )

    alpha = _finite_number(scoring.get("alpha"), "scoring.alpha")
    if alpha <= 0.0:
        raise ValueError("scoring.alpha must be greater than zero")
    scoring_mode = scoring.get("scoring_mode")
    if scoring_mode not in {"CLUSTERED", "FLAT"}:
        raise ValueError("scoring.scoring_mode must be CLUSTERED or FLAT")

    uplift = _finite_number(
        regime_policy.get("transitional_threshold_uplift"),
        "regime.regime_policy.transitional_threshold_uplift",
    )
    if uplift < 0.0:
        raise ValueError("transitional_threshold_uplift cannot be negative")

    engine_bias = _timeframe(
        engine.get("bias_timeframe"), "engine.bias_timeframe"
    )
    regime_bias = _timeframe(
        regime_timeframes.get("bias_timeframe"),
        "regime.per_timeframe.bias_timeframe",
    )
    if engine_bias is not regime_bias:
        raise ValueError(
            "engine.bias_timeframe and regime.per_timeframe.bias_timeframe "
            "must agree"
        )
    entry_timeframe = _timeframe(
        engine.get("entry_timeframe"), "engine.entry_timeframe"
    )

    counter_penalty = _finite_number(
        regime_timeframes.get("counter_bias_penalty"),
        "regime.per_timeframe.counter_bias_penalty",
    )
    aligned_multiplier = _finite_number(
        regime_timeframes.get("aligned_multiplier"),
        "regime.per_timeframe.aligned_multiplier",
    )
    if not 0.0 < counter_penalty <= aligned_multiplier <= 1.0:
        raise ValueError(
            "timeframe multipliers must satisfy "
            "0 < counter_bias_penalty <= aligned_multiplier <= 1"
        )

    runtime = dict(scoring)
    runtime["thresholds"] = dict(thresholds)
    runtime["validity"] = dict(validity)
    runtime["tally"] = dict(tally)
    runtime["regime_policy"] = dict(regime_policy)
    runtime["per_timeframe"] = {
        **dict(regime_timeframes),
        "bias_timeframe": engine_bias.value,
        "entry_timeframe": entry_timeframe.value,
        "counter_bias_penalty": counter_penalty,
        "aligned_multiplier": aligned_multiplier,
    }
    return _freeze(runtime)


@dataclass(frozen=True)
class Stage1ScoringModel:
    """Validated typed scoring dependencies loaded from versioned config."""

    registry: ClusterRegistry
    cluster_map: Mapping[Regime, Mapping[str, ClusterState]]
    runtime_config: Mapping[str, Any]
    config_version: str | None = None

    def __post_init__(self) -> None:
        frozen_rows = {
            regime: MappingProxyType(dict(row))
            for regime, row in self.cluster_map.items()
        }
        object.__setattr__(
            self,
            "cluster_map",
            MappingProxyType(frozen_rows),
        )
        object.__setattr__(self, "runtime_config", _freeze(self.runtime_config))

    @classmethod
    def from_sections(
        cls,
        clusters: Mapping[str, Any],
        regime: Mapping[str, Any],
        scoring: Mapping[str, Any],
        engine: Mapping[str, Any],
        *,
        config_version: str | None = None,
    ) -> "Stage1ScoringModel":
        registry = build_cluster_registry(clusters)
        cluster_map = build_regime_cluster_map(regime, registry)
        runtime_config = build_scoring_runtime_config(scoring, regime, engine)
        return cls(
            registry=registry,
            cluster_map=cluster_map,
            runtime_config=runtime_config,
            config_version=config_version,
        )

    @classmethod
    def from_config(cls, config: Config) -> "Stage1ScoringModel":
        if not isinstance(config, Config):
            raise TypeError("config must be a Config")
        return cls.from_sections(
            config.section("clusters"),
            config.section("regime"),
            config.section("scoring"),
            config.section("engine"),
            config_version=config.version,
        )


__all__ = [
    "Stage1ScoringModel",
    "build_cluster_registry",
    "build_regime_cluster_map",
    "build_scoring_runtime_config",
]
