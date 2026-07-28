"""§3 Tier 1 — pure market-regime features, classification, and hysteresis."""

from .classifier import (
    RegimeInputs,
    RegimeVerdict,
    apply_hysteresis,
    classify_raw,
    cluster_state,
    htf_alignment_penalty,
)
from .features import (
    NewsBlackoutFlags,
    RegimeFeatureConfig,
    compute_regime_inputs,
)

__all__ = [
    "NewsBlackoutFlags",
    "RegimeFeatureConfig",
    "RegimeInputs",
    "RegimeVerdict",
    "apply_hysteresis",
    "classify_raw",
    "cluster_state",
    "compute_regime_inputs",
    "htf_alignment_penalty",
]
