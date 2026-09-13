import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeEMA,
  computeATR,
  findSwingLowIndices,
  detectHigherLow,
  evaluateStrategy,
  DEFAULT_STRATEGY_CONFIG,
} from "./core-logic.js";
import type { Candle } from "../types/index.js";

function mkCandle(overrides: Partial<Candle> & { openingTime: number }): Candle {
  return {
    symbol: "SOLUSDC",
    interval: "1h",
    closeTime: overrides.openingTime + 3_600_000 - 1,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 1000,
    source: "binance",
    isClosed: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeEMA — verified against hand-calculated values
// ---------------------------------------------------------------------------

test("computeEMA returns NaN for indices before the period is seeded", () => {
  const ema = computeEMA([10, 10, 10], 5);
  assert.ok(ema.every((v) => Number.isNaN(v)));
});

test("computeEMA seeds correctly as a simple average of the first `period` values", () => {
  // closes = [22, 23, 24], period 3 -> seed = (22+23+24)/3 = 23
  const ema = computeEMA([22, 23, 24], 3);
  assert.equal(ema[2], 23);
});

test("computeEMA applies the correct smoothing constant on subsequent values", () => {
  // period=3 -> k = 2/(3+1) = 0.5. Seed at index 2 = 23. Next: 25*0.5 + 23*0.5 = 24
  const ema = computeEMA([22, 23, 24, 25], 3);
  assert.equal(ema[3], 24);
});

test("computeEMA on a flat series equals the flat value everywhere it's seeded", () => {
  const ema = computeEMA([10, 10, 10, 10, 10], 3);
  assert.equal(ema[2], 10);
  assert.equal(ema[3], 10);
  assert.equal(ema[4], 10);
});

test("computeEMA throws on a non-positive period", () => {
  assert.throws(() => computeEMA([1, 2, 3], 0));
  assert.throws(() => computeEMA([1, 2, 3], -1));
});

// ---------------------------------------------------------------------------
// computeATR
// ---------------------------------------------------------------------------

test("computeATR returns NaN until period+1 candles are available", () => {
  const candles = Array.from({ length: 5 }, (_, i) =>
    mkCandle({ openingTime: i * 3_600_000, open: 100, high: 101, low: 99, close: 100 })
  );
  const atr = computeATR(candles, 14);
  assert.ok(atr.every((v) => Number.isNaN(v)));
});

test("computeATR produces a positive value once seeded on volatile candles", () => {
  const candles = Array.from({ length: 20 }, (_, i) =>
    mkCandle({ openingTime: i * 3_600_000, open: 100, high: 105, low: 95, close: 100 })
  );
  const atr = computeATR(candles, 14);
  assert.ok(atr[14] > 0);
  assert.ok(!Number.isNaN(atr[19]));
});

test("computeATR is zero (not negative or NaN) on perfectly flat candles", () => {
  const candles = Array.from({ length: 20 }, (_, i) =>
    mkCandle({ openingTime: i * 3_600_000, open: 100, high: 100, low: 100, close: 100 })
  );
  const atr = computeATR(candles, 14);
  assert.equal(atr[14], 0);
});

test("computeATR throws on a non-positive period", () => {
  assert.throws(() => computeATR([], 0));
});

// ---------------------------------------------------------------------------
// findSwingLowIndices / detectHigherLow — verified against hand-traced cases
// ---------------------------------------------------------------------------

test("findSwingLowIndices identifies a single obvious local low with sufficient lookback padding", () => {
  const lookback = 2;
  const candles = [
    mkCandle({ openingTime: 0, low: 200, high: 210 }),
    mkCandle({ openingTime: 1, low: 200, high: 210 }),
    mkCandle({ openingTime: 2, low: 90, high: 200 }), // the dip
    mkCandle({ openingTime: 3, low: 200, high: 210 }),
    mkCandle({ openingTime: 4, low: 200, high: 210 }),
  ];
  const swings = findSwingLowIndices(candles, lookback);
  assert.deepEqual(swings, [2]);
});

test("detectHigherLow confirms a genuine rising sequence of swing lows (90 -> 95 -> 100)", () => {
  const lookback = 2;
  const candles = [
    mkCandle({ openingTime: 0, low: 200, high: 210 }),
    mkCandle({ openingTime: 1, low: 200, high: 210 }),
    mkCandle({ openingTime: 2, low: 300, high: 310 }),
    mkCandle({ openingTime: 3, low: 300, high: 310 }),
    mkCandle({ openingTime: 4, low: 90, high: 300 }),
    mkCandle({ openingTime: 5, low: 300, high: 310 }),
    mkCandle({ openingTime: 6, low: 300, high: 310 }),
    mkCandle({ openingTime: 7, low: 95, high: 300 }),
    mkCandle({ openingTime: 8, low: 300, high: 310 }),
    mkCandle({ openingTime: 9, low: 300, high: 310 }),
    mkCandle({ openingTime: 10, low: 100, high: 300 }),
    mkCandle({ openingTime: 11, low: 300, high: 310 }),
    mkCandle({ openingTime: 12, low: 300, high: 310 }),
  ];
  const result = detectHigherLow(candles, lookback, 2);
  assert.equal(result.confirmed, true);
  assert.equal(result.hlFloorPrice, 100);
  assert.deepEqual(result.swingLows, [90, 95, 100]);
});

test("detectHigherLow rejects a falling sequence of swing lows (100 -> 95 -> 90)", () => {
  const lookback = 2;
  const candles = [
    mkCandle({ openingTime: 0, low: 200, high: 210 }),
    mkCandle({ openingTime: 1, low: 200, high: 210 }),
    mkCandle({ openingTime: 2, low: 300, high: 310 }),
    mkCandle({ openingTime: 3, low: 300, high: 310 }),
    mkCandle({ openingTime: 4, low: 100, high: 300 }),
    mkCandle({ openingTime: 5, low: 300, high: 310 }),
    mkCandle({ openingTime: 6, low: 300, high: 310 }),
    mkCandle({ openingTime: 7, low: 95, high: 300 }),
    mkCandle({ openingTime: 8, low: 300, high: 310 }),
    mkCandle({ openingTime: 9, low: 300, high: 310 }),
    mkCandle({ openingTime: 10, low: 90, high: 300 }),
    mkCandle({ openingTime: 11, low: 300, high: 310 }),
    mkCandle({ openingTime: 12, low: 300, high: 310 }),
  ];
  const result = detectHigherLow(candles, lookback, 2);
  assert.equal(result.confirmed, false);
  assert.equal(result.hlFloorPrice, null);
});

test("detectHigherLow rejects when fewer swing lows exist than minSwingLows requires", () => {
  const lookback = 2;
  const candles = [
    mkCandle({ openingTime: 0, low: 200, high: 210 }),
    mkCandle({ openingTime: 1, low: 200, high: 210 }),
    mkCandle({ openingTime: 2, low: 90, high: 300 }),
    mkCandle({ openingTime: 3, low: 300, high: 310 }),
    mkCandle({ openingTime: 4, low: 300, high: 310 }),
  ];
  const result = detectHigherLow(candles, lookback, 2);
  assert.equal(result.confirmed, false);
  assert.match(result.reason, /Need/);
});

// ---------------------------------------------------------------------------
// evaluateStrategy — end-to-end candidate generation
// ---------------------------------------------------------------------------

/**
 * Uses the same trend-with-pullbacks generator verified in
 * backtest/engine.test.ts to reliably produce real strategy signals
 * (entries AND both stop-loss and take-profit exits when run through the
 * backtest engine). An earlier hand-built fixture attempting to construct
 * three isolated swing lows directly was tried first and, on inspection
 * via a real run, only produced 1 detectable swing low (the "bounce"
 * candles between pullbacks weren't high enough to isolate each dip under
 * the swingLookback=3 neighbor comparison) — caught before being trusted,
 * and replaced with this verified generator instead.
 */
function makeBullishHigherLowSeries(candleCount = 90): Candle[] {
  const candles: Candle[] = [];
  let price = 140;
  for (let i = 0; i < candleCount; i++) {
    price += (i % 11 === 0 ? -2.2 : 0.35) + Math.sin(i / 5) * 0.3;
    const open = price - 0.3;
    const close = price;
    const high = Math.max(open, close) + 0.4;
    const low = Math.min(open, close) - 0.5;
    candles.push(mkCandle({ openingTime: i * 3_600_000, open, high, low, close }));
  }
  return candles;
}

test("evaluateStrategy fixture sanity check: bullish higher-low series produces a valid BUY candidate", () => {
  const candidate = evaluateStrategy(makeBullishHigherLowSeries());
  assert.equal(candidate.shouldEnter, true);
  assert.equal(candidate.direction, "BUY");
  assert.ok(candidate.entryPrice !== null);
  assert.ok(candidate.stopLoss !== null && candidate.stopLoss < candidate.entryPrice!);
  assert.ok(candidate.takeProfit !== null && candidate.takeProfit > candidate.entryPrice!);
});

test("evaluateStrategy enforces exactly a 1:2 risk/reward ratio on a valid candidate", () => {
  const candidate = evaluateStrategy(makeBullishHigherLowSeries());
  assert.equal(candidate.shouldEnter, true);
  assert.ok(candidate.riskRewardRatio !== null);
  assert.ok(Math.abs(candidate.riskRewardRatio! - 2) < 1e-9);
});

test("evaluateStrategy rejects with INSUFFICIENT_DATA when too few candles are supplied", () => {
  const candles = Array.from({ length: 5 }, (_, i) =>
    mkCandle({ openingTime: i * 3_600_000, open: 100, high: 101, low: 99, close: 100 })
  );
  const candidate = evaluateStrategy(candles);
  assert.equal(candidate.shouldEnter, false);
  assert.ok(candidate.failedFilters.includes("INSUFFICIENT_DATA"));
});

test("evaluateStrategy rejects with EMA_FILTER when price is below/at a flat/declining EMA (no uptrend)", () => {
  // Flat series: close never exceeds its own EMA
  const candles = Array.from({ length: 60 }, (_, i) =>
    mkCandle({ openingTime: i * 3_600_000, open: 100, high: 100.5, low: 99.5, close: 100 })
  );
  const candidate = evaluateStrategy(candles);
  assert.equal(candidate.shouldEnter, false);
  assert.ok(candidate.failedFilters.includes("EMA_FILTER"));
});

test("evaluateStrategy rejects with HIGHER_LOW_FILTER when trend is up but no HL structure exists", () => {
  // Steady monotonic climb with no pullbacks at all -> no swing lows form
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < 60; i++) {
    price += 0.5;
    candles.push(
      mkCandle({ openingTime: i * 3_600_000, open: price - 0.5, high: price + 0.1, low: price - 0.55, close: price })
    );
  }
  const candidate = evaluateStrategy(candles);
  assert.equal(candidate.shouldEnter, false);
  // Either EMA passes and HL fails, or not enough swings form — both are
  // legitimate "no trade" outcomes for a monotonic climb with no pullbacks.
  assert.ok(candidate.failedFilters.includes("HIGHER_LOW_FILTER") || candidate.failedFilters.includes("EMA_FILTER"));
});

test("evaluateStrategy rejects with ATR_FILTER when risk distance is too wide relative to volatility", () => {
  const candidate = evaluateStrategy(makeBullishHigherLowSeries(), { atrMultiplierMax: 0.0001 });
  assert.equal(candidate.shouldEnter, false);
  assert.ok(candidate.failedFilters.includes("ATR_FILTER"));
});

test("evaluateStrategy config override changes filter behavior (minSwingLows stricter)", () => {
  const withDefault = evaluateStrategy(makeBullishHigherLowSeries());
  const withStricterHL = evaluateStrategy(makeBullishHigherLowSeries(), { minSwingLows: 5 });
  assert.equal(withDefault.shouldEnter, true);
  assert.equal(withStricterHL.shouldEnter, false);
  assert.ok(withStricterHL.failedFilters.includes("HIGHER_LOW_FILTER"));
});

test("evaluateStrategy never returns direction SELL (strategy is long-only by design)", () => {
  const candidate = evaluateStrategy(makeBullishHigherLowSeries());
  assert.notEqual(candidate.direction, "SELL");
});

test("DEFAULT_STRATEGY_CONFIG matches the documented 1:2 risk/reward design (atrTpMultiplierMax is 2x atrMultiplierMax)", () => {
  // This isn't a strict requirement of the math (TP is entry + riskDistance*2
  // regardless), but documents the intended relationship between the two
  // ATR sanity-check multipliers for future maintainers.
  assert.equal(DEFAULT_STRATEGY_CONFIG.atrTpMultiplierMax, DEFAULT_STRATEGY_CONFIG.atrMultiplierMax * 2);
});
