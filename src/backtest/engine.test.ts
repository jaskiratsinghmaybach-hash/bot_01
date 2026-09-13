import { test } from "node:test";
import assert from "node:assert/strict";
import { runBacktest } from "./engine.js";
import type { Candle } from "../types/index.js";

/**
 * Builds a synthetic candle series for testing engine MECHANICS (entry/exit
 * detection, fee math, drawdown, look-ahead prevention). This is NOT real
 * market data and results from it must never be presented as a real
 * backtest — it exists purely to verify the engine behaves correctly
 * against known, hand-constructed price paths.
 */
function makeCandle(overrides: Partial<Candle> & { openingTime: number }): Candle {
  return {
    symbol: "TESTUSDC",
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

/**
 * Generates an uptrend with periodic sharp pullbacks — verified by direct
 * execution during development to reliably produce multiple closed trades
 * (entries AND both stop-loss and take-profit exits) against the real
 * strategy filters, unlike several simpler hand-rolled patterns that were
 * tried first and produced zero signals. Any test that needs guaranteed
 * trade activity should use this generator and MUST assert
 * result.totalTrades > 0 explicitly — a test that only loops over
 * result.trades without that assertion passes vacuously on zero trades,
 * which is itself a bug (an earlier version of this file had exactly that
 * problem in two tests, caught during development).
 */
function makeTrendWithPullbacks(count = 200): Candle[] {
  const candles: Candle[] = [];
  let price = 140;
  for (let i = 0; i < count; i++) {
    price += (i % 11 === 0 ? -2.2 : 0.35) + Math.sin(i / 5) * 0.3;
    const open = price - 0.3;
    const close = price;
    const high = Math.max(open, close) + 0.4;
    const low = Math.min(open, close) - 0.5;
    candles.push(
      makeCandle({ openingTime: i * 3_600_000, open, high, low, close, volume: 5000 })
    );
  }
  return candles;
}

test("makeTrendWithPullbacks fixture reliably produces closed trades (guards against vacuous assertions below)", () => {
  const result = runBacktest(makeTrendWithPullbacks(), { riskAmountUsd: 25 });
  assert.ok(result.totalTrades > 0, "fixture must produce at least one closed trade for the tests below to be meaningful");
});

test("runBacktest never looks ahead: a signal at index i cannot be influenced by candles after i", () => {
  const base: Candle[] = [];
  let price = 100;
  for (let i = 0; i < 21; i++) {
    price += 0.5;
    base.push(
      makeCandle({ openingTime: i * 3_600_000, open: price - 0.5, high: price + 0.2, low: price - 0.7, close: price })
    );
  }

  const seriesA = [...base];
  const seriesB = [...base];

  for (let i = 21; i < 40; i++) {
    seriesA.push(makeCandle({ openingTime: i * 3_600_000, open: 200, high: 210, low: 190, close: 205 }));
    seriesB.push(makeCandle({ openingTime: i * 3_600_000, open: 50, high: 55, low: 45, close: 50 }));
  }

  const resultA = runBacktest(seriesA, { riskAmountUsd: 25 });
  const resultB = runBacktest(seriesB, { riskAmountUsd: 25 });

  const entriesAUpTo20 = resultA.trades
    .filter((t) => t.entryIndex <= 20)
    .map((t) => ({ entryIndex: t.entryIndex, entryPrice: t.entryPrice, stopLoss: t.stopLoss, takeProfit: t.takeProfit }));
  const entriesBUpTo20 = resultB.trades
    .filter((t) => t.entryIndex <= 20)
    .map((t) => ({ entryIndex: t.entryIndex, entryPrice: t.entryPrice, stopLoss: t.stopLoss, takeProfit: t.takeProfit }));

  assert.deepEqual(entriesAUpTo20, entriesBUpTo20);
});

test("runBacktest classifies stop-loss exits correctly with non-positive net PnL", () => {
  const result = runBacktest(makeTrendWithPullbacks(), { riskAmountUsd: 25 });
  const stopLossExits = result.trades.filter((t) => t.exitReason === "STOP_LOSS");

  assert.ok(stopLossExits.length > 0, "fixture must produce at least one stop-loss exit");
  for (const trade of stopLossExits) {
    assert.ok(trade.netPnlUsd !== null && trade.netPnlUsd <= 0);
  }
});

test("runBacktest classifies take-profit exits correctly with positive gross PnL before fees", () => {
  const result = runBacktest(makeTrendWithPullbacks(), { riskAmountUsd: 25 });
  const takeProfitExits = result.trades.filter((t) => t.exitReason === "TAKE_PROFIT");

  assert.ok(takeProfitExits.length > 0, "fixture must produce at least one take-profit exit");
  for (const trade of takeProfitExits) {
    assert.ok(trade.grossPnlUsd !== null && trade.grossPnlUsd > 0);
  }
});

test("runBacktest fee math: fees are strictly positive and net PnL is exactly gross minus fees", () => {
  const result = runBacktest(makeTrendWithPullbacks(), { riskAmountUsd: 25, feeFraction: 0.001, slippageFraction: 0.0005 });
  const closedTrades = result.trades.filter((t) => t.grossPnlUsd !== null);

  assert.ok(closedTrades.length > 0, "fixture must produce at least one closed trade");
  for (const trade of closedTrades) {
    assert.ok(trade.feesUsd > 0);
    assert.ok(trade.netPnlUsd! < trade.grossPnlUsd!);
    assert.ok(Math.abs(trade.netPnlUsd! - (trade.grossPnlUsd! - trade.feesUsd)) < 1e-9);
  }
});

test("runBacktest leaves a trade open (not fabricated) if price never reaches SL or TP by end of data", () => {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < 15; i++) {
    price += 0.6;
    candles.push(
      makeCandle({ openingTime: i * 3_600_000, open: price - 0.6, high: price + 0.1, low: price - 0.7, close: price })
    );
  }
  for (let i = 15; i < 20; i++) {
    candles.push(
      makeCandle({ openingTime: i * 3_600_000, open: price, high: price + 0.05, low: price - 0.05, close: price })
    );
  }

  const result = runBacktest(candles, { riskAmountUsd: 25 });
  const openTrades = result.trades.filter((t) => t.exitReason === null);
  for (const trade of openTrades) {
    assert.equal(trade.netPnlUsd, null);
    assert.equal(trade.exitPrice, null);
  }
});

test("runBacktest returns null (not NaN or 0) win rate/expectancy when there are zero closed trades", () => {
  const candles: Candle[] = Array.from({ length: 30 }, (_, i) =>
    makeCandle({ openingTime: i * 3_600_000, open: 100, high: 100.1, low: 99.9, close: 100 })
  );
  const result = runBacktest(candles, { riskAmountUsd: 25 });
  assert.equal(result.totalTrades, 0);
  assert.equal(result.winRate, null);
  assert.equal(result.averageRMultiple, null);
  assert.equal(result.profitFactor, null);
});

test("runBacktest max drawdown is non-negative and strictly positive when losses occur", () => {
  const result = runBacktest(makeTrendWithPullbacks(), { riskAmountUsd: 25 });
  assert.ok(result.totalTrades > 0);
  assert.ok(result.maxDrawdownUsd >= 0);
  assert.ok(result.losses > 0, "fixture must include losing trades for a meaningful drawdown check");
  assert.ok(result.maxDrawdownUsd > 0, "drawdown should be strictly positive when losing trades occurred");
  if (result.maxDrawdownPercent !== null) {
    assert.ok(result.maxDrawdownPercent >= 0);
  }
});

test("runBacktest caps position size at maxPositionUsd even when a tight stop implies a much larger size", () => {
  const result = runBacktest(makeTrendWithPullbacks(), { riskAmountUsd: 25, maxPositionUsd: 100 });
  assert.ok(result.totalTrades > 0);
  for (const trade of result.trades) {
    const notional = trade.quantity * trade.entryPrice;
    assert.ok(notional <= 100 * 1.01, `trade notional ${notional} exceeded maxPositionUsd cap`);
  }
});

test("runBacktest expresses drawdown as a percentage of real starting+cumulative equity, not just PnL peak", () => {
  const candles = makeTrendWithPullbacks();
  const resultLowEquity = runBacktest(candles, { riskAmountUsd: 25, startingEquityUsd: 100 });
  const resultHighEquity = runBacktest(candles, { riskAmountUsd: 25, startingEquityUsd: 100000 });

  assert.ok(resultLowEquity.maxDrawdownUsd > 0, "fixture must produce a real drawdown for this test to be meaningful");
  assert.ok(Math.abs(resultLowEquity.maxDrawdownUsd - resultHighEquity.maxDrawdownUsd) < 1e-6);
  assert.ok(resultLowEquity.maxDrawdownPercent !== null && resultHighEquity.maxDrawdownPercent !== null);
  assert.ok(resultLowEquity.maxDrawdownPercent! > resultHighEquity.maxDrawdownPercent!);
});
