import { Candle } from '../types/index.js';
import { query } from './database.js';

const STRATEGY_CANDLE_LIMIT = 200;

export async function ensureCandleStorage(): Promise<void> {
  await query(
    `CREATE TABLE IF NOT EXISTS market_candles (
      id BIGSERIAL PRIMARY KEY,
      symbol VARCHAR(20) NOT NULL,
      interval VARCHAR(10) NOT NULL,
      open_time BIGINT NOT NULL,
      close_time BIGINT NOT NULL,
      open NUMERIC(20, 8) NOT NULL,
      high NUMERIC(20, 8) NOT NULL,
      low NUMERIC(20, 8) NOT NULL,
      close NUMERIC(20, 8) NOT NULL,
      volume NUMERIC(30, 8) NOT NULL,
      source VARCHAR(50) NOT NULL DEFAULT 'binance',
      is_closed BOOLEAN NOT NULL DEFAULT TRUE,
      ingested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT market_candles_unique_kline UNIQUE (symbol, interval, open_time)
    )`
  );

  await query(
    `CREATE INDEX IF NOT EXISTS market_candles_symbol_interval_time_idx
      ON market_candles (symbol, interval, open_time DESC)`
  );
}

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

export function isValidClosedCandle(candle: Candle): boolean {
  const prices = [candle.open, candle.high, candle.low, candle.close, candle.volume];
  const hasValidNumbers = prices.every((value) => Number.isFinite(value) && value >= 0);
  const hasValidTime = Number.isInteger(candle.openingTime)
    && Number.isInteger(candle.closeTime)
    && candle.closeTime > candle.openingTime;

  return candle.source === 'binance'
    && candle.isClosed
    && candle.symbol.length > 0
    && (candle.interval === '1m' || candle.interval === '1h')
    && hasValidTime
    && hasValidNumbers
    && candle.high >= candle.low
    && candle.high >= candle.open
    && candle.high >= candle.close
    && candle.low <= candle.open
    && candle.low <= candle.close;
}

export async function upsertCandle(candle: Candle): Promise<void> {
  if (!isValidClosedCandle(candle)) {
    console.warn(
      `[CANDLE] Rejected invalid candle ${candle.symbol} ${candle.interval} open=${candle.openingTime}`
    );
    return;
  }

  await query(
    `INSERT INTO market_candles
      (symbol, interval, open_time, close_time, open, high, low, close, volume, source, is_closed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (symbol, interval, open_time)
     DO UPDATE SET
       close_time = EXCLUDED.close_time,
       open = EXCLUDED.open,
       high = EXCLUDED.high,
       low = EXCLUDED.low,
       close = EXCLUDED.close,
       volume = EXCLUDED.volume,
       source = EXCLUDED.source,
       is_closed = EXCLUDED.is_closed,
       updated_at = CURRENT_TIMESTAMP`,
    [
      candle.symbol,
      candle.interval,
      candle.openingTime,
      candle.closeTime,
      candle.open,
      candle.high,
      candle.low,
      candle.close,
      candle.volume,
      candle.source,
      candle.isClosed,
    ]
  );
}

export async function getRecentCandles(
  symbol: string,
  interval: Candle['interval'],
  limit: number
): Promise<Candle[]> {
  const result = await query(
    `SELECT symbol, interval, open_time, close_time, open, high, low, close, volume, source, is_closed
     FROM market_candles
     WHERE symbol = $1 AND interval = $2 AND is_closed = TRUE
     ORDER BY open_time DESC
     LIMIT $3`,
    [symbol, interval, limit]
  );

  return result.rows
    .reverse()
    .map((row): Candle => ({
      symbol: row.symbol,
      interval: row.interval as Candle['interval'],
      openingTime: toNumber(row.open_time),
      closeTime: toNumber(row.close_time),
      open: toNumber(row.open),
      high: toNumber(row.high),
      low: toNumber(row.low),
      close: toNumber(row.close),
      volume: toNumber(row.volume),
      source: row.source as Candle['source'],
      isClosed: row.is_closed,
    }));
}

export async function loadStrategyCandles(symbol: string): Promise<Candle[]> {
  return getRecentCandles(symbol, '1h', STRATEGY_CANDLE_LIMIT);
}

/**
 * Loads ALL closed candles for a symbol/interval within an optional time
 * range, in ascending chronological order. Unlike getRecentCandles (which
 * is capped for the live RAM cache), this is for backtesting — a backtest
 * needs the full historical series, not just the most recent N candles.
 */
export async function loadCandleRange(
  symbol: string,
  interval: Candle['interval'],
  fromOpenTime?: number,
  toOpenTime?: number
): Promise<Candle[]> {
  const conditions: string[] = ['symbol = $1', 'interval = $2', 'is_closed = TRUE'];
  const params: unknown[] = [symbol, interval];

  if (fromOpenTime !== undefined) {
    params.push(fromOpenTime);
    conditions.push(`open_time >= $${params.length}`);
  }
  if (toOpenTime !== undefined) {
    params.push(toOpenTime);
    conditions.push(`open_time <= $${params.length}`);
  }

  const result = await query(
    `SELECT symbol, interval, open_time, close_time, open, high, low, close, volume, source, is_closed
     FROM market_candles
     WHERE ${conditions.join(' AND ')}
     ORDER BY open_time ASC`,
    params
  );

  return result.rows.map((row): Candle => ({
    symbol: row.symbol,
    interval: row.interval as Candle['interval'],
    openingTime: toNumber(row.open_time),
    closeTime: toNumber(row.close_time),
    open: toNumber(row.open),
    high: toNumber(row.high),
    low: toNumber(row.low),
    close: toNumber(row.close),
    volume: toNumber(row.volume),
    source: row.source as Candle['source'],
    isClosed: row.is_closed,
  }));
}
