"""Golden-file tests for the Stage 0 harness — §10.3.

    §10.3: "Recorded MT5 fixtures, replayed deterministically. [...] Golden-file
    tests per module."

Two goldens are locked here:

1. **The strategy's own output**, bar by bar. This is the shape every Stage 2
   module's golden test will take: a fixed fixture in, a recorded
   `StrategyResult` series out, compared exactly.
2. **The whole replayed run**, serialised. This locks the harness rather than
   the strategy — intrabar resolution, cost application, §7.3 validation and the
   trade record all at once. If a refactor changes any number this fails, which
   is the point: §9 warns that retrofitting sub-bar resolution or cost modelling
   "changes every number the harness has ever produced".

`NBarBreakout` is harness scaffolding and **not** one of the 28 modules (see its
docstring). This file locks the harness's behaviour, not a trading edge.

**Regenerating.** Deliberately not automatic — a golden that rewrites itself on
failure tests nothing. Run `python3 -m tests.golden.test_trivial_golden
--regenerate` from the repo root, and read the diff before committing it.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import pytest

from backend.contracts import Timeframe
from backend.core.timeutil import UTC, bar_close_time
from backend.backtest.metrics import build_report
from backend.backtest.replay import ReplayEngine, RunSpec
from backend.strategies.trivial import NBarBreakout
from tests.doubles import (
    TEST_SYMBOL,
    InMemoryBarSource,
    expand_to_m1,
    make_test_config,
    spec_for_tests,
    zigzag_series,
)

GOLDEN_DIR = Path(__file__).resolve().parent / "data"
STRATEGY_GOLDEN = GOLDEN_DIR / "trivial_strategy_results.json"
RUN_GOLDEN = GOLDEN_DIR / "trivial_replay_run.json"

START = datetime(2026, 3, 2, 8, 0, tzinfo=UTC)
TF = Timeframe.M15

#: The fixture parameters. Fixed constants of the *test*, not of the system —
#: they define which recorded scenario the golden describes.
FIXTURE = dict(base=2000.0, leg_bars=8, step=0.5, cycles=2, half_range=0.10)

CONFIG_OVERRIDES = {
    "backtest.gate_strategy.lookback_bars": 3,
    "backtest.gate_strategy.stop_points": 100,
    "backtest.gate_strategy.target_points": 100,
    "costs.commission.per_lot_per_side.XAUUSD": 3.0,
    "costs.slippage.market_order_points": 5,
    "costs.slippage.stop_order_points": 5,
    "backtest.replay.volume": 0.10,
    "backtest.metrics.min_segment_trades": 30,
}


def _fixture(tmp_path):
    config = make_test_config(tmp_path, CONFIG_OVERRIDES)
    bars = zigzag_series(START, TF, **FIXTURE)
    source = InMemoryBarSource(
        spec_for_tests(), {TF: bars}, expand_to_m1(bars, TF)
    )
    return config, bars, source


def _strategy_series(config, bars) -> list[dict]:
    strategy = NBarBreakout.from_config(config)
    spec = spec_for_tests()
    out = []
    for i in range(strategy.min_bars - 1, len(bars)):
        result = strategy.evaluate(bars[: i + 1], spec)
        out.append(
            {
                "bar_index": i,
                "bar_time": bars[i].time.isoformat(),
                "fired": result.fired,
                "direction": result.direction.value,
                "score": result.score,
                "evidence": result.evidence,
            }
        )
    return out


def _run_dict(config, bars, source) -> dict:
    result = ReplayEngine(config, source).run(
        NBarBreakout.from_config(config),
        RunSpec(
            symbol=TEST_SYMBOL,
            timeframe=TF,
            start=bars[0].time,
            end=bar_close_time(bars[-1].time, TF),
        ),
    )
    payload = result.to_dict()
    # `config_version` hashes the temp config directory's contents, which are the
    # repo's files plus the overrides above. It is stable across runs but not
    # worth locking in a golden — a comment added to a YAML file would fail this
    # test for no behavioural reason.
    payload.pop("config_version")
    return payload


def _load(path: Path) -> object:
    if not path.exists():
        pytest.fail(
            f"golden file missing: {path}. Regenerate deliberately with "
            f"`python3 -m tests.golden.test_trivial_golden --regenerate` and "
            f"read the diff before committing."
        )
    return json.loads(path.read_text(encoding="utf-8"))


def test_trivial_strategy_output_matches_golden(tmp_path):
    config, bars, _ = _fixture(tmp_path)
    assert _strategy_series(config, bars) == _load(STRATEGY_GOLDEN)


def test_replayed_run_matches_golden(tmp_path):
    config, bars, source = _fixture(tmp_path)
    assert _run_dict(config, bars, source) == _load(RUN_GOLDEN)


def test_the_golden_run_is_reproducible_within_a_session(tmp_path):
    """Belt and braces on determinism: the golden could in principle have been
    recorded from a run that is not repeatable."""
    config, bars, source = _fixture(tmp_path)
    assert _run_dict(config, bars, source) == _run_dict(config, bars, source)


def test_the_golden_fixture_exercises_both_outcomes(tmp_path):
    """A golden over a fixture that only ever wins locks in nothing about loss
    handling, cost application on a stop, or the R denominator."""
    golden = _load(RUN_GOLDEN)
    reasons = {t["terminal_reason"] for t in golden["trades"]}
    assert {"TARGET", "STOP"} <= reasons


def test_the_golden_run_reports_no_ambiguity(tmp_path):
    """The fixture supplies complete M1 coverage and narrow bars, so every trade
    should resolve on OHLC alone. Any ambiguity here is a resolver bug, not a
    property of the data."""
    config, bars, source = _fixture(tmp_path)
    result = ReplayEngine(config, source).run(
        NBarBreakout.from_config(config),
        RunSpec(
            symbol=TEST_SYMBOL,
            timeframe=TF,
            start=bars[0].time,
            end=bar_close_time(bars[-1].time, TF),
        ),
    )
    report = build_report(result, config)
    assert report.overall.ambiguity_rate == 0.0
    assert report.overall.ambiguous_no_m1 == 0
    assert report.overall.ambiguous_irreducible == 0


def _regenerate() -> None:  # pragma: no cover - operator tool
    import tempfile

    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        config, bars, source = _fixture(Path(tmp))
        STRATEGY_GOLDEN.write_text(
            json.dumps(_strategy_series(config, bars), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        RUN_GOLDEN.write_text(
            json.dumps(_run_dict(config, bars, source), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    print(f"wrote {STRATEGY_GOLDEN}")
    print(f"wrote {RUN_GOLDEN}")


if __name__ == "__main__":  # pragma: no cover - operator tool
    import sys

    if "--regenerate" not in sys.argv:
        raise SystemExit(
            "refusing to overwrite goldens without --regenerate. A golden that "
            "rewrites itself tests nothing."
        )
    _regenerate()
