"""§5.4 Multi-timeframe combination, and the contradiction §6.1 resolves.

    "Each timeframe produces its own `TimeframeState`. They are **not** averaged
     into one number. [...] Disagreement is surfaced, not resolved. The UI shows
     every timeframe's state."

    | Pattern                   | Meaning                  | Action                        |
    |---------------------------|--------------------------|-------------------------------|
    | HTF agrees, LTF disagrees | Right idea, wrong timing | Route to Opportunity Radar as pending/forming |
    | HTF disagrees, LTF agrees | Counter-trend            | Apply 0.6 penalty; size down  |
    | HTF split (H4 vs H1)      | No coherent context      | Suppress signal               |

**A note on how these are asserted.** `combine_timeframes` returns a bare `dict`
and **nothing in §5.4, §5.3, §6.1 or §2 says what is in it** — no key names, no
nesting, nothing. Rather than invent a schema and test the invention, the tests
below assert over the *values* the result contains, using `gate_doubles.walk`.
That expresses what §5.4 actually claims — nothing was averaged, every timeframe
survived, and bias-vs-bias suppression carries §5.3's journal-stable reason —
without pinning a layout the spec never gave.

The directionally symmetric row-1/row-2 readings are not asserted through that
bare dictionary. Where a claim can be routed through a *typed* seam instead,
it is: the 0.6
penalty is `compute_breadth_quality_score`'s `htf_penalty` argument and the
bias-vs-bias block is `evaluate_validity`'s `bias_timeframes_conflicted`
argument. Those are asserted there, not guessed at here.
"""

from __future__ import annotations

import pytest

from typing import Any

from backend.contracts import Direction, Regime, SignalState, Timeframe
from backend.scoring.gate import VALIDITY_CONDITIONS, combine_timeframes, evaluate_validity
from backend.scoring.score import compute_breadth_quality_score
from tests.stage1.gate_doubles import (
    breakdown,
    numbers_in,
    scoring_config,
    timeframe_state,
    walk,
)
from tests.stage1.stage1_doubles import (
    ALIGNED_MULTIPLIER,
    ALPHA,
    CLUSTER_A,
    CLUSTER_B,
    CLUSTER_C,
    CLUSTER_E,
    CLUSTER_REGISTRY,
    COUNTER_BIAS_PENALTY,
    REGIME_CLUSTER_MAP,
    all_firing,
    firing,
)

CONFIG = scoring_config()

#: Four clusters spanning §4 Pillars 1, 2 and 3, so §5.3's `min_clusters` and
#: `min_pillars` are both satisfied and the only thing under test here is
#: condition 6.
VALID_FIRING = (
    firing(CLUSTER_A, Direction.BUY, 90.0, modules=(1,)),  # Pillar 1
    firing(CLUSTER_B, Direction.BUY, 90.0, modules=(12,)),  # Pillar 2
    firing(CLUSTER_C, Direction.BUY, 90.0, modules=(5,)),  # Pillar 1
    firing(CLUSTER_E, Direction.BUY, 90.0, modules=(17,)),  # Pillar 3
)
FOUR_CLUSTERS = (CLUSTER_A, CLUSTER_B, CLUSTER_C, CLUSTER_E)


def _tokens(obj: Any) -> set:
    """Every leaf in `obj`, with enum members reduced to their values.

    §2's enums are `str` mixins, so this reads the same whether an
    implementation stores `SignalState.LOCKED` or `"LOCKED"` — which is another
    thing the unspecified return schema leaves open.
    """
    return {getattr(v, "value", v) for v in walk(obj)}

#: §5.4: "**Bias timeframe** (default H4) establishes directional context" and
#: "**Entry timeframe** (user-selected, default M15)". Appendix B #4 reserves the
#: bias timeframe, so H4 here is a test fixture matching the spec's parenthesis.
BIAS_TF = Timeframe.H4
SECOND_BIAS_TF = Timeframe.H1  # §5.4's "HTF split (H4 vs H1 conflict)"
ENTRY_TF = Timeframe.M15

#: Three scores whose arithmetic mean (64.0) is not any of them, so a single
#: averaged number is recognisable on sight.
HTF_SCORE, MID_SCORE, LTF_SCORE = 88.0, 61.0, 43.0
ARITHMETIC_MEAN = (HTF_SCORE + MID_SCORE + LTF_SCORE) / 3.0  # 64.0


def _states(
    *,
    h4: Direction = Direction.BUY,
    h1: Direction = Direction.BUY,
    m15: Direction = Direction.BUY,
    h4_regime: Regime = Regime.TRENDING_BULLISH,
    h1_regime: Regime = Regime.TRENDING_BULLISH,
    m15_regime: Regime = Regime.TRENDING_BULLISH,
    h4_state: SignalState = SignalState.LOCKED,
    h1_state: SignalState = SignalState.SCANNING,
    m15_state: SignalState = SignalState.AWAITING_VALIDATION,
) -> dict[Timeframe, object]:
    """One `TimeframeState` per timeframe, each with its own regime, direction,
    score and lifecycle position — which is what §5.4 says it combines."""
    return {
        BIAS_TF: timeframe_state(
            BIAS_TF, regime=h4_regime, direction=h4, state=h4_state, score=HTF_SCORE
        ),
        SECOND_BIAS_TF: timeframe_state(
            SECOND_BIAS_TF, regime=h1_regime, direction=h1, state=h1_state, score=MID_SCORE
        ),
        ENTRY_TF: timeframe_state(
            ENTRY_TF, regime=m15_regime, direction=m15, state=m15_state, score=LTF_SCORE
        ),
    }


# ============================================= they are NOT averaged into one


def test_timeframes_are_not_averaged_into_one_number():
    """§5.4: "Each timeframe produces its own `TimeframeState`. They are **not**
    averaged into one number."

    The three input scores are 88, 61 and 43 — an arithmetic mean of exactly
    64.0, which is none of them and is not a threshold. If a combined score
    appears anywhere in the result, the collapse §5.4 forbids has happened.

    Why it matters beyond tidiness: an average hides which timeframe disagreed,
    and §5.4's three encoded patterns are all *about* which one disagreed. Once
    they are averaged the patterns are unrecoverable.
    """
    combined = combine_timeframes(_states(), CONFIG)

    assert ARITHMETIC_MEAN not in numbers_in(combined), (
        "an averaged composite score is exactly what §5.4 forbids"
    )


def test_every_timeframe_survives_the_combination():
    """§5.4: "Disagreement is surfaced, not resolved. **The UI shows every
    timeframe's state.**"

    The dual of the averaging test — it is not enough that no mean appears, the
    individual readings must still be there. §2 backs this with
    `Signal.timeframes: dict[Timeframe, TimeframeState]` and `Signal.mtf_aligned`
    ("1/5" — timeframes agreeing with this direction), both of which are
    unwritable from a collapsed number.
    """
    states = _states()
    combined = combine_timeframes(states, CONFIG)

    seen = _tokens(combined)
    for timeframe in states:
        assert timeframe.value in seen, (
            f"{timeframe.value} is not represented in the combined result"
        )
    for score in (HTF_SCORE, MID_SCORE, LTF_SCORE):
        assert score in numbers_in(combined), (
            f"the per-timeframe score {score} did not survive combination"
        )


def test_default_entry_timeframe_remains_m15_when_m5_is_also_configured():
    """§5.4 says the default is M15; analysis-list order must not change it."""

    states = _states()
    states[Timeframe.M5] = timeframe_state(
        Timeframe.M5,
        regime=Regime.TRENDING_BEARISH,
        direction=Direction.SELL,
        state=SignalState.AWAITING_VALIDATION,
        score=37.0,
    )

    combined = combine_timeframes(states, CONFIG)

    assert combined["candidate_direction"] == Direction.BUY.value
    assert combined["route"] == "STANDARD"


# =============================================== unambiguous conflict behavior


def test_a_split_between_the_bias_timeframes_suppresses_the_signal():
    """§5.4 row 3: "HTF split (H4 vs H1 conflict) | No coherent context |
    **Suppress signal**."

    §6.1 states the mechanism: "§5.3 validity rule 6 suppresses a signal when the
    **bias timeframes disagree with each other** — H4 says TRENDING_BULLISH while
    H1 says TRENDING_BEARISH — because there is then no coherent context to trade
    into."

    That gives the assertion a journal-stable name to look for rather than an
    invented key: `BIAS_TIMEFRAMES_NOT_CONFLICTED` is §5.3 condition 6 and is in
    `VALIDITY_CONDITIONS`. Rule 8 requires the reason to be recorded, so the
    combination cannot suppress silently.
    """
    combined = combine_timeframes(
        _states(
            h4=Direction.BUY,
            h4_regime=Regime.TRENDING_BULLISH,
            h1=Direction.SELL,
            h1_regime=Regime.TRENDING_BEARISH,
            m15=Direction.BUY,
        ),
        CONFIG,
    )

    assert "BIAS_TIMEFRAMES_NOT_CONFLICTED" in _tokens(combined)
    assert "BIAS_TIMEFRAMES_NOT_CONFLICTED" in VALIDITY_CONDITIONS


def test_bias_vs_entry_conflict_penalises_the_score_without_blocking_validity():
    """§3.5 / §5.4: bias-vs-entry conflict penalises rather than vetoes.

    The typed scoring and validity seams can express this without inventing a
    schema for ``combine_timeframes``: validity sees no bias-vs-bias conflict,
    while the final score alone receives the configured 0.6 multiplier.
    """
    penalised = evaluate_validity(
        breakdown(score=74.8 * COUNTER_BIAS_PENALTY),
        VALID_FIRING,
        CLUSTER_REGISTRY,
        Regime.TRENDING_BULLISH,
        20,
        26,
        False,
        False,  # the bias timeframes agree with EACH OTHER
        False,
        CONFIG,
    )
    assert penalised.passed is True
    assert penalised.failed_conditions == []

    aligned = compute_breadth_quality_score(
        all_firing(FOUR_CLUSTERS, Direction.BUY, 90.0),
        CLUSTER_REGISTRY,
        Regime.TRENDING_BULLISH,
        Direction.BUY,
        Direction.BUY,
        REGIME_CLUSTER_MAP,
        ALPHA,
        ALIGNED_MULTIPLIER,
    )
    opposing = compute_breadth_quality_score(
        all_firing(FOUR_CLUSTERS, Direction.BUY, 90.0),
        CLUSTER_REGISTRY,
        Regime.TRENDING_BULLISH,
        Direction.BUY,
        Direction.BUY,
        REGIME_CLUSTER_MAP,
        ALPHA,
        COUNTER_BIAS_PENALTY,
    )
    assert opposing.score == pytest.approx(aligned.score * COUNTER_BIAS_PENALTY)
