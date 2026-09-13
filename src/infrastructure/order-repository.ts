import { query } from "./database.js";
import type { OrderState } from "../types/index.js";

export async function ensureOrderStorage(): Promise<void> {
  await query(
    `CREATE TABLE IF NOT EXISTS order_history (
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
    )`
  );

  await query(
    `CREATE INDEX IF NOT EXISTS order_history_symbol_created_idx
      ON order_history (symbol, created_at DESC)`
  );

  await query(
    `CREATE INDEX IF NOT EXISTS order_history_provenance_idx
      ON order_history (provenance)`
  );

  await query(
    `CREATE TABLE IF NOT EXISTS paper_account_state (
      id SERIAL PRIMARY KEY,
      asset VARCHAR(32) NOT NULL UNIQUE,
      balance NUMERIC(20, 8) NOT NULL DEFAULT 0.0,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )`
  );
}

export async function insertOrder(order: OrderState): Promise<void> {
  await query(
    `INSERT INTO order_history
      (id, client_order_id, symbol, side, status, provenance,
       requested_price, requested_quantity, filled_price, filled_quantity,
       stop_loss, take_profit, fee_paid, slippage_applied)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      order.id,
      order.clientOrderId,
      order.symbol,
      order.side,
      order.status,
      order.provenance,
      order.requestedPrice,
      order.requestedQuantity,
      order.filledPrice,
      order.filledQuantity,
      order.stopLoss,
      order.takeProfit,
      order.feePaid,
      order.slippageApplied,
    ]
  );
}

export async function updateOrderStatus(
  id: string,
  status: OrderState["status"],
  fields: Partial<Pick<OrderState, "filledPrice" | "filledQuantity" | "feePaid" | "slippageApplied">> = {}
): Promise<void> {
  await query(
    `UPDATE order_history
     SET status = $2,
         filled_price = COALESCE($3, filled_price),
         filled_quantity = COALESCE($4, filled_quantity),
         fee_paid = COALESCE($5, fee_paid),
         slippage_applied = COALESCE($6, slippage_applied),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [
      id,
      status,
      fields.filledPrice ?? null,
      fields.filledQuantity ?? null,
      fields.feePaid ?? null,
      fields.slippageApplied ?? null,
    ]
  );
}

/** Reads the current simulated PAPER balance for an asset, defaulting to 0 if never initialized. */
export async function getPaperBalance(asset: string): Promise<number> {
  const result = await query(`SELECT balance FROM paper_account_state WHERE asset = $1`, [asset]);
  if (result.rows.length === 0) return 0;
  return Number(result.rows[0].balance);
}

export async function setPaperBalance(asset: string, balance: number): Promise<void> {
  await query(
    `INSERT INTO paper_account_state (asset, balance)
     VALUES ($1, $2)
     ON CONFLICT (asset) DO UPDATE SET balance = EXCLUDED.balance, updated_at = CURRENT_TIMESTAMP`,
    [asset, balance]
  );
}
