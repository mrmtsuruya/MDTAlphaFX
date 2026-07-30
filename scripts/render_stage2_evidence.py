"""Render the Stage 2 visual gate from locked evidence only.

This script deliberately does not import the strategy package.  It reads the
recorded M15 candles and the already-saved golden ``StrategyResult.evidence``
geometry, selects the first recorded firing result for each module, and draws
those facts verbatim.  No detector or indicator is executed or recomputed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections.abc import Iterable, Mapping, Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
from matplotlib.axes import Axes
from matplotlib.figure import Figure
from matplotlib.patches import Rectangle

from backend.contracts import Candle, Timeframe  # noqa: E402
from backend.core.timeutil import UTC, timeframe_delta  # noqa: E402
from backend.data.store import ParquetBarStore  # noqa: E402


DEFAULT_GOLDEN_DIR = REPO_ROOT / "tests" / "golden" / "data" / "stage2"
DEFAULT_FIXTURE_ROOT = REPO_ROOT / "fixtures"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "docs" / "stage2-gate"
PERIODS = ("trending", "ranging", "high_volatility")
IMAGE_METADATA = {"Software": "MDTAlphaFX Stage 2 Evidence Renderer"}
GEOMETRY_COLOURS = (
    "#22d3ee",
    "#facc15",
    "#c084fc",
    "#fb7185",
    "#60a5fa",
    "#a3e635",
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Render Stage 2 charts from recorded goldens without detectors."
    )
    parser.add_argument("--golden-dir", type=Path, default=DEFAULT_GOLDEN_DIR)
    parser.add_argument("--fixture-root", type=Path, default=DEFAULT_FIXTURE_ROOT)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--bars-before", type=int, default=40)
    parser.add_argument("--bars-after", type=int, default=12)
    return parser


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(UTC)


def _golden_receipt(
    payloads: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Validate one identical approved evaluation receipt before rendering."""

    if len(payloads) != 28:
        raise SystemExit(
            f"golden receipt requires exactly 28 payloads, got {len(payloads)}"
        )

    first_registry: list[Mapping[str, Any]] | None = None
    common_window: int | None = None
    for index, payload in enumerate(payloads):
        policy = payload.get("evaluation_window_policy")
        candidate_window = payload.get("common_window_bars")
        registry = payload.get("registry_min_bars")
        if policy != "COMMON_MAX_MIN_BARS":
            raise SystemExit(
                f"golden payload {index + 1} has invalid evaluation policy {policy!r}"
            )
        if (
            isinstance(candidate_window, bool)
            or not isinstance(candidate_window, int)
            or candidate_window != 203
        ):
            raise SystemExit(
                f"golden payload {index + 1} common_window_bars must be integer 203"
            )
        if not isinstance(registry, list) or len(registry) != 28:
            raise SystemExit(
                f"golden payload {index + 1} registry_min_bars must contain 28 rows"
            )
        if first_registry is None:
            first_registry = registry
            common_window = candidate_window
        elif registry != first_registry:
            raise SystemExit("all golden registry_min_bars receipts must be identical")

    assert first_registry is not None and common_window is not None
    min_bars_values: list[int] = []
    for expected_module_id, entry in enumerate(first_registry, start=1):
        if not isinstance(entry, Mapping):
            raise SystemExit("every registry_min_bars row must be an object")
        module_id = entry.get("module_id")
        min_bars = entry.get("min_bars")
        if (
            isinstance(module_id, bool)
            or not isinstance(module_id, int)
            or module_id != expected_module_id
        ):
            raise SystemExit(
                "registry_min_bars module ids must be the ordered sequence 1..28"
            )
        if (
            isinstance(min_bars, bool)
            or not isinstance(min_bars, int)
            or min_bars < 1
        ):
            raise SystemExit("registry_min_bars values must be positive integers")
        min_bars_values.append(min_bars)
    if max(min_bars_values) != common_window:
        raise SystemExit(
            "common_window_bars must equal the maximum registry min_bars"
        )
    return {
        "evaluation_window_policy": "COMMON_MAX_MIN_BARS",
        "common_window_bars": common_window,
        "registry_min_bars": [dict(entry) for entry in first_registry],
    }


def _geometry_times(value: Any) -> Iterable[datetime]:
    if isinstance(value, Mapping):
        for key, item in value.items():
            if key in {
                "time",
                "start_time",
                "end_time",
                "formation_time",
                "through_time",
                "start",
                "end",
            }:
                parsed = _parse_time(item)
                if parsed is not None:
                    yield parsed
            yield from _geometry_times(item)
    elif isinstance(value, list):
        for item in value:
            yield from _geometry_times(item)


def _first_fired(payload: Mapping[str, Any]) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    for period in payload["periods"]:
        if period["period"] not in PERIODS:
            raise ValueError(f"unapproved recorded period: {period['period']!r}")
        for evaluation in period["evaluations"]:
            if evaluation["result"]["fired"]:
                return period, evaluation
    raise ValueError(f"module {payload['module_id']} has no recorded firing result")


def _load_period_bars(
    fixture_root: Path, period: str, symbol: str
) -> tuple[list[Candle], Path]:
    store_root = fixture_root / period
    store = ParquetBarStore(store_root, m1_reference_timeframe=Timeframe.M5)
    coverage = store.coverage(symbol, Timeframe.M15)
    if coverage is None:
        raise ValueError(f"{period}/{symbol}: no recorded M15 coverage")
    start, last_open = coverage
    bars = store.bars(
        symbol,
        Timeframe.M15,
        start,
        last_open + timeframe_delta(Timeframe.M15),
    )
    if not bars:
        raise ValueError(f"{period}/{symbol}: recorded M15 store returned no bars")
    return bars, store_root


def _time_to_x(moment: datetime, bars: Sequence[Candle]) -> float:
    origin = bars[0].time.astimezone(UTC)
    return (moment - origin).total_seconds() / timeframe_delta(
        Timeframe.M15
    ).total_seconds()


def _numeric(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _geometry_label(geometry: Mapping[str, Any]) -> str:
    return str(
        geometry.get("kind")
        or geometry.get("role")
        or geometry.get("session")
        or geometry.get("type")
        or "evidence"
    )


def _draw_geometry(
    ax: Axes,
    geometry: Mapping[str, Any],
    bars: Sequence[Candle],
    colour: str,
) -> None:
    """Draw one evidence object by coordinate shape, not detector identity."""

    label = _geometry_label(geometry)
    points = geometry.get("points")
    if isinstance(points, list):
        coordinates: list[tuple[float, float]] = []
        for point in points:
            if not isinstance(point, Mapping):
                continue
            moment = _parse_time(point.get("time"))
            level = _numeric(point.get("price"))
            if moment is not None and level is not None:
                coordinates.append((_time_to_x(moment, bars), level))
        if coordinates:
            xs, ys = zip(*coordinates)
            ax.plot(xs, ys, color=colour, linewidth=1.8, marker="o", markersize=4)
            ax.annotate(
                label,
                xy=coordinates[-1],
                xytext=(4, 4),
                textcoords="offset points",
                color=colour,
                fontsize=7,
            )
        return

    time_value = _parse_time(geometry.get("time"))
    start = _parse_time(geometry.get("start_time")) or _parse_time(
        geometry.get("start")
    )
    end = _parse_time(geometry.get("end_time")) or _parse_time(geometry.get("end"))
    low = _numeric(geometry.get("min"))
    high = _numeric(geometry.get("max"))
    if low is None:
        low = _numeric(geometry.get("low"))
    if high is None:
        high = _numeric(geometry.get("high"))

    if start is not None and end is not None and low is not None and high is not None:
        x1 = _time_to_x(start, bars)
        x2 = _time_to_x(end, bars)
        ax.add_patch(
            Rectangle(
                (min(x1, x2), min(low, high)),
                max(abs(x2 - x1), 0.25),
                abs(high - low),
                facecolor=colour,
                edgecolor=colour,
                linewidth=1.2,
                alpha=0.16,
            )
        )
        ax.text(min(x1, x2), max(low, high), label, color=colour, fontsize=7)
        return

    price_level = _numeric(geometry.get("price"))
    if start is not None and end is not None and price_level is not None:
        x1 = _time_to_x(start, bars)
        x2 = _time_to_x(end, bars)
        ax.plot([x1, x2], [price_level, price_level], color=colour, linewidth=1.6)
        ax.text(min(x1, x2), price_level, label, color=colour, fontsize=7)
        return

    if time_value is not None and low is not None and high is not None:
        x = _time_to_x(time_value, bars)
        ax.vlines(x, low, high, color=colour, linewidth=4.0, alpha=0.8)
        ax.scatter([x], [(low + high) / 2.0], color=colour, s=18, zorder=6)
        ax.annotate(
            label,
            xy=(x, max(low, high)),
            xytext=(4, 4),
            textcoords="offset points",
            color=colour,
            fontsize=7,
        )
        return

    if time_value is not None and price_level is not None:
        x = _time_to_x(time_value, bars)
        ax.scatter([x], [price_level], color=colour, s=36, marker="D", zorder=7)
        ax.annotate(
            label,
            xy=(x, price_level),
            xytext=(4, 4),
            textcoords="offset points",
            color=colour,
            fontsize=7,
        )
        return

    if time_value is not None:
        levels = [
            (key, _numeric(geometry.get(key)))
            for key in ("band", "level", "center", "vwap", "close", "extreme")
        ]
        levels = [(key, value) for key, value in levels if value is not None]
        if levels:
            x = _time_to_x(time_value, bars)
            for offset, (key, value) in enumerate(levels):
                assert value is not None
                marker = "D" if key in {"close", "extreme"} else "o"
                ax.scatter(
                    [x + offset * 0.06],
                    [value],
                    color=colour,
                    s=30,
                    marker=marker,
                    zorder=7,
                )
                ax.annotate(
                    key,
                    xy=(x, value),
                    xytext=(4, 2),
                    textcoords="offset points",
                    color=colour,
                    fontsize=6,
                )
            return

    if start is not None and end is not None:
        ax.axvspan(
            _time_to_x(start, bars),
            _time_to_x(end, bars),
            color=colour,
            alpha=0.08,
        )
        ax.text(
            (_time_to_x(start, bars) + _time_to_x(end, bars)) / 2.0,
            0.98,
            label,
            transform=ax.get_xaxis_transform(),
            ha="center",
            va="top",
            color=colour,
            fontsize=7,
        )


def _draw_candles(
    ax: Axes, bars: Sequence[Candle], start_index: int, end_index: int
) -> None:
    for index in range(start_index, end_index + 1):
        bar = bars[index]
        rising = bar.close >= bar.open
        colour = "#34d399" if rising else "#fb7185"
        ax.vlines(index, bar.low, bar.high, color=colour, linewidth=0.8, alpha=0.9)
        body_low = min(bar.open, bar.close)
        body_height = abs(bar.close - bar.open)
        if body_height == 0.0:
            ax.hlines(bar.close, index - 0.28, index + 0.28, color=colour, linewidth=1.2)
        else:
            ax.add_patch(
                Rectangle(
                    (index - 0.28, body_low),
                    0.56,
                    body_height,
                    facecolor=colour,
                    edgecolor=colour,
                    linewidth=0.6,
                    alpha=0.9,
                )
            )


def _configure_axes(
    ax: Axes,
    bars: Sequence[Candle],
    start_index: int,
    end_index: int,
    event_index: int,
) -> None:
    ax.set_facecolor("#0b0f14")
    ax.grid(True, color="#27313d", linewidth=0.5, alpha=0.6)
    ax.tick_params(colors="#94a3b8", labelsize=8)
    for spine in ax.spines.values():
        spine.set_color("#334155")
    ax.axvline(event_index, color="#f8fafc", linewidth=0.8, linestyle="--", alpha=0.7)
    ax.set_xlim(start_index - 0.8, end_index + 0.8)
    tick_step = max(1, (end_index - start_index + 1) // 6)
    ticks = list(range(start_index, end_index + 1, tick_step))
    ax.set_xticks(ticks)
    ax.set_xticklabels(
        [bars[index].time.strftime("%m-%d\n%H:%M") for index in ticks],
        color="#94a3b8",
    )
    ax.set_ylabel("Price", color="#94a3b8", fontsize=8)


def _save_figure(fig: Figure, path: Path) -> None:
    fig.savefig(
        path,
        dpi=120,
        facecolor=fig.get_facecolor(),
        bbox_inches=None,
        metadata=IMAGE_METADATA,
    )
    plt.close(fig)


def _render_module(
    *,
    payload: Mapping[str, Any],
    golden_path: Path,
    fixture_root: Path,
    visuals_dir: Path,
    bars_before: int,
    bars_after: int,
) -> dict[str, Any]:
    period, evaluation = _first_fired(payload)
    result = evaluation["result"]
    evidence = result["evidence"]
    geometry = evidence.get("geometry")
    if not isinstance(geometry, list) or not geometry:
        raise ValueError(f"{golden_path.name}: firing result has no saved geometry")

    bars, store_root = _load_period_bars(
        fixture_root, str(period["period"]), str(period["symbol"])
    )
    event_index = int(evaluation["bar_index"])
    if not 0 <= event_index < len(bars):
        raise ValueError(f"{golden_path.name}: bar index is outside recorded fixture")
    if bars[event_index].time.isoformat() != evaluation["bar_time"]:
        raise ValueError(
            f"{golden_path.name}: golden event time does not match recorded bar"
        )

    geometry_moments = list(_geometry_times(geometry))
    geometry_indices = [
        int(round(_time_to_x(moment, bars))) for moment in geometry_moments
    ]
    earliest_geometry = min(geometry_indices, default=event_index)
    latest_geometry = max(geometry_indices, default=event_index)
    start_index = max(0, min(event_index - bars_before, earliest_geometry - 3))
    end_index = min(
        len(bars) - 1, max(event_index + bars_after, latest_geometry + 3)
    )

    plt.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "font.size": 9,
            "axes.unicode_minus": False,
            "path.simplify": False,
        }
    )
    fig, ax = plt.subplots(figsize=(12, 6))
    fig.set_facecolor("#070a0f")
    _draw_candles(ax, bars, start_index, end_index)
    for index, item in enumerate(geometry):
        if not isinstance(item, Mapping):
            raise ValueError(f"{golden_path.name}: geometry item is not an object")
        _draw_geometry(ax, item, bars, GEOMETRY_COLOURS[index % len(GEOMETRY_COLOURS)])
    _configure_axes(ax, bars, start_index, end_index, event_index)

    direction = str(result["direction"])
    glyph = "▲" if direction == "BUY" else "▼"
    ax.set_title(
        f"M{int(payload['module_id']):02d} · {payload['module_name']} · "
        f"{glyph} {direction} · score {float(result['score']):.0f}",
        loc="left",
        color="#f8fafc",
        fontsize=12,
        pad=12,
    )
    ax.text(
        0.0,
        1.01,
        f"{period['period']} · {period['symbol']} · M15 · "
        f"{evaluation['bar_time']} · saved geometry only",
        transform=ax.transAxes,
        color="#94a3b8",
        fontsize=8,
        va="bottom",
    )
    fig.tight_layout(pad=1.2)

    image_path = visuals_dir / f"m{int(payload['module_id']):02d}.png"
    _save_figure(fig, image_path)
    return {
        "module_id": int(payload["module_id"]),
        "module_name": str(payload["module_name"]),
        "period": str(period["period"]),
        "symbol": str(period["symbol"]),
        "timeframe": str(payload["timeframe"]),
        "recorded_positive": True,
        "event_time": str(evaluation["bar_time"]),
        "bar_index": event_index,
        "direction": direction,
        "score": float(result["score"]),
        "golden_path": golden_path.relative_to(REPO_ROOT).as_posix(),
        "golden_sha256": _sha256(golden_path),
        "fixture_store": store_root.relative_to(REPO_ROOT).as_posix(),
        "image_path": image_path.relative_to(REPO_ROOT).as_posix(),
        "image_sha256": _sha256(image_path),
        "geometry_objects": len(geometry),
    }


def _contact_sheet(entries: Sequence[Mapping[str, Any]], output_dir: Path) -> Path:
    rows, columns = 7, 4
    fig, axes = plt.subplots(rows, columns, figsize=(16, 19.6))
    fig.set_facecolor("#070a0f")
    for ax, entry in zip(axes.flat, entries):
        image_path = REPO_ROOT / str(entry["image_path"])
        ax.imshow(plt.imread(image_path))
        ax.set_title(
            f"M{int(entry['module_id']):02d} · {entry['direction']} · "
            f"{float(entry['score']):.0f}",
            color="#f8fafc",
            fontsize=8,
            loc="left",
            pad=3,
        )
        ax.axis("off")
    fig.suptitle(
        "MDTAlphaFX Stage 2 · Recorded visual evidence · 28/28",
        color="#f8fafc",
        fontsize=16,
        x=0.02,
        ha="left",
    )
    fig.subplots_adjust(
        left=0.015,
        right=0.985,
        top=0.975,
        bottom=0.01,
        wspace=0.025,
        hspace=0.08,
    )
    path = output_dir / "contact-sheet.png"
    _save_figure(fig, path)
    return path


def _render_markdown(manifest: Mapping[str, Any]) -> str:
    lines = [
        "# Stage 2 visual evidence manifest",
        "",
        "Status: **PASS — 28/28 recorded-positive module charts rendered**",
        "",
        "The renderer consumed locked golden results and recorded M15 candles. "
        "It did not import, execute, or recompute any detector or indicator.",
        "",
        f"Evaluation window: `{manifest['evaluation_window_policy']}`  ",
        f"Common window bars: `{manifest['common_window_bars']}`  ",
        "Registry min_bars receipt: `"
        + ", ".join(
            f"M{row['module_id']:02d}={row['min_bars']}"
            for row in manifest["registry_min_bars"]
        )
        + "`",
        "",
        f"Contact sheet: `{manifest['contact_sheet']['path']}`  ",
        f"SHA-256: `{manifest['contact_sheet']['sha256']}`",
        "",
        "| Module | Source | Event | Result | Golden SHA-256 | Image SHA-256 |",
        "|---|---|---|---|---|---|",
    ]
    for entry in manifest["modules"]:
        lines.append(
            f"| M{entry['module_id']:02d} {entry['module_name']} | "
            f"{entry['period']} · {entry['symbol']} · {entry['timeframe']} | "
            f"`{entry['event_time']}` | {entry['direction']} · {entry['score']:.0f} | "
            f"`{entry['golden_sha256']}` | `{entry['image_sha256']}` |"
        )
    lines.extend(
        [
            "",
            "Each chart shows raw recorded candles, a dashed event-bar marker, and "
            "only the typed coordinates already present in `evidence.geometry`.",
            "",
        ]
    )
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.bars_before < 1 or args.bars_after < 1:
        raise SystemExit("--bars-before and --bars-after must be positive")
    golden_dir = args.golden_dir.resolve()
    fixture_root = args.fixture_root.resolve()
    output_dir = args.output_dir.resolve()
    golden_paths = sorted(golden_dir.glob("m[0-2][0-9].json"))
    expected = [f"m{module_id:02d}.json" for module_id in range(1, 29)]
    if [path.name for path in golden_paths] != expected:
        raise SystemExit(
            "golden set must be exactly m01.json through m28.json; got "
            f"{[path.name for path in golden_paths]}"
        )

    payloads = [
        json.loads(path.read_text(encoding="utf-8")) for path in golden_paths
    ]
    receipt = _golden_receipt(payloads)

    visuals_dir = output_dir / "visuals"
    visuals_dir.mkdir(parents=True, exist_ok=True)

    entries: list[dict[str, Any]] = []
    for golden_path, payload in zip(golden_paths, payloads, strict=True):
        entries.append(
            _render_module(
                payload=payload,
                golden_path=golden_path,
                fixture_root=fixture_root,
                visuals_dir=visuals_dir,
                bars_before=args.bars_before,
                bars_after=args.bars_after,
            )
        )
        print(
            f"M{entries[-1]['module_id']:02d}: "
            f"{entries[-1]['period']} {entries[-1]['symbol']} "
            f"{entries[-1]['event_time']} -> {entries[-1]['image_path']}"
        )

    if len(entries) != 28 or {entry["module_id"] for entry in entries} != set(
        range(1, 29)
    ):
        raise SystemExit("visual gate requires exactly one entry for every module 1..28")

    contact_sheet = _contact_sheet(entries, output_dir)
    manifest = {
        "schema_version": 1,
        "status": "PASS",
        "evidence_mode": "LOCKED_GOLDENS_PLUS_RECORDED_CANDLES_ONLY",
        "detectors_executed": False,
        **receipt,
        "modules_rendered": len(entries),
        "modules": entries,
        "contact_sheet": {
            "path": contact_sheet.relative_to(REPO_ROOT).as_posix(),
            "sha256": _sha256(contact_sheet),
        },
    }
    manifest_path = output_dir / "visual-manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    markdown_path = output_dir / "visual-manifest.md"
    markdown_path.write_text(_render_markdown(manifest), encoding="utf-8")
    print(f"Manifest: {manifest_path}")
    print(f"Markdown: {markdown_path}")
    print(f"Contact sheet: {contact_sheet}")
    print("Status: PASS — 28/28 recorded-positive visual evidence charts rendered")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
