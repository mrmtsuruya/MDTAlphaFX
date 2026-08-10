export type LocalCliProvider = "codex" | "claude";

export type LocalCliProviderStatus = {
  available: boolean;
  authenticated: boolean;
  version: string | null;
  detail: string;
};

export type LocalCliHealth = {
  status: "success";
  summary: string;
  next_actions: string[];
  artifacts: string[];
  providers: Record<LocalCliProvider, LocalCliProviderStatus>;
};

export type LocalCliSignal = {
  pair: string;
  direction: "long" | "short";
  mode: "intraday" | "scalper";
  timeframe: string;
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  atr: number;
  confluence: number;
  status: string;
  verified: boolean;
  strategies: string[];
};

export type LocalCliConsultResult = {
  status: "success";
  summary: string;
  next_actions: string[];
  artifacts: string[];
  provider: LocalCliProvider;
  output: string;
  duration_ms: number;
};

const BRIDGE_URL = (import.meta.env.VITE_LOCAL_CLI_BRIDGE_URL ?? "http://127.0.0.1:43127").replace(
  /\/$/,
  "",
);

async function bridgeRequest<T>(path: string, init?: RequestInit, timeoutMs = 3_000): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BRIDGE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
      signal: controller.signal,
    });
    const payload = (await response.json()) as T & {
      status?: string;
      summary?: string;
      next_actions?: string[];
    };
    if (!response.ok) {
      throw new Error(
        [payload.summary, payload.next_actions?.[0]].filter(Boolean).join(" ") ||
          `Local CLI bridge failed (${response.status}).`,
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Local CLI bridge timed out.");
    }
    if (error instanceof TypeError) {
      throw new Error("Local CLI bridge is offline. Run npm run cli:bridge.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function getLocalCliHealth() {
  return bridgeRequest<LocalCliHealth>("/health");
}

export function consultSignalWithLocalCli(provider: LocalCliProvider, signal: LocalCliSignal) {
  return bridgeRequest<LocalCliConsultResult>(
    "/consult",
    {
      method: "POST",
      body: JSON.stringify({ provider, signal }),
    },
    125_000,
  );
}
