/**
 * Integration tests against a REAL Postgres database.
 *
 * These require DATABASE_URL to be set (see .env.example) and will be
 * skipped with a clear message if it isn't — they never run against a
 * mock, and they never silently pass without touching a real database.
 * A buyer running `npm test` with a local Postgres configured via .env
 * will see these execute for real.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";

const hasDatabase = Boolean(process.env.DATABASE_URL);

test("order_history round-trip: insert, status update, and read-back against real Postgres", { skip: !hasDatabase }, async () => {
  const repo = await import("./order-repository.js");
  await repo.ensureOrderStorage();

  const { query } = await import("./database.js");

  const id = `paper_inttest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const order = {
    id,
    clientOrderId: `bot01paper_inttest_${Date.now()}`,
    symbol: "SOLUSDC",
    side: "BUY" as const,
    status: "CREATED" as const,
    provenance: "PAPER" as const,
    requestedPrice: 150.25,
    requestedQuantity: 3.327,
    filledPrice: null,
    filledQuantity: null,
    stopLoss: 147.1,
    takeProfit: 156.55,
    feePaid: null,
    slippageApplied: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await repo.insertOrder(order);

  const afterInsert = await query("SELECT status, provenance FROM order_history WHERE id = $1", [id]);
  assert.equal(afterInsert.rows[0].status, "CREATED");
  assert.equal(afterInsert.rows[0].provenance, "PAPER");

  await repo.updateOrderStatus(id, "FILLED", {
    filledPrice: 150.32,
    filledQuantity: 3.327,
    feePaid: 0.15,
    slippageApplied: 0.07,
  });

  const afterFill = await query(
    "SELECT status, filled_price, filled_quantity, fee_paid FROM order_history WHERE id = $1",
    [id]
  );
  assert.equal(afterFill.rows[0].status, "FILLED");
  assert.equal(Number(afterFill.rows[0].filled_price), 150.32);
  assert.equal(Number(afterFill.rows[0].fee_paid), 0.15);

  await query("DELETE FROM order_history WHERE id = $1", [id]);
});

test("paper_account_state balance round-trips as a real number through real Postgres", { skip: !hasDatabase }, async () => {
  const repo = await import("./order-repository.js");
  await repo.ensureOrderStorage();

  const testAsset = `TEST_${Date.now()}`;
  await repo.setPaperBalance(testAsset, 975.12);
  const balance = await repo.getPaperBalance(testAsset);
  assert.equal(balance, 975.12);
  assert.equal(typeof balance, "number");

  const { query } = await import("./database.js");
  await query("DELETE FROM paper_account_state WHERE asset = $1", [testAsset]);
});

test("getPaperBalance returns 0 for an asset that was never initialized", { skip: !hasDatabase }, async () => {
  const repo = await import("./order-repository.js");
  const balance = await repo.getPaperBalance(`NEVER_SET_${Date.now()}`);
  assert.equal(balance, 0);
});

after(async () => {
  if (!hasDatabase) return;
  const { pool } = await import("./database.js");
  await pool.end();
});
