"""Shared Stage 1 scoring types — §§3.4, 5.1, 5.2 and 5.4.

Nothing here reads ``config/*.yaml``. Scoring remains a pure operation over
explicitly supplied registry, policy and timeframe state.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from types import MappingProxyType
from typing import Mapping

from ..contracts import Direction, Timeframe, TimeframeState


class ClusterState(str, Enum):
    """§3.4's three enablement states."""

    ENABLED = "ENABLED"
    COUNTER_ONLY = "COUNTER_ONLY"
    SUPPRESSED = "SUPPRESSED"


@dataclass(frozen=True)
class ClusterDef:
    """One of §5.1's nine correlation clusters."""

    cluster_id: str
    name: str
    weight: int
    modules: tuple[int, ...]


@dataclass(frozen=True)
class ClusterRegistry:
    """§5.1's cluster table plus §5.1.1's independent pillar map."""

    clusters: tuple[ClusterDef, ...]
    pillar_of_module: Mapping[int, int]

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "clusters",
            tuple(self.clusters),
        )
        object.__setattr__(
            self,
            "pillar_of_module",
            MappingProxyType(dict(self.pillar_of_module)),
        )

    def by_id(self, cluster_id: str) -> ClusterDef:
        for cluster in self.clusters:
            if cluster.cluster_id == cluster_id:
                return cluster
        raise KeyError(cluster_id)

    def assert_invariants(self) -> None:
        """Fail loudly when the registry cannot produce valid scores."""

        expected_ids = {"A", "B", "C", "D1", "D2", "E", "F", "G", "H"}
        cluster_ids = [cluster.cluster_id for cluster in self.clusters]
        if len(self.clusters) != len(expected_ids) or set(cluster_ids) != expected_ids:
            raise ValueError(
                "§5.1 cluster ids must be exactly A, B, C, D1, D2, E, F, G, H"
            )
        if len(cluster_ids) != len(set(cluster_ids)):
            raise ValueError("§5.1 cluster ids must be unique")

        weights = [cluster.weight for cluster in self.clusters]
        if any(
            isinstance(weight, bool) or not isinstance(weight, int) or weight <= 0
            for weight in weights
        ):
            raise ValueError("§5.1 cluster weights must be positive integers")
        if sum(weights) != 100:
            raise ValueError("§5.1 cluster weights must total exactly 100")

        members = [module for cluster in self.clusters for module in cluster.modules]
        if len(members) != len(set(members)):
            raise ValueError("§5.1 cluster membership contains an overlap")
        if sorted(members) != list(range(1, 29)):
            raise ValueError("§5.1 cluster membership must partition modules 1–28")

        if set(self.pillar_of_module) != set(range(1, 29)):
            raise ValueError("§5.1.1 pillar membership must cover modules 1–28")
        if set(self.pillar_of_module.values()) != {1, 2, 3, 4}:
            raise ValueError("§5.1.1 pillar ids must be exactly 1–4")


@dataclass(frozen=True)
class FiringCluster:
    """A cluster after §5.1 ANY / majority / MAX collapse."""

    cluster_id: str
    fired: bool
    direction: Direction
    score: float
    contributing_modules: tuple[int, ...] = ()
    top_module: str = ""


@dataclass(frozen=True)
class ScoreBreakdown:
    """§5.2's inseparable breadth, quality and composite score."""

    breadth: float
    quality: float
    score: float
    denominator: int
    numerator: int
    htf_penalty_applied: float


class MultiTimeframeRoute(str, Enum):
    """Candidate-centric §5.4 routing outcome."""

    STANDARD = "STANDARD"
    RADAR = "RADAR"
    SUPPRESSED = "SUPPRESSED"


@dataclass(frozen=True)
class MultiTimeframePolicy:
    """Typed policy used internally around frozen ``TimeframeState`` objects."""

    bias_timeframe: Timeframe
    secondary_bias_timeframe: Timeframe | None
    entry_timeframe: Timeframe
    counter_bias_penalty: float | None
    aligned_multiplier: float


@dataclass(frozen=True)
class MultiTimeframeInput:
    """The information needed to distinguish §5.4's first two rows."""

    states: Mapping[Timeframe, TimeframeState]
    candidate_direction: Direction
    policy: MultiTimeframePolicy

    def __post_init__(self) -> None:
        object.__setattr__(self, "states", MappingProxyType(dict(self.states)))


@dataclass(frozen=True)
class MultiTimeframeDecision:
    """Typed §5.4 output before compatibility serialization."""

    states: Mapping[Timeframe, TimeframeState]
    candidate_direction: Direction
    route: MultiTimeframeRoute
    score_penalty: float
    counter_bias: bool
    bias_timeframes_conflicted: bool
    failed_conditions: tuple[str, ...]
    aligned_count: int
    timeframe_count: int

    def __post_init__(self) -> None:
        object.__setattr__(self, "states", MappingProxyType(dict(self.states)))

    @property
    def mtf_aligned(self) -> str:
        return f"{self.aligned_count}/{self.timeframe_count}"

    def as_dict(self) -> dict:
        """Return the existing public shape without collapsing timeframe state."""

        return {
            "timeframes": {
                timeframe.value: state.model_dump(mode="json")
                for timeframe, state in self.states.items()
            },
            "candidate_direction": self.candidate_direction.value,
            "route": self.route.value,
            "score_penalty": self.score_penalty,
            "counter_bias": self.counter_bias,
            "bias_timeframes_conflicted": self.bias_timeframes_conflicted,
            "failed_conditions": list(self.failed_conditions),
            "mtf_aligned": self.mtf_aligned,
        }


__all__ = [
    "ClusterState",
    "ClusterDef",
    "ClusterRegistry",
    "FiringCluster",
    "ScoreBreakdown",
    "MultiTimeframeRoute",
    "MultiTimeframePolicy",
    "MultiTimeframeInput",
    "MultiTimeframeDecision",
]
