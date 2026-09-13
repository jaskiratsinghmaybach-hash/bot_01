/**
 * Risk engine.
 *
 * Pure, deterministic sizing math — no database, no network, no exchange
 * credentials. Takes a trade candidate (from the strategy) plus account/risk
 * configuration and Binance's symbol rules, and produces either a validated,
 * exchange-normalized order or a clear rejection reason.
 *
 * This module never assumes a mathematically "correct" quantity is
 * executable — it always normalizes against real exchange rules and rejects
 * rather than silently rounding up into more risk than intended.
 */

import type { SymbolRules } from "../exchange/exchange-info.js";
import { normalizeOrder } from "../exchange/precision.js";

export interface RiskInput {
  side: "BUY" | "SELL";
  entryPrice: number;
  stopLoss: number;
  riskAmountUsd: number;
  maxPositionUsd: number;
}

export interface RiskDecision {
  approved: boolean;
  reason: string;
  side: "BUY" | "SELL";
  /** Raw, pre-exchange-normalization quantity implied by risk math. */
  rawQuantity: number | null;
  /** Final quantity after LOT_SIZE/tick normalization, ready to submit. */
  quantity: number | null;
  price: number | null;
  notionalUsd: number | null;
  riskDistance: number | null;
}

function rejected(side: "BUY" | "SELL", reason: string): RiskDecision {
  return {
    approved: false,
    reason,
    side,
    rawQuantity: null,
    quantity: null,
    price: null,
    notionalUsd: null,
    riskDistance: null,
  };
}

/**
 * Computes riskDistance for a BUY or SELL.
 *   BUY:  riskDistance = entryPrice - stopLoss   (stop below entry)
 *   SELL: riskDistance = stopLoss - entryPrice   (stop above entry)
 */
export function computeRiskDistance(side: "BUY" | "SELL", entryPrice: number, stopLoss: number): number {
  return side === "BUY" ? entryPrice - stopLoss : stopLoss - entryPrice;
}

export function evaluateRisk(input: RiskInput, rules: SymbolRules): RiskDecision {
  const { side, entryPrice, stopLoss, riskAmountUsd, maxPositionUsd } = input;

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return rejected(side, `Invalid entryPrice: ${entryPrice}`);
  }
  if (!Number.isFinite(stopLoss) || stopLoss <= 0) {
    return rejected(side, `Invalid stopLoss: ${stopLoss}`);
  }
  if (!Number.isFinite(riskAmountUsd) || riskAmountUsd <= 0) {
    return rejected(side, `Invalid riskAmountUsd: ${riskAmountUsd}`);
  }
  if (!Number.isFinite(maxPositionUsd) || maxPositionUsd <= 0) {
    return rejected(side, `Invalid maxPositionUsd: ${maxPositionUsd}`);
  }

  const riskDistance = computeRiskDistance(side, entryPrice, stopLoss);

  if (!Number.isFinite(riskDistance)) {
    return rejected(side, `riskDistance is not finite (entry=${entryPrice}, stopLoss=${stopLoss})`);
  }
  if (riskDistance <= 0) {
    return rejected(
      side,
      `riskDistance must be > 0, got ${riskDistance} (entry=${entryPrice}, stopLoss=${stopLoss}, side=${side})`
    );
  }

  // Position size from pure risk math: riskAmount / riskDistance
  const rawQuantity = riskAmountUsd / riskDistance;

  if (!Number.isFinite(rawQuantity) || rawQuantity <= 0) {
    return rejected(side, `Computed rawQuantity is invalid: ${rawQuantity}`);
  }

  // Enforce the hard notional ceiling independent of risk-based sizing —
  // a very tight stop can otherwise imply a huge position size.
  const rawNotional = rawQuantity * entryPrice;
  let cappedQuantity = rawQuantity;
  if (rawNotional > maxPositionUsd) {
    cappedQuantity = maxPositionUsd / entryPrice;
  }

  const normalized = normalizeOrder(cappedQuantity, entryPrice, rules);

  if (!normalized.valid) {
    return {
      approved: false,
      reason: normalized.rejectionReason ?? "Order failed exchange normalization",
      side,
      rawQuantity,
      quantity: normalized.quantity || null,
      price: normalized.price || null,
      notionalUsd: normalized.notional || null,
      riskDistance,
    };
  }

  // After flooring to stepSize, confirm actual risk at the normalized
  // quantity hasn't drifted above what was requested (it can only be equal
  // or lower, since we always floor — this is a defensive assertion, not a
  // correction).
  const actualRiskUsd = normalized.quantity * riskDistance;
  if (actualRiskUsd > riskAmountUsd * 1.0001) {
    return rejected(
      side,
      `Normalized quantity ${normalized.quantity} implies risk ${actualRiskUsd.toFixed(2)} ` +
        `USD, exceeding requested riskAmountUsd ${riskAmountUsd}. Refusing to submit.`
    );
  }

  return {
    approved: true,
    reason: "Risk-approved and exchange-normalized",
    side,
    rawQuantity,
    quantity: normalized.quantity,
    price: normalized.price,
    notionalUsd: normalized.notional,
    riskDistance,
  };
}
