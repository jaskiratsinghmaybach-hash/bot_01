/**
 * Backtest engine WITH regime filters.
 *
 * This is a deliberate fork of engine.ts's main loop — not a patch to it.
 * core-logic.ts and engine.ts remain completely untouched by this file.
 * The only difference from the original loop: before accepting a
 * `shouldEnter` candidate from evaluateStrategy, this also requires
 * evaluateRegimeFilters() to pass. Everything else (sizing, fees,
 * slippage, exit simulation, cooldown, summary stats) is copied verbatim
 * from engine.ts so results are directly comparable apples-to-apples.
 *
 * If regime filters are all disabled (default config), this produces
 * IDENTICAL results to the original runBacktest — useful as a sanity check.
 */
import type { Candle } from "../types/index.js";
import { evaluateStrategy, type StrategyConfig } from "../strategies/core-logic.js";
import { computeRiskDistance } from "../risk/risk-engine.js";
import {
  evaluateRegimeFilters,
  DEFAULT_REGIME_FILTER_CONFIG,
  type RegimeFilterConfig,
} from "../strategies/regime-filters.js";
import type { BacktestConfig, BacktestTrade, BacktestResult } from "./engine.js";
import { DEFAULT_BACKTEST_CONFIG } from "./engine.js";

export interface RegimeBacktestConfig extends BacktestConfig {
  regimeFilterConfig: Partial<RegimeFilterConfig>;
}

export const DEFAULT_REGIME_BACKTEST_CONFIG: RegimeBacktestConfig = {
  ...DEFAULT_BACKTEST_CONFIG,
  regimeFilterConfig: {},
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

export interface RegimeBacktestResult extends BacktestResult {
  rejectedByRegimeFilter: number;
}

function summarize(trades: BacktestTrade[], cfg: BacktestConfig, rejectedByRegimeFilter: number): RegimeBacktestResult {
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
    rejectedByRegimeFilter,
  };
}

export function runBacktestWithRegimeFilters(
  candles: Candle[],
  config: Partial<RegimeBacktestConfig> = {}
): RegimeBacktestResult {
  const cfg: RegimeBacktestConfig = { ...DEFAULT_REGIME_BACKTEST_CONFIG, ...config };
  const strategyCfg: Partial<StrategyConfig> = cfg.strategyConfig;
  const emaPeriod = strategyCfg.emaPeriod ?? 50;
  const atrPeriod = strategyCfg.atrPeriod ?? 14;

  const trades: BacktestTrade[] = [];
  let cooldownUntilIndex = -1;
  let rejectedByRegimeFilter = 0;

  for (let i = 0; i < candles.length; i++) {
    if (i < cooldownUntilIndex) continue;

    const visibleCandles = candles.slice(0, i + 1);
    const candidate = evaluateStrategy(visibleCandles, cfg.strategyConfig);

    if (!candidate.shouldEnter || candidate.direction === null) continue;
    if (candidate.entryPrice === null || candidate.stopLoss === null || candidate.takeProfit === null) continue;

    // --- THE ONLY NEW GATE vs. the original engine loop ---
    const regimeCheck = evaluateRegimeFilters(visibleCandles, emaPeriod, atrPeriod, cfg.regimeFilterConfig);
    if (!regimeCheck.passed) {
      rejectedByRegimeFilter += 1;
      continue;
    }
    // --- end new gate ---

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

  return summarize(trades, cfg, rejectedByRegimeFilter);
}