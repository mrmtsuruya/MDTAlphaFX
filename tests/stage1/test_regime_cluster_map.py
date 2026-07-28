"""§3.4 Regime → cluster enablement, and §3.5 per-timeframe classification.

§3.4's warning is the reason this file is long:

    "The map has three states, not two — `ENABLED` (✅), `COUNTER_ONLY` (✅¹) and
     `SUPPRESSED` (⛔). Implementing it as a boolean loses the distinction and
     silently **mis-scores every trending signal**."

A suite that only distinguished enabled from suppressed would pass against
exactly the implementation the spec warns about, so the three-state property is
asserted through behaviour that no boolean can produce.

§3.4's table is transcribed here a second time, independently of
`stage1_doubles.REGIME_CLUSTER_MAP`. Two transcriptions of one table is the
cheapest guard there is against a mis-typed cell, and a mis-typed cell in this
particular table changes the score of every signal in that regime.
"""

from __future__ import annotations

import pytest

from backend.contracts import Direction, Regime
from backend.regime.classifier import cluster_state, htf_alignment_penalty
from backend.scoring.score import enabled_in
from backend.scoring.types import ClusterState
from tests.stage1.stage1_doubles import (
    ALL_CLUSTER_IDS,
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
    COUNTER_BIAS_PENALTY,
    REGIME_CLUSTER_MAP,
    regime_config,
)

CONFIG = regime_config()

_EN = ClusterState.ENABLED  # ✅
_CO = ClusterState.COUNTER_ONLY  # ✅¹
_SU = ClusterState.SUPPRESSED  # ⛔

#: §3.4's table, column order: TRENDING · RANGING · VOLATILE_NEWS · TRANSITIONAL
SPEC_TABLE = {
    CLUSTER_A: (_EN, _EN, _SU, _EN),  # A · Imbalance
    CLUSTER_B: (_EN, _EN, _SU, _EN),  # B · Zone retest
    CLUSTER_C: (_EN, _EN, _SU, _EN),  # C · Stop hunt & reject
    CLUSTER_D1: (_EN, _SU, _SU, _SU),  # D₁ · BOS continuation
    CLUSTER_D2: (_CO, _EN, _SU, _EN),  # D₂ · CHoCH / QM reversal  (✅¹)
    CLUSTER_E: (_EN, _SU, _SU, _SU),  # E · Trend stack
    CLUSTER_F: (_CO, _EN, _SU, _EN),  # F · Momentum divergence   (✅¹)
    CLUSTER_G: (_SU, _EN, _SU, _SU),  # G · Envelope reversion
    CLUSTER_H: (_EN, _SU, _SU, _SU),  # H · Volatility expansion
}

#: §3.4's column header is "TRENDING"; §2's `Regime` has two trending members.
#: `TRENDING_BULLISH` stands in for the column and a separate test asserts the
#: other member reads identically.
_COLUMNS = (
    Regime.TRENDING_BULLISH,
    Regime.RANGING,
    Regime.VOLATILE_NEWS,
    Regime.TRANSITIONAL,
)


def _cells():
    for cluster_id, row in SPEC_TABLE.items():
        name = CLUSTER_REGISTRY.by_id(cluster_id).name
        for regime, expected in zip(_COLUMNS, row):
            yield pytest.param(
                regime,
                cluster_id,
                expected,
                id=f"3.4-{regime.value}-{name.replace(' ', '_')}-{expected.value}",
            )


# ======================================================= every cell of §3.4


@pytest.mark.parametrize("regime,cluster_id,expected", list(_cells()))
def test_regime_cluster_map_cell(regime, cluster_id, expected):
    """§3.4's table, one test per cell.

    `SUPPRESSED` means "members return `fired=False` regardless of pattern";
    `COUNTER_ONLY` means the cluster "may only contribute **against** the trend
    direction, as early-reversal warnings".
    """
    assert cluster_state(regime, cluster_id, REGIME_CLUSTER_MAP) == expected


def test_the_trending_column_covers_both_trending_regimes():
    """§3.4 has one TRENDING column; §2's `Regime` has TRENDING_BULLISH and
    TRENDING_BEARISH.

    Nothing in §3.4 distinguishes them for cluster enablement — the ✅¹ note
    says D₂ and F may fire "against the trend direction", which is a property of
    the *signal's* direction, not of which way the trend points. A map that
    resolved only one of the two members would suppress every cluster in the
    other.
    """
    for cluster_id in ALL_CLUSTER_IDS:
        bullish = cluster_state(Regime.TRENDING_BULLISH, cluster_id, REGIME_CLUSTER_MAP)
        bearish = cluster_state(Regime.TRENDING_BEARISH, cluster_id, REGIME_CLUSTER_MAP)
        assert bullish == bearish


def test_the_map_is_total():
    """Every cluster has a state in every regime.

    §5.2's denominator is built by asking this question of all nine clusters; a
    missing cell is a `KeyError` in the middle of scoring a live signal.
    """
    for regime in Regime:
        for cluster_id in ALL_CLUSTER_IDS:
            state = cluster_state(regime, cluster_id, REGIME_CLUSTER_MAP)
            assert isinstance(state, ClusterState)


# ============================================ three states, provably not two


def test_counter_only_is_not_expressible_as_a_boolean():
    """§3.4: "Implementing it as a boolean loses the distinction and silently
    mis-scores every trending signal."

    The approved STAGE1-A01 reading makes counter-trend scoring a dedicated
    D2/F lane with denominator 22. For a fixed regime and trend direction:

        ENABLED       (True,  False)
        SUPPRESSED    (False, False)
        COUNTER_ONLY  (False, True)   <- impossible for any boolean per cluster

    A boolean per cluster cannot express the direction-dependent swap between
    ENABLED and COUNTER_ONLY.
    """
    regime, trend = Regime.TRENDING_BULLISH, Direction.BUY

    def counts_for(cluster_id, direction):
        return enabled_in(regime, cluster_id, direction, trend, REGIME_CLUSTER_MAP)

    def row(cluster_id):
        return (
            counts_for(cluster_id, Direction.BUY),  # with-trend
            counts_for(cluster_id, Direction.SELL),  # counter-trend
        )

    assert row(CLUSTER_A) == (True, False), "approved §5.2 — ENABLED is with-trend"
    assert row(CLUSTER_G) == (False, False), "§3.4 ⛔ — SUPPRESSED counts neither way"
    assert row(CLUSTER_D2) == (False, True), "§3.4 ✅¹ — COUNTER_ONLY, against only"
    assert row(CLUSTER_F) == (False, True), "§3.4 ✅¹ — COUNTER_ONLY, against only"

    assert row(CLUSTER_D2) != row(CLUSTER_A)
    assert row(CLUSTER_D2) != row(CLUSTER_G)


def test_the_trending_row_uses_all_three_states():
    """§3.4 — "three states, not two", and TRENDING is the row that uses them all.

    A `set` of the whole row must have exactly three members. Two means a state
    was collapsed; the map still looks plausible and every trending signal is
    scored against the wrong denominator.
    """
    states = {
        cluster_state(Regime.TRENDING_BULLISH, cid, REGIME_CLUSTER_MAP)
        for cid in ALL_CLUSTER_IDS
    }
    assert states == {
        ClusterState.ENABLED,
        ClusterState.COUNTER_ONLY,
        ClusterState.SUPPRESSED,
    }
    assert len(states) == 3


@pytest.mark.parametrize(
    "regime",
    [
        pytest.param(Regime.RANGING, id="3.4-RANGING-has_no_counter_only_cell"),
        pytest.param(Regime.TRANSITIONAL, id="3.4-TRANSITIONAL-has_no_counter_only_cell"),
        pytest.param(Regime.VOLATILE_NEWS, id="3.4-VOLATILE_NEWS-has_no_counter_only_cell"),
    ],
)
def test_counter_only_appears_only_in_the_trending_row(regime):
    """§3.4 note 1 is scoped: "**In TRENDING**, clusters D₂ and F may only
    contribute against the trend direction."

    Outside TRENDING there is no trend direction to be counter to, so the state
    must not appear. An implementation that marks D₂ COUNTER_ONLY everywhere
    silently halves the RANGING denominator.
    """
    states = {cluster_state(regime, cid, REGIME_CLUSTER_MAP) for cid in ALL_CLUSTER_IDS}
    assert ClusterState.COUNTER_ONLY not in states


# ================================================= VOLATILE_NEWS suppresses all


def test_volatile_news_suppresses_every_cluster():
    """§3.4: "**VOLATILE_NEWS generates no new signals at all.**"

    All nine cells in that column are ⛔. This is also §5.3 validity condition 3
    ("Regime is not `VOLATILE_NEWS`", always enforced) approached from the other
    side — belt and braces, deliberately, because the cost of a signal fired
    into a news release is not symmetric with the cost of missing one.
    """
    for cluster_id in ALL_CLUSTER_IDS:
        assert (
            cluster_state(Regime.VOLATILE_NEWS, cluster_id, REGIME_CLUSTER_MAP)
            == ClusterState.SUPPRESSED
        )


@pytest.mark.parametrize(
    "direction,trend",
    [
        pytest.param(Direction.BUY, Direction.BUY, id="3.4-VOLATILE_NEWS-with_trend_buy"),
        pytest.param(Direction.SELL, Direction.BUY, id="3.4-VOLATILE_NEWS-counter_buy"),
        pytest.param(Direction.BUY, Direction.SELL, id="3.4-VOLATILE_NEWS-counter_sell"),
        pytest.param(
            Direction.SELL, Direction.SELL, id="3.4-VOLATILE_NEWS-with_trend_sell"
        ),
        pytest.param(
            Direction.BUY, Direction.NONE, id="3.4-VOLATILE_NEWS-no_trend_direction"
        ),
    ],
)
def test_volatile_news_leaves_no_cluster_available_in_any_direction(direction, trend):
    """§3.4 — "no new signals at all" is stronger than "no with-trend signals".

    The available set §5.2 builds its denominator from is empty for every
    combination of candidate and trend direction. Nothing can fire, so nothing
    can be scored.
    """
    available = [
        cid
        for cid in ALL_CLUSTER_IDS
        if enabled_in(Regime.VOLATILE_NEWS, cid, direction, trend, REGIME_CLUSTER_MAP)
    ]
    assert available == []


# ==================================== §3.5 the bias timeframe does not veto


@pytest.mark.parametrize(
    "signal_direction,bias_regime,expected",
    [
        pytest.param(
            Direction.BUY, Regime.TRENDING_BULLISH, 1.0, id="3.5-buy_with_bullish_bias"
        ),
        pytest.param(
            Direction.SELL, Regime.TRENDING_BEARISH, 1.0, id="3.5-sell_with_bearish_bias"
        ),
        pytest.param(
            Direction.SELL,
            Regime.TRENDING_BULLISH,
            COUNTER_BIAS_PENALTY,
            id="3.5-sell_against_bullish_bias",
        ),
        pytest.param(
            Direction.BUY,
            Regime.TRENDING_BEARISH,
            COUNTER_BIAS_PENALTY,
            id="3.5-buy_against_bearish_bias",
        ),
    ],
)
def test_htf_alignment_penalty(signal_direction, bias_regime, expected):
    """§3.5: "a signal opposing the bias-timeframe regime receives a **weight
    penalty of 0.6** on its final score" — 1.0 when aligned."""
    assert htf_alignment_penalty(signal_direction, bias_regime, CONFIG) == expected


def test_the_bias_timeframe_penalises_rather_than_vetoes():
    """§3.5: "The **bias timeframe** does not veto lower timeframes."

    The counter-bias multiplier must be strictly between 0 and 1. At 0 it is a
    veto wearing a multiplier's clothes, and §3.5 says why that would be wrong:
    "This keeps counter-trend setups available at reduced conviction rather than
    banning them — which matters because cluster F is the most orthogonal signal
    in the library and is inherently counter-trend."
    """
    penalty = htf_alignment_penalty(Direction.BUY, Regime.TRENDING_BEARISH, CONFIG)
    assert 0.0 < penalty < 1.0
    assert penalty * 100.0 > 0.0, "§3.5 — a counter-bias signal survives at reduced size"


def test_a_counter_bias_signal_is_still_a_signal():
    """§3.5 — the penalty is applied to a score, so it must be a multiplier that
    an aligned signal can also take harmlessly.

    Asserting both halves together pins the pair: `aligned × counter < aligned`,
    and the aligned case is exactly 1.0 so it never alters an aligned score.
    """
    aligned = htf_alignment_penalty(Direction.BUY, Regime.TRENDING_BULLISH, CONFIG)
    opposing = htf_alignment_penalty(Direction.BUY, Regime.TRENDING_BEARISH, CONFIG)
    assert aligned == 1.0
    assert opposing < aligned
