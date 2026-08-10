import assert from "node:assert/strict";
import test from "node:test";
import { costsFor, DEFAULT_COSTS, halfSpread } from "./costs.ts";

test("costsFor: known-pair lookup returns the seeded cost record", () => {
  assert.deepEqual(costsFor("XAUUSD"), {
    spread: 0.2,
    commissionPerMicroLot: 0,
    contractSize: 100,
  });
  assert.deepEqual(costsFor("BTCUSD"), { spread: 5, commissionPerMicroLot: 0, contractSize: 1 });
  assert.deepEqual(costsFor("ETHUSD"), { spread: 0.5, commissionPerMicroLot: 0, contractSize: 1 });
  // costsFor should read from the exported table, not a private copy of it.
  assert.deepEqual(costsFor("XAUUSD"), DEFAULT_COSTS.XAUUSD);
});

test("costsFor: JPY pairs get the 3-decimal 0.3-pip spread, not the 5-decimal default", () => {
  for (const pair of ["USDJPY", "EURJPY", "GBPJPY", "AUDJPY"]) {
    assert.equal(costsFor(pair).spread, 0.003, `${pair} should use the JPY spread`);
    assert.equal(costsFor(pair).contractSize, 100_000);
  }
  // A non-JPY major isn't seeded, so it must fall through to the generic
  // 5-decimal default rather than accidentally reusing the JPY entry.
  assert.equal(costsFor("EURUSD").spread, 0.00003);
  assert.notEqual(costsFor("EURUSD").spread, costsFor("USDJPY").spread);
});

test("costsFor: an unlisted pair falls back to the generic FX entry instead of throwing", () => {
  assert.deepEqual(costsFor("NZDCHF"), {
    spread: 0.00003,
    commissionPerMicroLot: 0,
    contractSize: 100_000,
  });
  assert.deepEqual(costsFor("TOTALLY_UNKNOWN"), costsFor("EURUSD"));
});

test("halfSpread is exactly half of costsFor(pair).spread", () => {
  for (const pair of ["XAUUSD", "USDJPY", "EURUSD", "BTCUSD", "ETHUSD", "NZDCHF"]) {
    assert.equal(halfSpread(pair), costsFor(pair).spread / 2);
  }
  assert.equal(halfSpread("XAUUSD"), 0.1);
  assert.equal(halfSpread("BTCUSD"), 2.5);
});
