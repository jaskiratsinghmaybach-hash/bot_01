import { test } from "node:test";
import assert from "node:assert/strict";
import { floorToStep, normalizeOrder } from "./precision.js";
import type { SymbolRules } from "./exchange-info.js";

test("floorToStep truncates toward zero at the step boundary, never rounds up", () => {
  assert.equal(floorToStep(1.23456, 0.001), 1.234);
  assert.equal(floorToStep(9.9999, 0.1), 9.9);
  assert.equal(floorToStep(1.999999999, 0.001), 1.999);
});

test("floorToStep is immune to classic binary float drift (0.1 + 0.2)", () => {
  assert.equal(floorToStep(0.1 + 0.2, 0.01), 0.3);
  assert.equal(floorToStep(0.1 + 0.2, 0.1), 0.3);
});

test("floorToStep handles exact multiples without drifting down a full step", () => {
  assert.equal(floorToStep(100, 1), 100);
  assert.equal(floorToStep(0.003, 0.001), 0.003);
  assert.equal(floorToStep(50, 0.1), 50);
});

test("floorToStep supports Binance's smallest real tick size (1e-8)", () => {
  assert.equal(floorToStep(0.00000001, 0.00000001), 0.00000001);
});

test("floorToStep throws on non-finite or non-positive step", () => {
  assert.throws(() => floorToStep(1, 0));
  assert.throws(() => floorToStep(1, -0.01));
  assert.throws(() => floorToStep(NaN, 0.01));
  assert.throws(() => floorToStep(Infinity, 0.01));
});

const SOLUSDC_RULES: SymbolRules = {
  symbol: "SOLUSDC",
  baseAsset: "SOL",
  quoteAsset: "USDC",
  tickSize: 0.01,
  minPrice: 0.01,
  maxPrice: 100000,
  stepSize: 0.001,
  minQty: 0.001,
  maxQty: 92141578,
  minNotional: 5,
};

test("normalizeOrder accepts a well-formed order within all limits", () => {
  const result = normalizeOrder(1.23456, 150.789, SOLUSDC_RULES);
  assert.equal(result.valid, true);
  assert.equal(result.quantity, 1.234);
  assert.equal(result.price, 150.78);
  assert.ok(result.notional > SOLUSDC_RULES.minNotional!);
});

test("normalizeOrder rejects (not silently bumps) quantity below minQty after flooring", () => {
  const result = normalizeOrder(0.0005, 150, SOLUSDC_RULES);
  assert.equal(result.valid, false);
  assert.match(result.rejectionReason ?? "", /minQty/);
});

test("normalizeOrder rejects orders below minNotional", () => {
  const result = normalizeOrder(0.001, 150, SOLUSDC_RULES); // notional ~= 0.15
  assert.equal(result.valid, false);
  assert.match(result.rejectionReason ?? "", /minNotional/);
});

test("normalizeOrder rejects non-finite or non-positive raw quantity/price", () => {
  assert.equal(normalizeOrder(NaN, 150, SOLUSDC_RULES).valid, false);
  assert.equal(normalizeOrder(-1, 150, SOLUSDC_RULES).valid, false);
  assert.equal(normalizeOrder(1, NaN, SOLUSDC_RULES).valid, false);
  assert.equal(normalizeOrder(1, -150, SOLUSDC_RULES).valid, false);
});

test("normalizeOrder never returns a quantity greater than the raw input (floor-only guarantee)", () => {
  const result = normalizeOrder(1.9999, 150, SOLUSDC_RULES);
  assert.equal(result.valid, true);
  assert.ok(result.quantity! <= 1.9999);
});
