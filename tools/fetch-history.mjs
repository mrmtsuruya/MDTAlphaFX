// Dukascopy history fetcher.
//
// The signal engine currently backtests against mid-price candles with zero
// spread, which inflates its win rate -- a real trade pays the bid/ask
// spread on both the entry and the exit. This script pulls real bid AND ask
// history from Dukascopy so a backtester has something honest to run
// against.
//
// Fetches one calendar month at a time, not the whole requested range in one
// shot: a multi-year backfill can run for a long time against an unofficial,
// rate-limited source, and a crash, a kill, or a Dukascopy hiccup partway
// through must not throw away the months that already finished. Each month
// gets its own request(s), its own output file, and its own manifest entry,
// and the manifest is rewritten after every month so progress survives a
// process that dies mid-run.
//
// Plain ESM tooling script: no TypeScript, no bundler, run directly with
// `node tools/fetch-history.mjs`.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const TIMEFRAMES = ["tick", "m1", "m5", "m15", "m30", "h1", "h4", "d1"];

const HELP_TEXT = `Fetch Dukascopy bid/ask history to JSONL, one file per calendar month.

Usage:
  node tools/fetch-history.mjs --from YYYY-MM-DD --to YYYY-MM-DD [options]

Options:
  --instrument <symbol>   Dukascopy instrument code (default: xauusd)
  --from <YYYY-MM-DD>     Range start, inclusive (required)
  --to <YYYY-MM-DD>       Range end, exclusive (required)
  --timeframe <tf>        tick | m1 | m5 | m15 | m30 | h1 | h4 | d1 (default: m1)
  --out <dir>             Output root (default: data/history)
  --cache <dir>           dukascopy-node cache directory (default: .dukascopy-cache)
  --force                 Re-fetch months whose output file already exists
  --help                  Show this help and exit

Output:
  <out>/<instrument>/<timeframe>/<YYYY-MM>.jsonl   one JSON object per line
  <out>/manifest.json                              coverage summary, merged across runs
`;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function monthKeyOf(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

function parseDateOnly(value, label) {
  const match = typeof value === "string" ? DATE_ONLY_RE.exec(value) : null;
  if (!match) {
    throw new Error(`${label} must be a YYYY-MM-DD date, got ${JSON.stringify(value)}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC silently rolls invalid days into the next month (e.g. Feb 30 ->
  // Mar 2), so round-trip the parts to catch dates that were never real.
  const rolledOver =
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day;
  if (rolledOver) {
    throw new Error(`${label} is not a real calendar date: ${value}`);
  }
  return date;
}

function toUtcDate(value, label) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`${label} is an invalid Date`);
    }
    return value;
  }
  return parseDateOnly(value, label);
}

// ---------------------------------------------------------------------------
// Pure logic (exported for the test suite -- no I/O, no network below here
// until fetchMonthRows).
// ---------------------------------------------------------------------------

/**
 * Split [from, to) into calendar-month chunks, clipped to the requested
 * range at both ends. `from`/`to` may be `YYYY-MM-DD` strings or Dates.
 *
 * @param {string | Date} from - range start, inclusive
 * @param {string | Date} to - range end, exclusive
 * @returns {{ key: string, from: Date, to: Date }[]}
 */
export function monthChunks(from, to) {
  const start = toUtcDate(from, "from");
  const end = toUtcDate(to, "to");
  const chunks = [];

  let cursor = start;
  while (cursor.getTime() < end.getTime()) {
    const nextMonthStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const chunkEnd = nextMonthStart.getTime() < end.getTime() ? nextMonthStart : end;
    chunks.push({ key: monthKeyOf(cursor), from: cursor, to: chunkEnd });
    cursor = chunkEnd;
  }

  return chunks;
}

function ohlcOf(row) {
  return { open: row.open, high: row.high, low: row.low, close: row.close };
}

/**
 * Merge same-month bid and ask bar rows into one row per timestamp.
 *
 * Bar timeframes hand back one price side per call, so a bid candle and an
 * ask candle for the same minute arrive as two separate rows that need to be
 * zipped together by timestamp. Bid and ask ticks don't always land on
 * identical bar boundaries -- a quiet minute can produce a bid tick with no
 * matching ask tick, or vice versa -- so a timestamp that exists on only one
 * side is kept, with the other side set to `null`, rather than dropped:
 * dropping it would silently shrink the series and hide a real gap in the
 * source data. `unmatched` counts those one-sided rows so the manifest can
 * surface how much of that happened without anyone having to scan the file.
 *
 * @param {object[]} bidRows - JsonItem rows fetched with priceType: 'bid'
 * @param {object[]} askRows - JsonItem rows fetched with priceType: 'ask'
 * @returns {{ rows: object[], unmatched: number }}
 */
export function mergeBidAsk(bidRows, askRows) {
  const byTimestamp = new Map();

  for (const row of bidRows) {
    byTimestamp.set(row.timestamp, {
      timestamp: row.timestamp,
      bid: ohlcOf(row),
      ask: null,
      volume: row.volume ?? null,
    });
  }

  for (const row of askRows) {
    const existing = byTimestamp.get(row.timestamp);
    if (existing) {
      existing.ask = ohlcOf(row);
      // Bid and ask are independent bar aggregations of the same tick
      // stream, so their volumes are almost always equal but not guaranteed
      // to be identical. There's no principled reason to prefer one side, so
      // we just need a single deterministic number -- keep whichever landed
      // first (bid, set above).
    } else {
      byTimestamp.set(row.timestamp, {
        timestamp: row.timestamp,
        bid: null,
        ask: ohlcOf(row),
        volume: row.volume ?? null,
      });
    }
  }

  const rows = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  const unmatched = rows.reduce(
    (count, row) => count + (row.bid === null || row.ask === null ? 1 : 0),
    0,
  );
  return { rows, unmatched };
}

/**
 * Normalise raw tick rows to the flatter `bid`/`ask` shape used everywhere
 * else in this tool. The package's JSON tick shape (`JsonItemTick`, read
 * from the installed package's type definitions) is
 * `{ timestamp, askPrice, bidPrice, askVolume?, bidVolume? }` -- a single
 * tick call already carries both sides, so unlike bar timeframes there is
 * nothing to merge here, just a rename and a defensive sort in case a future
 * package version stops guaranteeing ascending order.
 *
 * @param {object[]} rows - JsonItemTick-shaped rows from `getHistoricalRates`
 * @returns {object[]}
 */
export function normaliseTicks(rows) {
  return rows
    .map((row) => ({
      timestamp: row.timestamp,
      bid: row.bidPrice,
      ask: row.askPrice,
      bidVolume: row.bidVolume ?? null,
      askVolume: row.askVolume ?? null,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

function monthRange(fromKey, toKey) {
  const [fromYear, fromMonth] = fromKey.split("-").map(Number);
  const [toYear, toMonth] = toKey.split("-").map(Number);
  const keys = [];

  let year = fromYear;
  let month = fromMonth;
  while (year < toYear || (year === toYear && month <= toMonth)) {
    keys.push(`${year}-${pad2(month)}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return keys;
}

/**
 * Recompute a manifest entry's derived summary fields from its `months` map.
 * Rebuilt from scratch on every write rather than patched incrementally: a
 * field that is only ever patched can drift from reality if a run is
 * interrupted between updates, while a value rederived from `months` every
 * time cannot.
 *
 * @param {Record<string, { status: string }>} monthsMap
 * @returns {{
 *   coverage: { from: string | null, to: string | null },
 *   missingMonths: string[],
 *   failedMonths: string[],
 * }}
 */
export function rebuildManifestEntry(monthsMap) {
  const keys = Object.keys(monthsMap).sort();
  if (keys.length === 0) {
    return { coverage: { from: null, to: null }, missingMonths: [], failedMonths: [] };
  }

  const from = keys[0];
  const to = keys[keys.length - 1];
  const present = new Set(keys);
  const missingMonths = monthRange(from, to).filter((monthKey) => !present.has(monthKey));
  const failedMonths = keys.filter((monthKey) => monthsMap[monthKey]?.status === "failed");

  return { coverage: { from, to }, missingMonths, failedMonths };
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

async function readManifest(manifestPath) {
  try {
    const content = await readFile(manifestPath, "utf8");
    return JSON.parse(content);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    // A manifest that exists but won't parse means something is already
    // wrong with the output directory; refusing to continue beats silently
    // clobbering whatever caused it.
    throw new Error(`Cannot read existing manifest at ${manifestPath}: ${err.message}`);
  }
}

async function writeManifest(manifestPath, manifest) {
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function writeJsonl(filePath, rows) {
  await mkdir(dirname(filePath), { recursive: true });
  // JSONL, not a JSON array: every line is a complete, independently
  // parseable record, so a month file can be streamed instead of loaded
  // whole, and a reader can make sense of a file even if a future version of
  // this script starts appending to it incrementally.
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(filePath, rows.length > 0 ? `${body}\n` : "", "utf8");
}

async function monthFileExistsAndNonEmpty(filePath) {
  try {
    const stats = await stat(filePath);
    return stats.isFile() && stats.size > 0;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

function summarizeRows(rows) {
  if (rows.length === 0) return { firstTs: null, lastTs: null };
  return { firstTs: rows[0].timestamp, lastTs: rows[rows.length - 1].timestamp };
}

async function statsFromExistingFile(filePath) {
  const content = await readFile(filePath, "utf8");
  const rows = content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  const unmatched = rows.reduce(
    (count, row) => count + (row.bid === null || row.ask === null ? 1 : 0),
    0,
  );
  return { rows: rows.length, ...summarizeRows(rows), unmatched };
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * Fetch and normalise one calendar month of history for one instrument /
 * timeframe.
 *
 * `dukascopy-node` is imported here, lazily, instead of at module scope.
 * That keeps every function above importable -- and unit-testable -- in an
 * environment where the package isn't installed or reachable, which is
 * exactly the situation the test suite runs under (no network, and the
 * package deliberately isn't a dependency of this repo).
 */
async function fetchMonthRows({ instrument, timeframe, chunk, cacheDir }) {
  const { getHistoricalRates } = await import("dukascopy-node");

  const baseConfig = {
    instrument,
    dates: { from: chunk.from, to: chunk.to },
    format: "json",
    utcOffset: 0,
    volumes: true,
    ignoreFlats: true,
    batchSize: 10,
    pauseBetweenBatchesMs: 1000,
    useCache: true,
    cacheFolderPath: cacheDir,
    retryCount: 5,
    pauseBetweenRetriesMs: 500,
    failAfterRetryCount: true,
  };

  if (timeframe === "tick") {
    // A tick call already carries both sides in one row (JsonItemTick), so
    // there's only one request to make -- see normaliseTicks above.
    const rows = await getHistoricalRates({ ...baseConfig, timeframe: "tick" });
    return { rows: normaliseTicks(rows), unmatched: 0 };
  }

  // Bar timeframes return exactly one price side per call (verified against
  // the installed package's type definitions), so a real spread means
  // fetching bid and ask separately and merging them (see mergeBidAsk).
  // Sequential, bid then ask, rather than parallel: each call already
  // batches its own sub-requests with a pause between them, and firing both
  // sides at once would just double the concurrent load on Dukascopy's
  // servers for no real time saved.
  const bidRows = await getHistoricalRates({ ...baseConfig, timeframe, priceType: "bid" });
  const askRows = await getHistoricalRates({ ...baseConfig, timeframe, priceType: "ask" });
  return mergeBidAsk(bidRows, askRows);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  process.stdout.write(HELP_TEXT);
}

async function main() {
  const { values: args } = parseArgs({
    args: process.argv.slice(2),
    options: {
      instrument: { type: "string", default: "xauusd" },
      from: { type: "string" },
      to: { type: "string" },
      timeframe: { type: "string", default: "m1" },
      out: { type: "string", default: "data/history" },
      cache: { type: "string", default: ".dukascopy-cache" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (args.help) {
    printHelp();
    return;
  }

  if (!args.from || !args.to) {
    process.stderr.write("Error: --from and --to are required (YYYY-MM-DD). See --help.\n");
    process.exitCode = 1;
    return;
  }

  if (!TIMEFRAMES.includes(args.timeframe)) {
    process.stderr.write(
      `Error: --timeframe must be one of ${TIMEFRAMES.join(", ")}; got "${args.timeframe}".\n`,
    );
    process.exitCode = 1;
    return;
  }

  let fromDate;
  let toDate;
  try {
    fromDate = parseDateOnly(args.from, "--from");
    toDate = parseDateOnly(args.to, "--to");
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  const chunks = monthChunks(fromDate, toDate);
  if (chunks.length === 0) {
    process.stderr.write("Error: --to must be after --from -- nothing to fetch.\n");
    process.exitCode = 1;
    return;
  }

  const { instrument, timeframe, force, out: outRoot, cache: cacheDir } = args;
  const manifestPath = join(outRoot, "manifest.json");
  const key = `${instrument}/${timeframe}`;

  await mkdir(cacheDir, { recursive: true });

  const manifest = await readManifest(manifestPath);
  const months = { ...(manifest[key]?.months ?? {}) };
  const failedThisRun = [];

  process.stderr.write(
    `${key}: ${chunks.length} month(s) to check, ${args.from} to ${args.to}${force ? " (--force)" : ""}\n`,
  );

  for (const chunk of chunks) {
    const filePath = join(outRoot, instrument, timeframe, `${chunk.key}.jsonl`);
    const alreadyThere = await monthFileExistsAndNonEmpty(filePath);

    if (alreadyThere && !force) {
      process.stderr.write(`[skip]  ${chunk.key} -- output exists (use --force to refetch)\n`);
      if (!months[chunk.key] || months[chunk.key].status !== "ok") {
        // The file is on disk but the manifest doesn't know about it (a
        // deleted manifest, or an out dir seeded some other way). Recover
        // the record from the file itself instead of hitting the network,
        // so the manifest stays truthful without breaking the resume
        // contract of "skip means no request".
        try {
          const stats = await statsFromExistingFile(filePath);
          months[chunk.key] = { ...stats, fetchedAt: new Date().toISOString(), status: "ok" };
        } catch (err) {
          process.stderr.write(
            `[warn]  ${chunk.key}: couldn't read existing file for the manifest (${err.message})\n`,
          );
        }
      }
    } else {
      process.stderr.write(`[fetch] ${chunk.key}\n`);
      try {
        const { rows, unmatched } = await fetchMonthRows({
          instrument,
          timeframe,
          chunk,
          cacheDir,
        });
        await writeJsonl(filePath, rows);
        months[chunk.key] = {
          rows: rows.length,
          ...summarizeRows(rows),
          unmatched,
          fetchedAt: new Date().toISOString(),
          status: "ok",
        };
        process.stderr.write(`[done]  ${chunk.key}: ${rows.length} rows, ${unmatched} unmatched\n`);
      } catch (err) {
        // Never let one bad month kill the run: record the failure and move
        // on, so the months on either side of it still get fetched.
        const message = err instanceof Error ? err.message : String(err);
        months[chunk.key] = {
          status: "failed",
          error: message,
          fetchedAt: new Date().toISOString(),
        };
        failedThisRun.push(chunk.key);
        process.stderr.write(`[FAIL]  ${chunk.key}: ${message}\n`);
      }
    }

    // Rebuilt and written after every month, not just at the end: if this
    // process is killed mid-backfill, everything fetched so far is already
    // on disk and recorded, and the next run resumes instead of restarting.
    manifest[key] = { months, ...rebuildManifestEntry(months) };
    await writeManifest(manifestPath, manifest);
  }

  if (failedThisRun.length > 0) {
    process.stderr.write(
      `\n${failedThisRun.length}/${chunks.length} month(s) failed: ${failedThisRun.join(", ")}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stderr.write(`\nDone: ${chunks.length} month(s) for ${key}.\n`);
  }
}

const isMainModule =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  });
}
