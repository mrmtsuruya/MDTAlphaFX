"""§11.1 — intrabar resolution.

**The Stage 0 gate lives in this file.** §9: "a synthetic fixture in which stop
and target share a candle resolves correctly against M1 data." Two tests carry
that: `test_gate_sub_bar_walk_resolves_target_first` and
`test_gate_sub_bar_walk_resolves_stop_first`. Both assert the resolver gets the
order right *and* that it does not flag an ambiguity it actually resolved —
over-flagging inflates the §11.1 ambiguity rate and makes a sound curve look
like an artefact.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from backend.contracts import Direction, Timeframe
from backend.core.errors import ConfigError, DataIntegrityError
from backend.core.timeutil import UTC
from backend.backtest.intrabar import (
    GapFill,
    IntrabarResolver,
    Resolution,
    ResolutionPath,
)
from tests.doubles import (
    TEST_SYMBOL,
    InMemoryBarSource,
    candle,
    m1_series,
    make_test_config,
    spec_for_tests,
)

BAR_OPEN = datetime(2026, 3, 2, 8, 0, tzinfo=UTC)

# One M15 candle whose range contains BOTH levels of the trade below. This is
# §11.1's problem statement, expressed as data.
AMBIGUOUS_M15 = candle(BAR_OPEN, 2000.00, 2005.00, 1997.00, 2001.00, spread=20)

STOP = 1998.00
TARGET = 2004.00

# 15 M1 closes that reach the TARGET first, then come back through the stop.
TARGET_FIRST_CLOSES = [
    2000.50, 2002.00, 2003.00, 2004.20, 2003.00,
    2001.00, 1999.00, 1997.20, 1998.00, 1999.00,
    2000.00, 2000.50, 2001.00, 2001.00, 2001.00,
]

# 15 M1 closes that reach the STOP first, then run up through the target.
STOP_FIRST_CLOSES = [
    1999.50, 1998.80, 1997.50, 1998.50, 2000.00,
    2002.00, 2004.20, 2003.00, 2002.00, 2001.50,
    2001.00, 2001.00, 2001.00, 2001.00, 2001.00,
]


def _source(m1=None, *, series=None, spec=None):
    spec = spec or spec_for_tests()
    series = series if series is not None else {Timeframe.M15: [AMBIGUOUS_M15]}
    return InMemoryBarSource(spec, series, m1)


def _resolver(tmp_path, source, overrides=None):
    return IntrabarResolver(make_test_config(tmp_path, overrides), source)


def _resolve(resolver, bar=AMBIGUOUS_M15, direction=Direction.BUY, tf=Timeframe.M15,
             stop=STOP, target=TARGET):
    return resolver.resolve(
        symbol=TEST_SYMBOL,
        bar=bar,
        timeframe=tf,
        direction=direction,
        stop=stop,
        target=target,
    )


# =============================================================== THE GATE ===


def test_gate_sub_bar_walk_resolves_target_first(tmp_path):
    """§9 Stage 0 gate, half one: stop and target inside one M15 candle, and the
    M1 sequence reaches the TARGET first."""
    source = _source(m1_series(BAR_OPEN, TARGET_FIRST_CLOSES))
    result = _resolve(_resolver(tmp_path, source))

    assert result.resolution is Resolution.TARGET_FIRST
    assert result.path is ResolutionPath.SUB_BAR_WALK
    # Resolved by evidence, so NOT ambiguous. §11.1's fallback was not used.
    assert result.ambiguous_fill is False
    assert result.fill_price == TARGET
    assert result.gapped is False
    # Minute 3 is where the target is first cleared.
    assert result.fill_time == BAR_OPEN + timedelta(minutes=3)
    # The walk actually consulted M1 rather than guessing.
    assert source.has_m1_calls == [(BAR_OPEN, BAR_OPEN + timedelta(minutes=15))]
    assert source.m1_calls == [(BAR_OPEN, BAR_OPEN + timedelta(minutes=15))]


def test_gate_sub_bar_walk_resolves_stop_first(tmp_path):
    """§9 Stage 0 gate, half two: the same candle, and the M1 sequence reaches
    the STOP first. The right answer here is a loss — but an *evidenced* loss,
    not the conservative assumption."""
    source = _source(m1_series(BAR_OPEN, STOP_FIRST_CLOSES))
    result = _resolve(_resolver(tmp_path, source))

    assert result.resolution is Resolution.STOP_FIRST
    assert result.path is ResolutionPath.SUB_BAR_WALK
    assert result.ambiguous_fill is False
    assert result.fill_price == STOP
    assert result.fill_time == BAR_OPEN + timedelta(minutes=2)


def test_gate_both_orders_are_distinguished(tmp_path):
    """The two halves must not agree. A resolver that always answers STOP_FIRST
    would pass the second test and be useless."""
    target_first = _resolve(
        _resolver(tmp_path / "a", _source(m1_series(BAR_OPEN, TARGET_FIRST_CLOSES)))
    )
    stop_first = _resolve(
        _resolver(tmp_path / "b", _source(m1_series(BAR_OPEN, STOP_FIRST_CLOSES)))
    )
    assert target_first.resolution is not stop_first.resolution


def test_gate_sell_side_is_symmetric(tmp_path):
    """A SELL's stop is above and its target below. The same M1 series therefore
    resolves the other way round — the resolver must not be hard-wired to BUY."""
    sell_stop, sell_target = 2004.00, 1998.00
    source = _source(m1_series(BAR_OPEN, TARGET_FIRST_CLOSES))
    result = _resolve(
        _resolver(tmp_path, source),
        direction=Direction.SELL,
        stop=sell_stop,
        target=sell_target,
    )
    # The series goes UP first, which for a SELL is the stop.
    assert result.resolution is Resolution.STOP_FIRST
    assert result.path is ResolutionPath.SUB_BAR_WALK
    assert result.ambiguous_fill is False
    assert result.fill_price == sell_stop


# ====================================================== conservative fallback


def test_no_m1_falls_back_to_a_flagged_loss(tmp_path):
    """§11.1 step 2: where M1 is unavailable, assume the stop was hit first,
    record the loss, flag `AMBIGUOUS_FILL`."""
    source = _source(m1=[])
    result = _resolve(_resolver(tmp_path, source))

    assert result.resolution is Resolution.STOP_FIRST
    assert result.path is ResolutionPath.FALLBACK_NO_M1
    assert result.ambiguous_fill is True
    assert result.fill_price == STOP
    assert "no complete M1 coverage" in result.detail
    assert "AMBIGUOUS_FILL" in result.detail


def test_partial_m1_coverage_is_not_good_enough(tmp_path):
    """A hole in the middle of the ambiguous candle is exactly where a walk
    produces a confident wrong answer, so partial coverage takes the fallback."""
    complete = m1_series(BAR_OPEN, TARGET_FIRST_CLOSES)
    with_hole = complete[:5] + complete[6:]  # minute 5 missing
    result = _resolve(_resolver(tmp_path, _source(with_hole)))

    assert result.path is ResolutionPath.FALLBACK_NO_M1
    assert result.ambiguous_fill is True
    assert result.resolution is Resolution.STOP_FIRST


def test_fallback_is_never_favourable(tmp_path):
    """§11.1 step 3. Whichever way the trade points, the unevidenced answer is
    the losing one."""
    for direction, stop, target in (
        (Direction.BUY, STOP, TARGET),
        (Direction.SELL, TARGET, STOP),
    ):
        result = _resolve(
            _resolver(tmp_path / direction.value, _source(m1=[])),
            direction=direction,
            stop=stop,
            target=target,
        )
        assert result.resolution is Resolution.STOP_FIRST
        assert result.fill_price == stop


# ================================================================ irreducible


def test_single_m1_candle_spanning_both_is_irreducible(tmp_path):
    """§11.1: "ambiguity survives only if a single *M1* candle spans both
    levels". It takes the same conservative fallback but is counted separately —
    acquiring more data cannot fix this one."""
    closes = [2000.00, 2001.00] + [2001.00] * 13
    highs = [2000.00, 2004.50] + [2001.00] * 13
    lows = [2000.00, 1997.50] + [2001.00] * 13
    source = _source(m1_series(BAR_OPEN, closes, highs=highs, lows=lows))
    result = _resolve(_resolver(tmp_path, source))

    assert result.resolution is Resolution.STOP_FIRST
    assert result.path is ResolutionPath.FALLBACK_IRREDUCIBLE
    assert result.ambiguous_fill is True
    assert "irreducible" in result.detail


def test_the_two_fallback_causes_are_different_values(tmp_path):
    """Metrics segment on this. If both causes carried the same path value there
    would be no way to tell a data-acquisition problem from a hard limit."""
    no_m1 = _resolve(_resolver(tmp_path / "a", _source(m1=[])))
    closes = [2000.00, 2001.00] + [2001.00] * 13
    highs = [2000.00, 2004.50] + [2001.00] * 13
    lows = [2000.00, 1997.50] + [2001.00] * 13
    irreducible = _resolve(
        _resolver(tmp_path / "b", _source(m1_series(BAR_OPEN, closes, highs=highs, lows=lows)))
    )
    assert no_m1.path is not irreducible.path
    assert no_m1.ambiguous_fill and irreducible.ambiguous_fill


def test_an_m1_bar_spanning_both_needs_no_sub_bar_lookup(tmp_path):
    """Handed an M1 bar directly there is nothing finer to consult, so the
    resolver must not ask the source for sub-bars at all."""
    m1_bar = candle(BAR_OPEN, 2000.00, 2005.00, 1997.00, 2001.00)
    source = _source(series={Timeframe.M1: [m1_bar]}, m1=[m1_bar])
    result = _resolve(_resolver(tmp_path, source), bar=m1_bar, tf=Timeframe.M1)

    assert result.path is ResolutionPath.FALLBACK_IRREDUCIBLE
    assert result.ambiguous_fill is True
    assert source.has_m1_calls == []
    assert source.m1_calls == []


# ============================================================ unambiguous ===


def test_only_one_level_inside_needs_no_assumption(tmp_path):
    bar = candle(BAR_OPEN, 2000.00, 2004.50, 1999.00, 2004.00)
    result = _resolve(_resolver(tmp_path, _source(m1=[])), bar=bar)

    assert result.resolution is Resolution.TARGET_FIRST
    assert result.path is ResolutionPath.UNAMBIGUOUS
    assert result.ambiguous_fill is False
    assert result.fill_price == TARGET


def test_neither_level_touched(tmp_path):
    bar = candle(BAR_OPEN, 2000.00, 2001.00, 1999.00, 2000.50)
    result = _resolve(_resolver(tmp_path, _source(m1=[])), bar=bar)

    assert result.resolution is Resolution.NEITHER
    assert result.path is ResolutionPath.UNAMBIGUOUS
    assert result.resolved is False
    assert result.fill_price is None
    assert result.ambiguous_fill is False


def test_trigger_checks_can_use_the_executable_spread_side(tmp_path):
    """§11.2: a SELL exits by buying at ASK, so BID touching TP is insufficient."""
    bar = candle(BAR_OPEN, 2000.00, 2000.00, 1999.00, 1999.50, spread=100)
    resolver = _resolver(tmp_path, _source(m1=[]))

    stored_side = _resolve(
        resolver,
        bar=bar,
        direction=Direction.SELL,
        stop=2002.00,
        target=1999.00,
    )
    executable_side = resolver.resolve(
        symbol=TEST_SYMBOL,
        bar=bar,
        timeframe=Timeframe.M15,
        direction=Direction.SELL,
        stop=2002.00,
        target=1999.00,
        price_adjustment=lambda candidate: candidate.spread * 0.01,
    )

    assert stored_side.resolution is Resolution.TARGET_FIRST
    assert executable_side.resolution is Resolution.NEITHER
    assert executable_side.fill_bar is None


def test_touching_a_level_exactly_counts_as_hitting_it(tmp_path):
    """§12.1 states the test as `high >= level`, so equality resolves."""
    bar = candle(BAR_OPEN, 2000.00, TARGET, 1999.00, 2003.00)
    result = _resolve(_resolver(tmp_path, _source(m1=[])), bar=bar)
    assert result.resolution is Resolution.TARGET_FIRST


# ==================================================================== gaps ===


def test_gap_through_the_stop_fills_at_the_gapped_price(tmp_path):
    """A gap through the stop fills at the **gapped price**, not at the stop
    price — there was no trade at the stop to fill against. This is the
    `GAPPED_PRICE` reading of AMBIGUITY-B06 and it loses more than 1R."""
    gapped_open = 1995.00
    bar = candle(BAR_OPEN, gapped_open, 1996.00, 1994.00, 1995.50)
    result = _resolve(_resolver(tmp_path, _source(m1=[])), bar=bar)

    assert result.resolution is Resolution.STOP_FIRST
    assert result.path is ResolutionPath.UNAMBIGUOUS
    assert result.ambiguous_fill is False
    assert result.gapped is True
    assert result.fill_price == gapped_open
    assert result.fill_price < STOP


def test_gap_through_the_target_also_fills_at_the_open(tmp_path):
    gapped_open = 2006.00
    bar = candle(BAR_OPEN, gapped_open, 2007.00, 2005.50, 2006.50)
    result = _resolve(_resolver(tmp_path, _source(m1=[])), bar=bar)

    assert result.resolution is Resolution.TARGET_FIRST
    assert result.gapped is True
    assert result.fill_price == gapped_open


def test_level_price_reading_fills_at_the_level(tmp_path):
    """The other reading of AMBIGUITY-B06 is implemented too, so the operator's
    choice is a config change rather than a code change."""
    bar = candle(BAR_OPEN, 1995.00, 1996.00, 1994.00, 1995.50)
    resolver = _resolver(
        tmp_path,
        _source(m1=[]),
        {"backtest.intrabar.gap_fill": GapFill.LEVEL_PRICE.value},
    )
    result = _resolve(resolver, bar=bar)

    assert result.gapped is True
    assert result.fill_price == STOP


def test_a_bar_that_opens_through_a_level_is_not_ambiguous(tmp_path):
    """The open crossed one level before price traded anywhere else, so the
    order is known even though the range contains both."""
    bar = candle(BAR_OPEN, 1997.50, 2005.00, 1997.00, 2004.50)
    source = _source(m1=[])
    result = _resolve(_resolver(tmp_path, source), bar=bar)

    assert result.resolution is Resolution.STOP_FIRST
    assert result.path is ResolutionPath.UNAMBIGUOUS
    assert result.ambiguous_fill is False
    assert source.has_m1_calls == []


# ================================================== source & config integrity


def test_source_that_contradicts_itself_raises(tmp_path):
    class Liar(InMemoryBarSource):
        def has_m1(self, symbol, start, end):
            return True

        def m1_bars(self, symbol, start, end):
            return []

    source = Liar(spec_for_tests(), {Timeframe.M15: [AMBIGUOUS_M15]}, [])
    with pytest.raises(DataIntegrityError, match="contradicts itself"):
        _resolve(_resolver(tmp_path, source))


def test_m1_that_never_reaches_either_level_raises(tmp_path):
    """The parent says both levels were touched; the M1 series says neither
    was. That is an inconsistent store, not an ambiguous market."""
    flat = m1_series(BAR_OPEN, [2001.00] * 15)
    with pytest.raises(DataIntegrityError, match="store is inconsistent"):
        _resolve(_resolver(tmp_path, _source(flat)))


@pytest.mark.parametrize(
    "override, message",
    [
        ({"backtest.intrabar.require_sub_bar_walk": False}, "required"),
        ({"backtest.intrabar.fallback": "TARGET_FIRST"}, "STOP_FIRST"),
        ({"backtest.intrabar.irreducible_takes_fallback": False}, "conservative"),
        ({"backtest.intrabar.gap_fill": "SOMETHING_ELSE"}, "gap_fill"),
        ({"engine.timeframes.sub_bar": "M5"}, "m1_bars"),
    ],
)
def test_config_that_would_weaken_11_1_refuses_to_construct(tmp_path, override, message):
    with pytest.raises(ConfigError, match=message):
        _resolver(tmp_path, _source(m1=[]), override)


@pytest.mark.parametrize(
    "direction, stop, target",
    [
        (Direction.BUY, 2004.00, 1998.00),
        (Direction.SELL, 1998.00, 2004.00),
        (Direction.NONE, 1998.00, 2004.00),
    ],
)
def test_inverted_or_directionless_levels_raise(tmp_path, direction, stop, target):
    with pytest.raises(ValueError):
        _resolve(
            _resolver(tmp_path, _source(m1=[])),
            direction=direction,
            stop=stop,
            target=target,
        )
