/**
 * Dry-run execution adapter.
 *
 * Logs what WOULD be submitted, at the risk-engine's already-normalized
 * quantity/price, but never writes an order_history row and never claims
 * any fill. This is the safest mode and the default — useful for watching
 * strategy + risk output against live market data with zero balance
 * tracking and zero persistence of "orders" that never happened.
 */

import type { RiskDecision } from "../risk/risk-engine.js";

export function logDryRunDecision(decision: RiskDecision, stopLoss: number, takeProfit: number): void {
  if (!decision.approved) {
    console.log(`[DRY_RUN] Signal rejected by risk engine: ${decision.reason}`);
    return;
  }

  console.log(
    `[DRY_RUN] Would submit ${decision.side} ${decision.quantity} @ ~${decision.price} ` +
      `(notional ~$${decision.notionalUsd?.toFixed(2)}, SL ${stopLoss.toFixed(4)}, TP ${takeProfit.toFixed(4)}). ` +
      `No order was created, submitted, or persisted.`
  );
}
