"""Stage 1 test doubles — §3's inputs, §3.4's cluster map, §5.1's cluster table.

**Nothing here reads `config/*.yaml`, deliberately.** §5.3.1 and §5.3.2's
calibration tables were computed with **ALPHA = 0.5 and
   the §5.1 hypothesised weights** ("These figures assume `ALPHA = 0.5` and the
§5.1 hypothesised weights"). Pinning those assertions to a future runtime
calibration would not test the published specification baseline.

Every agent-facing number below is quoted from the spec with its section. Where
the spec calls a number a *proposal* (Appendix B), it is used here as a **test
fixture**, not as a recommended default — the same convention `tests/doubles.py`
uses for costs.

The operator resolved `docs/AMBIGUITY.md` #001 by approving the ASCII `D1` and
`D2` identifiers used below and in `config/clusters.yaml`. Tests also assert the
§5.1 invariants: nine clusters, weights total 100, and modules partition 1–28.
"""

from __future__ import annotations

from typing import Any, Iterable

from backend.contracts import Direction, Regime, StrategyResult
from backend.regime.classifier import RegimeInputs, RegimeVerdict
from backend.scoring.types import ClusterDef, ClusterRegistry, ClusterState, FiringCluster

# =============================================================== §5.2 constants

#: §5.2: "score = 100 * (breadth ** ALPHA) * (quality / 100)  # ALPHA default 0.5".
#: Declared here rather than read from `config/scoring.yaml` because that file
#: carries a sentinel (Appendix B #6) AND because §5.3.1's and §5.3.2's tables
#: are only reproducible at 0.5. See the module docstring.
ALPHA = 0.5

#: §3.5 / §5.2: "1.0 aligned, 0.6 opposing". Appendix B #5 reserves the 0.6.
COUNTER_BIAS_PENALTY = 0.6
ALIGNED_MULTIPLIER = 1.0

# =============================================================== §3.2 constants

# §3.2 writes these three inline and Appendix B does *not* reserve them:
#   ELIF atr_percentile > 90 -> VOLATILE_NEWS
#   ... AND r_squared > 0.60 -> TRENDING_*
#   ... AND atr_percentile < 60 -> RANGING
# Note every comparison is STRICT. The boundary value itself must not trigger.
ATR_PERCENTILE_VOLATILE_ABOVE = 90.0
R_SQUARED_TREND_ABOVE = 0.60
ATR_PERCENTILE_RANGE_BELOW = 60.0

# §3.2 "adx > adx_trend_enter (27)" and §3.3 "Enter TRENDING at ADX > 27; exit
# only below 22. Enter RANGING at ADX < 20; exit above 25." Appendix B #1 and #2
# reserve all four as operator decisions — used here as test fixtures so the
# dead band has concrete edges to oscillate inside.
ADX_TREND_ENTER = 27.0
ADX_TREND_EXIT = 22.0
ADX_RANGE_ENTER = 20.0
ADX_RANGE_EXIT = 25.0

#: §3.3: "must hold for `regime_confirm_bars` (default **3**) consecutive closed
#: bars before it takes effect." Appendix B #3.
REGIME_CONFIRM_BARS = 3

#: §3.4 / §5.3: "TRANSITIONAL applies a signal threshold uplift of +5 and a
#: position size multiplier of 0.5." v2.4 lowered the uplift from +8.
TRANSITIONAL_THRESHOLD_UPLIFT = 5
TRANSITIONAL_SIZE_MULTIPLIER = 0.5

_CLASSIFICATION_KEYS = (
    "atr_percentile_volatile_above",
    "r_squared_trend_above",
    "atr_percentile_range_below",
)
_HYSTERESIS_KEYS = (
    "adx_trend_enter",
    "adx_trend_exit",
    "adx_range_enter",
    "adx_range_exit",
    "regime_confirm_bars",
    "transitional_exempt_from_confirmation",
)
_PER_TIMEFRAME_KEYS = ("counter_bias_penalty", "aligned_multiplier")
_POLICY_KEYS = (
    "transitional_threshold_uplift",
    "transitional_size_multiplier",
    "volatile_news_generates_signals",
)

_LEAVES: dict[str, Any] = {
    "atr_percentile_volatile_above": ATR_PERCENTILE_VOLATILE_ABOVE,
    "r_squared_trend_above": R_SQUARED_TREND_ABOVE,
    "atr_percentile_range_below": ATR_PERCENTILE_RANGE_BELOW,
    "adx_trend_enter": ADX_TREND_ENTER,
    "adx_trend_exit": ADX_TREND_EXIT,
    "adx_range_enter": ADX_RANGE_ENTER,
    "adx_range_exit": ADX_RANGE_EXIT,
    "regime_confirm_bars": REGIME_CONFIRM_BARS,
    # §3.3, not configurable — "TRANSITIONAL is exempt from confirmation".
    "transitional_exempt_from_confirmation": True,
    "counter_bias_penalty": COUNTER_BIAS_PENALTY,
    "aligned_multiplier": ALIGNED_MULTIPLIER,
    "transitional_threshold_uplift": TRANSITIONAL_THRESHOLD_UPLIFT,
    "transitional_size_multiplier": TRANSITIONAL_SIZE_MULTIPLIER,
    "volatile_news_generates_signals": False,
}


def regime_config(**overrides: Any) -> dict:
    """A test configuration accepted by the §3 public API.

    The API deliberately accepts injected flat dictionaries as well as the
    production nested YAML shape. This returns both so each test can focus on
    the specification behavior it is exercising.
    """
    leaves = dict(_LEAVES)
    leaves.update(overrides)
    cfg: dict[str, Any] = dict(leaves)
    cfg["classification"] = {k: leaves[k] for k in _CLASSIFICATION_KEYS}
    cfg["hysteresis"] = {k: leaves[k] for k in _HYSTERESIS_KEYS}
    cfg["per_timeframe"] = {k: leaves[k] for k in _PER_TIMEFRAME_KEYS}
    cfg["regime_policy"] = {k: leaves[k] for k in _POLICY_KEYS}
    return cfg


# ================================================== §5.1 the nine cluster ids

# See the module docstring: AMBIGUITY-001. These are symbols, never literals in
# a test assertion.
CLUSTER_A = "A"
CLUSTER_B = "B"
CLUSTER_C = "C"
CLUSTER_D1 = "D1"
CLUSTER_D2 = "D2"
CLUSTER_E = "E"
CLUSTER_F = "F"
CLUSTER_G = "G"
CLUSTER_H = "H"

ALL_CLUSTER_IDS = (
    CLUSTER_A,
    CLUSTER_B,
    CLUSTER_C,
    CLUSTER_D1,
    CLUSTER_D2,
    CLUSTER_E,
    CLUSTER_F,
    CLUSTER_G,
    CLUSTER_H,
)

# §5.1's table, verbatim. "Modules are therefore grouped into 9 clusters, and
# weight is assigned per cluster, not per module."
#
#   | Cluster            | Modules       | Base weight |
#   | A  Imbalance       | 1, 2, 10      | 11 |
#   | B  Zone retest     | 3, 4, 9,12,13 | 12 |
#   | C  Stop hunt       | 5, 6,14,15,16 | 12 |
#   | D1 Structure cont. | 8             | 11 |
#   | D2 Structure rev.  | 7, 11         | 11 |
#   | E  Trend stack     |17,18,19,21,22 | 12 |
#   | F  Momentum diverg.| 20            | 11 |
#   | G  Envelope revers.|24, 25, 26     | 10 |
#   | H  Volatility exp. |23, 27, 28     | 10 |
_CLUSTER_TABLE: tuple[tuple[str, str, int, tuple[int, ...]], ...] = (
    (CLUSTER_A, "Imbalance", 11, (1, 2, 10)),
    (CLUSTER_B, "Zone retest", 12, (3, 4, 9, 12, 13)),
    (CLUSTER_C, "Stop hunt & reject", 12, (5, 6, 14, 15, 16)),
    (CLUSTER_D1, "Structure continuation", 11, (8,)),
    (CLUSTER_D2, "Structure reversal", 11, (7, 11)),
    (CLUSTER_E, "Trend stack", 12, (17, 18, 19, 21, 22)),
    (CLUSTER_F, "Momentum divergence", 11, (20,)),
    (CLUSTER_G, "Envelope reversion", 10, (24, 25, 26)),
    (CLUSTER_H, "Volatility expansion", 10, (23, 27, 28)),
)

# §5.1.1 — pillars group by METHOD (4, the §4 headings); clusters group by
# OBSERVATION (9, they carry the weights). "They cut across each other, which is
# the entire point."
PILLAR_MODULES: dict[int, tuple[int, ...]] = {
    1: (1, 2, 3, 4, 5, 6, 7, 8, 9, 10),  # §4 Pillar 1 — SMC / ICT
    2: (11, 12, 13, 14, 15, 16),  # §4 Pillar 2 — Price Action & Pivots
    3: (17, 18, 19, 20, 21, 22),  # §4 Pillar 3 — Trend & Momentum
    4: (23, 24, 25, 26, 27, 28),  # §4 Pillar 4 — Volatility & Mean Reversion
}

PILLAR_OF_MODULE: dict[int, int] = {
    module: pillar for pillar, modules in PILLAR_MODULES.items() for module in modules
}

#: §5.1.1's cross-cut matrix. "Bold rows span two pillars — the same event seen
#: two ways." Recorded so the orthogonality test does not have to recompute it
#: from the thing it is checking.
CLUSTERS_SPANNING_TWO_PILLARS = (CLUSTER_B, CLUSTER_C, CLUSTER_D2)


def cluster_registry() -> ClusterRegistry:
    """§5.1's table as the real `ClusterRegistry`."""
    return ClusterRegistry(
        clusters=tuple(
            ClusterDef(cluster_id=cid, name=name, weight=weight, modules=modules)
            for cid, name, weight, modules in _CLUSTER_TABLE
        ),
        pillar_of_module=dict(PILLAR_OF_MODULE),
    )


CLUSTER_REGISTRY = cluster_registry()

WEIGHTS: dict[str, int] = {cid: weight for cid, _, weight, _ in _CLUSTER_TABLE}
MODULES_OF: dict[str, tuple[int, ...]] = {
    cid: modules for cid, _, _, modules in _CLUSTER_TABLE
}


def weight_sum(*cluster_ids: str) -> int:
    """Σ of §5.1 base weights. A table lookup, not a reimplementation of §5.2 —
    tests use it to *state* a denominator, never to derive one."""
    return sum(WEIGHTS[cid] for cid in cluster_ids)


def broken_registry_module_in_two_clusters() -> ClusterRegistry:
    """§5.1: "A module in two clusters would be double-counted."

    Module 1 is added to cluster H while remaining in cluster A.
    """
    clusters = []
    for cid, name, weight, modules in _CLUSTER_TABLE:
        if cid == CLUSTER_H:
            modules = tuple(modules) + (1,)
        clusters.append(
            ClusterDef(cluster_id=cid, name=name, weight=weight, modules=modules)
        )
    return ClusterRegistry(
        clusters=tuple(clusters), pillar_of_module=dict(PILLAR_OF_MODULE)
    )


def broken_registry_module_in_no_cluster() -> ClusterRegistry:
    """§5.1: "a module in none would be silently dead."

    Module 20 — the whole of cluster F — is dropped, so 1–28 has a hole.
    """
    clusters = []
    for cid, name, weight, modules in _CLUSTER_TABLE:
        if cid == CLUSTER_F:
            modules = tuple(m for m in modules if m != 20)
        clusters.append(
            ClusterDef(cluster_id=cid, name=name, weight=weight, modules=modules)
        )
    return ClusterRegistry(
        clusters=tuple(clusters), pillar_of_module=dict(PILLAR_OF_MODULE)
    )


def broken_registry_weights_not_100() -> ClusterRegistry:
    """§5.1: "the weights total 100" is a startup assertion. Here they total 101."""
    clusters = []
    for cid, name, weight, modules in _CLUSTER_TABLE:
        if cid == CLUSTER_A:
            weight += 1
        clusters.append(
            ClusterDef(cluster_id=cid, name=name, weight=weight, modules=modules)
        )
    return ClusterRegistry(
        clusters=tuple(clusters), pillar_of_module=dict(PILLAR_OF_MODULE)
    )


# ==================================================== §3.4 regime→cluster map

_TRENDING_ROW: dict[str, ClusterState] = {
    CLUSTER_A: ClusterState.ENABLED,
    CLUSTER_B: ClusterState.ENABLED,
    CLUSTER_C: ClusterState.ENABLED,
    CLUSTER_D1: ClusterState.ENABLED,
    CLUSTER_D2: ClusterState.COUNTER_ONLY,  # §3.4 note 1
    CLUSTER_E: ClusterState.ENABLED,
    CLUSTER_F: ClusterState.COUNTER_ONLY,  # §3.4 note 1
    CLUSTER_G: ClusterState.SUPPRESSED,
    CLUSTER_H: ClusterState.ENABLED,
}

_RANGING_ROW: dict[str, ClusterState] = {
    CLUSTER_A: ClusterState.ENABLED,
    CLUSTER_B: ClusterState.ENABLED,
    CLUSTER_C: ClusterState.ENABLED,
    CLUSTER_D1: ClusterState.SUPPRESSED,
    CLUSTER_D2: ClusterState.ENABLED,
    CLUSTER_E: ClusterState.SUPPRESSED,
    CLUSTER_F: ClusterState.ENABLED,
    CLUSTER_G: ClusterState.ENABLED,
    CLUSTER_H: ClusterState.SUPPRESSED,
}

#: §3.4: "**VOLATILE_NEWS generates no new signals at all.**"
_VOLATILE_NEWS_ROW: dict[str, ClusterState] = {
    cid: ClusterState.SUPPRESSED for cid in ALL_CLUSTER_IDS
}

_TRANSITIONAL_ROW: dict[str, ClusterState] = {
    CLUSTER_A: ClusterState.ENABLED,
    CLUSTER_B: ClusterState.ENABLED,
    CLUSTER_C: ClusterState.ENABLED,
    CLUSTER_D1: ClusterState.SUPPRESSED,
    CLUSTER_D2: ClusterState.ENABLED,
    CLUSTER_E: ClusterState.SUPPRESSED,
    CLUSTER_F: ClusterState.ENABLED,
    CLUSTER_G: ClusterState.SUPPRESSED,
    CLUSTER_H: ClusterState.SUPPRESSED,
}


def regime_cluster_map() -> dict:
    """§3.4's table, keyed by `Regime`.

    **§3.4's column header is "TRENDING"; the §2 `Regime` enum has two trending
    members.** `config/regime.yaml` keys the map `TRENDING`; the public function
    accepts a mapping. This double gives `TRENDING_BULLISH` and
    `TRENDING_BEARISH` the same row,
    because §3.4 shows one TRENDING column and nothing anywhere distinguishes
    the two for cluster enablement. If that reading is wrong, this is the one
    function to change.
    """
    return {
        Regime.TRENDING_BULLISH: dict(_TRENDING_ROW),
        Regime.TRENDING_BEARISH: dict(_TRENDING_ROW),
        Regime.RANGING: dict(_RANGING_ROW),
        Regime.VOLATILE_NEWS: dict(_VOLATILE_NEWS_ROW),
        Regime.TRANSITIONAL: dict(_TRANSITIONAL_ROW),
    }


REGIME_CLUSTER_MAP = regime_cluster_map()

# §5.2: "Working denominators under the §5.1 weights: TRENDING with-trend = 68
# (A, B, C, D1, E, H) · TRENDING counter-trend = 22 (D2, F) · RANGING = 67
# (A, B, C, D2, F, G) · TRANSITIONAL = 57 (A, B, C, D2, F)."
TRENDING_WITH_TREND_CLUSTERS = (
    CLUSTER_A,
    CLUSTER_B,
    CLUSTER_C,
    CLUSTER_D1,
    CLUSTER_E,
    CLUSTER_H,
)
TRENDING_COUNTER_TREND_CLUSTERS = (CLUSTER_D2, CLUSTER_F)
RANGING_CLUSTERS = (
    CLUSTER_A,
    CLUSTER_B,
    CLUSTER_C,
    CLUSTER_D2,
    CLUSTER_F,
    CLUSTER_G,
)
TRANSITIONAL_CLUSTERS = (CLUSTER_A, CLUSTER_B, CLUSTER_C, CLUSTER_D2, CLUSTER_F)

DENOM_TRENDING_WITH_TREND = 68
DENOM_TRENDING_COUNTER_TREND = 22
DENOM_RANGING = 67
DENOM_TRANSITIONAL = 57

# §5.3.1 and §5.3.2 label their rows by cluster COUNT, but §5.2's breadth is
# weight-based, so a count alone does not determine breadth — "4 of 6" spans
# several breadths depending on which four. The published breadth column
# disambiguates: 0.53, 0.69 and 0.85 are each produced by exactly one
# subset-sum of the six TRENDING with-trend weights (36, 47 and 58 of 68), which
# is the descending-weight prefix below. Every calibration test asserts the
# published breadth before it asserts the published score, so a wrong subset
# fails loudly rather than shifting the answer by two points.
CALIBRATION_ROWS: dict[int, tuple[str, ...]] = {
    3: (CLUSTER_B, CLUSTER_C, CLUSTER_E),  # 12+12+12 = 36/68 = 0.5294
    4: (CLUSTER_B, CLUSTER_C, CLUSTER_E, CLUSTER_A),  # +11 = 47/68 = 0.6912
    5: (
        CLUSTER_B,
        CLUSTER_C,
        CLUSTER_E,
        CLUSTER_A,
        CLUSTER_D1,
    ),  # +11 = 58/68 = 0.8529
    6: TRENDING_WITH_TREND_CLUSTERS,  # 68/68 = 1.0000
}

#: The breadth column as §5.3.1 and §5.3.2 print it.
CALIBRATION_BREADTH: dict[int, float] = {3: 0.53, 4: 0.69, 5: 0.85, 6: 1.00}


# ================================================== §5.1 cluster resolution

def firing(
    cluster_id: str,
    direction: Direction,
    score: float,
    *,
    modules: Iterable[int] = (),
    top_module: str = "",
) -> FiringCluster:
    """A cluster that fired, per §5.1 "Cluster resolution".

    The caller states the *resolved* outcome — "a cluster fires if ANY enabled
    member fires; its direction is the majority direction of firing members;
    its score is the MAXIMUM score among firing members agreeing with that
    direction". These tests supply that resolved output and assert on what
    §5.2 and §5.2.1 do with it.
    """
    mods = tuple(modules) if modules else MODULES_OF[cluster_id][:1]
    return FiringCluster(
        cluster_id=cluster_id,
        fired=True,
        direction=direction,
        score=score,
        contributing_modules=mods,
        top_module=top_module or f"module_{mods[0]}",
    )


def tied(cluster_id: str, score: float = 0.0) -> FiringCluster:
    """§5.1: "ties resolve to `NONE` and the cluster does not fire."

    `score` is settable so a test can prove a tie contributes nothing even when
    its members read strongly — the failure mode is a resolver that takes the
    first firing member instead of the majority.
    """
    return FiringCluster(
        cluster_id=cluster_id,
        fired=False,
        direction=Direction.NONE,
        score=score,
        contributing_modules=MODULES_OF[cluster_id],
        top_module="",
    )


def silent(cluster_id: str) -> FiringCluster:
    """A cluster with no firing member."""
    return FiringCluster(
        cluster_id=cluster_id,
        fired=False,
        direction=Direction.NONE,
        score=0.0,
    )


def resolved(*fired: FiringCluster) -> tuple:
    """All nine clusters in §5.1 order, with the given ones substituted in.

    §5.2's snippet iterates `CLUSTERS` — the complete resolved set — and derives
    both `available` and `firing` from it. Passing the complete set keeps the
    test agnostic about whether the implementation filters the argument or the
    registry.
    """
    overrides = {c.cluster_id: c for c in fired}
    unknown = set(overrides) - set(ALL_CLUSTER_IDS)
    if unknown:
        raise KeyError(f"not a §5.1 cluster: {sorted(unknown)}")
    return tuple(overrides.get(cid, silent(cid)) for cid in ALL_CLUSTER_IDS)


def all_firing(cluster_ids: Iterable[str], direction: Direction, score: float) -> tuple:
    """Every named cluster firing the same way at the same strength."""
    return resolved(*(firing(cid, direction, score) for cid in cluster_ids))


# ======================================================== §3.1 regime inputs


def inputs(
    *,
    adx: float = 24.0,
    ema_stack_aligned: bool = False,
    ema_stack_bullish: bool = False,
    atr_percentile: float = 50.0,
    r_squared: float = 0.30,
    within_news_blackout: bool = False,
) -> RegimeInputs:
    """§3.1's five inputs, pre-computed.

    The defaults deliberately match **no** §3.2 branch — ADX sits in the 22–27
    dead band, the stack is unaligned, R² is below 0.60 and ATR is neither above
    90 nor below 60 — so an unmodified `inputs()` falls through to the ELSE and
    every test states only the fields its branch turns on.
    """
    return RegimeInputs(
        adx=adx,
        ema_stack_aligned=ema_stack_aligned,
        ema_stack_bullish=ema_stack_bullish,
        atr_percentile=atr_percentile,
        r_squared=r_squared,
        within_news_blackout=within_news_blackout,
    )


def trending_inputs(*, bullish: bool = True, adx: float = 30.0, **overrides) -> RegimeInputs:
    """A textbook §3.2 branch-3 trend: ADX above enter, stack aligned, R² > 0.60."""
    base = dict(
        adx=adx,
        ema_stack_aligned=True,
        ema_stack_bullish=bullish,
        atr_percentile=50.0,
        r_squared=0.80,
    )
    base.update(overrides)
    return inputs(**base)


def ranging_inputs(*, adx: float = 15.0, **overrides) -> RegimeInputs:
    """A textbook §3.2 branch-4 range: ADX below enter AND ATR percentile < 60."""
    base = dict(
        adx=adx,
        ema_stack_aligned=False,
        ema_stack_bullish=False,
        atr_percentile=40.0,
        r_squared=0.10,
    )
    base.update(overrides)
    return inputs(**base)


def volatile_inputs(*, atr_percentile: float = 95.0, **overrides) -> RegimeInputs:
    """§3.2 branch 2 — ATR percentile above 90, nothing else needed."""
    base = dict(atr_percentile=atr_percentile)
    base.update(overrides)
    return inputs(**base)


def settled(regime: Regime, *, bars: int = 50) -> RegimeVerdict:
    """A regime that has been in force long enough that nothing is pending.

    `regime_confidence` is 1.0 so a test can assert §3.3's decay is *toward* 0
    without inventing the curve.
    """
    return RegimeVerdict(
        regime=regime,
        regime_confidence=1.0,
        bars_in_regime=bars,
        pending=None,
        pending_bars=0,
    )


# ==================================================== §5.2.2 FLAT mode inputs


def module_result(
    module_id: int,
    direction: Direction,
    score: float,
    *,
    fired: bool = True,
) -> StrategyResult:
    """A §2 `StrategyResult`, for §5.2.2's per-module FLAT mode."""
    return StrategyResult(
        module_id=module_id,
        module_name=f"module_{module_id}",
        fired=fired,
        direction=direction,
        score=score,
        evidence={},
    )


__all__ = [
    "ALPHA",
    "COUNTER_BIAS_PENALTY",
    "ALIGNED_MULTIPLIER",
    "ATR_PERCENTILE_VOLATILE_ABOVE",
    "R_SQUARED_TREND_ABOVE",
    "ATR_PERCENTILE_RANGE_BELOW",
    "ADX_TREND_ENTER",
    "ADX_TREND_EXIT",
    "ADX_RANGE_ENTER",
    "ADX_RANGE_EXIT",
    "REGIME_CONFIRM_BARS",
    "TRANSITIONAL_THRESHOLD_UPLIFT",
    "TRANSITIONAL_SIZE_MULTIPLIER",
    "regime_config",
    "CLUSTER_A",
    "CLUSTER_B",
    "CLUSTER_C",
    "CLUSTER_D1",
    "CLUSTER_D2",
    "CLUSTER_E",
    "CLUSTER_F",
    "CLUSTER_G",
    "CLUSTER_H",
    "ALL_CLUSTER_IDS",
    "CLUSTERS_SPANNING_TWO_PILLARS",
    "PILLAR_MODULES",
    "PILLAR_OF_MODULE",
    "WEIGHTS",
    "MODULES_OF",
    "weight_sum",
    "cluster_registry",
    "CLUSTER_REGISTRY",
    "broken_registry_module_in_two_clusters",
    "broken_registry_module_in_no_cluster",
    "broken_registry_weights_not_100",
    "regime_cluster_map",
    "REGIME_CLUSTER_MAP",
    "TRENDING_WITH_TREND_CLUSTERS",
    "TRENDING_COUNTER_TREND_CLUSTERS",
    "RANGING_CLUSTERS",
    "TRANSITIONAL_CLUSTERS",
    "DENOM_TRENDING_WITH_TREND",
    "DENOM_TRENDING_COUNTER_TREND",
    "DENOM_RANGING",
    "DENOM_TRANSITIONAL",
    "CALIBRATION_ROWS",
    "CALIBRATION_BREADTH",
    "firing",
    "tied",
    "silent",
    "resolved",
    "all_firing",
    "inputs",
    "trending_inputs",
    "ranging_inputs",
    "volatile_inputs",
    "settled",
    "module_result",
]
