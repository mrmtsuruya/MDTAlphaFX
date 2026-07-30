"""Recorded-fixture goldens for all 28 Stage 2 modules.

Regeneration is deliberately explicit:

    python -m tests.stage2.test_recorded_goldens --regenerate

Review the generated files and visual overlays before accepting a detector
change. A failing test never rewrites its own expected output.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import pytest

from backend.analysis.stage2_proposal import common_window_bars
from backend.contracts import Timeframe
from backend.core.config import Config
from backend.core.timeutil import ensure_utc
from backend.data.store import ParquetBarStore
from backend.strategies import build_strategy_registry
from backend.strategies.configuration import EVALUATION_WINDOW_POLICY


REPO_ROOT = Path(__file__).resolve().parents[2]
GOLDEN_ROOT = REPO_ROOT / "tests" / "golden" / "data" / "stage2"
TIMEFRAME = Timeframe.M15


def _parse_utc(raw: str) -> datetime:
    text = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    return ensure_utc(datetime.fromisoformat(text))


def _fixtures_root(config: Config) -> Path:
    value = Path(config.get("engine.paths.fixtures"))
    return value if value.is_absolute() else (REPO_ROOT / value).resolve()


def _recorded_payloads(config: Config) -> dict[int, dict]:
    strategies = build_strategy_registry(config)
    common = common_window_bars(strategies)
    registry_min_bars = [
        {"module_id": strategy.module_id, "min_bars": strategy.min_bars}
        for strategy in strategies
    ]
    payloads = {
        strategy.module_id: {
            "module_id": strategy.module_id,
            "module_name": strategy.module_name,
            "cluster_id": strategy.cluster_id,
            "min_bars": strategy.min_bars,
            "timeframe": TIMEFRAME.value,
            "evaluation_window_policy": EVALUATION_WINDOW_POLICY,
            "common_window_bars": common,
            "registry_min_bars": registry_min_bars,
            "periods": [],
        }
        for strategy in strategies
    }
    periods = config.section("backtest.fixtures.periods")
    for period_name, raw_period in periods.items():
        start = _parse_utc(str(raw_period["start"]))
        end = _parse_utc(str(raw_period["end"]))
        store = ParquetBarStore.from_config(
            config, root=_fixtures_root(config) / period_name
        )
        symbols = tuple(str(value) for value in raw_period["symbols"])
        for symbol in symbols:
            record = store.symbol_record(symbol)
            bars = store.bars(record.resolved_name, TIMEFRAME, start, end)
            if not bars:
                raise AssertionError(
                    f"recorded fixture {period_name}/{symbol}/{TIMEFRAME.value} is empty"
                )
            if len(bars) < common:
                raise AssertionError(
                    f"recorded fixture {period_name}/{symbol} has fewer than "
                    f"{common} common-window bars"
                )
            for strategy in strategies:
                evaluations = []
                for index in range(common - 1, len(bars)):
                    window = list(bars[index + 1 - common : index + 1])
                    result = strategy.evaluate(window, record.spec)
                    evaluations.append(
                        {
                            "bar_index": index,
                            "bar_time": bars[index].time.isoformat(),
                            "result": result.model_dump(mode="json"),
                        }
                    )
                payloads[strategy.module_id]["periods"].append(
                    {
                        "period": period_name,
                        "symbol": record.resolved_name,
                        "bars": len(bars),
                        "evaluations": evaluations,
                    }
                )
    for strategy in strategies:
        if not any(
            evaluation["result"]["fired"]
            for period in payloads[strategy.module_id]["periods"]
            for evaluation in period["evaluations"]
        ):
            raise AssertionError(
                f"module {strategy.module_id} has no recorded common-window positive"
            )
    return payloads


def _load(module_id: int) -> dict:
    path = GOLDEN_ROOT / f"m{module_id:02d}.json"
    if not path.is_file():
        pytest.fail(
            f"missing Stage 2 golden {path}; regenerate deliberately and review it"
        )
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def recorded_payloads() -> dict[int, dict]:
    return _recorded_payloads(Config.load(REPO_ROOT / "config"))


@pytest.mark.parametrize("module_id", range(1, 29))
def test_module_matches_recorded_fixture_golden(module_id, recorded_payloads):
    assert recorded_payloads[module_id] == _load(module_id)


def test_registry_close_evaluations_are_reproducible_within_a_session():
    config = Config.load(REPO_ROOT / "config")
    period_name, raw_period = next(
        iter(config.section("backtest.fixtures.periods").items())
    )
    start = _parse_utc(str(raw_period["start"]))
    end = _parse_utc(str(raw_period["end"]))
    store = ParquetBarStore.from_config(
        config, root=_fixtures_root(config) / period_name
    )
    record = store.symbol_record(str(raw_period["symbols"][0]))
    bars = store.bars(record.resolved_name, TIMEFRAME, start, end)

    for strategy in build_strategy_registry(config):
        first = strategy.evaluate(bars, record.spec)
        second = strategy.evaluate(bars, record.spec)
        assert first == second


def _regenerate() -> None:
    config = Config.load(REPO_ROOT / "config")
    payloads = _recorded_payloads(config)
    GOLDEN_ROOT.mkdir(parents=True, exist_ok=True)
    for module_id, payload in payloads.items():
        path = GOLDEN_ROOT / f"m{module_id:02d}.json"
        path.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(f"wrote {path}")


if __name__ == "__main__":
    import sys

    if "--regenerate" not in sys.argv:
        raise SystemExit("refusing to rewrite Stage 2 goldens without --regenerate")
    _regenerate()
