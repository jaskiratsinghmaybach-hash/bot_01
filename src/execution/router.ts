/**
 * Execution router.
 *
 * Single entry point that takes a strategy candidate + risk decision and
 * routes it to the adapter matching the configured TRADING_MODE. This is
 * the only place that branches on TRADING_MODE for execution purposes —
 * keeping that branch in one place makes it easy to verify LIVE can never
 * be silently reached without the explicit credential checks already
 * enforced in config/environment.ts.
 */

import environment from "../config/environment.js";
import type { RiskDecision } from "../risk/risk-engine.js";
import type { TradeCandidate } from "../strategies/core-logic.js";
import type { SymbolRules } from "../exchange/exchange-info.js";
import { logDryRunDecision } from "./dry-run-adapter.js";
import { submitPaperOrder } from "./paper-adapter.js";
import { executeLiveOrder } from "./live-adapter.js";

export async function routeExecution(
  candidate: TradeCandidate,
  decision: RiskDecision | null,
  rules: SymbolRules
): Promise<void> {
  const stopLoss = candidate.stopLoss ?? 0;
  const takeProfit = candidate.takeProfit ?? 0;

  switch (environment.TRADING_MODE) {
    case "dry-run":
      if (!decision) throw new Error("dry-run mode requires a risk decision");
      logDryRunDecision(decision, stopLoss, takeProfit);
      return;

    case "paper": {
      if (!decision) throw new Error("paper mode requires a risk decision");
      if (!decision.approved) {
        console.log(`[PAPER] Signal rejected by risk engine: ${decision.reason}`);
        return;
      }
      const { order, balanceAfter } = await submitPaperOrder(decision, stopLoss, takeProfit, candidate.candleOpenTime);
      console.log(
        `[PAPER] Order ${order.id} ${order.status} — ${order.side} ${order.filledQuantity ?? order.requestedQuantity} ` +
          `@ ${order.filledPrice ?? order.requestedPrice} | fee $${order.feePaid?.toFixed(4) ?? "0"} | ` +
          `simulated balance: $${balanceAfter.toFixed(2)}`
      );
      return;
    }

    case "live": {
      // Live mode resolves its own risk decision internally (fixed-usd or
      // percent-balance per RISK_MODEL, the latter requiring a live
      // account balance fetch) — any decision passed in is ignored.
      const result = await executeLiveOrder(candidate, rules);
      if (result.skippedReason) {
        console.log(`[LIVE] Skipped: ${result.skippedReason}`);
        return;
      }
      console.log(
        `[LIVE] Order ${result.order?.id} ${result.order?.status} — ${result.order?.side} ` +
          `${result.order?.filledQuantity} @ ${result.order?.filledPrice}`
      );
      return;
    }

    default: {
      const exhaustiveCheck: never = environment.TRADING_MODE;
      throw new Error(`Unhandled TRADING_MODE: ${exhaustiveCheck}`);
    }
  }
}
