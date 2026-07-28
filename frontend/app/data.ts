export type MarketGroup = "Major pairs" | "Crosses" | "Metals" | "Crypto" | "Indices";
export type Direction = "BUY" | "SELL" | "NEUTRAL";
export type Regime = "TRENDING" | "RANGING" | "TRANSITIONAL" | "VOLATILE_NEWS";

export type Instrument = {
  symbol: string;
  group: MarketGroup;
  price: string;
  change: number;
  direction: Direction;
  regime: Regime;
  score: number;
  breadth: number;
  quality: number;
  spread: string;
};

export type Signal = {
  id: string;
  symbol: string;
  direction: Exclude<Direction, "NEUTRAL">;
  orderType: "BUY LIMIT" | "BUY STOP" | "SELL LIMIT" | "SELL STOP" | "BUY NOW" | "SELL NOW";
  timeframe: "M15" | "H1" | "H4";
  regime: Regime;
  lifecycle: "LOCKED" | "MONITORING" | "AWAITING_VALIDATION";
  validity: "TAKEABLE" | "PENDING" | "CAUTION" | "TOO_LATE";
  score: number;
  breadth: number;
  quality: number;
  entry: string;
  stop: string;
  tp1: string;
  tp2: string;
  rr: string;
  expires: string;
  note: string;
};

export type StrategyModule = {
  id: number;
  name: string;
  pillar: "SMC / ICT" | "Price action" | "Trend & momentum" | "Volatility";
  cluster: string;
  detects: string;
};

export const instruments: Instrument[] = [
  { symbol: "EUR/USD", group: "Major pairs", price: "1.13741", change: -0.29, direction: "BUY", regime: "RANGING", score: 65, breadth: 8, quality: 66, spread: "1.2" },
  { symbol: "GBP/USD", group: "Major pairs", price: "1.32952", change: -0.32, direction: "BUY", regime: "TRENDING", score: 78, breadth: 3, quality: 81, spread: "1.2" },
  { symbol: "USD/JPY", group: "Major pairs", price: "163.733", change: 0.01, direction: "NEUTRAL", regime: "TRENDING", score: 74, breadth: 7, quality: 67, spread: "1.2" },
  { symbol: "USD/CHF", group: "Major pairs", price: "0.81948", change: -0.02, direction: "BUY", regime: "TRENDING", score: 78, breadth: 9, quality: 68, spread: "1.2" },
  { symbol: "AUD/USD", group: "Major pairs", price: "0.69707", change: 0.03, direction: "SELL", regime: "VOLATILE_NEWS", score: 62, breadth: 7, quality: 92, spread: "1.2" },
  { symbol: "USD/CAD", group: "Major pairs", price: "1.41143", change: 0.16, direction: "BUY", regime: "VOLATILE_NEWS", score: 79, breadth: 3, quality: 68, spread: "1.2" },
  { symbol: "NZD/USD", group: "Major pairs", price: "0.57729", change: 0.10, direction: "SELL", regime: "TRANSITIONAL", score: 70, breadth: 4, quality: 92, spread: "1.2" },
  { symbol: "EUR/GBP", group: "Crosses", price: "0.85481", change: -0.17, direction: "NEUTRAL", regime: "TRENDING", score: 86, breadth: 7, quality: 65, spread: "1.2" },
  { symbol: "EUR/JPY", group: "Crosses", price: "186.282", change: 0.34, direction: "SELL", regime: "TRENDING", score: 59, breadth: 4, quality: 86, spread: "1.2" },
  { symbol: "GBP/JPY", group: "Crosses", price: "217.920", change: -0.25, direction: "BUY", regime: "TRENDING", score: 69, breadth: 8, quality: 88, spread: "1.2" },
  { symbol: "AUD/JPY", group: "Crosses", price: "114.350", change: 0.19, direction: "SELL", regime: "RANGING", score: 62, breadth: 9, quality: 78, spread: "1.2" },
  { symbol: "CAD/JPY", group: "Crosses", price: "116.250", change: -0.32, direction: "SELL", regime: "VOLATILE_NEWS", score: 59, breadth: 7, quality: 64, spread: "1.2" },
  { symbol: "CHF/JPY", group: "Crosses", price: "200.170", change: 0.24, direction: "NEUTRAL", regime: "RANGING", score: 59, breadth: 4, quality: 86, spread: "1.2" },
  { symbol: "NZD/JPY", group: "Crosses", price: "94.845", change: 0.28, direction: "NEUTRAL", regime: "TRANSITIONAL", score: 76, breadth: 7, quality: 87, spread: "1.2" },
  { symbol: "EUR/CHF", group: "Crosses", price: "0.93120", change: 0.04, direction: "NEUTRAL", regime: "TRENDING", score: 65, breadth: 4, quality: 70, spread: "1.2" },
  { symbol: "GBP/CHF", group: "Crosses", price: "1.09030", change: 0.09, direction: "NEUTRAL", regime: "RANGING", score: 65, breadth: 8, quality: 65, spread: "1.2" },
  { symbol: "AUD/CAD", group: "Crosses", price: "0.97930", change: 0.01, direction: "NEUTRAL", regime: "TRENDING", score: 68, breadth: 6, quality: 62, spread: "1.2" },
  { symbol: "AUD/CHF", group: "Crosses", price: "0.56010", change: -0.16, direction: "BUY", regime: "TRENDING", score: 68, breadth: 3, quality: 65, spread: "1.2" },
  { symbol: "AUD/NZD", group: "Crosses", price: "1.21430", change: 0.06, direction: "SELL", regime: "RANGING", score: 77, breadth: 5, quality: 89, spread: "1.2" },
  { symbol: "CAD/CHF", group: "Crosses", price: "0.58040", change: 0.28, direction: "NEUTRAL", regime: "RANGING", score: 76, breadth: 9, quality: 93, spread: "1.2" },
  { symbol: "NZD/CAD", group: "Crosses", price: "0.81640", change: -0.19, direction: "SELL", regime: "TRANSITIONAL", score: 57, breadth: 6, quality: 64, spread: "1.2" },
  { symbol: "NZD/CHF", group: "Crosses", price: "0.47380", change: 0.01, direction: "SELL", regime: "TRANSITIONAL", score: 80, breadth: 5, quality: 87, spread: "1.2" },
  { symbol: "XAU/USD", group: "Metals", price: "4,044.11", change: -0.28, direction: "SELL", regime: "TRANSITIONAL", score: 59, breadth: 5, quality: 92, spread: "3.0" },
  { symbol: "XAG/USD", group: "Metals", price: "57.648", change: -0.25, direction: "NEUTRAL", regime: "RANGING", score: 86, breadth: 8, quality: 89, spread: "3.0" },
  { symbol: "BTC/USD", group: "Crypto", price: "63,341.00", change: -0.36, direction: "SELL", regime: "TRANSITIONAL", score: 77, breadth: 3, quality: 79, spread: "50" },
  { symbol: "ETH/USD", group: "Crypto", price: "1,624.95", change: 0.20, direction: "BUY", regime: "VOLATILE_NEWS", score: 86, breadth: 6, quality: 63, spread: "50" },
  { symbol: "US30", group: "Indices", price: "49,918.78", change: -0.04, direction: "BUY", regime: "TRENDING", score: 55, breadth: 8, quality: 78, spread: "1.2" },
  { symbol: "SPX500", group: "Indices", price: "7,346.37", change: -0.14, direction: "SELL", regime: "TRENDING", score: 71, breadth: 5, quality: 93, spread: "1.2" },
];

export const signals: Signal[] = [
  {
    id: "sig-xau-h1-001",
    symbol: "XAU/USD",
    direction: "BUY",
    orderType: "BUY LIMIT",
    timeframe: "H1",
    regime: "RANGING",
    lifecycle: "LOCKED",
    validity: "TAKEABLE",
    score: 82,
    breadth: 72,
    quality: 94,
    entry: "4,036.20–4,038.40",
    stop: "4,029.10",
    tp1: "4,049.80",
    tp2: "4,061.50",
    rr: "1 : 2.7",
    expires: "4h 12m",
    note: "Price remains inside the validated pullback zone; post-snap R:R is intact.",
  },
  {
    id: "sig-gbp-m15-002",
    symbol: "GBP/USD",
    direction: "BUY",
    orderType: "BUY STOP",
    timeframe: "M15",
    regime: "TRENDING",
    lifecycle: "MONITORING",
    validity: "PENDING",
    score: 78,
    breadth: 68,
    quality: 86,
    entry: "1.33180–1.33210",
    stop: "1.32760",
    tp1: "1.33850",
    tp2: "1.34290",
    rr: "1 : 2.4",
    expires: "2h 47m",
    note: "Awaiting a closed-bar break above the trigger. Do not enter at market.",
  },
  {
    id: "sig-btc-h4-003",
    symbol: "BTC/USD",
    direction: "SELL",
    orderType: "SELL LIMIT",
    timeframe: "H4",
    regime: "TRANSITIONAL",
    lifecycle: "LOCKED",
    validity: "CAUTION",
    score: 76,
    breadth: 64,
    quality: 88,
    entry: "64,180–64,420",
    stop: "65,310",
    tp1: "62,080",
    tp2: "60,940",
    rr: "1 : 2.1",
    expires: "11h 20m",
    note: "Entry remains structurally valid, but the transitional regime halves sizing.",
  },
  {
    id: "sig-eur-h1-004",
    symbol: "EUR/USD",
    direction: "SELL",
    orderType: "SELL NOW",
    timeframe: "H1",
    regime: "TRANSITIONAL",
    lifecycle: "MONITORING",
    validity: "TOO_LATE",
    score: 75,
    breadth: 70,
    quality: 80,
    entry: "1.13840–1.13880",
    stop: "1.14220",
    tp1: "1.13260",
    tp2: "1.12910",
    rr: "1 : 1.2",
    expires: "1h 08m",
    note: "Price has moved beyond chase tolerance and degraded R:R below the gate.",
  },
];

const moduleRows: Array<[string, StrategyModule["pillar"], string, string]> = [
  ["Bullish FVG Fill", "SMC / ICT", "A", "Price dips into a three-candle imbalance gap"],
  ["Bearish FVG Fill", "SMC / ICT", "A", "Price rallies into an overhead sell-side gap"],
  ["Bullish Order Block", "SMC / ICT", "B", "Mitigation of the last down candle before a structural break"],
  ["Bearish Order Block", "SMC / ICT", "B", "Mitigation of the last up candle before a collapse"],
  ["Sell-Side Liquidity Sweep", "SMC / ICT", "C", "Prior equal lows are swept before reversal"],
  ["Buy-Side Liquidity Sweep", "SMC / ICT", "C", "Equal highs are swept before reversal"],
  ["Change of Character", "SMC / ICT", "D₁", "First structural swing break signalling reversal"],
  ["Break of Structure", "SMC / ICT", "D₁", "Structural continuation break with the macro trend"],
  ["Breaker Block Mitigation", "SMC / ICT", "B", "Failed order block flips into support or resistance"],
  ["Liquidity Void Re-alignment", "SMC / ICT", "H", "Fast displacement begins to rebalance"],
  ["Quasimodo Level Reversal", "Price action", "C", "Over-extended structure returns to the left shoulder"],
  ["Support-to-Resistance Flip", "Price action", "B", "Broken horizontal level is retested from the opposite side"],
  ["Supply / Demand Zone Retest", "Price action", "B", "Institutional imbalance area is revisited"],
  ["Double Bottom / Top Validation", "Price action", "C", "Equal high or low retests with exhaustion"],
  ["Pinbar / Hammer Exhaustion", "Price action", "F", "Long-wick rejection at a multi-timeframe level"],
  ["Engulfing Cluster", "Price action", "F", "A high-volume candle absorbs prior candle wicks"],
  ["Triple EMA Alignment", "Trend & momentum", "D₁", "EMA 20, 50 and 200 align directionally"],
  ["EMA Dynamic Pullback", "Trend & momentum", "D₂", "Price revisits EMA 20 or 50 in an active trend"],
  ["MACD Zero-Line Crossover", "Trend & momentum", "E", "Momentum crosses the zero line"],
  ["RSI Divergence", "Trend & momentum", "F", "Price and oscillator form regular divergence"],
  ["ADX Trend Acceleration", "Trend & momentum", "E", "ADX rises through the trend threshold"],
  ["Supertrend Directional Flip", "Trend & momentum", "D₂", "Trailing band changes direction"],
  ["Bollinger Squeeze Breakout", "Volatility", "H", "Volatility contraction expands rapidly"],
  ["Bollinger Outer Reversion", "Volatility", "G", "Price touches the outer band in a range"],
  ["VWAP Deviation Touch", "Volatility", "G", "VWAP reaches an extreme deviation"],
  ["Keltner Channel Reversal", "Volatility", "G", "Channel touch coincides with slowing momentum"],
  ["ATR Volatility Expansion", "Volatility", "H", "ATR spike confirms breakout velocity"],
  ["Session Open Range Breakout", "Volatility", "E", "London or New York opening range breaks"],
];

export const strategyModules: StrategyModule[] = moduleRows.map(
  ([name, pillar, cluster, detects], index) => ({
    id: index + 1,
    name,
    pillar,
    cluster,
    detects,
  }),
);

export const syntheticMetrics = [
  { label: "Resolved trades", value: "34", tone: "neutral" },
  { label: "Win rate", value: "61.76%", tone: "positive" },
  { label: "Expectancy", value: "+0.098 R", tone: "positive" },
  { label: "Profit factor", value: "1.256", tone: "positive" },
  { label: "Max drawdown", value: "1.000 R", tone: "negative" },
  { label: "Ambiguity", value: "0.00%", tone: "neutral" },
] as const;
