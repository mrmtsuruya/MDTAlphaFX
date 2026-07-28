"""§5.3 validity gate — the six structural conditions, plus §5.5's `POOR_RR`.

    "**Validity gate.** These are structural facts, not preferences. Failing any
     of them means the setup is not tradeable at any score."

Two properties carry most of this file's weight.

**Every failing condition is recorded, not just the first.** §5.3 states it and
§10.2 says why it matters: near-miss logging "is the only way to notice that
`min_clusters` — not the score — has been silently rejecting everything." A gate
that returns on its first failure passes a one-condition-at-a-time test and fails
`test_every_failing_condition_is_recorded_not_just_the_first`, which is the
single test in this file worth keeping if the rest were deleted.

**`min_pillars` counts pillars among FIRING MODULES, not firing clusters.**
§5.1.1: "§5.3's `min_pillars` is that check, and it counts pillars among
**firing modules**, not among firing clusters." Clusters B, C and D₂ each span
two pillars, so a cluster count cannot answer the question a pillar count asks.

Every threshold below is declared in `gate_doubles`, never read from
`config/scoring.yaml`, so these specification tests stay pinned to the approved
baseline if runtime calibration changes later.

**On the `firing` argument.** `evaluate_validity` takes `firing: Sequence[
FiringCluster]` and is given no direction, trend direction or cluster map, so it
cannot derive §5.2's firing set itself — the caller must have filtered already.
These tests therefore pass only clusters that fired *and* agree, all with
`fired=True`, which reads the same whether the implementation counts the sequence
or re-filters it on `.fired`.
"""

from __future__ import annotations

import pytest

from backend.contracts import Direction, GateOutcome, Regime
from backend.scoring.gate import VALIDITY_CONDITIONS, count_pillars, evaluate_validity
from tests.stage1.gate_doubles import (
    AUTO_EXECUTE_THRESHOLD,
    DISPLAY_THRESHOLD,
    MIN_CLUSTERS,
    MIN_PILLARS,
    breakdown,
    scoring_config,
)
from tests.stage1.stage1_doubles import (
    CLUSTER_A,
    CLUSTER_B,
    CLUSTER_C,
    CLUSTER_D1,
    CLUSTER_D2,
    CLUSTER_E,
    CLUSTER_F,
    CLUSTER_G,
    CLUSTER_H,
    CLUSTER_REGISTRY,
    firing,
)

CONFIG = scoring_config()

# §5.3 condition 4: "Spread ≤ `max_spread_points` | per symbol | —". The spec
# proposes no value (AMBIGUITY-003: "§7.3 requires it and never proposes a
# value. Per-symbol — a number sane for EURUSD is nonsense for BTCUSD"), so
# these two are bare TEST FIXTURES. Every assertion below is about the
# RELATION between them, never about either number.
MAX_SPREAD_POINTS = 26
SPREAD_INSIDE_LIMIT = 20
SPREAD_OVER_LIMIT = 27

#: A confluence that satisfies every condition: three clusters (≥ `min_clusters`)
#: whose firing modules span two pillars (≥ `min_pillars`). B fires through
#: module 12 (Support-to-Resistance Flip, §4 Pillar 2) rather than module 3.
VALID_CONFLUENCE = (
    firing(CLUSTER_A, Direction.BUY, 90.0, modules=(1,)),  # §4 Pillar 1
    firing(CLUSTER_B, Direction.BUY, 88.0, modules=(12,)),  # §4 Pillar 2
    firing(CLUSTER_C, Direction.BUY, 92.0, modules=(5,)),  # §4 Pillar 1
)

#: §5.3's own worked example, restated in TRENDING: three SMC clusters reading
#: the same displacement. Clears `min_clusters`, fails `min_pillars`.
PURE_SMC_CONFLUENCE = (
    firing(CLUSTER_A, Direction.BUY, 90.0, modules=(1,)),  # Bullish FVG Fill
    firing(CLUSTER_B, Direction.BUY, 88.0, modules=(3,)),  # Bullish Order Block
    firing(CLUSTER_C, Direction.BUY, 92.0, modules=(5,)),  # Sell-Side Sweep
)

#: Two clusters — one short of `min_clusters`, pillars satisfied.
TOO_FEW_CLUSTERS = (
    firing(CLUSTER_A, Direction.BUY, 90.0, modules=(1,)),
    firing(CLUSTER_E, Direction.BUY, 88.0, modules=(17,)),
)


def _evaluate(
    *,
    clusters=VALID_CONFLUENCE,
    score: float = 75.0,
    regime: Regime = Regime.TRENDING_BULLISH,
    spread_points: int = SPREAD_INSIDE_LIMIT,
    max_spread_points: int = MAX_SPREAD_POINTS,
    has_conflicting_position: bool = False,
    bias_timeframes_conflicted: bool = False,
    poor_rr: bool = False,
    config: dict = CONFIG,
) -> GateOutcome:
    """Run §5.3's gate over a baseline that passes, with one fact changed."""
    return evaluate_validity(
        breakdown(score=score),
        clusters,
        CLUSTER_REGISTRY,
        regime,
        spread_points,
        max_spread_points,
        has_conflicting_position,
        bias_timeframes_conflicted,
        poor_rr,
        config,
    )


# ====================================================== §5.3 rule 2 — pillars
#
#   | Cluster   | Pillars represented |
#   | A, D₁     | 1 only (SMC/ICT)    |
#   | B, C, D₂  | 1 and 2             |
#   | E, F      | 3 only (Trend & Momentum) |
#   | G, H      | 4 only (Volatility & MR)  |


def test_a_pure_smc_confluence_clears_min_clusters_and_fails_min_pillars():
    """§5.3: "A pure-SMC confluence of A + B + D₂ where only the Pillar-1 members
    fire will clear `min_clusters` and fail `min_pillars`."

    Verbatim: A (module 1), B (module 3) and D₂ (module 7) are three distinct
    clusters, satisfying `min_clusters = 3`, and every firing module belongs to
    §4 Pillar 1, so `min_pillars = 2` fails. Stated in RANGING because that is
    the regime §5.3's paragraph is discussing — D₂ is `ENABLED` there, and
    `COUNTER_ONLY` in TRENDING.

    "That is arguably correct — three SMC clusters reading the same displacement
    is exactly the correlation the rule guards against — but it is a real
    constraint, not a formality."
    """
    pure_smc = (
        firing(CLUSTER_A, Direction.BUY, 90.0, modules=(1,)),  # Bullish FVG Fill
        firing(CLUSTER_B, Direction.BUY, 88.0, modules=(3,)),  # Bullish Order Block
        firing(CLUSTER_D2, Direction.BUY, 91.0, modules=(7,)),  # CHoCH
    )

    assert len(pure_smc) >= MIN_CLUSTERS, "the premise: min_clusters is cleared"
    assert count_pillars(pure_smc, CLUSTER_REGISTRY) == 1

    outcome = _evaluate(clusters=pure_smc, regime=Regime.RANGING)

    assert outcome.passed is False
    assert "MIN_PILLARS" in outcome.failed_conditions
    assert "MIN_CLUSTERS" not in outcome.failed_conditions


@pytest.mark.parametrize(
    "clusters,expected",
    [
        pytest.param(
            (firing(CLUSTER_A, Direction.BUY, 90.0, modules=(1,)),),
            1,
            id="5.1.1-A_fires_module_1-pillar_1_only",
        ),
        pytest.param(
            (firing(CLUSTER_D1, Direction.BUY, 90.0, modules=(8,)),),
            1,
            id="5.1.1-D1_fires_module_8-pillar_1_only",
        ),
        pytest.param(
            (firing(CLUSTER_E, Direction.BUY, 90.0, modules=(17,)),),
            1,
            id="5.1.1-E_fires_module_17-pillar_3_only",
        ),
        pytest.param(
            (firing(CLUSTER_F, Direction.BUY, 90.0, modules=(20,)),),
            1,
            id="5.1.1-F_fires_module_20-pillar_3_only",
        ),
        pytest.param(
            (firing(CLUSTER_G, Direction.BUY, 90.0, modules=(24,)),),
            1,
            id="5.1.1-G_fires_module_24-pillar_4_only",
        ),
        pytest.param(
            (firing(CLUSTER_H, Direction.BUY, 90.0, modules=(23,)),),
            1,
            id="5.1.1-H_fires_module_23-pillar_4_only",
        ),
        pytest.param(
            (firing(CLUSTER_B, Direction.BUY, 90.0, modules=(3,)),),
            1,
            id="5.1.1-B_spans_two_pillars_but_fires_only_module_3-pillar_1",
        ),
        pytest.param(
            (firing(CLUSTER_B, Direction.BUY, 90.0, modules=(12,)),),
            1,
            id="5.1.1-B_spans_two_pillars_but_fires_only_module_12-pillar_2",
        ),
        pytest.param(
            (firing(CLUSTER_B, Direction.BUY, 90.0, modules=(3, 12)),),
            2,
            id="5.1.1-ONE_cluster_B_firing_modules_3_and_12-two_pillars",
        ),
        pytest.param(
            (firing(CLUSTER_C, Direction.BUY, 90.0, modules=(6, 15)),),
            2,
            id="5.1.1-ONE_cluster_C_firing_modules_6_and_15-two_pillars",
        ),
        pytest.param(
            (firing(CLUSTER_D2, Direction.BUY, 90.0, modules=(7, 11)),),
            2,
            id="5.1.1-ONE_cluster_D2_firing_modules_7_and_11-two_pillars",
        ),
        pytest.param(
            PURE_SMC_CONFLUENCE,
            1,
            id="5.3-THREE_clusters_A_B_C_all_pillar_1-one_pillar",
        ),
        pytest.param(
            VALID_CONFLUENCE,
            2,
            id="5.3-three_clusters_A_B_C_spanning_pillars_1_and_2-two_pillars",
        ),
        pytest.param((), 0, id="5.3-nothing_firing-no_pillars"),
    ],
)
def test_pillars_are_counted_among_firing_modules_not_firing_clusters(
    clusters, expected
):
    """§5.1.1: "it counts pillars among **firing modules**, not among firing
    clusters."

    The three-cluster rows are the point. `PURE_SMC_CONFLUENCE` is three clusters
    and one pillar; a single cluster B firing modules 3 and 12 is one cluster and
    two pillars. Any implementation that maps cluster → pillars gets both wrong
    in opposite directions, and gets the middle rows right — which is why the
    single-cluster-two-pillar rows are here.
    """
    assert count_pillars(clusters, CLUSTER_REGISTRY) == expected


def test_min_pillars_in_ranging_leans_on_one_module_or_one_cluster():
    """§5.3: "In RANGING it must come from B, C, D₂, F or G — and **F is a single
    module** (20, RSI divergence), while G is the only Pillar-4 cluster
    available. So `min_pillars = 2` in RANGING leans on either one module firing
    or one cluster."

    Documented in v2.4 as an emergent behaviour "rather than left implicit". A
    RANGING confluence of A + B + C firing only SMC modules is one pillar; adding
    F — a single module — is what supplies the second. "Check the journal for
    `MIN_PILLARS` rejection frequency before assuming the rule is inert."
    """
    smc_only = (
        firing(CLUSTER_A, Direction.SELL, 90.0, modules=(2,)),
        firing(CLUSTER_B, Direction.SELL, 88.0, modules=(4,)),
        firing(CLUSTER_C, Direction.SELL, 92.0, modules=(6,)),
    )
    assert count_pillars(smc_only, CLUSTER_REGISTRY) == 1

    rescued_by_one_module = smc_only + (
        firing(CLUSTER_F, Direction.SELL, 80.0, modules=(20,)),
    )
    assert count_pillars(rescued_by_one_module, CLUSTER_REGISTRY) == MIN_PILLARS

    blocked = _evaluate(clusters=smc_only, regime=Regime.RANGING)
    allowed = _evaluate(clusters=rescued_by_one_module, regime=Regime.RANGING)

    assert "MIN_PILLARS" in blocked.failed_conditions
    assert "MIN_PILLARS" not in allowed.failed_conditions


# ======================================== §5.3 the six conditions, one at a time
#
#   | # | Condition                                | Config key    | Default |
#   | 1 | ≥ N distinct clusters firing in agreement| min_clusters  | 3       |
#   | 2 | ≥ N distinct pillars represented         | min_pillars   | 2       |
#   | 3 | Regime is not VOLATILE_NEWS              | —             | always  |
#   | 4 | Spread ≤ max_spread_points               | per symbol    | —       |
#   | 5 | No conflicting open position on the symbol| —            | always  |
#   | 6 | Bias timeframes not in mutual conflict    | —             | always  |
#
# plus POOR_RR from §5.5.


@pytest.mark.parametrize(
    "condition,kwargs",
    [
        pytest.param(
            "MIN_CLUSTERS",
            dict(clusters=TOO_FEW_CLUSTERS),
            id="5.3-condition_1-MIN_CLUSTERS-two_clusters_below_three",
        ),
        pytest.param(
            "MIN_PILLARS",
            dict(clusters=PURE_SMC_CONFLUENCE),
            id="5.3-condition_2-MIN_PILLARS-three_clusters_one_pillar",
        ),
        pytest.param(
            "REGIME_NOT_VOLATILE_NEWS",
            dict(regime=Regime.VOLATILE_NEWS),
            id="5.3-condition_3-REGIME_NOT_VOLATILE_NEWS",
        ),
        pytest.param(
            "MAX_SPREAD",
            dict(spread_points=SPREAD_OVER_LIMIT),
            id="5.3-condition_4-MAX_SPREAD-spread_above_limit",
        ),
        pytest.param(
            "NO_CONFLICTING_POSITION",
            dict(has_conflicting_position=True),
            id="5.3-condition_5-NO_CONFLICTING_POSITION",
        ),
        pytest.param(
            "BIAS_TIMEFRAMES_NOT_CONFLICTED",
            dict(bias_timeframes_conflicted=True),
            id="5.3-condition_6-BIAS_TIMEFRAMES_NOT_CONFLICTED",
        ),
        pytest.param(
            "POOR_RR",
            dict(poor_rr=True),
            id="5.5-POOR_RR-tp1_after_snapping_below_min_rr",
        ),
    ],
)
def test_each_validity_condition_fails_alone(condition, kwargs):
    """§5.3 — one condition per case, against a baseline that otherwise passes.

    Each case asserts the condition it broke is reported **and that nothing else
    is**, which is what makes the multi-failure test below meaningful: a gate
    that reported every condition unconditionally would also "record all
    failures" and would be useless.
    """
    outcome = _evaluate(**kwargs)

    assert outcome.passed is False
    assert outcome.failed_conditions == [condition]


def test_the_baseline_confluence_passes_every_condition():
    """§5.3 — the control. Three clusters, two pillars, TRENDING, spread inside
    the limit, no conflicting position, bias timeframes agreed, RR acceptable.

    Without this the parameterised table above proves only that the gate rejects
    things, not that it ever admits anything.
    """
    outcome = _evaluate()

    assert outcome.passed is True
    assert outcome.failed_conditions == []


@pytest.mark.parametrize(
    "spread,fails",
    [
        pytest.param(MAX_SPREAD_POINTS - 1, False, id="5.3-condition_4-below_limit-passes"),
        pytest.param(MAX_SPREAD_POINTS, False, id="5.3-condition_4-EQUAL_to_limit-passes"),
        pytest.param(MAX_SPREAD_POINTS + 1, True, id="5.3-condition_4-above_limit-fails"),
    ],
)
def test_max_spread_is_inclusive(spread, fails):
    """§5.3 condition 4: "Spread **≤** `max_spread_points`."

    The boundary is inclusive, so a spread exactly at the limit is tradeable. An
    off-by-one here rejects every bar on an instrument whose spread is a constant
    — which is not hypothetical: the broker probe recorded XAUUSD.m at a flat 26
    points across p50, p95, p99 and max (`docs/AMBIGUITY.md`, item 003).
    """
    outcome = _evaluate(spread_points=spread)

    assert ("MAX_SPREAD" in outcome.failed_conditions) is fails


# ============================ the test that matters: EVERY failure is recorded


def test_every_failing_condition_is_recorded_not_just_the_first():
    """§5.3: "**Every failing condition is recorded, not just the first** —
    `GateOutcome.failed_conditions` carries all of them."

    THE test for this section. Three structural facts are wrong at once — the
    spread is over the limit, a conflicting position is open, and TP1 after
    snapping does not clear `min_rr`. All three must appear.

    A gate that returns on its first failure passes every one-condition case
    above and fails here. §10.2 names the consequence: near-miss records are
    "the only way to notice that `min_clusters` — not the score — has been
    silently rejecting everything", and a truncated list cannot answer that.

    The three chosen are mutually independent: none of them implies another, so
    an implementation cannot pass by inferring two from one.
    """
    outcome = _evaluate(
        spread_points=SPREAD_OVER_LIMIT,
        has_conflicting_position=True,
        poor_rr=True,
    )

    assert outcome.passed is False
    assert set(outcome.failed_conditions) == {
        "MAX_SPREAD",
        "NO_CONFLICTING_POSITION",
        "POOR_RR",
    }
    assert len(outcome.failed_conditions) == 3, "no duplicates"


@pytest.mark.parametrize(
    "kwargs,expected",
    [
        pytest.param(
            dict(clusters=TOO_FEW_CLUSTERS, spread_points=SPREAD_OVER_LIMIT),
            {"MIN_CLUSTERS", "MAX_SPREAD"},
            id="5.3-no_short_circuit-condition_1_does_not_hide_condition_4",
        ),
        pytest.param(
            dict(clusters=PURE_SMC_CONFLUENCE, has_conflicting_position=True),
            {"MIN_PILLARS", "NO_CONFLICTING_POSITION"},
            id="5.3-no_short_circuit-condition_2_does_not_hide_condition_5",
        ),
        pytest.param(
            dict(regime=Regime.VOLATILE_NEWS, bias_timeframes_conflicted=True),
            {"REGIME_NOT_VOLATILE_NEWS", "BIAS_TIMEFRAMES_NOT_CONFLICTED"},
            id="5.3-no_short_circuit-condition_3_does_not_hide_condition_6",
        ),
        pytest.param(
            dict(spread_points=SPREAD_OVER_LIMIT, poor_rr=True),
            {"MAX_SPREAD", "POOR_RR"},
            id="5.3-no_short_circuit-condition_4_does_not_hide_POOR_RR",
        ),
    ],
)
def test_an_early_failure_never_masks_a_later_one(kwargs, expected):
    """§5.3 — the same rule, walked across the condition order.

    Each pair puts an earlier-listed condition in front of a later one, so any
    implementation that stops at the first failure loses the second in every row.

    `TOO_FEW_CLUSTERS` is deliberately A (module 1, §4 Pillar 1) plus E (module
    17, §4 Pillar 3) — two pillars — so it fails condition 1 while *passing*
    condition 2. The first row therefore isolates `min_clusters` from
    `min_pillars`, which §5.3 warns are easy to conflate.
    """
    outcome = _evaluate(**kwargs)

    assert outcome.passed is False
    assert set(outcome.failed_conditions) == expected


def test_all_seven_conditions_can_fail_at_once():
    """§5.3 + §5.5 — the degenerate case, which is also a coherent one.

    In `VOLATILE_NEWS` every cluster is `SUPPRESSED` (§3.4), so nothing fires and
    conditions 1 and 2 fall out for free. Add a blown spread, an open conflicting
    position, conflicting bias timeframes and no room to the next level, and all
    seven names are true simultaneously.

    "**VOLATILE_NEWS generates no new signals at all.**" — §3.4. The record is
    still written: rule 8, and §10.2's "near-misses are logged too".
    """
    outcome = _evaluate(
        clusters=(),
        regime=Regime.VOLATILE_NEWS,
        spread_points=SPREAD_OVER_LIMIT,
        has_conflicting_position=True,
        bias_timeframes_conflicted=True,
        poor_rr=True,
    )

    assert outcome.passed is False
    assert set(outcome.failed_conditions) == set(VALIDITY_CONDITIONS)


def test_failed_condition_names_come_from_the_journal_stable_set():
    """Rule 8: "Every gate rejection writes its failing condition to the
    journal." §2's example is `["MIN_CLUSTERS", "MAX_SPREAD"]`.

    The names are a journal schema, not prose: §10.2's append-only decision log
    is queried by them, and a gate that invented `"min clusters"` or
    `"CLUSTER_COUNT"` would break every historical query without failing
    anything at runtime.
    """
    outcome = _evaluate(
        clusters=TOO_FEW_CLUSTERS,
        spread_points=SPREAD_OVER_LIMIT,
        poor_rr=True,
    )

    assert outcome.failed_conditions, "the premise: something failed"
    assert set(outcome.failed_conditions) <= set(VALIDITY_CONDITIONS)


# ================================ validity is independent of score, in both directions


@pytest.mark.parametrize(
    "score",
    [
        pytest.param(99.0, id="5.3-not_tradeable_at_any_score-99"),
        pytest.param(90.0, id="5.3-not_tradeable_at_any_score-90"),
        pytest.param(80.0, id="5.3-not_tradeable_at_any_score-80"),
        pytest.param(41.0, id="5.3-not_tradeable_at_any_score-41"),
    ],
)
def test_a_failed_condition_is_not_tradeable_at_any_score(score):
    """§5.3: "Failing any of them means the setup is **not tradeable at any
    score**."

    99 is the row that matters. A near-perfect confluence with a conflicting
    position open on the symbol is still not takeable, and the score is not a
    vote against the structural fact — validity is not a weighted input.
    """
    outcome = _evaluate(score=score, has_conflicting_position=True)

    assert outcome.passed is False
    assert "NO_CONFLICTING_POSITION" in outcome.failed_conditions
    assert outcome.score == pytest.approx(score), "the score is recorded, not suppressed"


def test_a_score_of_41_passes_validity_when_the_structure_is_sound():
    """§5.3: "A score of 41 is a real observation and belongs in the journal."
    The mirror of the test above — a low score is not a validity failure.

    Validity asks whether the setup is structurally tradeable; `display_threshold`
    asks whether it is worth showing. Conflating them was the central error in
    v2, and a gate that folded the score into validity would make the Signal
    Center's "what would I have caught at 65?" query unanswerable, because the
    records below 65 would never have been written.
    """
    outcome = _evaluate(score=41.0)

    assert outcome.passed is True
    assert outcome.failed_conditions == []
    assert outcome.score == pytest.approx(41.0)


def test_the_gate_outcome_is_a_complete_near_miss_record():
    """§10.2: "An evaluation that fails the gate is written with its
    `failed_conditions`, not discarded. This is what makes threshold tuning
    empirical rather than superstitious."

    §2 gives `GateOutcome` seven fields, and the four beyond `passed` and
    `failed_conditions` exist so a stored rejection can be re-read against a
    *different* threshold later without a re-run. A `GateOutcome` carrying only
    the verdict answers "was it rejected"; it cannot answer "would 65 have caught
    it", which is the question §5.3 and §10.2 both say the record exists for.
    """
    outcome = _evaluate(score=41.0, spread_points=SPREAD_OVER_LIMIT)

    assert outcome.score == pytest.approx(41.0)
    assert outcome.breadth == pytest.approx(0.69)
    assert outcome.quality == pytest.approx(90.0)
    assert outcome.display_threshold == pytest.approx(DISPLAY_THRESHOLD)
    assert outcome.auto_execute_threshold == pytest.approx(AUTO_EXECUTE_THRESHOLD)


def test_min_clusters_and_min_pillars_are_read_from_config_not_hardcoded():
    """CLAUDE.md: "Config, never constants. [...] A numeric literal in logic is a
    bug." §5.3: "Cluster and pillar minimums are **configurable** and must
    surface as rejection reasons."

    §5.3.1 explains why this one matters beyond style: "At a threshold of 85 they
    never bound. At 70 they become the binding constraint, and a silent rejection
    looks like a broken slider." A confluence of exactly three clusters passes at
    `min_clusters = 3` and must fail at 4 — with the same inputs, and with only
    the config changed.
    """
    at_three = _evaluate(config=scoring_config(min_clusters=MIN_CLUSTERS))
    at_four = _evaluate(config=scoring_config(min_clusters=MIN_CLUSTERS + 1))

    assert "MIN_CLUSTERS" not in at_three.failed_conditions
    assert "MIN_CLUSTERS" in at_four.failed_conditions

    at_two_pillars = _evaluate(config=scoring_config(min_pillars=MIN_PILLARS))
    at_three_pillars = _evaluate(config=scoring_config(min_pillars=MIN_PILLARS + 1))

    assert "MIN_PILLARS" not in at_two_pillars.failed_conditions
    assert "MIN_PILLARS" in at_three_pillars.failed_conditions
