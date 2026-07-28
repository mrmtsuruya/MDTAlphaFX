"""Stage 1 doubles for §5.3, §5.4, §5.5 and §6.1.

An **extension** of `tests/stage1/stage1_doubles.py`, never a replacement. That
file owns §3's inputs, §3.4's cluster map and §5.1's cluster table and is
imported, not duplicated. This one adds only what the gate, level-derivation and
lifecycle sections need: the §2 objects their public APIs take as arguments, and the
Appendix B numbers their config dicts carry.

**Nothing here reads `config/*.yaml`**: §5.3.1/§5.3.2's tables are only
reproducible at ALPHA 0.5 with the §5.1 baseline weights. Every number below is
quoted from the specification or the approved profile and kept as an injected
fixture so later runtime calibration cannot rewrite the regression contract.
"""

from __future__ import annotations

import copy
from datetime import datetime, timedelta
from typing import Any, Iterable, Iterator

import pytest

from backend.contracts import (
    Direction,
    ExitPlan,
    GateOutcome,
    Regime,
    Signal,
    SignalState,
    Timeframe,
    TimeframeState,
    VoteTally,
)
from backend.core.timeutil import UTC, timeframe_delta
from backend.lifecycle.machine import FROZEN_ON_LOCK, LifecycleContext
from backend.scoring.levels import Swing
from backend.scoring.types import ScoreBreakdown
from tests.doubles import TEST_SYMBOL
from tests.stage1.stage1_doubles import TRANSITIONAL_THRESHOLD_UPLIFT

# ============================================================ §5.3 thresholds

#: §5.3: "Should the user see it? | `display_threshold` (**70**)". Appendix B #7.
#: §5.3.1 explains the choice: "It corresponds to four of six clusters at typical
#: quality — a genuine confluence, with headroom above it to tighten."
DISPLAY_THRESHOLD = 70.0

#: §5.3: "`auto_execute_threshold` (default **80**) is the only hard gate on
#: action". Appendix B #8. §5.3 and §5.2.4's rationale: "**80, not 88.** At 88
#: the auto gate is effectively unreachable: 5 of 6 clusters at quality 95 scores
#: 87.7 [...] 80 corresponds to 5 of 6 clusters at quality 90, uncontested."
AUTO_EXECUTE_THRESHOLD = 80.0

#: §5.3 validity table, conditions 1 and 2: "`min_clusters` | 3" and
#: "`min_pillars` | 2". Appendix B #9.
MIN_CLUSTERS = 3
MIN_PILLARS = 2

#: §5.3.1's rejected alternative, kept as a fixture so a test can prove +5 and +8
#: are not interchangeable: "**TRANSITIONAL's uplift is +5, not +8.** At +8 the
#: threshold becomes 78, which 4 of 5 clusters cannot reach at quality 85 (76.4)".
REJECTED_TRANSITIONAL_UPLIFT = 8

#: §5.3.1, the TRANSITIONAL note. The score 4 of 5 clusters reaches at quality 85
#: — stated by the spec, and the figure that makes +5 workable and +8 not.
TRANSITIONAL_FOUR_OF_FIVE_AT_Q85 = 76.4

#: §5.3.1: "With both clusters firing at quality 95, breadth 1.0 gives 95, then
#: §3.5's 0.6 penalty takes it to **57** — below even the display threshold."
COUNTER_TREND_BEST_SCORE = 57.0

#: The same figure under the *other* reading of AMBIGUITY-R01 — §5.2's
#: `enabled_in` snippet read literally puts every ENABLED cluster in a
#: counter-trend signal's denominator, making it 90 rather than the 22 §5.2's
#: prose and §5.3.1's table state. 22/90 breadth at quality 95, ×0.6 → 28.2.
#: Recorded so a test can be written to hold under BOTH readings rather than
#: silently picking one.
COUNTER_TREND_BEST_SCORE_UNDER_R01_LITERAL = 28.2

# ============================================================== §5.5 constants
#
# §5.5: "Every constant above lives in `config/levels.yaml`." The approved
# Appendix B decisions 16–19 are injected below as test fixtures.

MIN_ZONE_ATR = 0.15  # §5.5: "widened to a minimum of `min_zone_atr` × ATR(14) (default 0.15)"
SL_BUFFER_ATR = 0.25  # §5.5: "buffer = atr * sl_buffer_atr  # default 0.25"
MIN_SL_ATR = 1.0  # §5.5: "min_dist = atr * min_sl_atr  # default 1.0"
TP1_R = 1.5  # §5.5: "TP1 = entry ± `tp1_r` × R (default **1.5**)"
TP2_R = 3.0  # §5.5: "TP2 = entry ± `tp2_r` × R (default **3.0**)"
SNAP_ATR = 0.5  # §5.5: "within `snap_atr` × ATR (default 0.5)"
MIN_RR = 1.2  # §5.5: "less than `min_rr` (default **1.2**) [...] fails validity with POOR_RR"

# ============================================================== §6.1 constants

#: §6.2: "Setups expire after `signal_ttl_bars` (default 12 bars on the entry
#: timeframe) without triggering." Appendix B #19.
SIGNAL_TTL_BARS = 12

#: §6.1: "`TOO_LATE` | Price passed the zone by > `chase_tolerance_atr` × ATR".
#: **Appendix B #19 gives no cross-symbol default at all** — it says "pin per
#: symbol" and stops. 1.0 is therefore a bare TEST FIXTURE with no spec
#: standing: every test that uses it asserts a *relation* to the configured
#: value, never that the value is 1.0.
CHASE_TOLERANCE_ATR_FIXTURE = 1.0

# ================================================================ config dicts
#
# The public APIs accept a bare `dict` and the spec does not prescribe whether
# injected test config is nested or flat. Return **both** shapes, the
# nested tree mirroring the YAML file and every leaf aliased at the top level,
# so either supported input form exercises the same behavior.

_SCORING_LEAVES: dict[str, Any] = {
    "display_threshold": DISPLAY_THRESHOLD,
    "auto_execute_threshold": AUTO_EXECUTE_THRESHOLD,
    "must_be_ordered": True,
    "min_clusters": MIN_CLUSTERS,
    "min_pillars": MIN_PILLARS,
    # §5.2.1 / config/scoring.yaml: the tally is displayed, not scored, and a
    # contested tally makes the signal auto-ineligible regardless of score.
    "points_divisor": 10.0,
    "contested_blocks_auto": True,
    "tally_modifies_score": False,
    "scoring_mode": "CLUSTERED",
    # §3.4 / §5.3: "`display_threshold` rises by 5 in TRANSITIONAL, matching
    # §3.4." The key lives in `config/regime.yaml`'s `regime_policy` section, not
    # in `config/scoring.yaml`, yet `is_displayed(score, regime, config)` takes
    # ONE config dict — see the report. Carried here in both places.
    "transitional_threshold_uplift": TRANSITIONAL_THRESHOLD_UPLIFT,
}

_ALWAYS_ENFORCED = (
    "REGIME_NOT_VOLATILE_NEWS",
    "MAX_SPREAD",
    "NO_CONFLICTING_POSITION",
    "BIAS_TIMEFRAMES_NOT_CONFLICTED",
)


def scoring_config(**overrides: Any) -> dict:
    """A §5.3 test configuration in both supported shapes."""
    leaves = dict(_SCORING_LEAVES)
    leaves.update(overrides)
    cfg: dict[str, Any] = dict(leaves)
    cfg["thresholds"] = {
        k: leaves[k]
        for k in ("display_threshold", "auto_execute_threshold", "must_be_ordered")
    }
    cfg["validity"] = {
        "min_clusters": leaves["min_clusters"],
        "min_pillars": leaves["min_pillars"],
        "always_enforced": list(_ALWAYS_ENFORCED),
    }
    cfg["tally"] = {
        k: leaves[k]
        for k in ("points_divisor", "contested_blocks_auto", "tally_modifies_score")
    }
    cfg["regime_policy"] = {
        "transitional_threshold_uplift": leaves["transitional_threshold_uplift"]
    }
    return cfg


_LEVELS_LEAVES: dict[str, Any] = {
    "min_zone_atr": MIN_ZONE_ATR,
    "sl_buffer_atr": SL_BUFFER_ATR,
    "min_sl_atr": MIN_SL_ATR,
    "basis_required": True,
    "tp1_r": TP1_R,
    "tp2_r": TP2_R,
    "snap_atr": SNAP_ATR,
    "snap_may_only_reduce": True,
    "min_rr": MIN_RR,
    "reason_code": "POOR_RR",
    "signal_ttl_bars": SIGNAL_TTL_BARS,
    "chase_tolerance_atr": CHASE_TOLERANCE_ATR_FIXTURE,
    "max_locked_per_symbol_timeframe": 1,
    "age_bars_affects_levels": False,
    "frozen_on_lock": list(FROZEN_ON_LOCK),
}


def levels_config(**overrides: Any) -> dict:
    """A §5.5/§6.1 test configuration in both supported shapes."""
    leaves = dict(_LEVELS_LEAVES)
    leaves.update(overrides)
    cfg: dict[str, Any] = dict(leaves)
    cfg["zone"] = {"min_zone_atr": leaves["min_zone_atr"]}
    cfg["stop"] = {
        k: leaves[k] for k in ("sl_buffer_atr", "min_sl_atr", "basis_required")
    }
    cfg["targets"] = {
        k: leaves[k] for k in ("tp1_r", "tp2_r", "snap_atr", "snap_may_only_reduce")
    }
    cfg["rejection"] = {k: leaves[k] for k in ("min_rr", "reason_code")}
    cfg["lifecycle"] = {
        k: leaves[k]
        for k in (
            "signal_ttl_bars",
            "chase_tolerance_atr",
            "max_locked_per_symbol_timeframe",
            "age_bars_affects_levels",
            "frozen_on_lock",
        )
    }
    return cfg


# ======================================================== §2 object factories

BAR_ZERO = datetime(2026, 3, 2, 8, 0, tzinfo=UTC)  # a Monday, 08:00 UTC


def breakdown(
    *,
    score: float = 75.0,
    breadth: float = 0.69,
    quality: float = 90.0,
    denominator: int = 68,
    numerator: int = 47,
    htf_penalty_applied: float = 1.0,
) -> ScoreBreakdown:
    """§5.2's triple, stated rather than computed.

    `evaluate_validity` takes a `ScoreBreakdown` it does not recompute, so these
    tests supply one. §5.2's arithmetic is asserted in `test_score_computation.py`
    and `test_score_calibration.py`; asserting it again here would test the
    formula twice and the gate never.
    """
    return ScoreBreakdown(
        breadth=breadth,
        quality=quality,
        score=score,
        denominator=denominator,
        numerator=numerator,
        htf_penalty_applied=htf_penalty_applied,
    )


def vote_tally(
    *,
    buy_votes: int = 4,
    buy_points: float = 423.0,
    sell_votes: int = 0,
    sell_points: float = 0.0,
    contested: bool = False,
    leading_contributor: str = "module_3",
) -> VoteTally:
    """§2 `VoteTally`. `contested` is stated, not derived — §5.2.1's derivation
    is asserted in `test_vote_tally.py`."""
    return VoteTally(
        buy_votes=buy_votes,
        buy_points=buy_points,
        sell_votes=sell_votes,
        sell_points=sell_points,
        contested=contested,
        leading_contributor=leading_contributor,
    )


def contested_tally() -> VoteTally:
    """§5.2.1's rendered example: `BUY — 1 vote / 96 pts | SELL — 4 votes / 296
    pts`. "The user needs to see that the one dissenting vote is the strongest
    single reading on the chart"."""
    return vote_tally(
        buy_votes=1,
        buy_points=96.0,
        sell_votes=4,
        sell_points=296.0,
        contested=True,
        leading_contributor="module_20",
    )


def gate_outcome(
    *,
    passed: bool = True,
    failed_conditions: Iterable[str] = (),
    score: float = 75.0,
    breadth: float = 0.69,
    quality: float = 90.0,
    display_threshold: float = DISPLAY_THRESHOLD,
    auto_execute_threshold: float = AUTO_EXECUTE_THRESHOLD,
) -> GateOutcome:
    """§2 `GateOutcome` — "Written for every evaluation, passing or failing."""
    return GateOutcome(
        passed=passed,
        failed_conditions=list(failed_conditions),
        score=score,
        breadth=breadth,
        quality=quality,
        display_threshold=display_threshold,
        auto_execute_threshold=auto_execute_threshold,
    )


def exit_plan(
    *,
    stop_loss: float = 1990.0,
    take_profit_1: float = 2017.5,
    take_profit_2: float | None = 2034.0,
) -> ExitPlan:
    return ExitPlan(
        stop_loss=stop_loss,
        take_profit_1=take_profit_1,
        take_profit_2=take_profit_2,
    )


def timeframe_state(
    timeframe: Timeframe,
    *,
    regime: Regime = Regime.TRENDING_BULLISH,
    direction: Direction = Direction.BUY,
    state: SignalState = SignalState.SCANNING,
    score: float = 75.0,
    breadth: float = 0.69,
    quality: float = 90.0,
    regime_confidence: float = 1.0,
    bars_in_regime: int = 50,
    votes: VoteTally | None = None,
) -> TimeframeState:
    """§2 `TimeframeState` — "this timeframe's own lifecycle position".

    `clusters` and `modules` are empty: §5.4 combines *states*, and populating
    them would make a multi-timeframe test also a cluster-resolution test.
    """
    return TimeframeState(
        timeframe=timeframe,
        regime=regime,
        regime_confidence=regime_confidence,
        bars_in_regime=bars_in_regime,
        breadth=breadth,
        quality=quality,
        score=score,
        direction=direction,
        state=state,
        votes=votes if votes is not None else vote_tally(),
        clusters=[],
        modules=[],
    )


def signal(
    *,
    state: SignalState = SignalState.AWAITING_VALIDATION,
    direction: Direction = Direction.BUY,
    entry_timeframe: Timeframe = Timeframe.M15,
    symbol: str = TEST_SYMBOL,
    signal_id: str = "11111111-1111-4111-8111-111111111111",
    fingerprint: str = "a1b2c3d",
    created_at: datetime | None = None,
    locked_at: datetime | None = None,
    expires_at: datetime | None = None,
    age_bars: int = 0,
    score: float = 75.0,
    breadth: float = 0.69,
    quality: float = 90.0,
    votes: VoteTally | None = None,
    entry_zone: dict | None = None,
    plan: ExitPlan | None = None,
    sl_basis: str = "1.25 ATR beyond swing low",
    htf_regime: Regime = Regime.TRENDING_BULLISH,
    timeframes: dict[Timeframe, TimeframeState] | None = None,
    mtf_aligned: str = "3/5",
    gate: GateOutcome | None = None,
    displayed: bool = True,
    auto_eligible: bool = False,
    order_type: str = "BUY_LIMIT",
    config_version: str = "test-config-version",
) -> Signal:
    """A §2 `Signal`, every field stated.

    **`expires_at` is a known contract gap.** §2 types it `datetime` with no
    `| None`, while §6.1 rule 1 stamps it "on entering `LOCKED`" — so a signal at
    `AWAITING_VALIDATION` must carry *something* the contract forbids being None.
    `created_at` is used as that placeholder. It is a TEST FIXTURE, not a reading
    of the spec (see the report); every lock test below asserts that `expires_at`
    *changes* at lock, which holds whatever the pre-lock placeholder is.
    """
    created = created_at if created_at is not None else BAR_ZERO
    return Signal(
        signal_id=signal_id,
        fingerprint=fingerprint,
        created_at=created,
        locked_at=locked_at,
        expires_at=expires_at if expires_at is not None else created,
        age_bars=age_bars,
        symbol=symbol,
        direction=direction,
        order_type=order_type,
        score=score,
        breadth=breadth,
        quality=quality,
        votes=votes if votes is not None else vote_tally(),
        entry_zone=dict(entry_zone) if entry_zone is not None else {"min": 2000.0, "max": 2002.0},
        exit_plan=plan if plan is not None else exit_plan(),
        sl_basis=sl_basis,
        htf_regime=htf_regime,
        entry_timeframe=entry_timeframe,
        timeframes=timeframes if timeframes is not None else {},
        mtf_aligned=mtf_aligned,
        state=state,
        gate=gate if gate is not None else gate_outcome(score=score, breadth=breadth, quality=quality),
        displayed=displayed,
        auto_eligible=auto_eligible,
        pattern_context=None,
        config_version=config_version,
        outcome=None,
        llm_rationale=None,
    )


def locked_signal(
    *,
    locked_at: datetime | None = None,
    ttl_bars: int = SIGNAL_TTL_BARS,
    entry_timeframe: Timeframe = Timeframe.M15,
    **kwargs: Any,
) -> Signal:
    """A signal already past §6.1 rule 1 — `locked_at` and `expires_at` stamped.

    `expires_at` is `locked_at + ttl_bars × bar duration`, which is §2's "resolved
    wall-clock, not a bar count" done once, at lock, exactly as
    `should_expire`'s docstring describes.
    """
    stamped = locked_at if locked_at is not None else BAR_ZERO + timedelta(hours=1)
    kwargs.setdefault("state", SignalState.LOCKED)
    kwargs.setdefault("created_at", BAR_ZERO)
    return signal(
        locked_at=stamped,
        expires_at=stamped + ttl_bars * timeframe_delta(entry_timeframe),
        entry_timeframe=entry_timeframe,
        **kwargs,
    )


def lifecycle_ctx(
    *,
    price: float = 2001.0,
    now: datetime | None = None,
    bar_close_time: datetime | None = None,
    atr: float = 10.0,
    bars_since_lock: int = 0,
    forming_detected: bool = True,
    candidate_resolved: bool = True,
    regime_confirmed: bool = True,
    has_open_position: bool = False,
) -> LifecycleContext:
    """§6.1's `LifecycleContext` — "passed explicitly so the machine reads no
    clock and no global state" (rule 1: no clock reads)."""
    close = bar_close_time if bar_close_time is not None else BAR_ZERO + timedelta(hours=1)
    return LifecycleContext(
        now=now if now is not None else close,
        bar_close_time=close,
        price=price,
        atr=atr,
        bars_since_lock=bars_since_lock,
        forming_detected=forming_detected,
        candidate_resolved=candidate_resolved,
        regime_confirmed=regime_confirmed,
        has_open_position=has_open_position,
    )


def swing(*, high: float = 2020.0, low: float = 1990.0, label: str = "swing low") -> Swing:
    """§5.5's anchor structure. `label` is what `sl_basis` quotes back to the UI."""
    return Swing(high=high, low=low, label=label)


def evidence_zone(low: float, high: float) -> dict:
    """The leading contributor's structure, as `StrategyResult.evidence`.

    **§5.5 never names the keys.** It says only "Each module returns these
    coordinates in `StrategyResult.evidence`", and §2 types `evidence` as a bare
    `dict`. The one shape the spec *does* fix is `Signal.entry_zone`'s
    `{"min": float, "max": float}`, so that is the primary spelling here, with
    four common aliases carried alongside so an implementation reading any of
    them finds the same numbers. Refusing to decide, not deciding.
    """
    return {
        "min": low,
        "max": high,
        "zone_min": low,
        "zone_max": high,
        "low": low,
        "high": high,
    }


# ============================================================ walk / snapshot


def walk(obj: Any) -> Iterator[Any]:
    """Every key and every leaf value inside a nested mapping/sequence.

    Used by the §5.4 tests, whose stub returns a bare `dict` with **no specified
    schema**. Searching values rather than named keys is how those tests assert
    what §5.4 actually claims — that nothing was averaged, and that every
    timeframe survived — without inventing a key layout the spec never gave.
    """
    if isinstance(obj, dict):
        for key, value in obj.items():
            yield key
            yield from walk(value)
    elif isinstance(obj, (list, tuple, set, frozenset)):
        for item in obj:
            yield from walk(item)
    else:
        yield obj


def numbers_in(obj: Any) -> list[float]:
    """Every numeric leaf, `bool` excluded — `True` is an `int` in Python and a
    flag is not a score."""
    return [
        float(v)
        for v in walk(obj)
        if isinstance(v, (int, float)) and not isinstance(v, bool)
    ]


def snapshot(sig: Signal) -> dict:
    """A deep copy of a signal's fields, taken before `advance()`.

    Deep, deliberately. `advance` is annotated `-> Signal` but nothing forbids it
    mutating in place and returning the same object, and a shallow snapshot of a
    mutated model compares equal to itself — which is precisely how a
    recomputation regression would slip past §9 Stage 3's gate.
    """
    return copy.deepcopy(sig.model_dump())


def frozen_fields(sig: Signal) -> dict:
    """The §6.1 rule 1 fields only, deep-copied.

    Keyed by `FROZEN_ON_LOCK` so the set is read from the module under test
    rather than retyped — if someone drops `votes` from that tuple, these tests
    stop checking `votes` *and* `test_frozen_on_lock_is_rule_ones_list` fails,
    which is the intended pairing.
    """
    dumped = copy.deepcopy(sig.model_dump())
    return {name: dumped[name] for name in FROZEN_ON_LOCK}


def with_field(sig: Signal, **changes: Any) -> Signal:
    """A copy of `sig` with fields changed — the "later evaluation recomputed the
    levels" bug, constructed deliberately so §6.1 rule 2 can be asserted against
    it."""
    return sig.model_copy(update=changes)


def assert_rejects(fn, *args: Any, **kwargs: Any) -> None:
    """Assert `fn` refuses its input by raising — **without pinning the type**.

    §5.3 says an inverted threshold pair "fails validation at startup" and never
    names an exception. `backend.core.errors.ConfigError` is the obvious
    candidate and naming it here would be choosing a reading, so this accepts any
    deliberate refusal.

    `NotImplementedError` is re-raised so this helper can never make a future
    placeholder implementation appear to pass validation tests.
    """
    try:
        fn(*args, **kwargs)
    except NotImplementedError:
        raise
    except Exception:
        return
    pytest.fail(
        f"{getattr(fn, '__name__', fn)} accepted input the spec says must fail "
        f"validation; it returned instead of raising"
    )


__all__ = [
    "DISPLAY_THRESHOLD",
    "AUTO_EXECUTE_THRESHOLD",
    "MIN_CLUSTERS",
    "MIN_PILLARS",
    "REJECTED_TRANSITIONAL_UPLIFT",
    "TRANSITIONAL_FOUR_OF_FIVE_AT_Q85",
    "COUNTER_TREND_BEST_SCORE",
    "COUNTER_TREND_BEST_SCORE_UNDER_R01_LITERAL",
    "MIN_ZONE_ATR",
    "SL_BUFFER_ATR",
    "MIN_SL_ATR",
    "TP1_R",
    "TP2_R",
    "SNAP_ATR",
    "MIN_RR",
    "SIGNAL_TTL_BARS",
    "CHASE_TOLERANCE_ATR_FIXTURE",
    "BAR_ZERO",
    "scoring_config",
    "levels_config",
    "breakdown",
    "vote_tally",
    "contested_tally",
    "gate_outcome",
    "exit_plan",
    "timeframe_state",
    "signal",
    "locked_signal",
    "lifecycle_ctx",
    "swing",
    "evidence_zone",
    "walk",
    "numbers_in",
    "snapshot",
    "frozen_fields",
    "with_field",
    "assert_rejects",
]
