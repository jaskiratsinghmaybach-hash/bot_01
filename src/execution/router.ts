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
import { logDryRunDecision } from "./dry-run-adapter.js";
import { submitPaperOrder } from "./paper-adapter.js";
import { assertLiveModeNotImplemented } from "./live-adapter.js";

export async function routeExecution(
  decision: RiskDecision,
  stopLoss: number,
  takeProfit: number
): Promise<void> {
  switch (environment.TRADING_MODE) {
    case "dry-run":
      logDryRunDecision(decision, stopLoss, takeProfit);
      return;

    case "paper": {
      if (!decision.approved) {
        console.log(`[PAPER] Signal rejected by risk engine: ${decision.reason}`);
        return;
      }
      const { order, balanceAfter } = await submitPaperOrder(decision, stopLoss, takeProfit);
      console.log(
        `[PAPER] Order ${order.id} ${order.status} — ${order.side} ${order.filledQuantity ?? order.requestedQuantity} ` +
          `@ ${order.filledPrice ?? order.requestedPrice} | fee $${order.feePaid?.toFixed(4) ?? "0"} | ` +
          `simulated balance: $${balanceAfter.toFixed(2)}`
      );
      return;
    }

    case "live":
      assertLiveModeNotImplemented();
      return;

    default: {
      const exhaustiveCheck: never = environment.TRADING_MODE;
      throw new Error(`Unhandled TRADING_MODE: ${exhaustiveCheck}`);
    }
  }
}
