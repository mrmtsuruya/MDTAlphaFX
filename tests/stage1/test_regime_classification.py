"""§3.2 — the ordered classification rules, before hysteresis.

    IF within news_blackout_window        -> VOLATILE_NEWS
    ELIF atr_percentile > 90              -> VOLATILE_NEWS
    ELIF adx > adx_trend_enter (27)
         AND ema_stack_aligned
         AND r_squared > 0.60             -> TRENDING_BULLISH or TRENDING_BEARISH
    ELIF adx < adx_range_enter (20)
         AND atr_percentile < 60          -> RANGING
    ELSE                                  -> TRANSITIONAL

"Evaluated in order; first match wins." Order is load-bearing and every
comparison is strict, so both properties are tested explicitly rather than left
to follow from the branch table.

Every threshold used here is declared in `stage1_doubles`, never read from
`config/regime.yaml`. This pins the test to the approved §3 baseline even if a
future, separately approved calibration changes runtime configuration.
"""

from __future__ import annotations

import pytest

from backend.contracts import Regime
from backend.regime.classifier import classify_raw
from tests.stage1.stage1_doubles import (
    ADX_RANGE_ENTER,
    ADX_TREND_ENTER,
    ATR_PERCENTILE_RANGE_BELOW,
    ATR_PERCENTILE_VOLATILE_ABOVE,
    R_SQUARED_TREND_ABOVE,
    inputs,
    ranging_inputs,
    regime_config,
    trending_inputs,
    volatile_inputs,
)

CONFIG = regime_config()


# ============================================================== the five branches


@pytest.mark.parametrize(
    "regime_inputs,expected",
    [
        pytest.param(
            inputs(within_news_blackout=True),
            Regime.VOLATILE_NEWS,
            id="3.2-branch1-news_blackout",
        ),
        pytest.param(
            volatile_inputs(atr_percentile=95.0),
            Regime.VOLATILE_NEWS,
            id="3.2-branch2-atr_percentile_above_90",
        ),
        pytest.param(
            trending_inputs(bullish=True),
            Regime.TRENDING_BULLISH,
            id="3.2-branch3-trending_bullish",
        ),
        pytest.param(
            trending_inputs(bullish=False),
            Regime.TRENDING_BEARISH,
            id="3.2-branch3-trending_bearish",
        ),
        pytest.param(
            ranging_inputs(),
            Regime.RANGING,
            id="3.2-branch4-ranging",
        ),
        pytest.param(
            inputs(),
            Regime.TRANSITIONAL,
            id="3.2-branch5-else_transitional",
        ),
    ],
)
def test_classification_branches(regime_inputs, expected):
    """§3.2's five outcomes, one case per branch.

    The ELSE case matters as much as the others: §2 comments TRANSITIONAL as
    "no confident classification", so anything that matches nothing must land
    there rather than defaulting to the previous regime — that is §3.3's job,
    not §3.2's.
    """
    assert classify_raw(regime_inputs, CONFIG) == expected


def test_trend_direction_follows_the_ema_stack():
    """§3.2 branch 3 resolves to "TRENDING_BULLISH or TRENDING_BEARISH".

    §3.1 lists "EMA(20/50/200) alignment & slope" as supplying "trend direction
    and structure", so alignment gates the branch and the stack's sense picks
    the member. Identical inputs but for `ema_stack_bullish` must produce
    different regimes.
    """
    bull = classify_raw(trending_inputs(bullish=True), CONFIG)
    bear = classify_raw(trending_inputs(bullish=False), CONFIG)
    assert bull == Regime.TRENDING_BULLISH
    assert bear == Regime.TRENDING_BEARISH
    assert bull != bear


# ================================================================= rule ORDER


def test_news_blackout_outranks_a_textbook_trend():
    """§3.2: "Evaluated in order; first match wins."

    A news blackout arriving on top of ADX 40, an aligned stack and R² 0.90
    classifies VOLATILE_NEWS — which §3.4 then reads as "generates no new
    signals at all". An implementation that evaluates the trend test first
    trades straight into the release.
    """
    textbook_trend_during_news = trending_inputs(
        adx=40.0, r_squared=0.90, within_news_blackout=True
    )
    assert classify_raw(textbook_trend_during_news, CONFIG) == Regime.VOLATILE_NEWS


def test_news_blackout_outranks_a_textbook_range():
    """§3.2 rule 1 precedes rule 4 as well as rule 3."""
    quiet_market_during_news = ranging_inputs(within_news_blackout=True)
    assert classify_raw(quiet_market_during_news, CONFIG) == Regime.VOLATILE_NEWS


def test_atr_percentile_above_90_outranks_a_qualifying_adx():
    """§3.2 rule 2 precedes rule 3.

    ADX 40 with an aligned stack and R² 0.90 satisfies the trending branch
    completely. At ATR percentile 95 the classification is still VOLATILE_NEWS:
    a trend measured inside the top decile of volatility is the regime the stop
    distances were not sized for.
    """
    trend_in_extreme_volatility = trending_inputs(
        adx=40.0, r_squared=0.90, atr_percentile=95.0
    )
    assert classify_raw(trend_in_extreme_volatility, CONFIG) == Regime.VOLATILE_NEWS


def test_atr_percentile_above_90_outranks_a_qualifying_range_adx():
    """§3.2 rule 2 precedes rule 4.

    ADX 15 satisfies `adx < adx_range_enter`; the ATR test in rule 4 would
    reject it anyway, so this pins the *ordering* rather than the conjunction —
    the answer must be VOLATILE_NEWS, not TRANSITIONAL.
    """
    quiet_adx_in_extreme_volatility = inputs(adx=15.0, atr_percentile=95.0)
    assert classify_raw(quiet_adx_in_extreme_volatility, CONFIG) == Regime.VOLATILE_NEWS


def test_trending_outranks_the_else_branch():
    """§3.2 rule 3 precedes the ELSE. A qualifying trend is never TRANSITIONAL."""
    assert classify_raw(trending_inputs(), CONFIG) != Regime.TRANSITIONAL


# ============================================== strict comparisons at the edge

# §3.2 writes `>` and `<`, never `>=` or `<=`. The boundary value itself must
# NOT trigger its branch. Each pair below states the boundary and the smallest
# step past it, so a `>=` slip fails the first case and passes the second.


@pytest.mark.parametrize(
    "atr_percentile,expected",
    [
        pytest.param(
            ATR_PERCENTILE_VOLATILE_ABOVE,
            Regime.TRANSITIONAL,
            id="3.2-boundary-atr_exactly_90-does_NOT_trigger_volatile",
        ),
        pytest.param(
            ATR_PERCENTILE_VOLATILE_ABOVE + 0.01,
            Regime.VOLATILE_NEWS,
            id="3.2-boundary-atr_just_above_90-triggers_volatile",
        ),
    ],
)
def test_atr_percentile_volatility_boundary_is_strict(atr_percentile, expected):
    """§3.2: `atr_percentile > 90`, not `>=`.

    ADX 15 is held below `adx_range_enter` so the fall-through is visible: at
    exactly 90 the classification drops past rule 2, fails rule 4's
    `atr_percentile < 60`, and lands on TRANSITIONAL.
    """
    assert classify_raw(inputs(adx=15.0, atr_percentile=atr_percentile), CONFIG) == expected


@pytest.mark.parametrize(
    "adx,expected",
    [
        pytest.param(
            ADX_TREND_ENTER,
            Regime.TRANSITIONAL,
            id="3.2-boundary-adx_exactly_trend_enter-does_NOT_trend",
        ),
        pytest.param(
            ADX_TREND_ENTER + 0.01,
            Regime.TRENDING_BULLISH,
            id="3.2-boundary-adx_just_above_trend_enter-trends",
        ),
    ],
)
def test_trend_adx_boundary_is_strict(adx, expected):
    """§3.2: `adx > adx_trend_enter`, not `>=`. Every other trend condition is
    satisfied, so only the comparison operator decides."""
    assert classify_raw(trending_inputs(adx=adx), CONFIG) == expected


@pytest.mark.parametrize(
    "r_squared,expected",
    [
        pytest.param(
            R_SQUARED_TREND_ABOVE,
            Regime.TRANSITIONAL,
            id="3.2-boundary-r2_exactly_0.60-does_NOT_trend",
        ),
        pytest.param(
            R_SQUARED_TREND_ABOVE + 0.0001,
            Regime.TRENDING_BULLISH,
            id="3.2-boundary-r2_just_above_0.60-trends",
        ),
    ],
)
def test_trend_r_squared_boundary_is_strict(r_squared, expected):
    """§3.2: `r_squared > 0.60`, not `>=`. §3.1 calls R² "trend cleanliness vs.
    chop" — the boundary is the line between the two and belongs to chop."""
    assert classify_raw(trending_inputs(r_squared=r_squared), CONFIG) == expected


@pytest.mark.parametrize(
    "adx,expected",
    [
        pytest.param(
            ADX_RANGE_ENTER,
            Regime.TRANSITIONAL,
            id="3.2-boundary-adx_exactly_range_enter-does_NOT_range",
        ),
        pytest.param(
            ADX_RANGE_ENTER - 0.01,
            Regime.RANGING,
            id="3.2-boundary-adx_just_below_range_enter-ranges",
        ),
    ],
)
def test_range_adx_boundary_is_strict(adx, expected):
    """§3.2: `adx < adx_range_enter`, not `<=`."""
    assert classify_raw(ranging_inputs(adx=adx), CONFIG) == expected


@pytest.mark.parametrize(
    "atr_percentile,expected",
    [
        pytest.param(
            ATR_PERCENTILE_RANGE_BELOW,
            Regime.TRANSITIONAL,
            id="3.2-boundary-atr_exactly_60-does_NOT_range",
        ),
        pytest.param(
            ATR_PERCENTILE_RANGE_BELOW - 0.01,
            Regime.RANGING,
            id="3.2-boundary-atr_just_below_60-ranges",
        ),
    ],
)
def test_range_atr_boundary_is_strict(atr_percentile, expected):
    """§3.2: `atr_percentile < 60`, not `<=`."""
    assert (
        classify_raw(ranging_inputs(atr_percentile=atr_percentile), CONFIG) == expected
    )


# ============================================================ the conjunctions


@pytest.mark.parametrize(
    "regime_inputs,id_note",
    [
        pytest.param(
            trending_inputs(adx=24.0),
            "adx below enter",
            id="3.2-conjunction-trend-needs_adx",
        ),
        pytest.param(
            trending_inputs(ema_stack_aligned=False),
            "stack unaligned",
            id="3.2-conjunction-trend-needs_ema_stack_aligned",
        ),
        pytest.param(
            trending_inputs(r_squared=0.30),
            "R² below 0.60",
            id="3.2-conjunction-trend-needs_r_squared",
        ),
    ],
)
def test_trend_branch_requires_all_three_conditions(regime_inputs, id_note):
    """§3.2 branch 3 is an AND of three tests, not a majority vote.

    Removing any one drops the classification through to TRANSITIONAL —
    "no confident classification" (§2). ADX alone is a strength reading with no
    opinion about direction or cleanliness; §3.1 lists three inputs because one
    is not enough.
    """
    result = classify_raw(regime_inputs, CONFIG)
    assert result == Regime.TRANSITIONAL, id_note
    assert result not in (Regime.TRENDING_BULLISH, Regime.TRENDING_BEARISH)


@pytest.mark.parametrize(
    "regime_inputs",
    [
        pytest.param(ranging_inputs(adx=24.0), id="3.2-conjunction-range-needs_low_adx"),
        pytest.param(
            ranging_inputs(atr_percentile=70.0),
            id="3.2-conjunction-range-needs_low_atr",
        ),
    ],
)
def test_range_branch_requires_both_conditions(regime_inputs):
    """§3.2 branch 4 is `adx < adx_range_enter` AND `atr_percentile < 60`.

    A quiet ADX in an expanding-volatility tape is not a range — it is the
    coil before a break, and §3.4 enables G (envelope reversion) in RANGING
    only. Mean-reverting into an expansion is how that cluster loses money.
    """
    assert classify_raw(regime_inputs, CONFIG) == Regime.TRANSITIONAL


# ================================================================ §3.5 / rule 1


def test_classification_is_a_pure_function_of_its_inputs():
    """§3.5: "Regime is classified **independently on each timeframe**."

    Classifying an H4-shaped trend, then an M15-shaped range, then the H4 inputs
    again must return the first answer unchanged. `classify_raw` holds no state
    between calls, which is what makes "an H4 uptrend routinely contains a
    ranging M15" a normal reading rather than a contradiction to resolve.
    """
    h4 = trending_inputs()
    m15 = ranging_inputs()

    first = classify_raw(h4, CONFIG)
    interleaved = classify_raw(m15, CONFIG)
    again = classify_raw(h4, CONFIG)

    assert first == Regime.TRENDING_BULLISH
    assert interleaved == Regime.RANGING
    assert again == first, "§3.5 — classifying another timeframe changed this one"


def test_an_h4_trend_containing_a_ranging_m15_is_not_an_error():
    """§3.5: "An H4 uptrend routinely contains a ranging M15."

    Both classifications stand simultaneously. Nothing raises, and neither
    result is downgraded to reconcile it with the other — §5.4 surfaces the
    disagreement, §3.5 does not resolve it.
    """
    per_timeframe = {
        "H4": classify_raw(trending_inputs(), CONFIG),
        "M15": classify_raw(ranging_inputs(), CONFIG),
    }
    assert per_timeframe["H4"] == Regime.TRENDING_BULLISH
    assert per_timeframe["M15"] == Regime.RANGING
