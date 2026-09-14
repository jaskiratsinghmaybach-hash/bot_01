/**
 * Deep historical backfill.
 *
 * The normal boot-time backfill (binance-feed.ts) only pulls the most
 * recent `limit` candles in a single REST call (max 1000 per Binance's
 * API). This script pages backward in time using `endTime`, so you can
 * pull months of history instead of ~17 days, for a much larger backtest
 * sample size.
 *
 * Usage:
 *   node --loader ts-node/esm src/scripts/deep-backfill.ts [months]
 *
 * Example (default 6 months of 1h candles):
 *   node --loader ts-node/esm src/scripts/deep-backfill.ts
 *
 * Example (12 months):
 *   node --loader ts-node/esm src/scripts/deep-backfill.ts 12
 *
 * Safe to re-run — upsertCandle is idempotent per (symbol, interval,
 * openingTime), so re-running just fills in anything missing.
 */
import "dotenv/config";
import environment from "../config/environment.js";
import { ensureCandleStorage, upsertCandle } from "../infrastructure/candle-repository.js";
import { pool } from "../infrastructure/database.js";
import type { Candle } from "../types/index.js";

type BinanceKlineMatrix = [
  number, string, string, string, string, string,
  number, string, number, string, string, string
];

const BINANCE_KLINE_LIMIT = 1000; // Binance's hard per-request cap
const INTERVAL: Candle["interval"] = "1h";
const INTERVAL_MS = 60 * 60 * 1000; // 1h in ms — must match INTERVAL

function candleFromRestKline(symbol: string, interval: Candle["interval"], kline: BinanceKlineMatrix): Candle {
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

async function fetchKlinePage(symbol: string, interval: string, endTime: number): Promise<BinanceKlineMatrix[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${BINANCE_KLINE_LIMIT}&endTime=${endTime}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Binance REST API responded with status ${response.status}`);
  }
  return (await response.json()) as BinanceKlineMatrix[];
}

async function main() {
  const months = Number(process.argv[2] ?? 6);
  const symbol = environment.SYMBOL.toUpperCase();
  const startTime = Date.now() - months * 30 * 24 * 60 * 60 * 1000;

  console.log("=============================================");
  console.log("           DEEP HISTORICAL BACKFILL           ");
  console.log("=============================================");
  console.log(`Symbol:   ${symbol}`);
  console.log(`Interval: ${INTERVAL}`);
  console.log(`Target:   last ${months} month(s) (back to ${new Date(startTime).toISOString()})`);
  console.log("");

  await ensureCandleStorage();

  let endTime = Date.now();
  let totalPersisted = 0;
  let page = 0;

  while (endTime > startTime) {
    page += 1;
    const rawData = await fetchKlinePage(symbol, INTERVAL, endTime);

    if (rawData.length === 0) {
      console.log(`[BACKFILL] Page ${page}: no more data returned, stopping.`);
      break;
    }

    for (const kline of rawData) {
      await upsertCandle(candleFromRestKline(symbol, INTERVAL, kline));
    }

    totalPersisted += rawData.length;
    const earliestInPage = rawData[0][0];
    console.log(
      `[BACKFILL] Page ${page}: persisted ${rawData.length} candles ` +
      `(back to ${new Date(earliestInPage).toISOString()}). Running total: ${totalPersisted}`
    );

    // Next page ends right before the earliest candle we just got.
    endTime = earliestInPage - INTERVAL_MS;

    // Be polite to Binance's public rate limits between pages.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  console.log("");
  console.log(`[BACKFILL] Done. Persisted ~${totalPersisted} candles total for ${symbol} (${INTERVAL}).`);
  console.log(`Run "npm run backtest" now to test against the full history.`);

  await pool.end();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[BACKFILL FATAL]", message);
  process.exit(1);
});