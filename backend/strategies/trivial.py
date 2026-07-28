"""Harness scaffolding for the §9 Stage 0 gate. **NOT a strategy module.**

READ THIS BEFORE COUNTING IT AS ANYTHING:

`NBarBreakout` exists for exactly one reason — §9's Stage 0 gate requires that
"a trivial strategy runs end-to-end over history and produces a metrics report."
It is a plumbing test. It is **not** one of the 28 modules enumerated in §4, it
belongs to no pillar and no correlation cluster, it must never appear in a
cluster tally, a breadth denominator or a co-firing matrix, and it must never be
traded. Its `module_id` is **0** precisely so that anything expecting §2's
"1..28" range trips over it rather than silently absorbing it, and its
`cluster_id` is `"NONE"` rather than a letter from §5.1.

It is also, deliberately, not a trading idea. "Close beyond the highest high of
the last N bars" with a fixed point stop and a fixed point target is the
simplest thing that produces both winners and losers over synthetic data. Its
parameters are harness knobs read from `backtest.gate_strategy`, not Appendix B
decisions and not spec values — the spec does not define this strategy, so there
was nothing to look up.

What it *does* demonstrate, and what the 28 modules must also satisfy:

- **Rule 1 — pure function of a bar window.** `evaluate` reads its arguments and
  nothing else. No config read, no file, no network, no clock, no randomness, no
  module-level mutable state. Parameters arrive through `__init__`, which is how
  every Stage 2 module will take its own.
- **Rule 2 — no regime awareness.** Nothing in here asks what the market is
  doing at a higher level. Tier 1 gates modules externally (§3.4); a module that
  checks the regime itself smears Tier 1 across 28 files.
- **Honest `min_bars`.** `lookback + 1` — the lookback window plus the bar whose
  close is compared against it. Under-declaring would let the harness hand it a
  window too short to mean anything, and it would return a confident result
  anyway.
- **Broker values come from `SymbolSpec`.** Stop and target distances are
  configured in *points* and multiplied by `spec.point`; `spec.digits` normalises
  the levels. Nothing about the instrument is assumed.
"""

from __future__ import annotations

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from ..core.config import Config

#: Evidence keys the replay engine reads levels from. §2's `StrategyResult` has
#: no level fields and §5.5's level derivation is Stage 1, so `evidence` is the
#: only place on the frozen contract they can live. See AMBIGUITY-B11.
EVIDENCE_STOP_KEY = "stop_loss"
EVIDENCE_TARGET_KEY = "take_profit"


class NBarBreakout:
    """Fires when the close clears the extreme of the previous N bars.

    Satisfies the §4.1 `Strategy` protocol. Nothing more should be read into it.
    """

    module_id = 0
    """Deliberately outside §2's documented 1..28 range. This is not a module."""

    module_name = "TRIVIAL_N_BAR_BREAKOUT (Stage 0 harness scaffolding)"
    cluster_id = "NONE"
    """Belongs to no §5.1 cluster. Never enters a cluster score."""

    def __init__(
        self,
        *,
        lookback_bars: int,
        stop_points: float,
        target_points: float,
        fired_score: float,
    ):
        if lookback_bars < 1:
            raise ValueError("lookback_bars must be at least 1")
        if stop_points <= 0 or target_points <= 0:
            raise ValueError("stop_points and target_points must be positive")
        self.lookback_bars = lookback_bars
        self.stop_points = stop_points
        self.target_points = target_points
        self.fired_score = fired_score
        self.min_bars = lookback_bars + 1

    @classmethod
    def from_config(cls, config: Config) -> NBarBreakout:
        """Read the harness knobs. The *caller* touches config, never
        `evaluate` — rule 1 forbids I/O inside the pure function."""
        return cls(
            lookback_bars=config.get("backtest.gate_strategy.lookback_bars"),
            stop_points=config.get("backtest.gate_strategy.stop_points"),
            target_points=config.get("backtest.gate_strategy.target_points"),
            fired_score=config.get("backtest.gate_strategy.fired_score"),
        )

    def evaluate(self, bars: list[Candle], spec: SymbolSpec) -> StrategyResult:
        """Pure function. No I/O. No regime awareness. No global state."""
        if len(bars) < self.min_bars:
            # The harness enforces this via `check_window`; the module is never
            # handed a short window. Returning a non-firing result rather than
            # raising keeps `evaluate` total.
            return self._flat()

        window = bars[-self.min_bars :]
        prior = window[:-1]
        last = window[-1]

        highest = max(bar.high for bar in prior)
        lowest = min(bar.low for bar in prior)

        if last.close > highest:
            direction = Direction.BUY
            level = highest
        elif last.close < lowest:
            direction = Direction.SELL
            level = lowest
        else:
            return self._flat()

        # Distances are configured in POINTS and converted with the broker's own
        # point size. `spec.digits` normalises, so §7.3 condition 4 passes.
        stop_distance = self.stop_points * spec.point
        target_distance = self.target_points * spec.point
        reference = last.close

        if direction is Direction.BUY:
            stop_loss = round(reference - stop_distance, spec.digits)
            take_profit = round(reference + target_distance, spec.digits)
        else:
            stop_loss = round(reference + stop_distance, spec.digits)
            take_profit = round(reference - target_distance, spec.digits)

        return StrategyResult(
            module_id=self.module_id,
            module_name=self.module_name,
            fired=True,
            direction=direction,
            score=self.fired_score,
            evidence={
                "breakout_level": round(level, spec.digits),
                "reference_close": round(reference, spec.digits),
                "lookback_bars": self.lookback_bars,
                EVIDENCE_STOP_KEY: stop_loss,
                EVIDENCE_TARGET_KEY: take_profit,
            },
        )

    def _flat(self) -> StrategyResult:
        return StrategyResult(
            module_id=self.module_id,
            module_name=self.module_name,
            fired=False,
            direction=Direction.NONE,
            score=0.0,
            evidence={},
        )


__all__ = ["NBarBreakout", "EVIDENCE_STOP_KEY", "EVIDENCE_TARGET_KEY"]
