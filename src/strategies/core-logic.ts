import type { Candle } from '../types/index.js';

// ---------------------------------------------------------------------------
// 1. CODEX COMPLIANT INTERFACES
// ---------------------------------------------------------------------------

/** Keeps your existing live binance-feed.ts processing loop 100% functional */
interface StrategySignal {
  shouldEnter: boolean;
  direction: 'BUY' | 'SELL' | null;
  reason: string;
}

export interface StrategyConfig {
  /** EMA period for trend filter. Default: 50 */
  emaPeriod: number;
  /** Number of candles on each side to qualify a swing low. Default: 3 */
  swingLookback: number;
  /** Minimum number of swing lows needed to confirm a Higher Low. Default: 2 */
  minSwingLows: number;
  /** Stop loss buffer below the HL floor, as a fraction of price. Default: 0.002 (0.2%) */
  slBufferFraction: number;
  /** ATR period. Default: 14 */
  atrPeriod: number;
  /** Max allowed riskDistance as a multiple of ATR(14). Default: 1.5 */
  atrMultiplierMax: number;
  /** Max allowed takeProfit distance as a multiple of ATR(14). Default: 3.0 */
  atrTpMultiplierMax: number;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  emaPeriod: 50,
  swingLookback: 3,
  minSwingLows: 2,
  slBufferFraction: 0.002,
  atrPeriod: 14,
  atrMultiplierMax: 1.5,
  atrTpMultiplierMax: 3.0,
};

/** Exact detailed shape requested by Codex for Phase 2 candidate tagging */
export interface TradeCandidate {
  shouldEnter: boolean;
  direction: 'BUY' | null;
  reason: string;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskDistance: number | null;
  rewardDistance: number | null;
  riskRewardRatio: number | null;
  higherLowPrice: number | null;
  emaValue: number | null;
  atr14: number | null;
  passedFilters: string[];
  failedFilters: string[];
  candleOpenTime: number;
}

// ---------------------------------------------------------------------------
// 2. MATHEMATICAL CORE ENGINES
// ---------------------------------------------------------------------------

export function computeEMA(closes: number[], period: number): number[] {
  if (period <= 0) throw new Error(`EMA period must be > 0, got ${period}`);
  const k = 2 / (period + 1);
  const result: number[] = new Array(closes.length).fill(NaN);

  if (closes.length < period) return result;

  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i];
  result[period - 1] = seed / period;

  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

export function computeATR(candles: Candle[], period: number): number[] {
  if (period <= 0) throw new Error(`ATR period must be > 0, got ${period}`);
  const result: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return result;

  const tr: number[] = new Array(candles.length).fill(NaN);
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }

  let seed = 0;
  for (let i = 1; i <= period; i++) seed += tr[i];
  result[period] = seed / period;

  for (let i = period + 1; i < candles.length; i++) {
    result[i] = (result[i - 1] * (period - 1) + tr[i]) / period;
  }
  return result;
}

export function findSwingLowIndices(candles: Candle[], lookback: number): number[] {
  const swings: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const pivot = candles[i].low;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].low <= pivot) {
        isLow = false;
        break;
      }
    }
    if (isLow) swings.push(i);
  }
  return swings;
}

export interface HigherLowResult {
  confirmed: boolean;
  hlFloorPrice: number | null;
  swingLows: number[];
  reason: string;
}

export function detectHigherLow(
  candles: Candle[],
  lookback: number,
  minSwingLows: number,
): HigherLowResult {
  const swingIndices = findSwingLowIndices(candles, lookback);
  const swingPrices = swingIndices.map((i) => candles[i].low);

  if (swingPrices.length < minSwingLows) {
    return {
      confirmed: false,
      hlFloorPrice: null,
      swingLows: swingPrices,
      reason: `Need ≥${minSwingLows} swing lows, found ${swingPrices.length}`,
    };
  }

  let hlSequenceEnd = swingPrices.length - 1;
  let hlSequenceStart = hlSequenceEnd;

  for (let i = swingPrices.length - 2; i >= 0; i--) {
    if (swingPrices[i] < swingPrices[i + 1]) {
      hlSequenceStart = i;
    } else {
      break;
    }
  }

  const chainLength = hlSequenceEnd - hlSequenceStart + 1;
  if (chainLength < minSwingLows) {
    return {
      confirmed: false,
      hlFloorPrice: null,
      swingLows: swingPrices,
      reason: `Most recent HL chain length ${chainLength} < required ${minSwingLows}`,
    };
  }

  const hlFloorPrice = swingPrices[hlSequenceEnd];

  return {
    confirmed: true,
    hlFloorPrice,
    swingLows: swingPrices,
    reason: `Confirmed HL chain of ${chainLength} swing lows; floor = ${hlFloorPrice}`,
  };
}

// ---------------------------------------------------------------------------
// 3. CODEX STRATEGY CANDIDATE GENERATOR
// ---------------------------------------------------------------------------
export function evaluateStrategy(
  candles: Candle[],
  config: Partial<StrategyConfig> = {},
): TradeCandidate {
  const cfg: StrategyConfig = { ...DEFAULT_STRATEGY_CONFIG, ...config };
  const passedFilters: string[] = [];
  const failedFilters: string[] = [];

  const latest = candles[candles.length - 1];
  // Guarded Codex Type Matching: openingTime instead of open_time
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

  const minRequired = Math.max(cfg.emaPeriod, cfg.atrPeriod + 1, (cfg.swingLookback * 2 + 1) * cfg.minSwingLows + cfg.swingLookback);
  if (candles.length < minRequired) {
    failedFilters.push('INSUFFICIENT_DATA');
    return reject(`Need at least ${minRequired} candles, have ${candles.length}`);
  }

  // --- FILTER 1: EMA Trend Filter ---
  const closes = candles.map((c) => c.close);
  const emaValues = computeEMA(closes, cfg.emaPeriod);
  const latestEMA = emaValues[emaValues.length - 1];
  const latestClose = latest.close;

  if (isNaN(latestEMA)) {
    failedFilters.push('EMA_FILTER');
    return reject(`EMA(${cfg.emaPeriod}) produced NaN — not enough candles to seed`);
  }

  if (latestClose <= latestEMA) {
    failedFilters.push('EMA_FILTER');
    return reject(`EMA trend filter failed: close ${latestClose} ≤ EMA(${cfg.emaPeriod}) ${latestEMA.toFixed(4)}`);
  }
  passedFilters.push('EMA_FILTER');

  // --- FILTER 2: Higher Low Detection ---
  const hlResult = detectHigherLow(candles, cfg.swingLookback, cfg.minSwingLows);
  if (!hlResult.confirmed || hlResult.hlFloorPrice === null) {
    failedFilters.push('HIGHER_LOW_FILTER');
    return reject(`Higher Low filter failed: ${hlResult.reason}`);
  }
  passedFilters.push('HIGHER_LOW_FILTER');

  // --- Math Projections (Strict 1:2 R:R Rule) ---
  const entryPrice = latestClose;
  const hlFloor = hlResult.hlFloorPrice;
  const stopLoss = hlFloor * (1 - cfg.slBufferFraction);
  const riskDistance = entryPrice - stopLoss;

  if (riskDistance <= 0) {
    failedFilters.push('RISK_DISTANCE_FILTER');
    return reject(`Risk distance ≤ 0: entry ${entryPrice}, stopLoss ${stopLoss.toFixed(4)}`);
  }

  const takeProfit = entryPrice + riskDistance * 2;
  const rewardDistance = takeProfit - entryPrice;
  const riskRewardRatio = rewardDistance / riskDistance;
  passedFilters.push('RISK_DISTANCE_FILTER');

  // --- FILTER 3: ATR(14) Volatility Filter ---
  const atrValues = computeATR(candles, cfg.atrPeriod);
  const latestATR = atrValues[atrValues.length - 1];

  if (isNaN(latestATR)) {
    failedFilters.push('ATR_FILTER');
    return reject(`ATR(${cfg.atrPeriod}) produced NaN — not enough candles to seed`);
  }

  if (riskDistance > latestATR * cfg.atrMultiplierMax) {
    failedFilters.push('ATR_FILTER');
    return reject(`ATR filter failed: riskDistance too wide (${riskDistance.toFixed(4)} > ${cfg.atrMultiplierMax}x ATR)`);
  }

  if (rewardDistance > latestATR * cfg.atrTpMultiplierMax) {
    failedFilters.push('ATR_FILTER');
    return reject(`ATR filter failed: rewardDistance unrealistically far (${rewardDistance.toFixed(4)} > ${cfg.atrTpMultiplierMax}x ATR)`);
  }
  passedFilters.push('ATR_FILTER');

  // --- Success Canditate Emitted ---
  return {
    shouldEnter: true,
    direction: 'BUY',
    reason: 'All mathematical validation checks PASSED successfully',
    entryPrice,
    stopLoss,
    takeProfit,
    riskDistance,
    rewardDistance,
    riskRewardRatio,
    higherLowPrice: hlFloor,
    emaValue: latestEMA,
    atr14: latestATR,
    passedFilters,
    failedFilters,
    candleOpenTime,
  };
}

// ---------------------------------------------------------------------------
// ⚡ MASTER ADAPTER ENTRY POINT (Keeps everything safe)
// ---------------------------------------------------------------------------
export function evaluateMarketStrategy(candles: Candle[]): StrategySignal {
  const candidate = evaluateStrategy(candles);

  // Return exactly what the pipeline requires so execution parameters match downstream
  return {
    shouldEnter: candidate.shouldEnter,
    direction: candidate.direction, 
    reason: candidate.reason
  };
}