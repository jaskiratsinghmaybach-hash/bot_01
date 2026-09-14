/**
 * Backtest engine for the mean-reversion strategy.
 *
 * Same fork pattern as engine-with-regime.ts: reuses the original engine's
 * fee/slippage/sizing/exit-simulation/summarize logic verbatim, swapping
 * only which strategy function generates candidates. core-logic.ts and
 * engine.ts remain completely untouched.
 */
import type { Candle } from "../types/index.js";
import { evaluateMeanReversionStrategy, type MeanReversionConfig } from "../strategies/mean-reversion.js";
import { computeRiskDistance } from "../risk/risk-engine.js";
import type { BacktestConfig, BacktestTrade, BacktestResult } from "./engine.js";
import { DEFAULT_BACKTEST_CONFIG } from "./engine.js";

export interface MeanReversionBacktestConfig extends Omit<BacktestConfig, "strategyConfig"> {
  strategyConfig: Partial<MeanReversionConfig>;
}

export const DEFAULT_MEAN_REVERSION_BACKTEST_CONFIG: MeanReversionBacktestConfig = {
  ...DEFAULT_BACKTEST_CONFIG,
  strategyConfig: {},
};

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
      return { exitIndex: i, exitPrice: stopLoss, reason: "STOP_LOSS" };
    }
    if (hitStop) {
      return { exitIndex: i, exitPrice: stopLoss, reason: "STOP_LOSS" };
    }
    if (hitTarget) {
      return { exitIndex: i, exitPrice: takeProfit, reason: "TAKE_PROFIT" };
    }
  }
  return null;
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

  const expectancyR = averageRMultiple;

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

export function runMeanReversionBacktest(
  candles: Candle[],
  config: Partial<MeanReversionBacktestConfig> = {}
): BacktestResult {
  const cfg: MeanReversionBacktestConfig = { ...DEFAULT_MEAN_REVERSION_BACKTEST_CONFIG, ...config };
  const trades: BacktestTrade[] = [];
  let cooldownUntilIndex = -1;

  for (let i = 0; i < candles.length; i++) {
    if (i < cooldownUntilIndex) continue;

    const visibleCandles = candles.slice(0, i + 1);
    const candidate = evaluateMeanReversionStrategy(visibleCandles, cfg.strategyConfig);

    if (!candidate.shouldEnter || candidate.direction === null) continue;
    if (candidate.entryPrice === null || candidate.stopLoss === null || candidate.takeProfit === null) continue;

    const riskDistance = computeRiskDistance(candidate.direction, candidate.entryPrice, candidate.stopLoss);
    if (!Number.isFinite(riskDistance) || riskDistance <= 0) continue;

    const riskSizedQuantity = cfg.riskAmountUsd / riskDistance;
    const riskSizedNotional = riskSizedQuantity * candidate.entryPrice;
    const rawQuantity =
      riskSizedNotional > cfg.maxPositionUsd ? cfg.maxPositionUsd / candidate.entryPrice : riskSizedQuantity;

    const entryFillPrice = candidate.entryPrice * (1 + cfg.slippageFraction);
    const entryFeeUsd = entryFillPrice * rawQuantity * cfg.feeFraction;

    const exit = simulateExit(candles, i, candidate.stopLoss, candidate.takeProfit);

    if (exit === null) {
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
      continue;
    }

    const exitFillPrice =
      exit.reason === "STOP_LOSS"
        ? exit.exitPrice * (1 - cfg.slippageFraction)
        : exit.exitPrice * (1 - cfg.slippageFraction);

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