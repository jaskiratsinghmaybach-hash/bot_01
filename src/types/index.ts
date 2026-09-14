export interface Candle {
  symbol: string;
  interval: '1m' | '1h';
  openingTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: 'binance';
  isClosed: boolean;
}

/**
 * Honest order lifecycle states. "FILLED" must only ever be written when an
 * exchange (live) or a documented simulation (paper) has actually confirmed
 * the fill — never on order construction alone.
 */
export type OrderStatus =
  | 'CREATED'        // Order object built locally, not yet sent anywhere
  | 'SUBMITTED'       // Sent to Binance (live) or accepted into the paper simulator
  | 'ACKNOWLEDGED'    // Binance has accepted the order (live only)
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'UNKNOWN'          // Network/response ambiguity — status could not be confirmed
  | 'FILLED_UNHEDGED'; // LIVE only: entry filled but the protective OCO bracket
                        // (stop-loss + take-profit) failed to place. The
                        // position is open on the real exchange with NO
                        // automated stop-loss protection. Requires manual
                        // intervention. Never silently downgraded to FILLED
                        // — that would hide a genuinely dangerous state.

/** Where an order's fill price/status came from — never blur these together. */
export type OrderProvenance = 'LIVE' | 'PAPER' | 'DRY_RUN';

export interface OrderState {
  /** Exchange order ID (live) or a clearly-prefixed synthetic ID (paper/dry-run). Never fabricated as if real. */
  id: string;
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  status: OrderStatus;
  provenance: OrderProvenance;
  /**
   * openingTime of the candle whose closed-candle signal produced this
   * order. Used as a duplicate-order guard — the same signal candle
   * should never produce two entries for the same symbol.
   */
  candleOpenTime: number;
  requestedPrice: number;
  requestedQuantity: number;
  /** Actual fill price. Null until a fill (real or simulated) has occurred. */
  filledPrice: number | null;
  filledQuantity: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Real Binance order ID for the stop-loss leg of a live OCO bracket. Null until placed. LIVE provenance only. */
  stopLossOrderId: string | null;
  /** Real Binance order ID for the take-profit leg of a live OCO bracket. Null until placed. LIVE provenance only. */
  takeProfitOrderId: string | null;
  /** Simulated or real fee paid, in quote-asset units. */
  feePaid: number | null;
  /** Simulated or real slippage applied vs requested price, in quote-asset units. */
  slippageApplied: number | null;
  createdAt: number;
  updatedAt: number;
}
