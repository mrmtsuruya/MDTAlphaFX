// Keyless macro-context provider for the signal engine.
//
// Two public feeds, no API keys:
//  - Economic calendar -> ForexFactory weekly RSS (nfs.faireconomy.media). Real
//    release schedule with impact levels for every currency in the app.
//  - Positioning       -> CFTC Commitments of Traders (publicreporting.cftc.gov
//    Socrata "Legacy - Futures Only"). Weekly net spec positioning per market.
//
// The engine uses this as an informational overlay (stored on signals and shown
// in the UI) plus a small confluence nudge when a High-impact release for one
// of the pair's currencies is imminent.

export type CalendarEvent = {
  currency: string;
  title: string;
  date: string; // MM-DD-YYYY (ForexFactory RSS format)
  time: string; // 24h HH:MM UTC
  /** Epoch ms UTC, computed once from date+time at parse time. Every window
   *  check (news_reactive's release proximity, the lookahead filter below)
   *  reads this instead of re-deriving the date, which is how a bare HH:MM
   *  comparison used to match events on the wrong calendar day. */
  timestamp: number;
  impact: "High" | "Medium" | "Low";
  forecast: string | null;
  previous: string | null;
};

export type CotPosition = {
  pair: string;
  market: string;
  nonCommLong: number;
  nonCommShort: number;
  net: number;
  /** -100 (all short) .. +100 (all long) among non-commercials. */
  netPct: number;
  reportDate: string;
};

export type MacroContext = {
  /** Upcoming High/Medium events within the lookahead window for the pair's currencies. */
  events: CalendarEvent[];
  /** COT for the pair when the futures market exists (FX majors + gold). */
  cot: CotPosition | null;
};

const FF_CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.xml";
const COT_LEGACY_URL =
  "https://publicreporting.cftc.gov/resource/6dca-aqww.json?$limit=1000&$order=report_date_as_yyyy_mm_dd%20DESC";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Currency per pair (base + quote) so we can match calendar events.
const PAIR_CURRENCIES: Record<string, [string, string]> = {
  EURUSD: ["EUR", "USD"],
  GBPUSD: ["GBP", "USD"],
  USDJPY: ["USD", "JPY"],
  AUDUSD: ["AUD", "USD"],
  USDCAD: ["USD", "CAD"],
  NZDUSD: ["NZD", "USD"],
  USDCHF: ["USD", "CHF"],
  EURGBP: ["EUR", "GBP"],
  EURJPY: ["EUR", "JPY"],
  GBPJPY: ["GBP", "JPY"],
  AUDJPY: ["AUD", "JPY"],
  XAUUSD: ["USD", "USD"], // gold is USD-priced
};

// COT market names (Legacy - Futures Only, as returned by the CFTC Socrata API).
const COT_MARKETS: Record<string, string> = {
  EURUSD: "EURO FX",
  GBPUSD: "BRITISH POUND",
  USDJPY: "JAPANESE YEN",
  AUDUSD: "AUSTRALIAN DOLLAR",
  USDCAD: "CANADIAN DOLLAR",
  NZDUSD: "NEW ZEALAND DOLLAR",
  USDCHF: "SWISS FRANC",
  EURGBP: "EURO FX/BRITISH POUND",
  XAUUSD: "GOLD",
};

// ---------------------------------------------------------------------------
// Economic calendar — ForexFactory RSS (windows-1252 XML)
// ---------------------------------------------------------------------------

function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractCdata(block: string, tag: string): string {
  const match = block.match(
    new RegExp(`<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`),
  );
  if (match) return match[1].trim();
  const plain = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return plain ? plain[1].trim() : "";
}

function parseCalendarXml(xml: string): CalendarEvent[] {
  const blocks = xml.match(/<event>[\s\S]*?<\/event>/g) ?? [];
  return blocks
    .map((block) => {
      const title = decodeEntities(extractCdata(block, "title"));
      const country = decodeEntities(extractCdata(block, "country"));
      const date = extractCdata(block, "date");
      const rawTime = extractCdata(block, "time");
      const impact = decodeEntities(extractCdata(block, "impact"));
      if (!title || !country || !date || !rawTime) return null;

      // Time like "9:15am" / "9:15pm" / "All Day" -> HH:MM UTC (FX data is UTC).
      let time = "";
      const match = rawTime.match(/^(\d{1,2}):(\d{2})\s*([ap]m)?/i);
      if (match) {
        let hours = Number(match[1]);
        const minutes = match[2];
        const meridian = (match[3] ?? "").toLowerCase();
        if (meridian === "pm" && hours < 12) hours += 12;
        if (meridian === "am" && hours === 12) hours = 0;
        time = `${String(hours).padStart(2, "0")}:${minutes}`;
      }

      // FF RSS dates are MM-DD-YYYY — Date.parse on that is implementation-
      // dependent (often NaN in V8), so build the UTC timestamp manually,
      // once, here at the source, from the numeric parts.
      const [month, day, year] = date.split("-").map(Number);
      const [hours, minutes] = time.split(":").map(Number);
      const timestamp = Date.UTC(year, month - 1, day, hours, minutes);

      const normalizedImpact =
        impact === "High" || impact === "Medium" || impact === "Low" ? impact : "Low";
      return {
        currency: country.toUpperCase(),
        title,
        date,
        time,
        timestamp,
        impact: normalizedImpact,
        forecast: decodeEntities(extractCdata(block, "forecast")) || null,
        previous: decodeEntities(extractCdata(block, "previous")) || null,
      };
    })
    .filter(
      (event): event is CalendarEvent =>
        event !== null && event.time !== "" && Number.isFinite(event.timestamp),
    );
}

// Calendar data only changes daily and COT weekly — cache aggressively so the
// keyless feeds are hit once per window instead of once per scan. This also
// keeps us clear of the feeds' rate limits.
const CALENDAR_TTL_MS = 15 * 60 * 1000;
const COT_TTL_MS = 6 * 60 * 60 * 1000;
let calendarCache: { at: number; value: CalendarEvent[] } | null = null;
let cotCache: { at: number; value: CotPosition[] } | null = null;

export async function fetchCalendarEvents(): Promise<CalendarEvent[]> {
  if (calendarCache && Date.now() - calendarCache.at < CALENDAR_TTL_MS) {
    return calendarCache.value;
  }
  try {
    const response = await fetch(FF_CALENDAR_URL, {
      headers: { "User-Agent": BROWSER_UA, Accept: "application/xml" },
    });
    if (!response.ok) return calendarCache?.value ?? [];
    const xml = await response.text();
    const value = parseCalendarXml(xml);
    calendarCache = { at: Date.now(), value };
    return value;
  } catch {
    return calendarCache?.value ?? [];
  }
}

// ---------------------------------------------------------------------------
// COT positioning — CFTC legacy futures-only Socrata dataset
// ---------------------------------------------------------------------------

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function fetchCotPositions(): Promise<CotPosition[]> {
  if (cotCache && Date.now() - cotCache.at < COT_TTL_MS) {
    return cotCache.value;
  }
  try {
    const response = await fetch(COT_LEGACY_URL, {
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
    });
    if (!response.ok) return cotCache?.value ?? [];
    const rows = (await response.json()) as Record<string, unknown>[];
    const byMarket = new Map<string, CotPosition>();
    let reportDate = "";
    for (const row of rows) {
      const market = String(row.market_and_exchange_names ?? "").trim();
      const date = String(row.report_date_as_yyyy_mm_dd ?? "").slice(0, 10);
      if (!reportDate) reportDate = date;
      if (date !== reportDate) break; // only the latest weekly report
      const normalized = market.toUpperCase();
      for (const [pair, key] of Object.entries(COT_MARKETS)) {
        if (normalized === key || normalized.startsWith(`${key} - `)) {
          const long = toNumber(row.noncomm_positions_long_all);
          const short = toNumber(row.noncomm_positions_short_all);
          const total = long + short;
          byMarket.set(pair, {
            pair,
            market,
            nonCommLong: long,
            nonCommShort: short,
            net: long - short,
            netPct: total > 0 ? Math.round(((long - short) / total) * 100) : 0,
            reportDate: date,
          });
          break;
        }
      }
    }
    const value = [...byMarket.values()];
    cotCache = { at: Date.now(), value };
    return value;
  } catch {
    return cotCache?.value ?? [];
  }
}

// ---------------------------------------------------------------------------
// Composed context for a set of pairs (used by the signal engine)
// ---------------------------------------------------------------------------

export async function fetchMacroContext(pairs: string[]): Promise<Record<string, MacroContext>> {
  const [events, cotPositions] = await Promise.all([fetchCalendarEvents(), fetchCotPositions()]);
  const cotByPair = new Map(cotPositions.map((position) => [position.pair, position]));
  const now = Date.now();
  const lookaheadMs = 24 * 60 * 60 * 1000;

  const result: Record<string, MacroContext> = {};
  for (const pair of pairs) {
    const currencies = PAIR_CURRENCIES[pair] ?? ["USD", "USD"];
    const relevant = events.filter((event) => {
      if (event.impact === "Low") return false;
      if (!currencies.includes(event.currency)) return false;
      return event.timestamp >= now - 60 * 60 * 1000 && event.timestamp <= now + lookaheadMs;
    });
    result[pair] = {
      events: relevant.slice(0, 4),
      cot: cotByPair.get(pair) ?? null,
    };
  }
  return result;
}
