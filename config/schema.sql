-- BOT_01 database schema.
--
-- This file is the canonical, human-readable reference for the schema.
-- The application also creates these tables idempotently at boot via
-- src/infrastructure/candle-repository.ts and src/infrastructure/order-repository.ts
-- (CREATE TABLE IF NOT EXISTS), so a fresh database needs no manual migration
-- step. This file exists so a reviewer/buyer can read the whole schema in
-- one place without running the app.

-- Real closed Binance candles (REST backfill + WebSocket kline stream).
CREATE TABLE IF NOT EXISTS market_candles (
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
);

CREATE INDEX IF NOT EXISTS market_candles_symbol_interval_time_idx
    ON market_candles (symbol, interval, open_time DESC);

-- Order audit trail. status only ever becomes 'FILLED' when a real exchange
-- fill (provenance = LIVE) or a documented simulated fill
-- (provenance = PAPER) has actually occurred — never on order construction
-- alone. provenance must never be conflated: a PAPER row is a simulation
-- and must never be presented or queried as if it were a LIVE result.
CREATE TABLE IF NOT EXISTS order_history (
    id VARCHAR(100) PRIMARY KEY,
    client_order_id VARCHAR(100) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    side VARCHAR(10) NOT NULL CHECK (side IN ('BUY', 'SELL')),
    status VARCHAR(50) NOT NULL CHECK (
        status IN (
            'CREATED', 'SUBMITTED', 'ACKNOWLEDGED', 'PARTIALLY_FILLED',
            'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'UNKNOWN'
        )
    ),
    provenance VARCHAR(10) NOT NULL CHECK (provenance IN ('LIVE', 'PAPER', 'DRY_RUN')),
    requested_price NUMERIC(20, 8) NOT NULL,
    requested_quantity NUMERIC(20, 8) NOT NULL,
    filled_price NUMERIC(20, 8),
    filled_quantity NUMERIC(20, 8),
    stop_loss NUMERIC(20, 8),
    take_profit NUMERIC(20, 8),
    fee_paid NUMERIC(20, 8),
    slippage_applied NUMERIC(20, 8),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS order_history_symbol_created_idx
    ON order_history (symbol, created_at DESC);

CREATE INDEX IF NOT EXISTS order_history_provenance_idx
    ON order_history (provenance);

-- Simulated account balance for PAPER mode only. Never used for LIVE trading
-- decisions — live balance must come from Binance's account endpoint.
CREATE TABLE IF NOT EXISTS paper_account_state (
    id SERIAL PRIMARY KEY,
    asset VARCHAR(32) NOT NULL UNIQUE,
    balance NUMERIC(20, 8) NOT NULL DEFAULT 0.0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
