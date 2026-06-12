-- Track true mathematical capital balance state
CREATE TABLE IF NOT EXISTS balance_state (
    id SERIAL PRIMARY KEY,
    asset VARCHAR(10) NOT NULL UNIQUE,
    free_amount NUMERIC(20, 8) NOT NULL DEFAULT 0.0,
    locked_amount NUMERIC(20, 8) NOT NULL DEFAULT 0.0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Track actual execution states (Zero simulations)
CREATE TABLE IF NOT EXISTS order_history (
    id VARCHAR(100) PRIMARY KEY,
    client_order_id VARCHAR(100) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    price NUMERIC(20, 8) NOT NULL,
    quantity NUMERIC(20, 8) NOT NULL,
    side VARCHAR(10) NOT NULL,
    status VARCHAR(50) NOT NULL,
    executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Persist real closed Binance candles for auditable strategy computation.
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
