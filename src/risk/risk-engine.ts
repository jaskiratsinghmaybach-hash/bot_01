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
  /** USD amount to risk on this trade — already resolved by the caller (see resolveRiskAmountUsd below for how fixed-usd vs percent-balance models compute this). */
  riskAmountUsd: number;
  maxPositionUsd: number;
  /**
   * Optional: current account balance in USD (quote-asset terms). When
   * provided, an additional independent ceiling is enforced —
   * quantity * entryPrice can never exceed balance * maxBalanceFraction,
   * regardless of what risk math alone implies. This mirrors a real
   * account's actual affordability limit, distinct from MAX_POSITION_USD
   * (a fixed configured ceiling) and distinct from riskAmountUsd (how
   * much of that position you're willing to lose). Omit for paper/dry-run
   * flows that don't have a real balance to check against.
   */
  accountBalanceUsd?: number;
  /** Fraction of accountBalanceUsd treated as the absolute affordability ceiling (e.g. 0.98). Required if accountBalanceUsd is provided. */
  maxBalanceFraction?: number;
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

/**
 * Resolves the USD amount to risk on a trade, given the configured risk
 * model. This is the single place fixed-usd vs percent-balance branching
 * happens — evaluateRisk() itself is agnostic to which model produced its
 * riskAmountUsd input.
 */
export function resolveRiskAmountUsd(params: {
  riskModel: "fixed-usd" | "percent-balance";
  riskPerTradeUsd: number;
  riskPercentOfBalance: number;
  accountBalanceUsd: number | null;
}): { riskAmountUsd: number } | { error: string } {
  const { riskModel, riskPerTradeUsd, riskPercentOfBalance, accountBalanceUsd } = params;

  if (riskModel === "fixed-usd") {
    return { riskAmountUsd: riskPerTradeUsd };
  }

  // percent-balance
  if (accountBalanceUsd === null || !Number.isFinite(accountBalanceUsd) || accountBalanceUsd <= 0) {
    return { error: `RISK_MODEL=percent-balance requires a valid account balance, got ${accountBalanceUsd}` };
  }
  const riskAmountUsd = accountBalanceUsd * riskPercentOfBalance;
  if (!Number.isFinite(riskAmountUsd) || riskAmountUsd <= 0) {
    return { error: `Computed percent-balance riskAmountUsd is invalid: ${riskAmountUsd}` };
  }
  return { riskAmountUsd };
}

export function evaluateRisk(input: RiskInput, rules: SymbolRules): RiskDecision {
  const { side, entryPrice, stopLoss, riskAmountUsd, maxPositionUsd, accountBalanceUsd, maxBalanceFraction } = input;

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
  if (accountBalanceUsd !== undefined) {
    if (!Number.isFinite(accountBalanceUsd) || accountBalanceUsd <= 0) {
      return rejected(side, `Invalid accountBalanceUsd: ${accountBalanceUsd}`);
    }
    if (maxBalanceFraction === undefined || !Number.isFinite(maxBalanceFraction) || maxBalanceFraction <= 0 || maxBalanceFraction > 1) {
      return rejected(side, `accountBalanceUsd was provided but maxBalanceFraction is missing or invalid: ${maxBalanceFraction}`);
    }
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

  // Independent affordability ceiling against a real account balance, if
  // provided (used by RISK_MODEL=percent-balance in live mode). This can
  // only ever shrink cappedQuantity further, never grow it.
  if (accountBalanceUsd !== undefined && maxBalanceFraction !== undefined) {
    const maxAffordableQuantity = (accountBalanceUsd * maxBalanceFraction) / entryPrice;
    if (maxAffordableQuantity < cappedQuantity) {
      cappedQuantity = maxAffordableQuantity;
    }
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
