import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRisk, computeRiskDistance } from "./risk-engine.js";
import type { SymbolRules } from "../exchange/exchange-info.js";

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

test("computeRiskDistance for BUY: entry minus stopLoss", () => {
  assert.equal(computeRiskDistance("BUY", 150, 145), 5);
});

test("computeRiskDistance for SELL: stopLoss minus entry", () => {
  assert.equal(computeRiskDistance("SELL", 150, 155), 5);
});

test("evaluateRisk approves a valid BUY within all constraints", () => {
  const decision = evaluateRisk(
    { side: "BUY", entryPrice: 150, stopLoss: 145, riskAmountUsd: 25, maxPositionUsd: 500 },
    SOLUSDC_RULES
  );
  assert.equal(decision.approved, true);
  assert.equal(decision.riskDistance, 5);
  // rawQuantity = 25 / 5 = 5
  assert.equal(decision.rawQuantity, 5);
  assert.ok(decision.quantity! <= 5);
  assert.ok(decision.notionalUsd! <= 500 + 1); // within max position cap
});

test("evaluateRisk rejects zero risk distance", () => {
  const decision = evaluateRisk(
    { side: "BUY", entryPrice: 150, stopLoss: 150, riskAmountUsd: 25, maxPositionUsd: 500 },
    SOLUSDC_RULES
  );
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /riskDistance/);
});

test("evaluateRisk rejects negative risk distance (stop on wrong side for BUY)", () => {
  const decision = evaluateRisk(
    { side: "BUY", entryPrice: 150, stopLoss: 155, riskAmountUsd: 25, maxPositionUsd: 500 },
    SOLUSDC_RULES
  );
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /riskDistance/);
});

test("evaluateRisk rejects negative risk distance (stop on wrong side for SELL)", () => {
  const decision = evaluateRisk(
    { side: "SELL", entryPrice: 150, stopLoss: 145, riskAmountUsd: 25, maxPositionUsd: 500 },
    SOLUSDC_RULES
  );
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /riskDistance/);
});

test("evaluateRisk rejects NaN/Infinity inputs", () => {
  assert.equal(
    evaluateRisk({ side: "BUY", entryPrice: NaN, stopLoss: 145, riskAmountUsd: 25, maxPositionUsd: 500 }, SOLUSDC_RULES).approved,
    false
  );
  assert.equal(
    evaluateRisk({ side: "BUY", entryPrice: 150, stopLoss: 145, riskAmountUsd: Infinity, maxPositionUsd: 500 }, SOLUSDC_RULES).approved,
    false
  );
});

test("evaluateRisk rejects zero or negative riskAmountUsd / maxPositionUsd", () => {
  assert.equal(
    evaluateRisk({ side: "BUY", entryPrice: 150, stopLoss: 145, riskAmountUsd: 0, maxPositionUsd: 500 }, SOLUSDC_RULES).approved,
    false
  );
  assert.equal(
    evaluateRisk({ side: "BUY", entryPrice: 150, stopLoss: 145, riskAmountUsd: 25, maxPositionUsd: -1 }, SOLUSDC_RULES).approved,
    false
  );
});

test("evaluateRisk caps notional at maxPositionUsd even when risk math implies more", () => {
  // Very tight stop -> huge raw quantity implied by risk math alone
  const decision = evaluateRisk(
    { side: "BUY", entryPrice: 150, stopLoss: 149.99, riskAmountUsd: 25, maxPositionUsd: 100 },
    SOLUSDC_RULES
  );
  assert.equal(decision.approved, true);
  assert.ok(decision.notionalUsd! <= 100 + 1); // capped, not the raw risk-implied size
});

test("evaluateRisk never approves a quantity implying more risk than requested after flooring", () => {
  const decision = evaluateRisk(
    { side: "BUY", entryPrice: 150, stopLoss: 145, riskAmountUsd: 25, maxPositionUsd: 500 },
    SOLUSDC_RULES
  );
  assert.equal(decision.approved, true);
  const actualRisk = decision.quantity! * decision.riskDistance!;
  assert.ok(actualRisk <= 25.01);
});

test("evaluateRisk rejects when normalized quantity falls below exchange minQty", () => {
  // riskDistance = 5, riskAmountUsd = 0.001 -> rawQuantity = 0.0002,
  // which floors to 0 at stepSize 0.001 and is below minQty 0.001.
  const decision = evaluateRisk(
    { side: "BUY", entryPrice: 150, stopLoss: 145, riskAmountUsd: 0.001, maxPositionUsd: 500 },
    SOLUSDC_RULES
  );
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /minQty/);
});
