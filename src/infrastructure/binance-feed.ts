import { evaluateMarketStrategy } from "../strategies/core-logic.js";
import WebSocket from "ws";
import { Candle } from "../types/index.js";
import environment from "../config/environment.js";
import {
  ensureCandleStorage,
  getRecentCandles,
  isValidClosedCandle,
  loadStrategyCandles,
  upsertCandle,
} from "./candle-repository.js";

// This is your live RAM storage. High-speed array holding your math inputs.
export const marketCandles: Candle[] = [];
export const strategyCandles: Candle[] = [];
const MAX_CANDLES_IN_RAM = 200; // Keep RAM light and fast
const SUPPORTED_INTERVALS: Candle["interval"][] = ["1m", "1h"];

type BinanceKlineMatrix = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string
];

interface BinanceWsKline {
  t: number;
  T: number;
  s: string;
  i: Candle["interval"];
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  x: boolean;
}

function replaceCache(target: Candle[], candles: Candle[]): void {
  target.splice(0, target.length, ...candles.slice(-MAX_CANDLES_IN_RAM));
}

function candleFromRestKline(
  symbol: string,
  interval: Candle["interval"],
  kline: BinanceKlineMatrix
): Candle {
  return {
    symbol,
    interval,
    openingTime: kline[0],
    closeTime: kline[6],
    open: parseFloat(kline[1]),
    high: parseFloat(kline[2]),
    low: parseFloat(kline[3]),
    close: parseFloat(kline[4]),
    volume: parseFloat(kline[5]),
    source: "binance",
    isClosed: true,
  };
}

function candleFromWsKline(kline: BinanceWsKline): Candle {
  return {
    symbol: kline.s.toUpperCase(),
    interval: kline.i,
    openingTime: kline.t,
    closeTime: kline.T,
    open: parseFloat(kline.o),
    high: parseFloat(kline.h),
    low: parseFloat(kline.l),
    close: parseFloat(kline.c),
    volume: parseFloat(kline.v),
    source: "binance",
    isClosed: kline.x,
  };
}

/**
 * Fetches historical closed candles from Binance REST API on startup
 * and persists them before RAM is hydrated from Postgres.
 */
export async function backfillHistoricalCandles(
  interval: Candle["interval"],
  limit: number
): Promise<void> {
  const symbol = environment.SYMBOL.toUpperCase();
  console.log(`[BOOT] Fetching last ${limit} ${interval} candles from Binance REST API for ${symbol}...`);

  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Binance REST API responded with status ${response.status}`);
    }

    const rawData = (await response.json()) as BinanceKlineMatrix[];

    for (const kline of rawData) {
      await upsertCandle(candleFromRestKline(symbol, interval, kline));
    }

    console.log(`[BOOT] Persisted ${rawData.length} real ${interval} Binance candles.`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[BOOT ERROR] Historical ${interval} backfill failed:`, message);
    throw error;
  }
}

export async function backfillHistoricalData(): Promise<void> {
  await ensureCandleStorage();
  await backfillHistoricalCandles("1m", MAX_CANDLES_IN_RAM);
  await backfillHistoricalCandles("1h", MAX_CANDLES_IN_RAM);

  replaceCache(marketCandles, await getRecentCandles(environment.SYMBOL, "1m", MAX_CANDLES_IN_RAM));
  replaceCache(strategyCandles, await loadStrategyCandles(environment.SYMBOL));

  console.log(`[BOOT] Loaded ${marketCandles.length} 1m candles into RAM from Postgres.`);
  console.log(`[BOOT] Loaded ${strategyCandles.length} 1h strategy candles into RAM from Postgres.`);
}

function initializeMarketStream(interval: Candle["interval"]): void {
  const wsUrl = `wss://stream.binance.com:9443/ws/${environment.SYMBOL.toLowerCase()}@kline_${interval}`;
  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    console.log(`[DATA] Live ${interval} market feed connected to Binance for ${environment.SYMBOL}`);
  });

  ws.on("message", async (data: string) => {
    try {
      const raw = JSON.parse(data);
      const kline = raw.k as BinanceWsKline | undefined;

      if (!kline || !kline.x) {
        return;
      }

      const closedCandle = candleFromWsKline(kline);

      if (closedCandle.symbol !== environment.SYMBOL || closedCandle.interval !== interval) {
        console.warn(`[DATA] Rejected mismatched candle ${closedCandle.symbol} ${closedCandle.interval}`);
        return;
      }

      if (!isValidClosedCandle(closedCandle)) {
        console.warn(`[DATA] Rejected invalid closed ${interval} candle from Binance.`);
        return;
      }

      await upsertCandle(closedCandle);

      if (interval === "1m") {
        replaceCache(marketCandles, await getRecentCandles(environment.SYMBOL, "1m", MAX_CANDLES_IN_RAM));
        console.log(`[DATA] Persisted closed 1m candle. RAM cache: ${marketCandles.length}`);
        return;
      }

      replaceCache(strategyCandles, await loadStrategyCandles(environment.SYMBOL));
      console.log(`[DATA] Persisted closed 1h candle. Strategy RAM cache: ${strategyCandles.length}`);

      const signal = evaluateMarketStrategy(strategyCandles);
      console.log(`[SIGNAL] Phase 1.5 scan only: ${signal.reason}. Trade routing remains disabled.`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[DATA] Failed to process ${interval} candle:`, message);
    }
  });

  ws.on("error", (err: any) => {
    console.error(`[DATA] ${interval} feed error:`, err.message);
  });

  ws.on("close", () => {
    console.log(`[DATA] ${interval} feed disconnected. Reconnecting in 5s...`);
    setTimeout(() => initializeMarketStream(interval), 5000);
  });
}

export function initializeMarketFeed(): void {
  for (const interval of SUPPORTED_INTERVALS) {
    initializeMarketStream(interval);
  }
}
