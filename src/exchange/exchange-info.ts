/**
 * Binance /api/v3/exchangeInfo client and symbol-rule extraction.
 *
 * This is a public (unauthenticated) endpoint — no API key required. It
 * tells us the exact precision and size rules Binance will enforce on an
 * order for a given symbol, so we can normalize a mathematically-derived
 * quantity into one Binance will actually accept, rather than guessing.
 */

export interface SymbolRules {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  /** Smallest allowed increment in price (PRICE_FILTER.tickSize). */
  tickSize: number;
  minPrice: number;
  maxPrice: number;
  /** Smallest allowed increment in order quantity (LOT_SIZE.stepSize). */
  stepSize: number;
  minQty: number;
  maxQty: number;
  /** Minimum allowed notional (price * quantity) for an order, if present. */
  minNotional: number | null;
}

interface BinanceExchangeInfoFilter {
  filterType: string;
  tickSize?: string;
  minPrice?: string;
  maxPrice?: string;
  stepSize?: string;
  minQty?: string;
  maxQty?: string;
  minNotional?: string;
}

interface BinanceExchangeInfoSymbol {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  filters: BinanceExchangeInfoFilter[];
}

interface BinanceExchangeInfoResponse {
  symbols: BinanceExchangeInfoSymbol[];
}

const BINANCE_REST_BASE = "https://api.binance.com";

/**
 * Fetches and parses the LOT_SIZE / PRICE_FILTER / MIN_NOTIONAL (or NOTIONAL)
 * filters for a single symbol. Throws if the symbol is not found or is not
 * currently in TRADING status — we should never build an order against a
 * symbol Binance isn't actively trading.
 */
export async function fetchSymbolRules(symbol: string): Promise<SymbolRules> {
  const url = `${BINANCE_REST_BASE}/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Binance exchangeInfo request failed with status ${response.status}`);
  }

  const data = (await response.json()) as BinanceExchangeInfoResponse;
  const symbolInfo = data.symbols?.[0];

  if (!symbolInfo) {
    throw new Error(`Symbol ${symbol} not found in Binance exchangeInfo response`);
  }

  if (symbolInfo.status !== "TRADING") {
    throw new Error(`Symbol ${symbol} is not in TRADING status (status=${symbolInfo.status})`);
  }

  const priceFilter = symbolInfo.filters.find((f) => f.filterType === "PRICE_FILTER");
  const lotSizeFilter = symbolInfo.filters.find((f) => f.filterType === "LOT_SIZE");
  // Binance has migrated some symbols from MIN_NOTIONAL to NOTIONAL; support both.
  const notionalFilter = symbolInfo.filters.find(
    (f) => f.filterType === "MIN_NOTIONAL" || f.filterType === "NOTIONAL"
  );

  if (!priceFilter?.tickSize || !priceFilter.minPrice || !priceFilter.maxPrice) {
    throw new Error(`Symbol ${symbol} is missing a usable PRICE_FILTER`);
  }
  if (!lotSizeFilter?.stepSize || !lotSizeFilter.minQty || !lotSizeFilter.maxQty) {
    throw new Error(`Symbol ${symbol} is missing a usable LOT_SIZE filter`);
  }

  return {
    symbol: symbolInfo.symbol,
    baseAsset: symbolInfo.baseAsset,
    quoteAsset: symbolInfo.quoteAsset,
    tickSize: Number(priceFilter.tickSize),
    minPrice: Number(priceFilter.minPrice),
    maxPrice: Number(priceFilter.maxPrice),
    stepSize: Number(lotSizeFilter.stepSize),
    minQty: Number(lotSizeFilter.minQty),
    maxQty: Number(lotSizeFilter.maxQty),
    minNotional: notionalFilter?.minNotional ? Number(notionalFilter.minNotional) : null,
  };
}
