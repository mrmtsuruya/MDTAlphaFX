"""Pure analytical cores. No data access or configuration writes."""

from .stage2_cofire import (
    ClusterProposal,
    CofireAnalysis,
    CofireObservation,
    PairRegimeMetrics,
    analyse_cofiring,
    cluster_modules,
    compute_pair_metrics,
    equal_cluster_weights,
)

__all__ = [
    "ClusterProposal",
    "CofireAnalysis",
    "CofireObservation",
    "PairRegimeMetrics",
    "analyse_cofiring",
    "cluster_modules",
    "compute_pair_metrics",
    "equal_cluster_weights",
]
