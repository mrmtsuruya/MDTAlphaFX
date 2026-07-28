"""§3.3 Hysteresis — required. Both mechanisms, both mandatory.

    "A regime flipping every few bars swaps half the strategy library in and out
     and makes signals appear and vanish."

    **Asymmetric thresholds.** Enter TRENDING at ADX > 27; exit only below 22.
    Enter RANGING at ADX < 20; exit above 25. The dead band between prevents
    oscillation.

    **Confirmation bars.** A new classification must hold for
    `regime_confirm_bars` (default 3) consecutive closed bars before it takes
    effect. Until confirmed, the previous regime remains active and
    `regime_confidence` decays toward 0.

    `TRANSITIONAL` is exempt from confirmation — degrading to uncertain should
    be immediate.

`raw` is supplied directly by each test rather than routed through
`classify_raw`, so a failure here names §3.3 and not §3.2.

----------------------------------------------------------------------------
READ BEFORE CHANGING THE OSCILLATION TESTS.

§3.3's two mechanisms overlap in one place and the spec does not order them.
An ADX of 24 while TRENDING is (a) inside the dead band, which §3.3 says must
not flip the regime, and (b) classified TRANSITIONAL by §3.2, which §3.3 says
takes effect immediately. Read the second way, the dead band never fires and
the anti-oscillation mechanism is dead code.

The two dead-band oscillation cases are explicitly skipped as ``STAGE1-A02``.
That keeps the tests visible without choosing whether the exit band or the
immediate-TRANSITIONAL sentence takes precedence. The uncontested confirmation,
decay, and outside-band TRANSITIONAL cases remain active.
----------------------------------------------------------------------------
"""

from __future__ import annotations

import pytest

from backend.contracts import Regime
from backend.regime.classifier import apply_hysteresis
from tests.stage1.stage1_doubles import (
    ADX_RANGE_ENTER,
    ADX_RANGE_EXIT,
    ADX_TREND_ENTER,
    ADX_TREND_EXIT,
    REGIME_CONFIRM_BARS,
    inputs,
    ranging_inputs,
    regime_config,
    settled,
    trending_inputs,
)

CONFIG = regime_config()


def _walk(previous, steps, config=CONFIG):
    """Feed consecutive CLOSED bars through `apply_hysteresis`.

    Rule 6 — "Evaluation happens on bar close, not on tick" — so one step is one
    closed bar and §3.3's "consecutive closed bars" is literally the length of
    this list. Returns every intermediate verdict so a test can assert on the
    bar *before* the flip as well as the bar of it.
    """
    verdicts = []
    current = previous
    for raw, bar_inputs in steps:
        current = apply_hysteresis(current, raw, bar_inputs, config)
        verdicts.append(current)
    return verdicts


# ==================================== asymmetric thresholds — the dead band


def test_adx_oscillating_inside_the_trend_dead_band_holds_the_regime():
    """§3.3: "Enter TRENDING at ADX > 27; exit only below 22. The dead band
    between prevents oscillation."

    The series crosses `adx_trend_enter` five times and never reaches
    `adx_trend_exit`. Under a single-threshold implementation the regime flips
    on every crossing — nine changes over nine bars, each one swapping half the
    strategy library in and out. Under §3.3 it does not move at all.
    """
    # ADX wanders across 27 but stays clear of 22. Above the enter threshold the
    # raw classification is a trend; below it §3.2's trend conjunction fails and
    # the raw answer is TRANSITIONAL.
    adx_series = [26.0, 28.0, 26.5, 29.0, 24.0, 28.5, 23.0, 27.5, 25.0]
    steps = []
    for adx in adx_series:
        assert ADX_TREND_EXIT < adx, "fixture bug: this bar leaves the dead band"
        raw = Regime.TRENDING_BULLISH if adx > ADX_TREND_ENTER else Regime.TRANSITIONAL
        steps.append((raw, trending_inputs(adx=adx)))

    verdicts = _walk(settled(Regime.TRENDING_BULLISH), steps)

    assert [v.regime for v in verdicts] == [Regime.TRENDING_BULLISH] * len(adx_series)


def test_adx_oscillating_inside_the_range_dead_band_holds_the_regime():
    """§3.3: "Enter RANGING at ADX < 20; exit above 25."

    The RANGING band is the mirror image and is just as mandatory. G (envelope
    reversion) is enabled in RANGING and nowhere else (§3.4), so a regime
    oscillating here switches a whole mean-reversion cluster on and off bar by
    bar.
    """
    adx_series = [18.0, 21.0, 19.0, 22.5, 17.5, 24.0, 19.5, 23.0]
    steps = []
    for adx in adx_series:
        assert adx < ADX_RANGE_EXIT, "fixture bug: this bar leaves the dead band"
        raw = Regime.RANGING if adx < ADX_RANGE_ENTER else Regime.TRANSITIONAL
        steps.append((raw, ranging_inputs(adx=adx)))

    verdicts = _walk(settled(Regime.RANGING), steps)

    assert [v.regime for v in verdicts] == [Regime.RANGING] * len(adx_series)


def test_the_enter_and_exit_thresholds_are_not_the_same_number():
    """§3.3: the whole mechanism is that entering and exiting differ.

    Asserted on the fixture values themselves before they are used, so a config
    that collapsed the band would be caught here rather than showing up as an
    oscillation nobody reproduces.
    """
    assert ADX_TREND_EXIT < ADX_TREND_ENTER
    assert ADX_RANGE_ENTER < ADX_RANGE_EXIT
    # And the two bands must not overlap into a region belonging to both.
    assert ADX_RANGE_ENTER < ADX_TREND_ENTER

# ========================================================= confirmation bars


def _sustained_trend_steps(count):
    """`count` consecutive closed bars all classifying TRENDING_BULLISH."""
    return [(Regime.TRENDING_BULLISH, trending_inputs(adx=30.0))] * count


def test_a_new_classification_is_not_active_before_the_confirm_bar_count():
    """§3.3: "A new classification must hold for `regime_confirm_bars`
    consecutive closed bars before it takes effect. Until confirmed, the
    previous regime remains active."

    At N-1 bars the OLD regime is still the answer. This is the half of the
    mechanism an implementation is most likely to drop, because dropping it
    looks like the system being responsive.
    """
    verdicts = _walk(
        settled(Regime.RANGING), _sustained_trend_steps(REGIME_CONFIRM_BARS - 1)
    )

    assert [v.regime for v in verdicts] == [Regime.RANGING] * (REGIME_CONFIRM_BARS - 1)


def test_the_new_classification_takes_effect_on_the_confirm_bar():
    """§3.3 — at N consecutive bars it takes effect, and not before.

    Asserted as one sequence so the bar of the flip is identified exactly: every
    bar before it reads RANGING, the Nth reads TRENDING_BULLISH.
    """
    verdicts = _walk(settled(Regime.RANGING), _sustained_trend_steps(REGIME_CONFIRM_BARS))

    before = [v.regime for v in verdicts[:-1]]
    assert before == [Regime.RANGING] * (REGIME_CONFIRM_BARS - 1)
    assert verdicts[-1].regime == Regime.TRENDING_BULLISH
    assert verdicts[-1].pending is None
    assert verdicts[-1].pending_bars == 0


def test_the_pending_classification_is_visible_while_it_waits():
    """§3.3 — `RegimeVerdict.pending` carries "classification awaiting
    confirmation, if any".

    A regime change that is two thirds of the way through confirmation is a
    thing the operator can act on; §8.4's status indicators cannot show it if
    the classifier only reports the settled answer.
    """
    verdicts = _walk(
        settled(Regime.RANGING), _sustained_trend_steps(REGIME_CONFIRM_BARS - 1)
    )

    assert all(v.pending == Regime.TRENDING_BULLISH for v in verdicts)
    pending_counts = [v.pending_bars for v in verdicts]
    assert all(
        later > earlier for earlier, later in zip(pending_counts, pending_counts[1:])
    ), "§3.3 — the consecutive-bar count must advance while the candidate holds"


def test_regime_confidence_decays_toward_zero_while_pending():
    """§3.3: "the previous regime remains active and `regime_confidence` decays
    toward 0."

    The shape of the decay is not specified and is not asserted. What is
    asserted is direction and bounds: strictly decreasing across pending bars,
    below the settled 1.0, and inside §2's stated 0..1 range. A confidence that
    stays at 1.0 while the classification is being contradicted is the display
    telling the operator the opposite of what the data says.
    """
    start = settled(Regime.RANGING)
    verdicts = _walk(start, _sustained_trend_steps(REGIME_CONFIRM_BARS - 1))

    confidences = [v.regime_confidence for v in verdicts]
    assert all(0.0 <= c <= 1.0 for c in confidences), "§2 — regime_confidence is 0..1"
    assert confidences[0] < start.regime_confidence
    assert confidences == sorted(confidences, reverse=True)
    assert len(set(confidences)) == len(confidences), "decay must actually move"


def test_confirmation_requires_CONSECUTIVE_bars():
    """§3.3: "consecutive closed bars", so an interruption restarts the count.

    Two trending bars, one bar that reverts to the regime in force, then two
    more trending bars is five bars containing a three-bar total but no
    three-bar run. The regime must not have changed.
    """
    steps = (
        _sustained_trend_steps(2)
        + [(Regime.RANGING, ranging_inputs(adx=15.0))]
        + _sustained_trend_steps(2)
    )
    verdicts = _walk(settled(Regime.RANGING), steps)

    assert [v.regime for v in verdicts] == [Regime.RANGING] * 5
    assert verdicts[2].pending is None, "the interrupting bar must clear the candidate"
    assert verdicts[2].pending_bars == 0


def test_a_regime_already_in_force_does_not_re_enter_confirmation():
    """§3.3 — confirmation gates *new* classifications only.

    A raw answer equal to the active regime leaves nothing pending, and
    `bars_in_regime` advances, which is what §2's field means and what §7.5's
    regime-transition policy reads.
    """
    start = settled(Regime.TRENDING_BULLISH, bars=50)
    verdicts = _walk(start, _sustained_trend_steps(3))

    assert all(v.regime == Regime.TRENDING_BULLISH for v in verdicts)
    assert all(v.pending is None for v in verdicts)
    assert verdicts[-1].bars_in_regime > start.bars_in_regime


# ================================================== TRANSITIONAL is exempt


def test_transitional_takes_effect_on_the_first_bar():
    """§3.3: "`TRANSITIONAL` is exempt from confirmation — degrading to
    uncertain should be immediate."

    One bar, not `regime_confirm_bars`. The asymmetry is deliberate: becoming
    less certain is free, becoming more certain is not. §3.4 gives TRANSITIONAL
    a smaller enabled set and a +5 threshold uplift, so the exemption fails
    safe.

    ADX 15 is below `adx_trend_exit`, so the trend has genuinely been exited on
    the asymmetric-threshold mechanism too and this case does not depend on the
    ordering question in the module docstring.
    """
    verdicts = _walk(
        settled(Regime.TRENDING_BULLISH),
        [(Regime.TRANSITIONAL, inputs(adx=15.0, atr_percentile=70.0))],
    )

    assert verdicts[0].regime == Regime.TRANSITIONAL
    assert verdicts[0].pending is None, "nothing is pending — it already took effect"


def test_the_exemption_does_not_run_in_reverse():
    """§3.3 exempts *degrading to* TRANSITIONAL, not leaving it.

    "Degrading to uncertain should be immediate" is one-directional. Promoting
    TRANSITIONAL to a confident regime is a new classification like any other
    and still owes `regime_confirm_bars`; an implementation that exempts the
    whole TRANSITIONAL row makes the confident regimes instant too.
    """
    verdicts = _walk(
        settled(Regime.TRANSITIONAL), _sustained_trend_steps(REGIME_CONFIRM_BARS - 1)
    )

    assert [v.regime for v in verdicts] == [Regime.TRANSITIONAL] * (
        REGIME_CONFIRM_BARS - 1
    )


@pytest.mark.parametrize(
    "previous_regime,adx",
    [
        # Each ADX is chosen to be OUTSIDE the previous regime's exit band, so
        # the two §3.3 mechanisms agree and this test does not depend on the
        # ordering question described in the module docstring. ATR percentile 70
        # is what makes the raw answer TRANSITIONAL in every case: above §3.2's
        # range ceiling of 60, below its volatility floor of 90.
        pytest.param(Regime.TRENDING_BULLISH, 15.0, id="3.3-exempt-from_trending_bullish"),
        pytest.param(Regime.TRENDING_BEARISH, 15.0, id="3.3-exempt-from_trending_bearish"),
        pytest.param(Regime.RANGING, 26.0, id="3.3-exempt-from_ranging"),
    ],
)
def test_transitional_is_exempt_from_every_prior_regime(previous_regime, adx):
    """§3.3's exemption is a property of the *destination*, not of the pair."""
    if previous_regime is Regime.RANGING:
        assert adx > ADX_RANGE_EXIT, "fixture bug: RANGING has not been exited"
    else:
        assert adx < ADX_TREND_EXIT, "fixture bug: TRENDING has not been exited"

    verdict = apply_hysteresis(
        settled(previous_regime),
        Regime.TRANSITIONAL,
        inputs(adx=adx, atr_percentile=70.0),
        CONFIG,
    )
    assert verdict.regime == Regime.TRANSITIONAL
