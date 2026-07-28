"""§5.5 Level derivation — entry zone, stop, targets.

**Ordering matters and is easy to get wrong:**

    AWAITING_VALIDATION  ->  derive levels (PROVISIONAL, may be recomputed each bar)
                         ->  run validity gate, INCLUDING POOR_RR
           LOCKED        ->  freeze. Nothing recomputes them. §6.1 rule 1.

Levels are provisional at `AWAITING_VALIDATION` precisely because §5.3's
validity gate includes `POOR_RR`, which cannot be evaluated before a target
exists. Computing them at lock — as an earlier draft of §5.5 said — makes the
validity gate reference values that do not yet exist.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ..contracts import Direction, ExitPlan, SymbolSpec, Timeframe


@dataclass(frozen=True)
class Swing:
    """The structure a stop anchors beyond. `label` feeds `sl_basis`."""

    high: float
    low: float
    label: str


@dataclass(frozen=True)
class OpposingStructure:
    """A typed price structure that can support an inward target snap."""

    price: float
    kind: str
    source_timeframe: Timeframe
    stable_id: str


@dataclass(frozen=True)
class ProvisionalLevels:
    """Derived at AWAITING_VALIDATION. **Not yet frozen.**

    Named `Provisional` rather than `Levels` so that a caller freezing them at
    the wrong lifecycle point reads as obviously wrong at the call site.
    """

    entry_zone: dict  # {"min": float, "max": float}
    exit_plan: ExitPlan
    sl_basis: str
    r_distance: float
    rr_after_snap: float
    poor_rr: bool


def _configured(config: Mapping[str, Any], section: str, key: str) -> Any:
    """Read the YAML-shaped config, with the test-double's flat alias fallback."""

    nested = config.get(section)
    if isinstance(nested, Mapping) and key in nested:
        return nested[key]
    if key in config:
        return config[key]
    raise KeyError(f"missing levels config value {section}.{key}")


def _number(value: Any, name: str, *, allow_zero: bool = True) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{name} must be a number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite")
    if result < 0 or (not allow_zero and result == 0):
        qualifier = "non-negative" if allow_zero else "positive"
        raise ValueError(f"{name} must be {qualifier}")
    return result


def _positive_atr(atr: float) -> float:
    return _number(atr, "atr", allow_zero=False)


def _trade_direction(direction: Direction) -> Direction:
    if direction not in (Direction.BUY, Direction.SELL):
        raise ValueError("level derivation requires BUY or SELL direction")
    return direction


def _zone_coordinates(evidence: Mapping[str, Any]) -> tuple[float, float]:
    """Extract the frozen entry-zone shape, accepting its documented aliases."""

    for low_key, high_key in (
        ("min", "max"),
        ("zone_min", "zone_max"),
        ("low", "high"),
    ):
        if low_key in evidence and high_key in evidence:
            low = _number(evidence[low_key], f"evidence.{low_key}")
            high = _number(evidence[high_key], f"evidence.{high_key}")
            if low > high:
                raise ValueError(
                    f"entry-zone minimum {low!r} exceeds maximum {high!r}"
                )
            return low, high
    raise KeyError(
        "leading-contributor evidence must contain min/max, "
        "zone_min/zone_max, or low/high"
    )


def _zone(zone: Mapping[str, Any]) -> tuple[float, float]:
    if "min" not in zone or "max" not in zone:
        raise KeyError("entry zone must contain min and max")
    low = _number(zone["min"], "zone.min")
    high = _number(zone["max"], "zone.max")
    if low > high:
        raise ValueError(f"entry-zone minimum {low!r} exceeds maximum {high!r}")
    return low, high


def _normalise_price(price: float, spec: SymbolSpec) -> float:
    if isinstance(spec.digits, bool) or spec.digits < 0:
        raise ValueError("SymbolSpec.digits must be a non-negative integer")
    return round(price, spec.digits)


def derive_entry_zone(
    evidence: dict, atr: float, spec: SymbolSpec, config: dict
) -> dict:
    """§5.5 — the LEADING CONTRIBUTOR's own structure defines the zone.

    An order block's body, an FVG's gap, a sweep's rejection wick. Each module
    returns those coordinates in `StrategyResult.evidence`; the zone is that
    range, widened to a minimum of `min_zone_atr` × ATR(14) so a hairline zone
    is not unfillable.

    The approved geometry widens symmetrically about the original midpoint.
    Wide structures are returned unchanged.
    """
    del spec  # The structural zone is price geometry, not a broker constraint.

    atr_value = _positive_atr(atr)
    low, high = _zone_coordinates(evidence)
    minimum_width = atr_value * _number(
        _configured(config, "zone", "min_zone_atr"),
        "levels.zone.min_zone_atr",
    )
    if high - low >= minimum_width:
        return {"min": low, "max": high}

    midpoint = (low + high) / 2
    half_width = minimum_width / 2
    return {"min": midpoint - half_width, "max": midpoint + half_width}


def derive_stop(
    direction: Direction,
    zone: dict,
    swing: Swing,
    atr: float,
    spec: SymbolSpec,
    config: dict,
) -> tuple[float, str]:
    """§5.5 — structure first, volatility as the floor. Four steps, in order.

    1. Anchor beyond the structure the setup depends on.
    2. Buffer past it by `sl_buffer_atr` × ATR, so a wick through is not a stop-out.
    3. Floor: never tighter than `min_sl_atr` × ATR from the zone edge.
    4. Broker floor (§7.3 `stops_level`). **Widen, never tighten.**

    Returns `(stop, sl_basis)`. `sl_basis` carries a human sentence to the UI —
    "1.06 ATR below swing low" — "because a stop the user cannot explain is a
    stop they will move."

    `stops_level` comes from `SymbolSpec`, resolved per §7.1. Never assumed.
    """
    side = _trade_direction(direction)
    atr_value = _positive_atr(atr)
    zone_min, zone_max = _zone(zone)
    anchor = _number(
        swing.low if side is Direction.BUY else swing.high,
        "swing anchor",
    )
    buffer_distance = atr_value * _number(
        _configured(config, "stop", "sl_buffer_atr"),
        "levels.stop.sl_buffer_atr",
    )
    minimum_atr_distance = atr_value * _number(
        _configured(config, "stop", "min_sl_atr"),
        "levels.stop.min_sl_atr",
    )
    point = _number(spec.point, "SymbolSpec.point", allow_zero=False)
    stops_level = _number(spec.stops_level, "SymbolSpec.stops_level")
    minimum_broker_distance = point * stops_level

    if side is Direction.BUY:
        edge = zone_min
        structural_stop = anchor - buffer_distance
        stop = min(
            structural_stop,
            edge - minimum_atr_distance,
            edge - minimum_broker_distance,
        )
    else:
        edge = zone_max
        structural_stop = anchor + buffer_distance
        stop = max(
            structural_stop,
            edge + minimum_atr_distance,
            edge + minimum_broker_distance,
        )

    stop = _normalise_price(stop, spec)

    # Rounding to quote precision must not undo either widening floor.
    required_distance = max(minimum_atr_distance, minimum_broker_distance)
    if abs(edge - stop) < required_distance:
        quote_unit = 10.0 ** -spec.digits
        stop = _normalise_price(
            stop - quote_unit if side is Direction.BUY else stop + quote_unit,
            spec,
        )

    realised_atr = abs(edge - stop) / atr_value
    basis = f"{realised_atr:.2f} ATR beyond {swing.label}"
    return stop, basis


def _opposing_structures(
    opposing_levels: Sequence[float | OpposingStructure],
    direction: Direction,
    entry_mid: float,
) -> list[OpposingStructure]:
    """Return distinct structures, nearest-first from the entry.

    Bare prices remain accepted for Stage 0 fixture compatibility. They receive
    deterministic legacy identities and duplicate prices collapse.
    """

    structures: dict[str, OpposingStructure] = {}
    for index, value in enumerate(opposing_levels):
        if isinstance(value, OpposingStructure):
            price = _number(value.price, f"opposing_levels[{index}].price")
            if not value.kind.strip():
                raise ValueError(f"opposing_levels[{index}].kind must not be empty")
            if not value.stable_id.strip():
                raise ValueError(
                    f"opposing_levels[{index}].stable_id must not be empty"
                )
            structure = OpposingStructure(
                price=price,
                kind=value.kind,
                source_timeframe=value.source_timeframe,
                stable_id=value.stable_id,
            )
        else:
            price = _number(value, f"opposing_levels[{index}]")
            structure = OpposingStructure(
                price=price,
                kind="LEGACY_PRICE",
                source_timeframe=Timeframe.M1,
                stable_id=f"legacy-price:{price!r}",
            )
        if direction is Direction.BUY and price > entry_mid:
            structures.setdefault(structure.stable_id, structure)
        elif direction is Direction.SELL and price < entry_mid:
            structures.setdefault(structure.stable_id, structure)
    return sorted(
        structures.values(),
        key=lambda structure: structure.price,
        reverse=direction is Direction.SELL,
    )


def _inside_structure(
    price: float,
    direction: Direction,
    spec: SymbolSpec,
) -> float:
    """Move one broker tick toward the entry side of an opposing structure."""

    tick = _number(spec.tick_size, "SymbolSpec.tick_size", allow_zero=False)
    inside = price - tick if direction is Direction.BUY else price + tick
    return _normalise_price(inside, spec)


def _snap_target_inward(
    raw_target: float,
    direction: Direction,
    entry_mid: float,
    opposing_structures: Sequence[OpposingStructure],
    snap_distance: float,
    spec: SymbolSpec,
    *,
    beyond: float | None = None,
) -> tuple[float, OpposingStructure | None]:
    """Snap to the closest eligible structure to the raw target, inward only."""

    candidates: list[tuple[float, float, OpposingStructure]] = []
    for structure in opposing_structures:
        price = structure.price
        distance = abs(raw_target - price)
        if distance > snap_distance:
            continue

        if direction is Direction.BUY:
            if price > raw_target:
                continue
            snapped = _inside_structure(price, direction, spec)
            lower_bound = entry_mid if beyond is None else beyond
            if not lower_bound < snapped <= raw_target:
                continue
        else:
            if price < raw_target:
                continue
            snapped = _inside_structure(price, direction, spec)
            upper_bound = entry_mid if beyond is None else beyond
            if not raw_target <= snapped < upper_bound:
                continue

        candidates.append((distance, snapped, structure))

    if not candidates:
        return raw_target, None
    _, snapped, structure = min(candidates, key=lambda candidate: candidate[0])
    return snapped, structure


def derive_targets(
    direction: Direction,
    entry_mid: float,
    stop: float,
    opposing_levels: Sequence[float | OpposingStructure],
    atr: float,
    spec: SymbolSpec,
    config: dict,
) -> tuple[float, float | None, float]:
    """§5.5 — R-multiples off the REALISED stop distance, then snapped.

    - `R = |entry_mid − stop_loss|`
    - TP1 = entry ± `tp1_r` × R
    - TP2 = entry ± `tp2_r` × R, `None` if no structure supports it
    - Each target is pulled back to just inside the nearest opposing level
      (prior swing, unfilled FVG, session high/low) within `snap_atr` × ATR.
      **Never pushed out — snapping may only reduce the target.**

    Returns `(tp1, tp2, rr_after_snap)`.
    """
    side = _trade_direction(direction)
    entry = _number(entry_mid, "entry_mid")
    stop_price = _number(stop, "stop")
    atr_value = _positive_atr(atr)
    r_distance = abs(entry - stop_price)
    if r_distance == 0:
        raise ValueError("entry_mid and stop must define a positive R distance")
    if side is Direction.BUY and stop_price >= entry:
        raise ValueError("a BUY stop must be below entry_mid")
    if side is Direction.SELL and stop_price <= entry:
        raise ValueError("a SELL stop must be above entry_mid")

    tp1_r = _number(
        _configured(config, "targets", "tp1_r"),
        "levels.targets.tp1_r",
        allow_zero=False,
    )
    tp2_r = _number(
        _configured(config, "targets", "tp2_r"),
        "levels.targets.tp2_r",
        allow_zero=False,
    )
    snap_distance = atr_value * _number(
        _configured(config, "targets", "snap_atr"),
        "levels.targets.snap_atr",
    )
    sign = 1 if side is Direction.BUY else -1
    raw_tp1 = _normalise_price(entry + sign * tp1_r * r_distance, spec)
    raw_tp2 = _normalise_price(entry + sign * tp2_r * r_distance, spec)
    structures = _opposing_structures(opposing_levels, side, entry)

    tp1, tp1_structure = _snap_target_inward(
        raw_tp1,
        side,
        entry,
        structures,
        snap_distance,
        spec,
    )

    # The approved profile requires a second, distinct structure beyond TP1.
    # With the current list[float] API, distinct price is the only identity
    # available; typed stable identifiers cannot be represented here.
    tp2: float | None = None
    if len(structures) >= 2:
        structures_beyond_tp1 = [
            structure
            for structure in structures
            if (
                tp1_structure is None
                or structure.stable_id != tp1_structure.stable_id
            )
            and (
                structure.price > tp1
                if side is Direction.BUY
                else structure.price < tp1
            )
        ]
        if structures_beyond_tp1:
            tp2, _ = _snap_target_inward(
                raw_tp2,
                side,
                entry,
                structures_beyond_tp1,
                snap_distance,
                spec,
                beyond=tp1,
            )

    rr_after_snap = abs(tp1 - entry) / r_distance
    return tp1, tp2, rr_after_snap


def check_poor_rr(rr_after_snap: float, config: dict) -> bool:
    """§5.5 rejection — TP1 AFTER SNAPPING below `min_rr` fails validity.

    "A correct read of the chart with no room to the next level is not a trade."

    Evaluated at AWAITING_VALIDATION, before lock — which is the whole reason
    levels are provisional at that state.
    """
    rr = _number(rr_after_snap, "rr_after_snap")
    minimum = _number(
        _configured(config, "rejection", "min_rr"),
        "levels.rejection.min_rr",
    )
    return rr < minimum


__all__ = [
    "Swing",
    "OpposingStructure",
    "ProvisionalLevels",
    "derive_entry_zone",
    "derive_stop",
    "derive_targets",
    "check_poor_rr",
]
