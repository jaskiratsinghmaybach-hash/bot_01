/**
 * Mean-reversion strategy — genuinely different hypothesis from
 * core-logic.ts's trend-following signal.
 *
 * Thesis: instead of "price above EMA + higher low = keep going up",
 * this bets that when price gets unusually stretched BELOW its recent
 * mean AND momentum is oversold (not just dipping, but genuinely
 * exhausted), it tends to snap back toward the mean.
 *
 * This is a completely separate file from core-logic.ts — nothing there
 * is modified. It returns the same TradeCandidate shape so it plugs into
 * the existing (unmodified) backtest engine without changes.
 *
 * Exit design differs deliberately from the trend strategy: take-profit
 * targets the mean itself (the middle Bollinger Band), not an arbitrary
 * fixed R:R multiple — a reversion trade's natural target IS the mean,
 * so this is the structurally honest choice rather than picking a ratio
 * and hoping price gets there.
 */
import type { Candle } from "../types/index.js";
import type { TradeCandidate } from "./core-logic.js";
import { computeATR } from "./core-logic.js";

export interface MeanReversionConfig {
  /** Period for the Bollinger Band SMA (the "mean"). Default: 20 */
  bbPeriod: number;
  /** Standard deviation multiplier for the bands. Default: 2.0 */
  bbStdDevMultiplier: number;
  /** RSI period. Default: 14 */
  rsiPeriod: number;
  /** RSI must be at or below this to confirm oversold. Default: 30 */
  rsiOversoldThreshold: number;
  /** ATR period, used for stop-loss placement. Default: 14 */
  atrPeriod: number;
  /** Stop-loss distance below entry, as a multiple of ATR. Default: 1.5 */
  atrStopMultiplier: number;
  /** Minimum risk:reward implied by (mean - entry) / (entry - stop) to accept the trade. Default: 1.0 */
  minRiskRewardRatio: number;
}

export const DEFAULT_MEAN_REVERSION_CONFIG: MeanReversionConfig = {
  bbPeriod: 20,
  bbStdDevMultiplier: 2.0,
  rsiPeriod: 14,
  rsiOversoldThreshold: 30,
  atrPeriod: 14,
  atrStopMultiplier: 1.5,
  minRiskRewardRatio: 1.0,
};

export interface BollingerBands {
  middle: number[];
  upper: number[];
  lower: number[];
}

/** Simple moving average + standard-deviation bands. NaN until `period` candles are available. */
export function computeBollingerBands(closes: number[], period: number, stdDevMultiplier: number): BollingerBands {
  const middle: number[] = new Array(closes.length).fill(NaN);
  const upper: number[] = new Array(closes.length).fill(NaN);
  const lower: number[] = new Array(closes.length).fill(NaN);

  for (let i = period - 1; i < closes.length; i++) {
    const window = closes.slice(i - period + 1, i + 1);
    const mean = window.reduce((sum, v) => sum + v, 0) / period;
    const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
    const stdDev = Math.sqrt(variance);

    middle[i] = mean;
    upper[i] = mean + stdDev * stdDevMultiplier;
    lower[i] = mean - stdDev * stdDevMultiplier;
  }

  return { middle, upper, lower };
}

/** Standard Wilder RSI. NaN until `period + 1` candles are available. */
export function computeRSI(closes: number[], period: number): number[] {
  const result: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return result;

  const gains: number[] = new Array(closes.length).fill(0);
  const losses: number[] = new Array(closes.length).fill(0);

  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains[i] = change > 0 ? change : 0;
    losses[i] = change < 0 ? -change : 0;
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;

  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return result;
}

export function evaluateMeanReversionStrategy(
  candles: Candle[],
  config: Partial<MeanReversionConfig> = {}
): TradeCandidate {
  const cfg: MeanReversionConfig = { ...DEFAULT_MEAN_REVERSION_CONFIG, ...config };
  const passedFilters: string[] = [];
  const failedFilters: string[] = [];

  const latest = candles[candles.length - 1];
  const candleOpenTime = latest ? latest.openingTime : Date.now();

  const reject = (reason: string): TradeCandidate => ({
    shouldEnter: false,
    direction: null,
    reason,
    entryPrice: null,
    stopLoss: null,
    takeProfit: null,
    riskDistance: null,
    rewardDistance: null,
    riskRewardRatio: null,
    higherLowPrice: null,
    emaValue: null,
    atr14: null,
    passedFilters,
    failedFilters,
    candleOpenTime,
  });

  const minRequired = Math.max(cfg.bbPeriod, cfg.rsiPeriod + 1, cfg.atrPeriod + 1) + 1;
  if (candles.length < minRequired) {
    failedFilters.push("INSUFFICIENT_DATA");
    return reject(`Need at least ${minRequired} candles, have ${candles.length}`);
  }

  const closes = candles.map((c) => c.close);
  const latestClose = latest.close;

  // --- FILTER 1: Bollinger Band stretch (price below lower band) ---
  const bands = computeBollingerBands(closes, cfg.bbPeriod, cfg.bbStdDevMultiplier);
  const latestLower = bands.lower[bands.lower.length - 1];
  const latestMiddle = bands.middle[bands.middle.length - 1];

  if (isNaN(latestLower) || isNaN(latestMiddle)) {
    failedFilters.push("BB_FILTER");
    return reject(`Bollinger Bands not yet available (need ${cfg.bbPeriod} candles)`);
  }

  if (latestClose > latestLower) {
    failedFilters.push("BB_FILTER");
    return reject(`Price ${latestClose} not below lower band ${latestLower.toFixed(4)} — no stretch to fade`);
  }
  passedFilters.push("BB_FILTER");

  // --- FILTER 2: RSI oversold confirmation ---
  const rsiValues = computeRSI(closes, cfg.rsiPeriod);
  const latestRSI = rsiValues[rsiValues.length - 1];

  if (isNaN(latestRSI)) {
    failedFilters.push("RSI_FILTER");
    return reject(`RSI(${cfg.rsiPeriod}) not yet available`);
  }

  if (latestRSI > cfg.rsiOversoldThreshold) {
    failedFilters.push("RSI_FILTER");
    return reject(`RSI ${latestRSI.toFixed(1)} above oversold threshold ${cfg.rsiOversoldThreshold} — momentum not exhausted`);
  }
  passedFilters.push("RSI_FILTER");

  // --- Trade math: entry now, stop below via ATR, target = the mean itself ---
  const atrValues = computeATR(candles, cfg.atrPeriod);
  const latestATR = atrValues[atrValues.length - 1];

  if (isNaN(latestATR)) {
    failedFilters.push("ATR_FILTER");
    return reject(`ATR(${cfg.atrPeriod}) not yet available`);
  }

  const entryPrice = latestClose;
  const stopLoss = entryPrice - latestATR * cfg.atrStopMultiplier;
  const riskDistance = entryPrice - stopLoss;

  if (riskDistance <= 0) {
    failedFilters.push("RISK_DISTANCE_FILTER");
    return reject(`Risk distance <= 0: entry ${entryPrice}, stop ${stopLoss.toFixed(4)}`);
  }

  // Target the mean (middle band) — the structurally honest reversion
  // target, not an arbitrary fixed R:R multiple.
  const takeProfit = latestMiddle;
  const rewardDistance = takeProfit - entryPrice;

  if (rewardDistance <= 0) {
    failedFilters.push("REWARD_DISTANCE_FILTER");
    return reject(`Mean ${latestMiddle.toFixed(4)} is not above entry ${entryPrice} — no room to revert`);
  }

  const riskRewardRatio = rewardDistance / riskDistance;
  if (riskRewardRatio < cfg.minRiskRewardRatio) {
    failedFilters.push("MIN_RR_FILTER");
    return reject(
      `R:R ${riskRewardRatio.toFixed(2)} below minimum ${cfg.minRiskRewardRatio} — mean too close relative to stop distance`
    );
  }
  passedFilters.push("RISK_DISTANCE_FILTER");
  passedFilters.push("REWARD_DISTANCE_FILTER");
  passedFilters.push("MIN_RR_FILTER");

  return {
    shouldEnter: true,
    direction: "BUY",
    reason: `Mean reversion: price ${latestClose.toFixed(4)} below lower band ${latestLower.toFixed(4)}, RSI ${latestRSI.toFixed(1)} oversold, targeting mean ${latestMiddle.toFixed(4)}`,
    entryPrice,
    stopLoss,
    takeProfit,
    riskDistance,
    rewardDistance,
    riskRewardRatio,
    higherLowPrice: null, // not applicable to this strategy; kept null to match the shared shape
    emaValue: latestMiddle, // repurposed field: the "mean" this strategy targets
    atr14: latestATR,
    passedFilters,
    failedFilters,
    candleOpenTime,
  };
}