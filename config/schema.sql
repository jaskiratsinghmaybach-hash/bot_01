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