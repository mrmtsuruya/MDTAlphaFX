// XAUUSD auto-paper worker Edge Function (Deno).
//
// Thin seam: reads the three environment secrets, constructs the keyless
// market-data provider (TradingView quotes + Yahoo candles — no broker
// account) and the service-role repository, and delegates every request to
// the tested createWorkerHandler. There is deliberately no order-capable
// code anywhere in this graph, and the request boundary accepts only the
// cron's empty POST.

import { createClient } from "@supabase/supabase-js";
import { createTvKeylessXauusdProvider } from "../../../src/lib/tv-keyless-provider.ts";
import { createSupabasePaperRepository } from "../../../src/lib/xauusd-paper-repository.ts";
import { runXauusdPaperCycle } from "../../../src/lib/xauusd-paper-worker.ts";
import { createWorkerHandler } from "../../../src/lib/xauusd-paper-handler.ts";

const WORKER_ENGINE_VERSION = "engine-2026-08-11-v1";
const WORKER_POLICY_VERSION = "policy-2026-08-11-v1";

function buildHandler() {
  const secret = Deno.env.get("XAUUSD_WORKER_CRON_SECRET") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  return createWorkerHandler({
    expectedSecret: secret,
    runCycle: async () => {
      if (!supabaseUrl || !serviceRoleKey) {
        throw new Error("worker_unconfigured");
      }
      const client = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      return runXauusdPaperCycle({
        now: () => new Date(),
        provider: createTvKeylessXauusdProvider(),
        repository: createSupabasePaperRepository(client),
        engineVersion: WORKER_ENGINE_VERSION,
        policyVersion: WORKER_POLICY_VERSION,
      });
    },
  });
}

const handler = buildHandler();

Deno.serve((req) => handler(req));
