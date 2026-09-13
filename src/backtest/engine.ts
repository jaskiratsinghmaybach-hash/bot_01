/**
 * Backtest engine.
 *
 * Replays a historical candle series through the real strategy
 * (evaluateStrategy) using an EXPANDING WINDOW: at each candle index i, the
 * strategy only ever sees candles[0..i] (inclusive) — never candles[i+1..],
 * which is what prevents look-ahead bias. A signal "at" candle i is exactly
 * what live trading would have seen at the moment candle i closed.
 *
 * Entries are assumed to fill at candle i's close (the same price the
 * strategy used as entryPrice), which is realistic for a live system that
 * reacts to a closed candle over a WebSocket feed. Exits are detected by
 * scanning subsequent candles' high/low for a stop-loss or take-profit
 * touch — if BOTH are touched within the same candle, this is ambiguous
 * from OHLC data alone (we don't know the intra-candle path), so the
 * backtest conservatively assumes the STOP was hit first (worse case for
 * the trader) rather than assuming the more favorable outcome.
 *
 * This is explicitly a BACKTEST — historical replay under documented
 * assumptions, not a guarantee of future performance and not a paper or
 * live result. Never mix these result types.
 */

import type { Candle } from "../types/index.js";
import { evaluateStrategy, type StrategyConfig } from "../strategies/core-logic.js";
import { computeRiskDistance } from "../risk/risk-engine.js";

export interface BacktestConfig {
  strategyConfig: Partial<StrategyConfig>;
  /** USD risked per trade — mirrors RISK_PER_TRADE_USD in live/paper config. */
  riskAmountUsd: number;
  /**
   * Hard notional ceiling in USD, mirroring MAX_POSITION_USD in live/paper
   * config. This is enforced the same way the real risk engine enforces it
   * — a tight stop-loss can otherwise imply an unrealistically large
   * position purely from risk math, which would overstate both potential
   * gains and losses versus what the live risk engine would ever actually
   * approve.
   */
  maxPositionUsd: number;
  /**
   * Starting account equity in USD, used ONLY to express max drawdown as a
   * percentage. Without a real starting balance, "drawdown as % of peak
   * cumulative PnL" is not a meaningful figure (a small early profit peak
   * can produce a nonsensical percentage) — so maxDrawdownPercent is
   * always computed against startingEquityUsd + peak PnL, i.e. real
   * account equity at the peak, not just the PnL peak itself.
   */
  startingEquityUsd: number;
  /** Taker fee as a fraction of notional, applied on both entry and exit. */
  feeFraction: number;
  /** Slippage as a fraction of price, applied against the trader on both entry and exit. */
  slippageFraction: number;
  /**
   * Minimum number of candles between the end of one trade and the
   * earliest next entry — prevents evaluating a fresh signal on the very
   * candle a position just closed. 0 means no cooldown.
   */
  cooldownCandles: number;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  strategyConfig: {},
  riskAmountUsd: 25,
  maxPositionUsd: 500,
  startingEquityUsd: 1000,
  feeFraction: 0.001,
  slippageFraction: 0.0005,
  cooldownCandles: 0,
};

export interface BacktestTrade {
  direction: "BUY";
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
  exitIndex: number | null;
  exitTime: number | null;
  exitPrice: number | null;
  exitReason: "TAKE_PROFIT" | "STOP_LOSS" | "END_OF_DATA" | null;
  stopLoss: number;
  takeProfit: number;
  quantity: number;
  grossPnlUsd: number | null;
  feesUsd: number;
  netPnlUsd: number | null;
  rMultiple: number | null;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  totalTrades: number;
  wins: number;
  losses: number;
  openAtEnd: number;
  winRate: number | null;
  averageRMultiple: number | null;
  expectancyR: number | null;
  cumulativeNetPnlUsd: number;
  maxDrawdownUsd: number;
  maxDrawdownPercent: number | null;
  profitFactor: number | null;
  config: BacktestConfig;
}

function simulateExit(
  candles: Candle[],
  entryIndex: number,
  stopLoss: number,
  takeProfit: number
): { exitIndex: number; exitPrice: number; reason: "TAKE_PROFIT" | "STOP_LOSS" } | null {
  for (let i = entryIndex + 1; i < candles.length; i++) {
    const candle = candles[i];
    const hitStop = candle.low <= stopLoss;
    const hitTarget = candle.high >= takeProfit;

    if (hitStop && hitTarget) {
      // Ambiguous within a single candle from OHLC alone — assume the
      // worse outcome for the trader (stop hit first) rather than guess
      // favorably.
      return { exitIndex: i, exitPrice: stopLoss, reason: "STOP_LOSS" };
    }
    if (hitStop) {
      return { exitIndex: i, exitPrice: stopLoss, reason: "STOP_LOSS" };
    }
    if (hitTarget) {
      return { exitIndex: i, exitPrice: takeProfit, reason: "TAKE_PROFIT" };
    }
  }
  return null; // position still open at end of available data
}

export function runBacktest(candles: Candle[], config: Partial<BacktestConfig> = {}): BacktestResult {
  const cfg: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, ...config };
  const trades: BacktestTrade[] = [];

  let cooldownUntilIndex = -1;

  // Expanding window: at index i, only candles[0..i] are visible to the
  // strategy. This is the mechanism that prevents look-ahead bias.
  for (let i = 0; i < candles.length; i++) {
    if (i < cooldownUntilIndex) continue;

    const visibleCandles = candles.slice(0, i + 1);
    const candidate = evaluateStrategy(visibleCandles, cfg.strategyConfig);

    if (!candidate.shouldEnter || candidate.direction === null) continue;
    if (candidate.entryPrice === null || candidate.stopLoss === null || candidate.takeProfit === null) continue;

    const riskDistance = computeRiskDistance(candidate.direction, candidate.entryPrice, candidate.stopLoss);
    if (!Number.isFinite(riskDistance) || riskDistance <= 0) continue;

    // Mirror the live risk engine: size from risk math, then cap notional
    // at maxPositionUsd. A very tight stop can otherwise imply an
    // unrealistically large position that the real risk engine would
    // never approve, which would badly distort backtest PnL/drawdown.
    const riskSizedQuantity = cfg.riskAmountUsd / riskDistance;
    const riskSizedNotional = riskSizedQuantity * candidate.entryPrice;
    const rawQuantity =
      riskSizedNotional > cfg.maxPositionUsd ? cfg.maxPositionUsd / candidate.entryPrice : riskSizedQuantity;

    // Entry fills at this candle's close, worsened by slippage (higher
    // fill price for a BUY).
    const entryFillPrice = candidate.entryPrice * (1 + cfg.slippageFraction);
    const entryFeeUsd = entryFillPrice * rawQuantity * cfg.feeFraction;

    const exit = simulateExit(candles, i, candidate.stopLoss, candidate.takeProfit);

    if (exit === null) {
      // Position still open at the end of available data — record it as
      // an incomplete trade rather than fabricating an exit.
      trades.push({
        direction: "BUY",
        entryIndex: i,
        entryTime: candidate.candleOpenTime,
        entryPrice: entryFillPrice,
        exitIndex: null,
        exitTime: null,
        exitPrice: null,
        exitReason: null,
        stopLoss: candidate.stopLoss,
        takeProfit: candidate.takeProfit,
        quantity: rawQuantity,
        grossPnlUsd: null,
        feesUsd: entryFeeUsd,
        netPnlUsd: null,
        rMultiple: null,
      });
      continue; // do not advance cooldown further; no more entries needed past this point in this simple loop, but keep scanning is fine
    }

    const exitFillPrice =
      exit.reason === "STOP_LOSS"
        ? exit.exitPrice * (1 - cfg.slippageFraction) // worse (lower) exit on a stop
        : exit.exitPrice * (1 - cfg.slippageFraction); // also apply slippage against the trader on take-profit exits

    const exitFeeUsd = exitFillPrice * rawQuantity * cfg.feeFraction;
    const grossPnlUsd = (exitFillPrice - entryFillPrice) * rawQuantity;
    const feesUsd = entryFeeUsd + exitFeeUsd;
    const netPnlUsd = grossPnlUsd - feesUsd;
    const rMultiple = netPnlUsd / cfg.riskAmountUsd;

    trades.push({
      direction: "BUY",
      entryIndex: i,
      entryTime: candidate.candleOpenTime,
      entryPrice: entryFillPrice,
      exitIndex: exit.exitIndex,
      exitTime: candles[exit.exitIndex].openingTime,
      exitPrice: exitFillPrice,
      exitReason: exit.reason,
      stopLoss: candidate.stopLoss,
      takeProfit: candidate.takeProfit,
      quantity: rawQuantity,
      grossPnlUsd,
      feesUsd,
      netPnlUsd,
      rMultiple,
    });

    cooldownUntilIndex = exit.exitIndex + 1 + cfg.cooldownCandles;
  }

  return summarize(trades, cfg);
}

function summarize(trades: BacktestTrade[], cfg: BacktestConfig): BacktestResult {
  const closedTrades = trades.filter((t) => t.netPnlUsd !== null);
  const wins = closedTrades.filter((t) => (t.netPnlUsd ?? 0) > 0);
  const losses = closedTrades.filter((t) => (t.netPnlUsd ?? 0) <= 0);

  const winRate = closedTrades.length > 0 ? wins.length / closedTrades.length : null;

  const averageRMultiple =
    closedTrades.length > 0
      ? closedTrades.reduce((sum, t) => sum + (t.rMultiple ?? 0), 0) / closedTrades.length
      : null;

  const expectancyR = averageRMultiple; // expectancy per trade, in R, is exactly the mean R-multiple

  let cumulative = 0;
  let peakEquity = cfg.startingEquityUsd;
  let maxDrawdownUsd = 0;
  let maxDrawdownPercent = 0;
  for (const t of closedTrades) {
    cumulative += t.netPnlUsd ?? 0;
    const equity = cfg.startingEquityUsd + cumulative;
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity - equity;
    if (drawdown > maxDrawdownUsd) {
      maxDrawdownUsd = drawdown;
      maxDrawdownPercent = peakEquity > 0 ? (drawdown / peakEquity) * 100 : 0;
    }
  }

  const grossProfit = wins.reduce((sum, t) => sum + (t.netPnlUsd ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + (t.netPnlUsd ?? 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

  return {
    trades,
    totalTrades: closedTrades.length,
    wins: wins.length,
    losses: losses.length,
    openAtEnd: trades.length - closedTrades.length,
    winRate,
    averageRMultiple,
    expectancyR,
    cumulativeNetPnlUsd: cumulative,
    maxDrawdownUsd,
    maxDrawdownPercent,
    profitFactor,
    config: cfg,
  };
}
