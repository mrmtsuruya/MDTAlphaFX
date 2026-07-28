"""§5.3 — validity, visibility and execution are three different questions.

    "The three questions are answered separately, and **conflating them was the
     central error in v2**."

    | Question                    | Governed by            | Effect when it fails                       |
    |-----------------------------|------------------------|--------------------------------------------|
    | Is this structurally valid? | validity gate          | Signal recorded, never shown, cannot be taken |
    | Should the user see it?     | `display_threshold` 70 | Recorded and queryable, hidden from default views |
    | May it fire unattended?     | `auto_execute_threshold` 80 | Shown and takeable by hand, never auto-executed |

The whole file exists to stop the three collapsing back into one. `display_threshold`
is a **filter** — it sets `Signal.displayed` and never prevents construction —
and the consequences §5.3 lists are all consequences of records existing below
it:

    "The Signal Center can answer *"what would I have caught at 65?"* by
     re-filtering existing records — no re-run, no lost history."

Thresholds are declared in `gate_doubles`, never read from `config/scoring.yaml`:
`display_threshold` and `auto_execute_threshold` are pinned to the approved
Appendix B #7 and #8 values so future calibration cannot rewrite this contract.
"""

from __future__ import annotations

import pytest

from backend.contracts import Direction, Regime, SignalState, Timeframe
from backend.scoring.gate import (
    assert_thresholds_ordered,
    is_auto_eligible,
    is_displayed,
)
from tests.stage1.gate_doubles import (
    AUTO_EXECUTE_THRESHOLD,
    DISPLAY_THRESHOLD,
    REJECTED_TRANSITIONAL_UPLIFT,
    TRANSITIONAL_FOUR_OF_FIVE_AT_Q85,
    assert_rejects,
    contested_tally,
    gate_outcome,
    scoring_config,
    signal,
    vote_tally,
)
from tests.stage1.stage1_doubles import TRANSITIONAL_THRESHOLD_UPLIFT

CONFIG = scoring_config()

# The auto-eligibility tests all state TRENDING_BULLISH deliberately. §5.3 says
# "`display_threshold` rises by 5 in TRANSITIONAL" and §3.4 says "TRANSITIONAL
# applies a **signal threshold** uplift of +5" — whether the uplift also moves
# `auto_execute_threshold` is not stated either way. Left untested rather than
# decided; see the report.
WITH_TREND = Regime.TRENDING_BULLISH


# ============================== `display_threshold` is a FILTER, not a gate


@pytest.mark.parametrize(
    "score,expected",
    [
        pytest.param(41.0, False, id="5.3-display_filter-41_is_recorded_not_shown"),
        pytest.param(62.0, False, id="5.3-display_filter-62_near_noise_floor"),
        pytest.param(69.9, False, id="5.3-display_filter-just_below_70"),
        pytest.param(70.0, True, id="5.3-display_filter-exactly_70_is_shown"),
        pytest.param(75.0, True, id="5.3-display_filter-75_working_band"),
        pytest.param(99.0, True, id="5.3-display_filter-99"),
    ],
)
def test_display_threshold_sets_displayed_inclusively(score, expected):
    """§2: `displayed: bool  # score >= display_threshold (a FILTER, not a gate)`.

    Inclusive at the boundary, per the `>=` in the contract comment. §5.3.1's
    guidance for the operator reads the bands the same way: "62–68 is near-noise
    and exists mainly for the journal. 70–78 is the working band."
    """
    assert is_displayed(score, WITH_TREND, CONFIG) is expected


def test_a_signal_below_the_display_threshold_is_still_constructed_and_recorded():
    """§5.3: "**Construct the `Signal` object whenever a direction resolves.**
    Scoring is cheap; the bars are already loaded. A score of 41 is a real
    observation and belongs in the journal."

    Three things must hold at once and only the second is about the threshold:
    the `Signal` exists, `displayed` is False, and the record carries everything
    needed to re-judge it later — its score, its `GateOutcome`, and the two
    thresholds in force when it was written.

    v2 "refused to construct a `Signal` below threshold"; that is the behaviour
    this asserts is gone.
    """
    below = signal(
        score=41.0,
        breadth=0.53,
        quality=58.0,
        gate=gate_outcome(passed=True, score=41.0, breadth=0.53, quality=58.0),
        displayed=is_displayed(41.0, WITH_TREND, CONFIG),
    )

    assert below.displayed is False
    assert below.gate.passed is True, "validity is not visibility"
    assert below.score == pytest.approx(41.0)
    assert below.gate.display_threshold == pytest.approx(DISPLAY_THRESHOLD)
    assert below.gate.auto_execute_threshold == pytest.approx(AUTO_EXECUTE_THRESHOLD)


def test_lowering_the_filter_resurfaces_records_without_a_re_run():
    """§5.3: "The Signal Center can answer *"what would I have caught at 65?"* by
    re-filtering existing records — no re-run, no lost history." And: "The
    Backtester can sweep the threshold across one pass over history instead of
    one pass per setting."

    That is only possible if visibility is a pure function of `(score, regime,
    config)` applied to stored records — never a decision taken at construction
    time and baked in. Here one fixed set of three recorded signals is re-judged
    at three different thresholds, and nothing is re-computed.

    "Lowering your filter surfaces yesterday's near-misses immediately, which is
    how you learn where your number should be."
    """
    journal = [signal(score=score) for score in (41.0, 65.0, 72.0)]

    def visible_at(threshold: float) -> list[float]:
        config = scoring_config(display_threshold=threshold)
        return [s.score for s in journal if is_displayed(s.score, WITH_TREND, config)]

    assert visible_at(DISPLAY_THRESHOLD) == [72.0]
    assert visible_at(65.0) == [65.0, 72.0]
    assert visible_at(40.0) == [41.0, 65.0, 72.0]


# ================================ below auto, above display — hand-takeable only


@pytest.mark.parametrize(
    "score",
    [
        pytest.param(70.0, id="5.3-hand_takeable-70_at_the_display_floor"),
        pytest.param(74.8, id="5.3-hand_takeable-74.8_four_of_six_at_q90"),
        pytest.param(79.9, id="5.3-hand_takeable-79.9_just_below_auto"),
    ],
)
def test_between_the_thresholds_a_signal_is_shown_and_takeable_but_never_auto(score):
    """§5.3: below `auto_execute_threshold` and above `display_threshold` means
    "**Shown and takeable by hand, never auto-executed**."

    74.8 is not arbitrary — §5.3.1's table puts four of six clusters at quality
    90 exactly there, and §5.3.1 calls that "a genuine confluence". The band
    between 70 and 80 is where the system expects most of its work to happen, so
    an implementation that treated one threshold as both would either hide these
    or fire them unattended.
    """
    assert is_displayed(score, WITH_TREND, CONFIG) is True
    assert is_auto_eligible(score, vote_tally(), WITH_TREND, True, CONFIG) is False


@pytest.mark.parametrize(
    "score,expected",
    [
        pytest.param(79.9, False, id="5.3-auto_gate-just_below_80"),
        pytest.param(80.0, True, id="5.3-auto_gate-exactly_80_is_eligible"),
        pytest.param(83.1, True, id="5.3-auto_gate-83.1_five_of_six_at_q90"),
        pytest.param(99.0, True, id="5.3-auto_gate-99"),
    ],
)
def test_auto_execute_threshold_is_inclusive(score, expected):
    """§2: `auto_eligible: bool  # score >= auto_execute_threshold AND symbol
    enabled`. §5.3: "80 corresponds to 5 of 6 clusters at quality 90,
    uncontested, which is a defensible bar for unattended execution."
    """
    assert is_auto_eligible(score, vote_tally(), WITH_TREND, True, CONFIG) is expected


# ==================== a contested tally is auto-ineligible REGARDLESS OF SCORE


@pytest.mark.parametrize(
    "score",
    [
        pytest.param(99.0, id="5.3-contested_blocks_auto-at_99"),
        pytest.param(95.0, id="5.3-contested_blocks_auto-at_95"),
        pytest.param(90.0, id="5.3-contested_blocks_auto-at_90"),
        pytest.param(80.0, id="5.3-contested_blocks_auto-at_the_threshold"),
    ],
)
def test_a_contested_tally_blocks_auto_regardless_of_score(score):
    """§5.3: "A `contested` tally (§5.2.1) makes a signal **auto-ineligible
    regardless of score** — if the strongest single reading on the chart argues
    the other way, that is a decision for a person."

    99 is the row that matters. §5.2.1's worked example is exactly this shape:
    `BUY — 1 vote / 96 pts | SELL — 4 votes / 296 pts`, where the dissenting vote
    is the strongest single reading on the chart. The composite score cannot see
    that, because "the tally is **displayed, not scored**" — so an implementation
    that only compares the score to the threshold fires on it.

    Note this does not hide the signal: it stays displayed and hand-takeable.
    """
    contested = contested_tally()
    assert contested.contested is True

    assert is_auto_eligible(score, contested, WITH_TREND, True, CONFIG) is False
    assert is_displayed(score, WITH_TREND, CONFIG) is True


def test_the_same_score_uncontested_is_auto_eligible():
    """§5.3 — the control for the test above. Without it, an implementation that
    returned False unconditionally would pass.

    §5.2.1: "A setup where four clusters say SELL and none say BUY, and one where
    four say SELL and one says BUY at strength 96, produce an identical score.
    **They are not the same trade.**" Same score, opposite eligibility.
    """
    score = 88.0
    uncontested = vote_tally(sell_votes=0, sell_points=0.0, contested=False)

    assert is_auto_eligible(score, uncontested, WITH_TREND, True, CONFIG) is True
    assert is_auto_eligible(score, contested_tally(), WITH_TREND, True, CONFIG) is False


def test_a_disabled_symbol_is_not_auto_eligible_at_any_score():
    """§2: `auto_eligible: bool  # score >= auto_execute_threshold AND symbol
    enabled`. Rule 7: "AUTO execution defaults to off [...] Enabling it on a live
    account requires an explicit **per-symbol toggle** plus a deliberately-set
    environment variable."

    The per-symbol toggle is a separate conjunct from the threshold, so no score
    substitutes for it.
    """
    assert is_auto_eligible(99.0, vote_tally(), WITH_TREND, False, CONFIG) is False
    assert is_auto_eligible(99.0, vote_tally(), WITH_TREND, True, CONFIG) is True


# ================================================= TRANSITIONAL's +5 uplift


@pytest.mark.parametrize(
    "score,in_trending,in_transitional",
    [
        pytest.param(74.0, True, False, id="3.4-transitional_uplift-74_shown_in_TRENDING_hidden_in_TRANSITIONAL"),
        pytest.param(74.9, True, False, id="3.4-transitional_uplift-74.9_just_under_the_uplifted_75"),
        pytest.param(75.0, True, True, id="3.4-transitional_uplift-75_clears_the_uplifted_threshold"),
        pytest.param(69.9, False, False, id="3.4-transitional_uplift-69.9_hidden_in_both"),
        pytest.param(83.1, True, True, id="3.4-transitional_uplift-83.1_shown_in_both"),
    ],
)
def test_the_display_threshold_rises_by_the_transitional_uplift(
    score, in_trending, in_transitional
):
    """§5.3: "`display_threshold` rises by 5 in TRANSITIONAL, matching §3.4."
    §3.4: "**TRANSITIONAL** applies a signal threshold uplift of **+5** and a
    position size multiplier of 0.5."

    70 + 5 = 75, so the four rows either side of 75 are what distinguish an
    implementation that applies the uplift from one that ignores it — and the two
    rows away from the boundary prove the uplift is not applied in TRENDING.
    """
    assert is_displayed(score, WITH_TREND, CONFIG) is in_trending
    assert is_displayed(score, Regime.TRANSITIONAL, CONFIG) is in_transitional


def test_the_uplift_is_plus_five_and_not_plus_eight():
    """§5.3.1: "**TRANSITIONAL's uplift is +5, not +8.** At +8 the threshold
    becomes 78, which 4 of 5 clusters cannot reach at quality 85 (76.4) — the
    regime would need 4 of 5 at quality 90+, stricter than TRENDING's 4 of 6 by a
    wide margin. +5 lands it at 75, which 4 of 5 clears at quality 85."

    v2.4 lowered it, and the two values are one line apart in config, so this
    asserts the consequence rather than the number: the same 76.4 signal — the
    best a four-cluster TRANSITIONAL confluence produces at typical quality — is
    displayed under the shipped uplift and invisible under the rejected one.

    "TRANSITIONAL remains stricter than TRENDING, which is the intent; it is no
    longer accidentally near-prohibitive."
    """
    score = TRANSITIONAL_FOUR_OF_FIVE_AT_Q85  # 76.4, §5.3.1

    shipped = scoring_config(
        transitional_threshold_uplift=TRANSITIONAL_THRESHOLD_UPLIFT  # +5
    )
    rejected = scoring_config(
        transitional_threshold_uplift=REJECTED_TRANSITIONAL_UPLIFT  # +8
    )

    assert is_displayed(score, Regime.TRANSITIONAL, shipped) is True
    assert is_displayed(score, Regime.TRANSITIONAL, rejected) is False

    # And it is stricter than TRENDING either way — that part is the intent.
    assert is_displayed(72.0, WITH_TREND, shipped) is True
    assert is_displayed(72.0, Regime.TRANSITIONAL, shipped) is False


@pytest.mark.parametrize(
    "regime",
    [
        pytest.param(Regime.TRENDING_BULLISH, id="3.4-no_uplift-TRENDING_BULLISH"),
        pytest.param(Regime.TRENDING_BEARISH, id="3.4-no_uplift-TRENDING_BEARISH"),
        pytest.param(Regime.RANGING, id="3.4-no_uplift-RANGING"),
    ],
)
def test_no_other_regime_moves_the_display_threshold(regime):
    """§3.4 names exactly one regime with an uplift. §5.3.1's per-regime table
    lists TRENDING, RANGING and TRANSITIONAL against the same "Display 70"
    column, with only TRANSITIONAL's cell annotated *(at 75)*.

    `VOLATILE_NEWS` is absent from this list on purpose: §3.4 says it "generates
    no new signals at all", so what its display threshold would be is not a
    question the spec answers.
    """
    assert is_displayed(72.0, regime, CONFIG) is True
    assert is_displayed(69.0, regime, CONFIG) is False


# ================================================ threshold ordering, at startup


@pytest.mark.parametrize(
    "display,auto",
    [
        pytest.param(70.0, 69.0, id="5.3-inverted_thresholds-auto_one_below_display"),
        pytest.param(80.0, 70.0, id="5.3-inverted_thresholds-auto_ten_below_display"),
        pytest.param(90.0, 62.0, id="5.3-inverted_thresholds-auto_far_below_display"),
    ],
)
def test_an_inverted_threshold_pair_fails_validation_at_startup(display, auto):
    """§5.3: "`auto_execute_threshold` [...] must be ≥ `display_threshold`; **a
    config that inverts them fails validation at startup**."

    At startup, not at first signal. An inverted pair means the engine would fire
    unattended on a setup it had decided was not worth showing — and it would do
    so silently, because nothing downstream compares the two.

    The exception TYPE is deliberately not pinned: §5.3 says "fails validation"
    and names none (`backend.core.errors.ConfigError` is the obvious candidate,
    but choosing it here would be a reading — see the report). `assert_rejects`
    accepts any deliberate refusal while re-raising `NotImplementedError`, so
    this cannot go green against a stub.
    """
    config = scoring_config(display_threshold=display, auto_execute_threshold=auto)

    assert_rejects(assert_thresholds_ordered, config)


@pytest.mark.parametrize(
    "display,auto",
    [
        pytest.param(70.0, 80.0, id="5.3-ordered_thresholds-the_shipped_pair_70_80"),
        pytest.param(70.0, 70.0, id="5.3-ordered_thresholds-EQUAL_is_permitted"),
        pytest.param(62.0, 93.0, id="5.3-ordered_thresholds-the_full_usable_range"),
    ],
)
def test_an_ordered_threshold_pair_is_accepted(display, auto):
    """§5.3: "It must be **≥** `display_threshold`" — so equality is legal, and
    an implementation using a strict `>` would reject a valid config in which the
    operator has chosen to auto-execute everything they can see.

    62 and 93 are §5.3.1's stated bounds: "The dial therefore has real travel
    only between roughly **62 and 93**."
    """
    config = scoring_config(display_threshold=display, auto_execute_threshold=auto)

    assert assert_thresholds_ordered(config) is None


# ================================ the three questions are actually independent


def test_validity_visibility_and_execution_vary_independently():
    """§5.3: "The three questions are answered separately, and conflating them
    was the central error in v2."

    Independence is a property of the three answers taken together, so it is
    asserted as a matrix rather than one axis at a time. Four signals share a
    passing validity gate and differ only in score and tally; the resulting
    (displayed, auto_eligible) pairs must be all four combinations minus the
    impossible one — nothing is auto-eligible while hidden, because
    `auto_execute_threshold ≥ display_threshold` makes that unreachable.

    That last point is why §5.3 requires the ordering assertion: without it the
    fourth combination becomes reachable and AUTO fires on invisible signals.
    """
    rows = {
        "hidden": (41.0, vote_tally()),
        "shown_only": (74.8, vote_tally()),
        "shown_contested": (99.0, contested_tally()),
        "shown_and_auto": (83.1, vote_tally()),
    }
    observed = {
        name: (
            is_displayed(score, WITH_TREND, CONFIG),
            is_auto_eligible(score, votes, WITH_TREND, True, CONFIG),
        )
        for name, (score, votes) in rows.items()
    }

    assert observed == {
        "hidden": (False, False),
        "shown_only": (True, False),
        "shown_contested": (True, False),
        "shown_and_auto": (True, True),
    }


def test_a_hidden_signal_still_carries_a_full_lifecycle_position():
    """§5.3 + §6.1 — visibility is not lifecycle.

    §5.3 makes `displayed` a view filter; §6.1 makes `state` the signal's own
    position, tracked per timeframe. A signal at 41 is hidden from default views
    and still occupies a real state, which is what lets §12.1 resolve it later:
    rule 11, "every signal resolves. Taken or not."

    An implementation that skipped construction below the display threshold —
    v2's behaviour — would leave nothing for the outcome resolver to replay, and
    §12.3's aggregate counterfactual reporting would have no denominator.
    """
    hidden = signal(
        score=41.0,
        state=SignalState.LOCKED,
        entry_timeframe=Timeframe.M15,
        direction=Direction.BUY,
        displayed=is_displayed(41.0, WITH_TREND, CONFIG),
    )

    assert hidden.displayed is False
    assert hidden.state is SignalState.LOCKED
    assert hidden.signal_id, "the idempotency key exists whether or not it is shown"
