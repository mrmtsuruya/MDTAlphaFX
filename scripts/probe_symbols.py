"""Probe the broker for symbol names and specs. **Run this on Windows.**

Answers three questions the operator cannot answer from a spec, and which the
engine refuses to guess:

1. **What is this broker's actual name for each watchlist symbol?** §7.1 says
   the suffix varies (`XAUUSD`, `XAUUSD.m`, `XAUUSDm`). This runs the full
   suffix ladder from `config/symbols.yaml` and reports which one hit.
2. **Which index CFDs exist here?** `symbols.watchlist_pending` is an unresolved
   `<OPERATOR DECISION>` because US30/NAS100 naming is broker-specific. This
   reports which of the common variants the terminal actually exposes, so the
   decision is made against evidence.
3. **What should `max_spread_points` be?** §7.3 requires it, the spec gives no
   default, and Appendix B does not list it. A single instantaneous spread is
   not enough to set a rejection threshold, so this also reports the spread
   distribution over a recent sample — the value has to survive the wide end.

It **prints for a human** and writes a JSON report for the record. It changes no
config. Nothing here is written back into `config/`; the operator reads the
report and edits `symbols.yaml`.

Usage
-----
    python scripts/probe_symbols.py
    python scripts/probe_symbols.py --out data/symbol_probe.json
    python scripts/probe_symbols.py --login 123456 --password ... --server Broker-Demo

With no credentials it attaches to the account already logged into the running
terminal. Rule 5 applies either way: a non-demo account is refused unless
MDTALPHAFX_ALLOW_LIVE_ACCOUNT=1 is deliberately set.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.contracts import Timeframe  # noqa: E402
from backend.core.config import Config  # noqa: E402
from backend.core.errors import MDTAlphaFXError  # noqa: E402
from backend.core.timeutil import utc_now  # noqa: E402
from backend.data.mt5_connector import MT5Connector, ResolvedSymbol  # noqa: E402

DEFAULT_CONFIG_DIR = REPO_ROOT / "config"
DEFAULT_OUTPUT = REPO_ROOT / "data" / "symbol_probe.json"

# Report shaping only.
_RULE = "-" * 78
_PERCENTILES = (50, 90, 95, 99)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Resolve broker symbol names and print the full SymbolSpec."
    )
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_DIR))
    parser.add_argument("--out", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--terminal-path", default=None)
    parser.add_argument("--login", type=int, default=None)
    parser.add_argument("--password", default=None)
    parser.add_argument("--server", default=None)
    parser.add_argument(
        "--spread-sample-bars",
        type=int,
        default=None,
        help="Override symbols.probe.spread_sample_bars for this run.",
    )
    parser.add_argument(
        "--no-spread-sample",
        action="store_true",
        help="Skip the spread distribution. Useful when the market is closed.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    config = Config.load(args.config)

    report: dict[str, Any] = {
        "generated_at_utc": utc_now().isoformat(),
        "config_version": config.version,
        "suffix_candidates": config.get("symbols.suffix_candidates"),
        "account": None,
        "server_clock": None,
        "watchlist": {},
        "index_candidates": {},
        "notes": [],
    }

    connector = MT5Connector(
        config,
        terminal_path=args.terminal_path,
        login=args.login,
        password=args.password,
        server=args.server,
    )

    with connector:
        account = connector.account
        report["account"] = {
            "login": account.login,
            "server": account.server,
            "trade_mode": account.trade_mode,
            "trade_mode_name": account.trade_mode_name,
            "currency": account.currency,
        }
        _print_account(account)

        watchlist = connector.watchlist_from_config()
        index_candidates = list(config.get("symbols.index_probe_candidates"))

        print(f"\nResolving {len(watchlist)} watchlist symbol(s) — §7.1\n{_RULE}")
        watchlist_results = connector.probe_symbol_names(watchlist)

        print(
            f"\nProbing {len(index_candidates)} index-CFD name(s). "
            f"These are NOT added to the watchlist — they settle "
            f"symbols.watchlist_pending.\n{_RULE}"
        )
        index_results = connector.probe_symbol_names(index_candidates)

        # The clock is needed for bar reads. It can legitimately fail with the
        # market closed, which must not cost the operator the spec report.
        clock_error: str | None = None
        try:
            clock = connector.measure_server_clock(
                [r.name for r in watchlist_results.values() if isinstance(r, ResolvedSymbol)]
            )
            report["server_clock"] = {
                "offset_minutes": clock.offset_minutes,
                "hint": clock.server_timezone_hint,
                "measured_at_utc": clock.measured_at.isoformat(),
            }
            print(
                f"\n§10.1 server offset: {clock.offset_minutes:+d} min "
                f"({clock.server_timezone_hint}), measured "
                f"{clock.measured_at.isoformat()}"
            )
        except MDTAlphaFXError as exc:
            clock_error = str(exc)
            report["server_clock"] = {"error": clock_error}
            report["notes"].append(
                "Server offset could not be measured; spread sampling skipped."
            )
            print(f"\n§10.1 server offset UNRESOLVED:\n  {clock_error}")

        sample_bars = args.spread_sample_bars
        if sample_bars is None:
            sample_bars = int(config.get("symbols.probe.spread_sample_bars"))
        sample_tf = Timeframe(config.get("symbols.probe.spread_sample_timeframe"))
        want_sample = not args.no_spread_sample and clock_error is None

        for requested, result in watchlist_results.items():
            entry = _describe(connector, requested, result)
            if want_sample and isinstance(result, ResolvedSymbol):
                entry["spread_sample"] = _sample_spread(
                    connector, result.name, sample_tf, sample_bars
                )
            report["watchlist"][requested] = entry
            _print_symbol(requested, entry)

        for requested, result in index_results.items():
            entry = _describe(connector, requested, result)
            report["index_candidates"][requested] = entry

        _print_index_summary(report["index_candidates"])

    _print_next_steps(report)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(report, indent=2, sort_keys=True, default=str) + "\n",
        encoding="utf-8",
    )
    print(f"\nJSON report written to {out_path}")
    return 0


def _describe(
    connector: MT5Connector, requested: str, result: ResolvedSymbol | str
) -> dict[str, Any]:
    if isinstance(result, str):
        return {"resolved": False, "error": result}
    entry: dict[str, Any] = {
        "resolved": True,
        "requested_name": result.requested_name,
        "broker_name": result.name,
        "tried": list(result.tried),
        "spec": result.spec.model_dump(),
        "swap_long": result.swap_long,
        "swap_short": result.swap_short,
    }
    try:
        entry["current_spread_points"] = connector.current_spread_points(result.name)
    except MDTAlphaFXError as exc:
        entry["current_spread_points"] = None
        entry["current_spread_error"] = str(exc)
    return entry


def _sample_spread(
    connector: MT5Connector, name: str, timeframe: Timeframe, count: int
) -> dict[str, Any]:
    """Recent per-bar spread distribution — the evidence for max_spread_points.

    Reported, never applied. This script sets nothing.
    """
    try:
        bars = connector.bars_from_pos(name, timeframe, count)
    except MDTAlphaFXError as exc:
        return {"error": str(exc)}
    if not bars:
        return {"error": "no bars returned"}

    spreads = sorted(bar.spread for bar in bars)
    summary: dict[str, Any] = {
        "timeframe": timeframe.value,
        "bars": len(spreads),
        "first_bar_utc": bars[0].time.isoformat(),
        "last_bar_utc": bars[-1].time.isoformat(),
        "min": spreads[0],
        "max": spreads[-1],
        "zero_or_negative_bars": sum(1 for value in spreads if value <= 0),
    }
    for percentile in _PERCENTILES:
        summary[f"p{percentile}"] = _percentile(spreads, percentile)
    if summary["zero_or_negative_bars"]:
        summary["warning"] = (
            "This broker reports non-positive spread in its rate array. §11.2 "
            "requires a recorded per-bar spread and the historical store will "
            "refuse to persist these bars. Settle this with the broker before "
            "recording fixtures."
        )
    return summary


def _percentile(sorted_values: list[int], percentile: int) -> int:
    """Nearest-rank percentile. Integral because spread is integral points."""
    if not sorted_values:
        raise ValueError("empty sample")
    rank = max(1, (percentile * len(sorted_values) + 99) // 100)
    return sorted_values[min(rank, len(sorted_values)) - 1]


# ------------------------------------------------------------------ printing


def _print_account(account: Any) -> None:
    print(_RULE)
    print("MDTAlphaFX — symbol probe (§7.1)")
    print(_RULE)
    print(f"  account   : {account.login} @ {account.server}")
    print(f"  trade mode: {account.trade_mode_name}   (rule 5 guard passed)")
    print(f"  currency  : {account.currency}")


def _print_symbol(requested: str, entry: dict[str, Any]) -> None:
    print(f"\n{requested}")
    if not entry.get("resolved"):
        print("  NOT RESOLVED")
        for line in str(entry.get("error", "")).splitlines():
            print(f"    {line}")
        return

    spec = entry["spec"]
    print(f"  broker name    : {entry['broker_name']}")
    print(f"  tried          : {', '.join(entry['tried'])}")
    print("  SymbolSpec (§2, resolved from symbol_info() — never assumed):")
    width = max(len(key) for key in spec)
    for key, value in spec.items():
        print(f"    {key.ljust(width)} : {value}")
    print(f"  swap_long      : {entry['swap_long']}")
    print(f"  swap_short     : {entry['swap_short']}")
    print(f"  spread now     : {entry.get('current_spread_points')} points")

    sample = entry.get("spread_sample")
    if not sample:
        return
    if "error" in sample:
        print(f"  spread sample  : unavailable ({sample['error']})")
        return
    print(
        f"  spread over {sample['bars']} {sample['timeframe']} bars: "
        f"min {sample['min']} · p50 {sample['p50']} · p90 {sample['p90']} · "
        f"p95 {sample['p95']} · p99 {sample['p99']} · max {sample['max']}"
    )
    print(
        f"    -> max_spread_points for {requested} must sit above the normal "
        f"band and below the spike band. p95={sample['p95']}, max={sample['max']}."
    )
    if sample.get("warning"):
        print(f"    !! {sample['warning']}")


def _print_index_summary(index_entries: dict[str, Any]) -> None:
    print(f"\n{_RULE}\nIndex CFD names available on this broker\n{_RULE}")
    found = {
        name: entry for name, entry in index_entries.items() if entry.get("resolved")
    }
    if not found:
        print("  none of the probed variants resolved.")
    for name, entry in found.items():
        spec = entry["spec"]
        print(
            f"  {name:<12} -> {entry['broker_name']:<16} "
            f"digits={spec['digits']} point={spec['point']} "
            f"vol {spec['volume_min']}–{spec['volume_max']} step "
            f"{spec['volume_step']} stops_level={spec['stops_level']}"
        )
    missing = [name for name in index_entries if name not in found]
    if missing:
        print(f"\n  not present: {', '.join(missing)}")


def _print_next_steps(report: dict[str, Any]) -> None:
    print(f"\n{_RULE}\nWhat to do with this\n{_RULE}")
    print(
        "  1. symbols.watchlist_pending — replace <OPERATOR DECISION> with the\n"
        "     exact broker name(s) from the index table above, or delete the key\n"
        "     if you are not trading indices."
    )
    print(
        "  2. symbols.max_spread_points — set one per symbol, in points, from\n"
        "     the distributions above. §7.3 rejects an order when the current\n"
        "     spread exceeds it, so a value under p95 rejects routinely."
    )
    print(
        "  3. costs.commission_per_lot_per_side — NOT in symbol_info(). Read it\n"
        "     off the broker's contract specifications; nothing here can."
    )
    print(
        "  4. costs.swap.rollover_hour_utc / triple_swap_weekday — also not in\n"
        "     symbol_info(). The swap RATES are captured above; the schedule is\n"
        "     a broker policy you have to look up."
    )
    if report.get("server_clock", {}).get("error"):
        print(
            "  5. The server offset did not resolve. Re-run during market hours —\n"
            "     the measurement compares a live quote time against UTC and a\n"
            "     stale weekend quote cannot distinguish offset from staleness."
        )


if __name__ == "__main__":
    raise SystemExit(main())
