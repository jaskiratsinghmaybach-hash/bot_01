# Data Pipeline

## Sources

- **REST backfill** (`binance-feed.ts: backfillHistoricalData`) — pulls
  historical closed klines from Binance's public REST API
  (`/api/v3/klines`) once at boot, to pre-fill the strategy's candle cache
  and the `market_candles` table.
- **WebSocket live stream** (`binance-feed.ts: initializeMarketStream`) —
  subscribes to `wss://stream.binance.com:9443/ws/<symbol>@kline_<interval>`
  for real-time candle updates.

## Closed-candle-only processing

Binance's kline WebSocket payload includes an `x` field indicating whether
the candle has closed. Only candles where `x: true` are persisted or
passed to the strategy engine — an in-progress candle's high/low/close
can still change, and evaluating a signal against it would mean the
signal could change moment-to-moment rather than being a stable decision
made once per closed bar. This is enforced in the WebSocket message
handler before any downstream call.

## Persistence

`market_candles` (see `config/schema.sql`) has a unique constraint on
`(symbol, interval, open_time)`. Both the REST backfill and the WebSocket
handler `UPSERT` (`ON CONFLICT ... DO UPDATE`) rather than blind `INSERT`,
so:

- Re-running a backfill over an already-populated range is safe (no
  duplicate-key errors, no duplicate rows).
- A late-arriving correction to a candle (rare, but possible on exchange
  data feeds) updates the existing row instead of creating a duplicate.

## Validation

Every candle is validated by `infrastructure/candle-validation.ts`
(`isValidClosedCandle`) before being trusted:

- OHLC consistency (`high >= low`, `high >= open/close`, `low <= open/close`)
- All price/volume fields finite and non-negative
- `closeTime > openingTime`, both integers
- `isClosed === true`
- `source === 'binance'`
- `interval` is one of the two supported values

This is a pure function with no database dependency, so it's directly
unit-testable (14 tests in `candle-validation.test.ts`) without a Postgres
connection.

## Reconnection and resilience

The WebSocket client automatically reconnects 5 seconds after a
disconnect, unless the application is in the middle of a graceful
shutdown (`shutdownMarketFeed()` sets a flag that both stops new reconnect
attempts and closes any open sockets — verified by inspection of
`main.ts`'s SIGINT/SIGTERM handler, which calls this before closing the
database pool).

## In-memory strategy cache

`candle-repository.ts: loadStrategyCandles` loads the most recent 200
closed 1h candles into memory on each new closed candle. This bounded
window (not the full historical table) is what the live strategy
evaluates against — sufficient to seed EMA(50)/ATR(14) with headroom.
Backtesting uses a separate, unbounded function
(`loadCandleRange`) that loads the entire historical range for a
symbol/interval, since a backtest needs the full series, not just the
most recent window.
