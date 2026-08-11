// Web-standard HTTP boundary for the auto-paper worker.
//
// This is the ONLY place a request can touch the cycle, and it accepts
// exactly one shape: POST with a correct x-worker-secret and an empty JSON
// object body. The request can never supply a user id, symbol, lot size,
// strategy ids, or a provider URL — those come from the database and the
// worker's own environment. Failures return generic responses: no stack
// traces, no tokens, no internal detail.

import type { WorkerRunCounts } from "./xauusd-paper-worker.ts";

const JSON_HEADERS = { "content-type": "application/json" };

/** Constant-time comparison via SHA-256 digests (Node + Edge compatible). */
async function digestEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(a)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(b)),
  ]);
  const ua = new Uint8Array(da);
  const ub = new Uint8Array(db);
  if (ua.length !== ub.length) return false;
  let difference = 0;
  for (let i = 0; i < ua.length; i += 1) difference |= ua[i] ^ ub[i];
  return difference === 0;
}

export function createWorkerHandler(opts: {
  expectedSecret: string;
  runCycle: () => Promise<WorkerRunCounts>;
}): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "method_not_allowed" }), {
          status: 405,
          headers: JSON_HEADERS,
        });
      }
      const supplied = req.headers.get("x-worker-secret") ?? "";
      if (!(await digestEqual(supplied, opts.expectedSecret))) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: JSON_HEADERS,
        });
      }
      const body = (await req.text()).trim();
      if (body !== "" && body !== "{}") {
        return new Response(JSON.stringify({ error: "invalid_body" }), {
          status: 400,
          headers: JSON_HEADERS,
        });
      }
      const counts = await opts.runCycle();
      return new Response(JSON.stringify(counts), { status: 200, headers: JSON_HEADERS });
    } catch {
      return new Response(JSON.stringify({ error: "worker_failed" }), {
        status: 503,
        headers: JSON_HEADERS,
      });
    }
  };
}
