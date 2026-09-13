/**
 * Pure candle validation — no database, no network, no environment
 * dependency. Deliberately split out from candle-repository.ts so this
 * logic (and its tests) can be imported without requiring DATABASE_URL to
 * be configured, matching the same "strategy/validation logic shouldn't
 * need credentials" principle applied to strategies/core-logic.ts and
 * risk/risk-engine.ts.
 */
import type { Candle } from "../types/index.js";

export function isValidClosedCandle(candle: Candle): boolean {
  const prices = [candle.open, candle.high, candle.low, candle.close, candle.volume];
  const hasValidNumbers = prices.every((value) => Number.isFinite(value) && value >= 0);
  const hasValidTime =
    Number.isInteger(candle.openingTime) &&
    Number.isInteger(candle.closeTime) &&
    candle.closeTime > candle.openingTime;

  return (
    candle.source === "binance" &&
    candle.isClosed &&
    candle.symbol.length > 0 &&
    (candle.interval === "1m" || candle.interval === "1h") &&
    hasValidTime &&
    hasValidNumbers &&
    candle.high >= candle.low &&
    candle.high >= candle.open &&
    candle.high >= candle.close &&
    candle.low <= candle.open &&
    candle.low <= candle.close
  );
}
