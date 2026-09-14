# Architecture

## Overview

BOT_01 is a single-process TypeScript application with four layers, kept
deliberately separate so each can be understood, tested, and trusted in
isolation:

```
Binance Market Data (REST + WebSocket)
            ↓
     market_candles (Postgres)
            ↓
     Strategy Engine (pure, no I/O)
            ↓
      Risk Engine (pure, no I/O)
            ↓
   Execution Router (TRADING_MODE-gated)
            ↓
   dry-run | paper | live(not yet built)
            ↓
     order_history (Postgres, honest lifecycle)
```

## Directory layout

```
src/
├── config/
│   └── environment.ts       # validated, fail-fast env config
├── infrastructure/
│   ├── binance-feed.ts       # REST backfill + WebSocket kline stream
│   ├── candle-repository.ts  # market_candles persistence
│   ├── candle-validation.ts  # pure OHLC validation (no DB dependency)
│   ├── database.ts           # Postgres pool, single DATABASE_URL source
│   └── order-repository.ts   # order_history + paper_account_state persistence
├── exchange/
│   ├── exchange-info.ts      # Binance exchangeInfo client (LOT_SIZE etc.)
│   └── precision.ts          # floor-to-step quantity/price normalization
├── risk/
│   └── risk-engine.ts        # pure position sizing + validation
├── strategies/
│   └── core-logic.ts         # pure EMA/ATR/higher-low signal generation
├── execution/
│   ├── router.ts             # picks an adapter based on TRADING_MODE
│   ├── dry-run-adapter.ts    # logs only, no persistence
│   ├── paper-adapter.ts      # simulated fills against real prices
│   └── live-adapter.ts       # NOT YET IMPLEMENTED — see docs/execution.md
├── backtest/
│   └── engine.ts             # historical replay, look-ahead-safe
├── scripts/
│   ├── verify-strategy.ts    # human-readable strategy verification
│   └── run-backtest.ts       # historical backtest CLI
├── types/
│   └── index.ts
└── main.ts                    # boot sequence, graceful shutdown
```

## Design principle: pure core, thin edges

`strategies/core-logic.ts`, `risk/risk-engine.ts`, `exchange/precision.ts`,
and `infrastructure/candle-validation.ts` have **zero dependencies** on the
database, network, or environment configuration. They take plain data in
and return plain data out. This is deliberate:

- They can be unit-tested without a database connection or Binance
  credentials (confirmed — the full strategy/risk/precision test suite
  runs with no `DATABASE_URL` set).
- The backtest engine can reuse the exact same strategy and risk logic
  that live/paper trading uses, so backtest and live behavior cannot
  silently diverge.
- A bug in, say, the EMA calculation is testable and fixable in isolation
  from any Postgres or Binance concern.

Everything that touches the outside world (Postgres, Binance REST/WS) is
pushed to the edges: `infrastructure/`, `exchange/`, `execution/`.

## Data flow: one closed candle

1. `binance-feed.ts` receives a closed 1h kline over the Binance
   WebSocket stream.
2. The candle is validated (`candle-validation.ts`) and upserted into
   `market_candles` (`candle-repository.ts`).
3. The in-memory strategy candle cache is refreshed from Postgres.
4. `evaluateStrategy()` runs against the refreshed cache — pure function,
   no side effects.
5. If a candidate signal is returned, `evaluateRisk()` sizes it against
   the cached Binance exchange rules (`exchange-info.ts`) and the
   configured risk limits.
6. `routeExecution()` sends the risk decision to whichever adapter
   matches `TRADING_MODE`.

## Why the fake execution layer was removed

An earlier revision of this codebase computed a position size and stop
loss/take profit, then wrote `status: 'FILLED'` directly to Postgres with
a fabricated order ID (`binance_${Date.now()}`) — without ever contacting
Binance. That has been deleted entirely (see git history:
`src/infrastructure/exchange.ts`). The current execution architecture
never marks an order `FILLED` without either a real Binance confirmation
(`LIVE`, not yet implemented) or a documented simulation
(`PAPER`, implemented and tested). See `docs/execution.md`.
