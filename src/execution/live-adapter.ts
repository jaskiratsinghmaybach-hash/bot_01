/**
 * Live execution adapter.
 *
 * Real, signed Binance Spot API order submission: authenticated account
 * balance fetch, signed MARKET BUY, signed OCO SELL bracket (stop-loss +
 * take-profit), and an honest order-state machine persisted to
 * order_history with provenance = 'LIVE'.
 *
 * SAFETY: This module is only ever reached when TRADING_MODE=live, which
 * itself requires BINANCE_API_KEY/BINANCE_SECRET_KEY to be configured
 * (config/environment.ts enforces this at boot). Every guard below exists
 * to prevent a duplicate entry, an oversized position, or a silently
 * unprotected (stop-loss-less) open position — see docs/execution.md for
 * the full safety model.
 *
 * VERIFICATION STATUS: The HMAC-SHA256 request signing in
 * exchange/binance-signing.ts is verified byte-for-byte against Binance's
 * own published worked example (cross-checked independently against
 * OpenSSL — see binance-signing.test.ts). The actual HTTP calls to
 * Binance's live order endpoints in THIS file have NOT been verified
 * against a real or testnet Binance account — outbound network access to
 * api.binance.com was unavailable in this project's development
 * environment. Test against Binance's testnet before any mainnet use.
 * See docs/verification.md.
 */

import environment from "../config/environment.js";
import { buildSignedQuery } from "../exchange/binance-signing.js";
import type { SymbolRules } from "../exchange/exchange-info.js";
import { evaluateRisk, resolveRiskAmountUsd, type RiskDecision } from "../risk/risk-engine.js";
import { insertOrder, updateOrderStatus, hasActiveOrderForCandle, hasOpenPosition } from "../infrastructure/order-repository.js";
import type { OrderState } from "../types/index.js";
import type { TradeCandidate } from "../strategies/core-logic.js";

const BINANCE_BASE = "https://api.binance.com";

// ---------------------------------------------------------------------------
// Binance response shapes
// ---------------------------------------------------------------------------

interface BinanceOrderFill {
  price: string;
  qty: string;
  commission: string;
  commissionAsset: string;
  tradeId: number;
}

interface BinanceOrderResponse {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  transactTime: number;
  price: string;
  origQty: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  status: string;
  type: string;
  side: string;
  fills?: BinanceOrderFill[];
}

interface BinanceOcoOrderReport {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  type: string;
}

interface BinanceOcoResponse {
  orderListId: number;
  listClientOrderId: string;
  symbol: string;
  orders: Array<{ symbol: string; orderId: number; clientOrderId: string }>;
  orderReports: BinanceOcoOrderReport[];
}

interface BinanceAccountResponse {
  balances: Array<{ asset: string; free: string; locked: string }>;
}

// ---------------------------------------------------------------------------
// Signed request helper
// ---------------------------------------------------------------------------

async function binanceSigned<T>(
  method: "GET" | "POST",
  path: string,
  params: Record<string, string | number>
): Promise<T> {
  const query = buildSignedQuery(params, environment.BINANCE_SECRET_KEY, Date.now(), environment.RECV_WINDOW_MS);
  const url = method === "GET" ? `${BINANCE_BASE}${path}?${query}` : `${BINANCE_BASE}${path}`;

  const response = await fetch(url, {
    method,
    headers: {
      "X-MBX-APIKEY": environment.BINANCE_API_KEY,
      ...(method !== "GET" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(method !== "GET" ? { body: query } : {}),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Binance API error on ${method} ${path} — HTTP ${response.status}: ${text}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Failed to parse Binance response from ${path}: ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Account balance
// ---------------------------------------------------------------------------

async function getQuoteAssetBalance(quoteAsset: string): Promise<number> {
  const account = await binanceSigned<BinanceAccountResponse>("GET", "/api/v3/account", {});
  const balance = account.balances.find((b) => b.asset === quoteAsset);
  if (!balance) {
    throw new Error(`${quoteAsset} balance not found in Binance account response`);
  }
  const free = Number(balance.free);
  if (!Number.isFinite(free) || free <= 0) {
    throw new Error(`${quoteAsset} free balance is zero or invalid: "${balance.free}"`);
  }
  return free;
}

// ---------------------------------------------------------------------------
// Order placement
// ---------------------------------------------------------------------------

async function placeMarketBuy(symbol: string, quantity: string): Promise<BinanceOrderResponse> {
  return binanceSigned<BinanceOrderResponse>("POST", "/api/v3/order", {
    symbol,
    side: "BUY",
    type: "MARKET",
    quantity,
  });
}

async function placeOcoSell(
  symbol: string,
  quantity: string,
  takeProfitPrice: string,
  stopTriggerPrice: string,
  stopLimitPrice: string
): Promise<BinanceOcoResponse> {
  return binanceSigned<BinanceOcoResponse>("POST", "/api/v3/order/oco", {
    symbol,
    side: "SELL",
    quantity,
    price: takeProfitPrice,
    stopPrice: stopTriggerPrice,
    stopLimitPrice,
    stopLimitTimeInForce: "GTC",
  });
}

function randomClientOrderId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface LiveExecutionResult {
  order: OrderState | null;
  skippedReason: string | null;
}

/**
 * Executes a trade candidate against real Binance, if TRADING_MODE=live
 * and every guard passes. Returns skippedReason (not an exception) for
 * ordinary "did not trade" outcomes (open position exists, duplicate
 * signal, risk rejected) — exceptions are reserved for genuine failures
 * (network error, Binance rejection, malformed response).
 */
export async function executeLiveOrder(
  candidate: TradeCandidate,
  rules: SymbolRules
): Promise<LiveExecutionResult> {
  if (environment.TRADING_MODE !== "live") {
    throw new Error(`executeLiveOrder called while TRADING_MODE=${environment.TRADING_MODE}. Refusing.`);
  }
  if (!candidate.shouldEnter || candidate.direction !== "BUY") {
    return { order: null, skippedReason: "Candidate is not an actionable BUY signal" };
  }
  if (candidate.entryPrice === null || candidate.stopLoss === null || candidate.takeProfit === null) {
    throw new Error("Candidate is missing entryPrice/stopLoss/takeProfit — should never reach execution");
  }

  const symbol = environment.SYMBOL;

  // ---- Guard 1: single open position at a time -----------------------
  if (await hasOpenPosition(symbol, "LIVE")) {
    return { order: null, skippedReason: "Open LIVE position already exists for this symbol — refusing new entry" };
  }

  // ---- Guard 2: duplicate signal for this candle ----------------------
  if (await hasActiveOrderForCandle(symbol, "LIVE", candidate.candleOpenTime)) {
    return { order: null, skippedReason: `Active LIVE order already exists for candle_open_time=${candidate.candleOpenTime}` };
  }

  // ---- Resolve risk amount from the configured risk model -------------
  let accountBalanceUsd: number | null = null;
  if (environment.RISK_MODEL === "percent-balance") {
    accountBalanceUsd = await getQuoteAssetBalance(rules.quoteAsset);
  }
  const riskAmountResult = resolveRiskAmountUsd({
    riskModel: environment.RISK_MODEL,
    riskPerTradeUsd: environment.RISK_PER_TRADE_USD,
    riskPercentOfBalance: environment.RISK_PERCENT_OF_BALANCE,
    accountBalanceUsd,
  });
  if ("error" in riskAmountResult) {
    throw new Error(`Risk amount resolution failed: ${riskAmountResult.error}`);
  }

  // ---- Risk engine: size + exchange-normalize --------------------------
  const decision: RiskDecision = evaluateRisk(
    {
      side: "BUY",
      entryPrice: candidate.entryPrice,
      stopLoss: candidate.stopLoss,
      riskAmountUsd: riskAmountResult.riskAmountUsd,
      maxPositionUsd: environment.MAX_POSITION_USD,
      ...(accountBalanceUsd !== null
        ? { accountBalanceUsd, maxBalanceFraction: environment.MAX_BALANCE_FRACTION }
        : {}),
    },
    rules
  );

  if (!decision.approved || decision.quantity === null || decision.price === null) {
    return { order: null, skippedReason: `Risk engine rejected candidate: ${decision.reason}` };
  }

  // ---- Persist CREATED row before any exchange call --------------------
  const id = randomClientOrderId("live_pending");
  const clientOrderId = randomClientOrderId("bot01live");
  const now = Date.now();

  const order: OrderState = {
    id,
    clientOrderId,
    symbol,
    side: "BUY",
    status: "CREATED",
    provenance: "LIVE",
    candleOpenTime: candidate.candleOpenTime,
    requestedPrice: decision.price,
    requestedQuantity: decision.quantity,
    filledPrice: null,
    filledQuantity: null,
    stopLoss: candidate.stopLoss,
    takeProfit: candidate.takeProfit,
    stopLossOrderId: null,
    takeProfitOrderId: null,
    feePaid: null,
    slippageApplied: null,
    createdAt: now,
    updatedAt: now,
  };
  await insertOrder(order);

  // ---- Place the real MARKET BUY ----------------------------------------
  let entryOrder: BinanceOrderResponse;
  try {
    await updateOrderStatus(id, "SUBMITTED");
    entryOrder = await placeMarketBuy(symbol, String(decision.quantity));
  } catch (err) {
    await updateOrderStatus(id, "REJECTED");
    throw new Error(`MARKET BUY submission failed (order marked REJECTED in order_history, id=${id}): ${String(err)}`);
  }

  // ---- Derive fill details ------------------------------------------------
  let avgFillPrice = Number(entryOrder.price) || decision.price;
  let executedQty = Number(entryOrder.executedQty) || decision.quantity;
  if (entryOrder.fills && entryOrder.fills.length > 0) {
    let totalQty = 0;
    let totalValue = 0;
    for (const fill of entryOrder.fills) {
      const q = Number(fill.qty);
      const p = Number(fill.price);
      totalQty += q;
      totalValue += q * p;
    }
    if (totalQty > 0) {
      avgFillPrice = totalValue / totalQty;
      executedQty = totalQty;
    }
  }

  await updateOrderStatus(id, "FILLED", { filledPrice: avgFillPrice, filledQuantity: executedQty });

  // ---- Place the protective OCO bracket -----------------------------------
  // A tighter stop-limit trigger than the strategy's raw stopLoss, so the
  // limit order has a realistic chance of filling during a fast move
  // rather than sitting unfilled below the market. Buffer is the larger
  // of a small ATR-based amount or a flat 0.5% of the stop price.
  const atrBuffer = (candidate.atr14 ?? 0) * 0.5;
  const pctBuffer = candidate.stopLoss * 0.005;
  const slippageBuffer = Math.max(atrBuffer, pctBuffer);
  const stopLimitPrice = candidate.stopLoss - slippageBuffer;

  try {
    const ocoResult = await placeOcoSell(
      symbol,
      String(executedQty),
      String(candidate.takeProfit),
      String(candidate.stopLoss),
      String(stopLimitPrice)
    );

    const stopReport = ocoResult.orderReports.find((r) => r.type === "STOP_LOSS_LIMIT");
    const tpReport = ocoResult.orderReports.find((r) => r.type === "LIMIT_MAKER" || r.type === "LIMIT");
    const stopOrderId = stopReport ? String(stopReport.orderId) : String(ocoResult.orders[0]?.orderId ?? "");
    const tpOrderId = tpReport ? String(tpReport.orderId) : String(ocoResult.orders[1]?.orderId ?? "");

    await updateOrderStatus(id, "FILLED", { stopLossOrderId: stopOrderId, takeProfitOrderId: tpOrderId });

    order.status = "FILLED";
  } catch (err) {
    // CRITICAL: entry filled but the protective bracket failed. The
    // position is open on the real exchange with NO automated stop-loss.
    // This must never be silently reported as a normal FILLED order.
    await updateOrderStatus(id, "FILLED_UNHEDGED");
    order.status = "FILLED_UNHEDGED";
    throw new Error(
      `CRITICAL: MARKET BUY filled (orderId=${entryOrder.orderId}) but OCO bracket placement FAILED. ` +
        `Position is open and UNHEDGED on Binance. Manual intervention required immediately. ` +
        `order_history id=${id}. Underlying error: ${String(err)}`
    );
  }

  order.filledPrice = avgFillPrice;
  order.filledQuantity = executedQty;

  return { order, skippedReason: null };
}
