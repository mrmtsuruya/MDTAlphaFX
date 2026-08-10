import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.MDT_CLI_BRIDGE_PORT ?? 43127);
const MAX_BODY_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const CONSULT_TIMEOUT_MS = 120_000;
const WORK_DIR = join(tmpdir(), "mdtalpha-cli-consult");
const ALLOWED_ORIGINS = new Set(
  (process.env.MDT_CLI_BRIDGE_ORIGINS ?? "http://127.0.0.1:8080,http://localhost:8080")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

await mkdir(WORK_DIR, { recursive: true });

class BridgeError extends Error {
  constructor(message, statusCode = 500, nextAction = "Retry the request.") {
    super(message);
    this.statusCode = statusCode;
    this.nextAction = nextAction;
  }
}

class ProviderAuthError extends BridgeError {
  constructor(provider, message, nextAction) {
    super(message, 503, nextAction);
    this.provider = provider;
  }
}

function setCorsHeaders(request, response) {
  const origin = request.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Private-Network", "true");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
}

function assertAllowedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    throw new BridgeError("Request origin is not allowed.", 403, "Open MDTAlphaFX locally.");
  }
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        reject(new BridgeError("Request body is too large.", 413, "Send one signal at a time."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new BridgeError("Request body must be valid JSON.", 400));
      }
    });
    request.on("error", reject);
  });
}

function runProcess(command, args, input, timeoutMs = CONSULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        TERM: "dumb",
      },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const failForOutputSize = () => {
      child.kill();
      finish(() =>
        reject(
          new BridgeError(
            `${command} returned too much output.`,
            502,
            "Retry with a shorter signal context.",
          ),
        ),
      );
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) failForOutputSize();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (Buffer.byteLength(stderr, "utf8") > MAX_OUTPUT_BYTES) failForOutputSize();
    });
    child.on("error", (error) => {
      finish(() =>
        reject(
          new BridgeError(
            `${command} could not start: ${error.message}`,
            503,
            `Confirm ${command} is installed and authenticated.`,
          ),
        ),
      );
    });
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
          return;
        }
        reject(
          new BridgeError(
            `${command} exited with code ${code}: ${stderr.trim() || stdout.trim() || "No details returned."}`,
            502,
            `Run ${command} directly once and confirm its login is active.`,
          ),
        );
      });
    });

    timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(
          new BridgeError(
            `${command} timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
            504,
            "Retry once; stop if the CLI remains unresponsive.",
          ),
        ),
      );
    }, timeoutMs);

    child.stdin.end(input);
  });
}

function requiredString(value, field, pattern = /^[\w./:-]+$/) {
  if (typeof value !== "string" || value.length < 1 || value.length > 80 || !pattern.test(value)) {
    throw new BridgeError(`Invalid signal field: ${field}.`, 400);
  }
  return value;
}

function requiredNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BridgeError(`Invalid signal field: ${field}.`, 400);
  }
  return value;
}

function validateConsultPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new BridgeError("Request payload must be an object.", 400);
  }
  if (payload.provider !== "codex" && payload.provider !== "claude") {
    throw new BridgeError("Provider must be codex or claude.", 400);
  }
  const signal = payload.signal;
  if (!signal || typeof signal !== "object" || Array.isArray(signal)) {
    throw new BridgeError("Signal is required.", 400);
  }

  const direction = requiredString(signal.direction, "direction");
  if (direction !== "long" && direction !== "short") {
    throw new BridgeError("Invalid signal field: direction.", 400);
  }
  const mode = requiredString(signal.mode, "mode");
  if (mode !== "intraday" && mode !== "scalper") {
    throw new BridgeError("Invalid signal field: mode.", 400);
  }
  const strategies = Array.isArray(signal.strategies)
    ? signal.strategies
        .slice(0, 28)
        .map((strategy) => requiredString(strategy, "strategies", /^[\w-]+$/))
    : [];

  return {
    provider: payload.provider,
    signal: {
      pair: requiredString(signal.pair, "pair", /^[A-Z]{6}$/),
      direction,
      mode,
      timeframe: requiredString(signal.timeframe, "timeframe", /^[A-Z0-9]+$/),
      entry: requiredNumber(signal.entry, "entry"),
      stopLoss: requiredNumber(signal.stopLoss, "stopLoss"),
      takeProfit1: requiredNumber(signal.takeProfit1, "takeProfit1"),
      takeProfit2: requiredNumber(signal.takeProfit2, "takeProfit2"),
      atr: requiredNumber(signal.atr, "atr"),
      confluence: requiredNumber(signal.confluence, "confluence"),
      status: requiredString(signal.status, "status", /^[\w-]+$/),
      verified: signal.verified === true,
      strategies,
    },
  };
}

function buildSignalPrompt(signal) {
  const dataQuality = signal.verified ? "VERIFIED_OANDA" : "UNVERIFIED_LEGACY_SYNTHETIC";
  return `You are a disciplined, risk-first forex signal reviewer.

Analyze only the structured signal below. Do not use tools, browse, inspect files, execute commands, or infer missing live-market facts.
If DATA_QUALITY is UNVERIFIED_LEGACY_SYNTHETIC, the verdict must be SKIP and the reason must clearly say the price data is not trustworthy.
This is decision support, not a guarantee of profit.

SIGNAL
PAIR: ${signal.pair}
DIRECTION: ${signal.direction.toUpperCase()}
MODE: ${signal.mode.toUpperCase()}
TIMEFRAME: ${signal.timeframe}
ENTRY: ${signal.entry}
STOP_LOSS: ${signal.stopLoss}
TAKE_PROFIT_1: ${signal.takeProfit1}
TAKE_PROFIT_2: ${signal.takeProfit2}
ATR: ${signal.atr}
CONFLUENCE: ${signal.confluence}
STATUS: ${signal.status}
DATA_QUALITY: ${dataQuality}
EVALUATED_STRATEGIES: ${signal.strategies.join(", ") || "NONE"}

Return exactly these four lines:
VERDICT: TAKE | SKIP | WAIT
REASON: one concise sentence
RISK: one concise sentence
CHECK: the single most important condition to verify before acting`;
}

async function runCodex(prompt) {
  let stdout;
  try {
    ({ stdout } = await runProcess(
      "codex",
      [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--color",
        "never",
        "--cd",
        WORK_DIR,
        "-",
      ],
      prompt,
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/\b401\b|not logged in|authentication/i.test(message)) {
      throw new ProviderAuthError(
        "codex",
        "Codex authentication expired.",
        "Run codex login, then restart the local CLI bridge.",
      );
    }
    throw new BridgeError(
      "Codex could not complete this consult.",
      502,
      "Run codex directly to inspect the local CLI error.",
    );
  }
  if (!stdout) throw new BridgeError("Codex returned an empty response.", 502);
  return stdout;
}

async function runClaude(prompt) {
  let stdout;
  try {
    ({ stdout } = await runProcess(
      "claude",
      [
        "-p",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--tools",
        "",
        "--safe-mode",
        "--permission-mode",
        "dontAsk",
      ],
      prompt,
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/\b401\b|failed to authenticate|token has been revoked/i.test(message)) {
      throw new ProviderAuthError(
        "claude",
        "Claude Code authentication expired.",
        "Run claude auth login, then restart the local CLI bridge.",
      );
    }
    throw new BridgeError(
      "Claude Code could not complete this consult.",
      502,
      "Run claude directly to inspect the local CLI error.",
    );
  }
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new BridgeError("Claude returned malformed JSON.", 502);
  }
  if (payload.is_error || typeof payload.result !== "string" || !payload.result.trim()) {
    throw new BridgeError(payload.result || "Claude returned an empty response.", 502);
  }
  return payload.result.trim();
}

async function checkProvider(command, authArgs) {
  let version;
  try {
    const versionResult = await runProcess(command, ["--version"], "", 10_000);
    version = versionResult.stdout || versionResult.stderr;
  } catch {
    return {
      available: false,
      authenticated: false,
      version: null,
      detail: `${command} is not installed or is not on PATH.`,
    };
  }

  try {
    const authResult = await runProcess(command, authArgs, "", 10_000);
    const authOutput = authResult.stdout || authResult.stderr;
    const authenticated =
      command === "claude"
        ? JSON.parse(authOutput).loggedIn === true
        : /\blogged in\b/i.test(authOutput);
    return {
      available: true,
      authenticated,
      version,
      detail: authenticated ? "Authenticated" : "Authentication required.",
    };
  } catch {
    return {
      available: true,
      authenticated: false,
      version,
      detail: "Authentication required.",
    };
  }
}

let providerStatusPromise;
let providerStatusCheckedAt = 0;
const runtimeAuthFailures = new Set();

function getProviderStatus() {
  if (!providerStatusPromise || Date.now() - providerStatusCheckedAt > 10_000) {
    providerStatusCheckedAt = Date.now();
    providerStatusPromise = Promise.all([
      checkProvider("codex", ["login", "status"]),
      checkProvider("claude", ["auth", "status"]),
    ]).then(([codex, claude]) => {
      const providers = { codex, claude };
      for (const provider of runtimeAuthFailures) {
        providers[provider].authenticated = false;
        providers[provider].detail = "Authentication required.";
      }
      return providers;
    });
  }
  return providerStatusPromise;
}

let activeConsults = 0;

const server = createServer(async (request, response) => {
  setCorsHeaders(request, response);

  if (request.method === "OPTIONS") {
    if (request.headers.origin && ALLOWED_ORIGINS.has(request.headers.origin)) {
      response.statusCode = 204;
      response.end();
    } else {
      sendJson(response, 403, { status: "error", summary: "Origin not allowed." });
    }
    return;
  }

  try {
    assertAllowedOrigin(request);
    const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);

    if (request.method === "GET" && url.pathname === "/health") {
      const providers = await getProviderStatus();
      sendJson(response, 200, {
        status: "success",
        summary: "Local CLI bridge is ready.",
        next_actions: [],
        artifacts: [],
        providers,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/consult") {
      if (activeConsults >= 2) {
        throw new BridgeError(
          "The local CLI bridge is busy.",
          429,
          "Wait for the active consult to finish.",
        );
      }
      const { provider, signal } = validateConsultPayload(await readJsonBody(request));
      const providers = await getProviderStatus();
      if (!providers[provider].available || !providers[provider].authenticated) {
        throw new BridgeError(
          `${provider} is not ready.`,
          503,
          `Run ${provider === "claude" ? "claude auth status" : "codex login status"} locally.`,
        );
      }

      activeConsults += 1;
      const startedAt = Date.now();
      try {
        const prompt = buildSignalPrompt(signal);
        let output;
        try {
          output = provider === "codex" ? await runCodex(prompt) : await runClaude(prompt);
        } catch (error) {
          if (error instanceof ProviderAuthError) {
            runtimeAuthFailures.add(error.provider);
            providers[error.provider].authenticated = false;
            providers[error.provider].detail = "Authentication required.";
            providerStatusCheckedAt = Date.now();
          }
          throw error;
        }
        sendJson(response, 200, {
          status: "success",
          summary: `${provider} consult completed.`,
          next_actions: signal.verified
            ? ["Verify the current market price before acting."]
            : ["Connect verified market data before requesting an actionable verdict."],
          artifacts: [],
          provider,
          output,
          duration_ms: Date.now() - startedAt,
        });
      } finally {
        activeConsults -= 1;
      }
      return;
    }

    throw new BridgeError("Route not found.", 404, "Use /health or /consult.");
  } catch (error) {
    const bridgeError =
      error instanceof BridgeError
        ? error
        : new BridgeError(error instanceof Error ? error.message : String(error));
    sendJson(response, bridgeError.statusCode, {
      status: "error",
      summary: bridgeError.message,
      next_actions: [bridgeError.nextAction],
      artifacts: [],
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MDTAlphaFX CLI bridge listening on http://${HOST}:${PORT}`);
  console.log(`Allowed origins: ${[...ALLOWED_ORIGINS].join(", ")}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
