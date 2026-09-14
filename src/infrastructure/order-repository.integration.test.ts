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
    candleOpenTime: Date.now(),
    requestedPrice: 150.25,
    requestedQuantity: 3.327,
    filledPrice: null,
    filledQuantity: null,
    stopLoss: 147.1,
    takeProfit: 156.55,
    stopLossOrderId: null,
    takeProfitOrderId: null,
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

test("hasActiveOrderForCandle: true for an active order, false after it's REJECTED/CANCELED", { skip: !hasDatabase }, async () => {
  const repo = await import("./order-repository.js");
  await repo.ensureOrderStorage();
  const { query } = await import("./database.js");

  const candleOpenTime = Date.now();
  const symbol = `T1_${Date.now()%100000}`;
  const id = `live_inttest_${Date.now()}`;

  const order = {
    id,
    clientOrderId: `bot01live_inttest_${Date.now()}`,
    symbol,
    side: "BUY" as const,
    status: "CREATED" as const,
    provenance: "LIVE" as const,
    candleOpenTime,
    requestedPrice: 150,
    requestedQuantity: 1,
    filledPrice: null,
    filledQuantity: null,
    stopLoss: 145,
    takeProfit: 160,
    stopLossOrderId: null,
    takeProfitOrderId: null,
    feePaid: null,
    slippageApplied: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await repo.insertOrder(order);
  const activeBefore = await repo.hasActiveOrderForCandle(symbol, "LIVE", candleOpenTime);
  assert.equal(activeBefore, true);

  await repo.updateOrderStatus(id, "REJECTED");
  const activeAfter = await repo.hasActiveOrderForCandle(symbol, "LIVE", candleOpenTime);
  assert.equal(activeAfter, false);

  await query("DELETE FROM order_history WHERE id = $1", [id]);
});

test("hasOpenPosition: true while FILLED, false once no open-state orders remain", { skip: !hasDatabase }, async () => {
  const repo = await import("./order-repository.js");
  await repo.ensureOrderStorage();
  const { query } = await import("./database.js");

  const symbol = `T2_${Date.now()%100000}`;
  const id = `live_inttest2_${Date.now()}`;

  const order = {
    id,
    clientOrderId: `bot01live_inttest2_${Date.now()}`,
    symbol,
    side: "BUY" as const,
    status: "FILLED" as const,
    provenance: "LIVE" as const,
    candleOpenTime: Date.now(),
    requestedPrice: 150,
    requestedQuantity: 1,
    filledPrice: 150.1,
    filledQuantity: 1,
    stopLoss: 145,
    takeProfit: 160,
    stopLossOrderId: "123",
    takeProfitOrderId: "124",
    feePaid: 0.15,
    slippageApplied: 0.05,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await repo.insertOrder(order);
  const openBefore = await repo.hasOpenPosition(symbol, "LIVE");
  assert.equal(openBefore, true);

  await query("UPDATE order_history SET status = 'CANCELED' WHERE id = $1", [id]);
  const openAfter = await repo.hasOpenPosition(symbol, "LIVE");
  assert.equal(openAfter, false);

  await query("DELETE FROM order_history WHERE id = $1", [id]);
});

test("hasOpenPosition: FILLED_UNHEDGED counts as an open position (must block new entries)", { skip: !hasDatabase }, async () => {
  const repo = await import("./order-repository.js");
  await repo.ensureOrderStorage();
  const { query } = await import("./database.js");

  const symbol = `T3_${Date.now()%100000}`;
  const id = `live_inttest3_${Date.now()}`;

  await repo.insertOrder({
    id,
    clientOrderId: `bot01live_inttest3_${Date.now()}`,
    symbol,
    side: "BUY",
    status: "CREATED",
    provenance: "LIVE",
    candleOpenTime: Date.now(),
    requestedPrice: 150,
    requestedQuantity: 1,
    filledPrice: null,
    filledQuantity: null,
    stopLoss: 145,
    takeProfit: 160,
    stopLossOrderId: null,
    takeProfitOrderId: null,
    feePaid: null,
    slippageApplied: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await repo.updateOrderStatus(id, "FILLED_UNHEDGED");

  const isOpen = await repo.hasOpenPosition(symbol, "LIVE");
  assert.equal(isOpen, true, "FILLED_UNHEDGED must be treated as an open, unresolved position");

  await query("DELETE FROM order_history WHERE id = $1", [id]);
});

test("order_history_symbol_candle_active_uidx: DB rejects a second active order for the same symbol+candle+provenance", { skip: !hasDatabase }, async () => {
  const repo = await import("./order-repository.js");
  await repo.ensureOrderStorage();
  const { query } = await import("./database.js");

  const symbol = `T4_${Date.now()%100000}`;
  const candleOpenTime = Date.now();
  const id1 = `dup_inttest_a_${Date.now()}`;
  const id2 = `dup_inttest_b_${Date.now()}`;

  const base = {
    symbol,
    side: "BUY" as const,
    status: "CREATED" as const,
    provenance: "LIVE" as const,
    candleOpenTime,
    requestedPrice: 150,
    requestedQuantity: 1,
    filledPrice: null,
    filledQuantity: null,
    stopLoss: 145,
    takeProfit: 160,
    stopLossOrderId: null,
    takeProfitOrderId: null,
    feePaid: null,
    slippageApplied: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await repo.insertOrder({ ...base, id: id1, clientOrderId: `c1_${Date.now()}` });

  await assert.rejects(
    repo.insertOrder({ ...base, id: id2, clientOrderId: `c2_${Date.now()}` }),
    /duplicate key|unique/i
  );

  await query("DELETE FROM order_history WHERE id = $1", [id1]);
});
