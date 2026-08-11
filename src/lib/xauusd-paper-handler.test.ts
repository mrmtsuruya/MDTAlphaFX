import assert from "node:assert/strict";
import test from "node:test";
import { createWorkerHandler } from "./xauusd-paper-handler.ts";

const SECRET = "worker-secret-abc";
const JSON_HEADERS = { "content-type": "application/json" };

type Counts = {
  profiles: number;
  scans: number;
  signals: number;
  transitions: number;
  failures: number;
};

function buildHandler(opts: { runCycle?: () => Promise<Counts>; secret?: string } = {}) {
  return createWorkerHandler({
    expectedSecret: opts.secret ?? SECRET,
    runCycle:
      opts.runCycle ??
      (async () => ({ profiles: 1, scans: 2, signals: 1, transitions: 3, failures: 0 })),
  });
}

function post(body: string | null, secret?: string): Request {
  return new Request("https://function/xauusd-paper-worker", {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      ...(secret ? { "x-worker-secret": secret } : {}),
    },
    body: body ?? undefined,
  });
}

test("missing or wrong secret returns 401", async () => {
  const handler = buildHandler();
  assert.equal((await handler(post("{}"))).status, 401);
  assert.equal((await handler(post("{}", "wrong-secret"))).status, 401);
});

test("only POST is accepted", async () => {
  const handler = buildHandler();
  const get = new Request("https://function/xauusd-paper-worker", {
    method: "GET",
    headers: { "x-worker-secret": SECRET },
  });
  const response = await handler(get);
  assert.equal(response.status, 405);
});

test("a non-empty body other than an empty JSON object returns 400", async () => {
  const handler = buildHandler();
  const withPayload = await handler(post(JSON.stringify({ userId: "attacker" }), SECRET));
  assert.equal(withPayload.status, 400);
  const malformed = await handler(post("not json", SECRET));
  assert.equal(malformed.status, 400);
});

test("valid secret plus an empty object returns 200 with bounded counters", async () => {
  let called = false;
  const handler = buildHandler({
    runCycle: async () => {
      called = true;
      return { profiles: 2, scans: 4, signals: 1, transitions: 5, failures: 0 };
    },
  });
  const response = await handler(post("{}", SECRET));
  assert.equal(response.status, 200);
  assert.equal(called, true);
  const body = (await response.json()) as Record<string, number>;
  assert.deepEqual(body, { profiles: 2, scans: 4, signals: 1, transitions: 5, failures: 0 });
  // Bounded: no request-supplied user, symbol, lot, strategy ids, or provider URL may be echoed.
  assert.equal("userId" in body, false);
});

test("an empty body is accepted as the empty object", async () => {
  const handler = buildHandler();
  assert.equal((await handler(post("", SECRET))).status, 200);
});

test("a thrown worker error returns a generic 503 without stack or token leakage", async () => {
  const handler = buildHandler({
    runCycle: async () => {
      throw new Error("secret leak: " + SECRET);
    },
  });
  const response = await handler(post("{}", SECRET));
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.doesNotMatch(text, /stack|secret-abc/i);
  assert.match(text, /worker_failed/i);
});
