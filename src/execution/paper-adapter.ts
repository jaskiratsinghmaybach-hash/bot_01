/**
 * Paper execution adapter.
 *
 * Simulates order fills against a REAL current market price (fetched live
 * from Binance), applying configurable slippage and a taker fee, and
 * tracks a simulated USD balance in Postgres. This never contacts
 * Binance's order endpoints and never produces a real fill — every row it
 * writes is stamped provenance = 'PAPER' and every synthetic ID is
 * prefixed so it can never be confused with a real Binance order ID.
 *
 * This exists specifically so the strategy + risk engine + execution
 * pipeline can be exercised end-to-end, with realistic cost assumptions,
 * before Phase B (real signed Binance execution) is ever enabled.
 */

import environment from "../config/environment.js";
import type { OrderState, OrderStatus } from "../types/index.js";
import { insertOrder, updateOrderStatus, getPaperBalance, setPaperBalance } from "../infrastructure/order-repository.js";
import type { RiskDecision } from "../risk/risk-engine.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface PaperFillResult {
  order: OrderState;
  balanceAfter: number;
}

/**
 * Fetches the current best price for a symbol from Binance's public ticker
 * endpoint. This is real market data — only the FILL is simulated, not the
 * price it fills against.
 */
export async function fetchCurrentPrice(symbol: string): Promise<number> {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Binance ticker price request failed with status ${response.status}`);
  }
  const data = (await response.json()) as { price?: string };
  const price = Number(data.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Binance ticker returned an invalid price for ${symbol}: ${data.price}`);
  }
  return price;
}

/**
 * Simulates submitting and immediately filling a market order in PAPER
 * mode. Applies PAPER_SLIPPAGE_FRACTION against the fetched market price
 * (worse for the trader, in the direction of the trade) and
 * PAPER_FEE_FRACTION as a taker fee on notional. Debits/credits the
 * simulated quote-asset (USD-equivalent) balance accordingly and refuses
 * to fill if the simulated balance can't cover the notional + fee.
 *
 * Never fabricates a Binance order ID — synthetic IDs are prefixed
 * "paper_" so they can never be mistaken for a live exchange order ID.
 */
export async function submitPaperOrder(
  decision: RiskDecision,
  stopLoss: number,
  takeProfit: number,
  candleOpenTime: number
): Promise<PaperFillResult> {
  if (!decision.approved || decision.quantity === null || decision.price === null) {
    throw new Error("submitPaperOrder called with an unapproved risk decision");
  }
  if (environment.TRADING_MODE !== "paper") {
    throw new Error(
      `submitPaperOrder called while TRADING_MODE=${environment.TRADING_MODE}. Refusing to simulate a fill outside paper mode.`
    );
  }

  const symbol = environment.SYMBOL;
  const side = decision.side;
  const requestedPrice = decision.price;
  const requestedQuantity = decision.quantity;

  const marketPrice = await fetchCurrentPrice(symbol);

  // Slippage always moves the fill price AGAINST the trader: worse for a
  // BUY (higher fill), worse for a SELL (lower fill). This is a realistic,
  // conservative assumption for a market order — never assume favorable
  // slippage.
  const slippageFraction = environment.PAPER_SLIPPAGE_FRACTION;
  const slippedPrice =
    side === "BUY" ? marketPrice * (1 + slippageFraction) : marketPrice * (1 - slippageFraction);

  const notional = slippedPrice * requestedQuantity;
  const fee = notional * environment.PAPER_FEE_FRACTION;
  const slippageCostUsd = Math.abs(slippedPrice - marketPrice) * requestedQuantity;

  const id = randomId("paper");
  const clientOrderId = randomId("bot01paper");
  const now = Date.now();

  const order: OrderState = {
    id,
    clientOrderId,
    symbol,
    side,
    status: "CREATED",
    provenance: "PAPER",
    candleOpenTime,
    requestedPrice,
    requestedQuantity,
    filledPrice: null,
    filledQuantity: null,
    stopLoss,
    takeProfit,
    stopLossOrderId: null,
    takeProfitOrderId: null,
    feePaid: null,
    slippageApplied: null,
    createdAt: now,
    updatedAt: now,
  };

  await insertOrder(order);

  const quoteAsset = "USD_SIM"; // simulated quote balance, intentionally distinct from any real asset symbol
  const currentBalance = await getPaperBalance(quoteAsset);

  const totalCost = notional + fee;

  if (side === "BUY" && totalCost > currentBalance) {
    await updateOrderStatus(id, "REJECTED" as OrderStatus);
    order.status = "REJECTED";
    return { order, balanceAfter: currentBalance };
  }

  // Simulate settlement: BUY debits quote balance by notional+fee,
  // SELL credits quote balance by notional-fee. This is a simplified
  // single-asset PnL model (quote-currency accounting only) — it does not
  // simulate holding a base-asset inventory across multiple trades.
  const balanceAfter = side === "BUY" ? currentBalance - totalCost : currentBalance + notional - fee;

  await setPaperBalance(quoteAsset, balanceAfter);
  await updateOrderStatus(id, "FILLED" as OrderStatus, {
    filledPrice: slippedPrice,
    filledQuantity: requestedQuantity,
    feePaid: fee,
    slippageApplied: slippageCostUsd,
  });

  order.status = "FILLED";
  order.filledPrice = slippedPrice;
  order.filledQuantity = requestedQuantity;
  order.feePaid = fee;
  order.slippageApplied = slippageCostUsd;

  return { order, balanceAfter };
}

/** Initializes the simulated PAPER balance if it hasn't been set yet. Idempotent. */
export async function ensurePaperBalanceInitialized(): Promise<number> {
  const quoteAsset = "USD_SIM";
  const existing = await getPaperBalance(quoteAsset);
  if (existing > 0) return existing;
  await setPaperBalance(quoteAsset, environment.PAPER_STARTING_BALANCE_USD);
  return environment.PAPER_STARTING_BALANCE_USD;
}
