// Exit-policy simulator for the signal autopsy.
//
// The live worker resolves every paper trade with the B-single machine
// (TP1 arms a breakeven stop, the whole 0.01-lot position runs to TP2). The
// autopsy answers the trader's "what if" questions on the SAME recorded
// candles: should TP1 close the trade? should the stop trail? should
// breakeven arm early when TP1 is not achievable? Each alternative is
// simulated independently and reported alongside the control, so a policy is
// promoted to the worker only when its own history says it wins.
//
// Semantics mirror src/lib/paper-trade-state.ts as closely as a mid-candle
// replay can: exits run on the exit-side extreme (low for a long, high for a
// short — the chart's candles are mid, so bid/ask is not modelled and the
// caller labels the result as an approximation), a candle that touches the
// stop AND a target resolves adversarially to the stop with
// `ambiguousIntrabar`, and the arming candle never triggers its own new stop.
// Entry is not re-simulated: the recorded fill is the starting point, so the
// walk covers only exits from `entryTime` onward.
//
// The module is pure: no I/O, no wall-clock reads, deterministic per input.

export const EXIT_POLICIES = [
  "b_single_v1",
  "close_at_tp1_v1",
  "trail_after_tp1_v1",
  "early_be_v1",
] as const;

export type ExitPolicy = (typeof EXIT_POLICIES)[number];

export const EXIT_POLICY_LABEL: Record<ExitPolicy, string> = {
  b_single_v1: "CURRENT · TP1→BE, RUN TO TP2",
  close_at_tp1_v1: "CLOSE 100% AT TP1",
  trail_after_tp1_v1: "TRAIL 1.0×ATR AFTER TP1",
  early_be_v1: "EARLY BE AT +0.5R",
};

/** Favorable-excursion threshold (in R) that arms the early breakeven stop. */
export const EARLY_BE_THRESHOLD_R = 0.5 as const;
/** Trail distance (in ATR multiples) behind the post-TP1 peak. */
export const TRAIL_ATR_MULTIPLE = 1.0 as const;

export type SimCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type PolicySimInput = {
  direction: "long" | "short";
  /** Recorded fill price — the walk starts here, entry is not re-simulated. */
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  atr: number;
  entryTime: string;
  /** Candles with time strictly AFTER entryTime; sorted ascending. */
  candles: SimCandle[];
};

export type PolicySimResult = {
  policy: ExitPolicy;
  state:
    | "closed_tp2"
    | "closed_tp1"
    | "closed_breakeven"
    | "closed_stop"
    | "trail_exit"
    | "still_open";
  exitPrice: number | null;
  exitTimeUtc: string | null;
  resultR: number | null;
  barsHeld: number;
  ambiguousIntrabar: boolean;
};

type SimState =
  | "open"
  | "tp1_protected" // breakeven (entry) armed
  | "be_armed_early"; // breakeven armed before TP1 (early_be policy)

function priceInR(input: PolicySimInput, price: number): number {
  const risk = Math.abs(input.entry - input.stopLoss);
  if (risk <= 0) return 0;
  const dir = input.direction === "long" ? 1 : -1;
  return (dir * (price - input.entry)) / risk;
}

/**
 * Exit-side extremes of a mid candle. Directional meaning is applied at the
 * call sites (long stop at lows / targets at highs; short mirrors), matching
 * paper-trade-state.ts where both sides resolve against the same candle.
 */
function exitSide(_input: PolicySimInput, candle: SimCandle): { low: number; high: number } {
  return { low: candle.low, high: candle.high };
}

function result(
  policy: ExitPolicy,
  state: PolicySimResult["state"],
  exitPrice: number | null,
  exitTimeUtc: string | null,
  input: PolicySimInput,
  barsHeld: number,
  ambiguousIntrabar: boolean,
): PolicySimResult {
  return {
    policy,
    state,
    exitPrice,
    exitTimeUtc,
    resultR: exitPrice == null ? null : priceInR(input, exitPrice),
    barsHeld,
    ambiguousIntrabar,
  };
}

function simulateOne(input: PolicySimInput, policy: ExitPolicy): PolicySimResult {
  const { direction, entry, stopLoss, takeProfit1, takeProfit2, atr, entryTime } = input;
  const risk = Math.abs(entry - stopLoss);
  const entryMs = Date.parse(entryTime);
  let state: SimState = "open";
  let barsHeld = 0;
  let ambiguous = false;
  let trailStop = entry; // trail_after_tp1: ratchets up (long) from entry

  const candles = input.candles.filter((c) => Date.parse(c.time) > entryMs);
  for (const candle of candles) {
    if (state === "open" || state === "be_armed_early") {
      const side = exitSide(input, candle);
      const touchedSl = direction === "long" ? side.low <= stopLoss : side.high >= stopLoss;
      const touchedTp2 = direction === "long" ? side.high >= takeProfit2 : side.low <= takeProfit2;
      const touchedTp1 = direction === "long" ? side.high >= takeProfit1 : side.low <= takeProfit1;
      const favourable =
        direction === "long" ? side.high - entry : entry - side.low;
      const touchedEarlyBe =
        policy === "early_be_v1" && risk > 0 && favourable >= EARLY_BE_THRESHOLD_R * risk;

      barsHeld += 1;

      // Adversarial intrabar: the stop (SL or early BE) beats every target.
      if (state === "open" && touchedSl && (touchedTp1 || touchedTp2)) {
        return result(policy, "closed_stop", stopLoss, candle.time, input, barsHeld, true);
      }
      if (state === "open" && touchedSl) {
        return result(policy, "closed_stop", stopLoss, candle.time, input, barsHeld, false);
      }
      const beTouched = direction === "long" ? side.low <= entry : side.high >= entry;
      if (state === "be_armed_early" && beTouched) {
        if (beTouched && touchedTp2) {
          return result(policy, "closed_breakeven", entry, candle.time, input, barsHeld, true);
        }
        return result(policy, "closed_breakeven", entry, candle.time, input, barsHeld, false);
      }
      if (touchedTp2) {
        return result(policy, "closed_tp2", takeProfit2, candle.time, input, barsHeld, false);
      }
      if (touchedTp1) {
        if (policy === "close_at_tp1_v1") {
          return result(policy, "closed_tp1", takeProfit1, candle.time, input, barsHeld, false);
        }
        state = "tp1_protected"; // BE armed at entry; arming candle never triggers it
        if (policy === "trail_after_tp1_v1") {
          // The TP1 candle's own extreme sets the initial trail level; like
          // every other arming bar, it cannot also trigger that new stop.
          trailStop =
            direction === "long"
              ? Math.max(entry, side.high - TRAIL_ATR_MULTIPLE * atr)
              : Math.min(entry, side.low + TRAIL_ATR_MULTIPLE * atr);
        }
        continue;
      }
      if (touchedEarlyBe) {
        state = "be_armed_early";
        continue;
      }
      continue;
    }

    // tp1_protected: breakeven (entry) live; trail_after_tp1 additionally
    // ratchets the stop behind the post-TP1 peak. TP2 is still the target.
    const side = exitSide(input, candle);
    barsHeld += 1;
    const touchedTp2 = direction === "long" ? side.high >= takeProfit2 : side.low <= takeProfit2;

    if (policy === "trail_after_tp1_v1") {
      // Exit test uses the trail level established BEFORE this candle; the
      // ratchet below takes effect from the next candle (intrabar order is
      // unknowable, so a candle never triggers the level it just set).
      const touchedTrail = direction === "long" ? side.low <= trailStop : side.high >= trailStop;
      if (touchedTrail && touchedTp2) {
        return result(policy, "trail_exit", trailStop, candle.time, input, barsHeld, true);
      }
      if (touchedTrail) {
        return result(policy, "trail_exit", trailStop, candle.time, input, barsHeld, false);
      }
      if (touchedTp2) {
        return result(policy, "closed_tp2", takeProfit2, candle.time, input, barsHeld, false);
      }
      const peak = direction === "long" ? side.high : side.low;
      trailStop =
        direction === "long"
          ? Math.max(trailStop, Math.max(entry, peak - TRAIL_ATR_MULTIPLE * atr))
          : Math.min(trailStop, Math.min(entry, peak + TRAIL_ATR_MULTIPLE * atr));
      continue;
    }

    // b_single / early_be after TP1: static breakeven at entry, run to TP2.
    const touchedBE = direction === "long" ? side.low <= entry : side.high >= entry;
    if (touchedBE && touchedTp2) {
      return result(policy, "closed_breakeven", entry, candle.time, input, barsHeld, true);
    }
    if (touchedBE) {
      return result(policy, "closed_breakeven", entry, candle.time, input, barsHeld, false);
    }
    if (touchedTp2) {
      return result(policy, "closed_tp2", takeProfit2, candle.time, input, barsHeld, false);
    }
  }

  return result(policy, "still_open", null, null, input, barsHeld, ambiguous);
}

/**
 * Simulate every exit policy over the same candle window. The control policy
 * (b_single_v1) is the first result; it reproduces the worker's recorded
 * outcome when the candles match what the worker saw (mid vs two-sided
 * candles can shift a touch by the spread).
 */
export function simulateExitPolicies(input: PolicySimInput): PolicySimResult[] {
  return EXIT_POLICIES.map((policy) => simulateOne(input, policy));
}
