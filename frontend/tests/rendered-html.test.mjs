import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the operator console with an explicit simulation boundary", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /MDTAlphaFX Operator Console/);
  assert.match(html, /Market Overview/);
  assert.match(html, /SIMULATION INTERFACE/);
  assert.match(html, /ENGINE DISCONNECTED/);
  assert.match(html, /No live price feed/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
});

test("server-renders every product route", async () => {
  const expectations = [
    ["/signals", /Signal Center/],
    ["/chart", /Price and evidence/],
    ["/strategies", /Module catalogue/],
    ["/backtester", /Stage 0 evidence/],
  ];

  for (const [pathname, pattern] of expectations) {
    const response = await render(pathname);
    assert.equal(response.status, 200, pathname);
    assert.match(await response.text(), pattern, pathname);
  }
});
