/**
 * Regime filters.
 *
 * These are additional PRE-ENTRY gates layered on top of the existing,
 * unmodified strategy in core-logic.ts. They don't change the EMA/higher-low
 * entry logic itself — they decide whether the market context is even worth
 * acting on when that logic fires a candidate.
 *
 * Each filter is independently togglable so a sweep can isolate which one
 * (if any) actually helps, rather than bundling everything into one
 * unverifiable change.
 *
 * This module is read-only with respect to core-logic.ts and engine.ts —
 * nothing here imports or edits those files' internals.
 */
import type { Candle } from "../types/index.js";
import { computeEMA, computeATR } from "../strategies/core-logic.js";

export interface RegimeFilterConfig {
  /** Require the EMA itself to be rising (not just price > EMA). */
  requireEmaSlope: boolean;
  /** Minimum EMA slope over `emaSlopeLookback` candles, as a fraction of EMA value. */
  minEmaSlopeFraction: number;
  /** How many candles back to measure EMA slope over. */
  emaSlopeLookback: number;

  /** Require current ATR to sit within a "normal" band of its own recent history. */
  requireAtrBand: boolean;
  /** Lookback window (in candles) used to build the ATR percentile band. */
  atrBandLookback: number;
  /** Reject if current ATR is below this percentile of its own recent range (too quiet/choppy). */
  atrBandMinPercentile: number;
  /** Reject if current ATR is above this percentile of its own recent range (too wild/unstable). */
  atrBandMaxPercentile: number;

  /** Require a higher-timeframe (4h, built from the same 1h candles) uptrend agreement. */
  requireHtfTrend: boolean;
  /** EMA period used on the aggregated 4h series for the HTF trend check. */
  htfEmaPeriod: number;
}

export const DEFAULT_REGIME_FILTER_CONFIG: RegimeFilterConfig = {
  requireEmaSlope: false,
  minEmaSlopeFraction: 0.0005, // 0.05% rise over the lookback window
  emaSlopeLookback: 5,

  requireAtrBand: false,
  atrBandLookback: 100,
  atrBandMinPercentile: 0.25,
  atrBandMaxPercentile: 0.85,

  requireHtfTrend: false,
  htfEmaPeriod: 50,
};

export interface RegimeCheckResult {
  passed: boolean;
  reason: string;
  details: Record<string, number | boolean | null>;
}

/**
 * EMA slope filter: rejects entries where price is technically above the
 * EMA but the EMA itself is flat or falling — i.e. a stale/weak "uptrend"
 * rather than a genuinely developing one.
 */
export function checkEmaSlope(candles: Candle[], emaPeriod: number, cfg: RegimeFilterConfig): RegimeCheckResult {
  if (!cfg.requireEmaSlope) {
    return { passed: true, reason: "EMA slope filter disabled", details: {} };
  }

  const closes = candles.map((c) => c.close);
  const emaValues = computeEMA(closes, emaPeriod);
  const lookback = cfg.emaSlopeLookback;

  const latest = emaValues[emaValues.length - 1];
  const past = emaValues[emaValues.length - 1 - lookback];

  if (isNaN(latest) || past === undefined || isNaN(past)) {
    return { passed: false, reason: "Insufficient data for EMA slope check", details: { latest, past: past ?? null } };
  }

  const slopeFraction = (latest - past) / past;
  const passed = slopeFraction >= cfg.minEmaSlopeFraction;

  return {
    passed,
    reason: passed
      ? `EMA slope ${(slopeFraction * 100).toFixed(3)}% over ${lookback} candles (>= ${(cfg.minEmaSlopeFraction * 100).toFixed(3)}%)`
      : `EMA slope too weak: ${(slopeFraction * 100).toFixed(3)}% over ${lookback} candles (< ${(cfg.minEmaSlopeFraction * 100).toFixed(3)}%)`,
    details: { slopeFraction, latest, past },
  };
}

/**
 * ATR percentile band filter: rejects entries when current volatility is
 * an outlier relative to its OWN recent history (adaptive, unlike a fixed
 * ATR threshold that goes stale as SOL's baseline volatility drifts over
 * a year of data).
 */
export function checkAtrBand(candles: Candle[], atrPeriod: number, cfg: RegimeFilterConfig): RegimeCheckResult {
  if (!cfg.requireAtrBand) {
    return { passed: true, reason: "ATR band filter disabled", details: {} };
  }

  const atrValues = computeATR(candles, atrPeriod);
  const latestAtr = atrValues[atrValues.length - 1];

  if (isNaN(latestAtr)) {
    return { passed: false, reason: "ATR not yet available", details: { latestAtr } };
  }

  const window = atrValues.slice(-cfg.atrBandLookback).filter((v) => !isNaN(v));
  if (window.length < cfg.atrBandLookback * 0.5) {
    return { passed: false, reason: "Insufficient ATR history for percentile band", details: { windowLength: window.length } };
  }

  const sorted = [...window].sort((a, b) => a - b);
  const rank = sorted.filter((v) => v <= latestAtr).length / sorted.length;

  const passed = rank >= cfg.atrBandMinPercentile && rank <= cfg.atrBandMaxPercentile;

  return {
    passed,
    reason: passed
      ? `ATR at ${(rank * 100).toFixed(0)}th percentile of last ${window.length} candles (within [${cfg.atrBandMinPercentile * 100}-${cfg.atrBandMaxPercentile * 100}])`
      : `ATR at ${(rank * 100).toFixed(0)}th percentile — outside normal band [${cfg.atrBandMinPercentile * 100}-${cfg.atrBandMaxPercentile * 100}]`,
    details: { rank, latestAtr },
  };
}

/**
 * Higher-timeframe trend filter: aggregates the visible 1h candles into 4h
 * bars and requires the 4h close to sit above its own EMA — a coarser,
 * less noisy trend signal used purely as a confirmation gate for the 1h
 * entry. Built entirely from the same 1h data already loaded, so no new
 * data source or API calls are needed.
 */
export function aggregateTo4h(hourlyCandles: Candle[]): Candle[] {
  const result: Candle[] = [];
  for (let i = 0; i + 4 <= hourlyCandles.length; i += 4) {
    const group = hourlyCandles.slice(i, i + 4);
    result.push({
      symbol: group[0].symbol,
      interval: "1h", // kept as 1h type-wise; this is a synthetic 4h bar for internal use only
      openingTime: group[0].openingTime,
      closeTime: group[group.length - 1].closeTime,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((sum, c) => sum + c.volume, 0),
      source: "binance",
      isClosed: group.every((c) => c.isClosed),
    });
  }
  return result;
}

export function checkHtfTrend(hourlyCandles: Candle[], cfg: RegimeFilterConfig): RegimeCheckResult {
  if (!cfg.requireHtfTrend) {
    return { passed: true, reason: "HTF trend filter disabled", details: {} };
  }

  const htfCandles = aggregateTo4h(hourlyCandles);
  if (htfCandles.length < cfg.htfEmaPeriod + 1) {
    return { passed: false, reason: "Insufficient 4h history for HTF trend check", details: { htfCandleCount: htfCandles.length } };
  }

  const closes = htfCandles.map((c) => c.close);
  const emaValues = computeEMA(closes, cfg.htfEmaPeriod);
  const latestEma = emaValues[emaValues.length - 1];
  const latestClose = closes[closes.length - 1];

  if (isNaN(latestEma)) {
    return { passed: false, reason: "4h EMA not yet available", details: { latestEma } };
  }

  const passed = latestClose > latestEma;
  return {
    passed,
    reason: passed
      ? `4h close ${latestClose.toFixed(4)} > 4h EMA(${cfg.htfEmaPeriod}) ${latestEma.toFixed(4)}`
      : `4h close ${latestClose.toFixed(4)} <= 4h EMA(${cfg.htfEmaPeriod}) ${latestEma.toFixed(4)} — HTF trend disagrees`,
    details: { latestClose, latestEma },
  };
}

/**
 * Runs all enabled regime filters against the currently-visible candle
 * window. Short-circuits on the first failure for a clear, single reason.
 */
export function evaluateRegimeFilters(
  candles: Candle[],
  emaPeriod: number,
  atrPeriod: number,
  cfg: Partial<RegimeFilterConfig> = {}
): RegimeCheckResult {
  const fullCfg: RegimeFilterConfig = { ...DEFAULT_REGIME_FILTER_CONFIG, ...cfg };

  const slope = checkEmaSlope(candles, emaPeriod, fullCfg);
  if (!slope.passed) return slope;

  const atrBand = checkAtrBand(candles, atrPeriod, fullCfg);
  if (!atrBand.passed) return atrBand;

  const htf = checkHtfTrend(candles, fullCfg);
  if (!htf.passed) return htf;

  return { passed: true, reason: "All enabled regime filters passed", details: {} };
}