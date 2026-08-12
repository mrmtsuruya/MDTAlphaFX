// Pure floating-P&L math for the MT5-style position view.
//
// XAUUSD convention: 1.0 standard lot = 100 troy ounces, so a 0.01-lot paper
// trade is exactly 1 ounce and $1 of price move equals $1 of P&L. R is the
// signed price distance expressed as a multiple of the risk (entry->stop).

export type PaperPositionMath = {
  /** Signed price distance in $/oz (positive = in the trade's favour). */
  points: number;
  /** Floating P&L in USD for the trade's lot size. */
  usd: number;
  /** Floating P&L as a signed multiple of entry->stop risk. */
  r: number;
};

export function computePaperPosition(input: {
  direction: "long" | "short";
  entry: number;
  stopLoss: number;
  lotSize: number;
  current: number;
}): PaperPositionMath | null {
  const { direction, entry, stopLoss, lotSize, current } = input;
  if (![entry, stopLoss, lotSize, current].every((n) => Number.isFinite(n))) return null;
  if (lotSize <= 0) return null;
  const dir = direction === "long" ? 1 : -1;
  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return null;
  const points = dir * (current - entry);
  return {
    points,
    usd: points * lotSize * 100,
    r: points / risk,
  };
}
