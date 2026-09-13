import "dotenv/config";
import environment from "./config/environment.js";

async function bootSystemEngine() {
  console.log("=============================================");
  console.log("      INITIALIZING BOT_01 TRADING CORE       ");
  console.log("=============================================");
  console.log(`[BOOT] Symbol: ${environment.SYMBOL} | Trading mode: ${environment.TRADING_MODE.toUpperCase()}`);

  if (environment.TRADING_MODE === "live") {
    // Phase B (real signed Binance execution) has not been built yet.
    // Refuse to boot rather than starting a live-labeled process that
    // cannot actually place live orders.
    console.error(
      "[BOOT FATAL] TRADING_MODE=live is not yet implemented in this build. " +
        "Use TRADING_MODE=dry-run or TRADING_MODE=paper. See src/execution/live-adapter.ts."
    );
    process.exit(1);
  }

  let shuttingDown = false;
  let pool: import("pg").Pool | null = null;
  let shutdownMarketFeed: (() => void) | null = null;

  try {
    const { pool: dbPool, query } = await import("./infrastructure/database.js");
    pool = dbPool;
    const {
      initializeMarketFeed,
      backfillHistoricalData,
      primeSymbolRules,
      shutdownMarketFeed: shutdownFeedFn,
    } = await import("./infrastructure/binance-feed.js");
    shutdownMarketFeed = shutdownFeedFn;
    const { ensureOrderStorage } = await import("./infrastructure/order-repository.js");
    const { ensurePaperBalanceInitialized } = await import("./execution/paper-adapter.js");

    // 1. Handshake check with Postgres
    await query("SELECT NOW()");
    console.log("[BOOT] Database handshake completed.");

    // 2. Ensure order/paper-balance tables exist alongside candle storage
    await ensureOrderStorage();

    // 3. Load real Binance exchange rules (LOT_SIZE/PRICE_FILTER/MIN_NOTIONAL)
    //    before any signal can be risk-evaluated.
    await primeSymbolRules();

    // 4. In paper mode, ensure a starting simulated balance exists.
    if (environment.TRADING_MODE === "paper") {
      const balance = await ensurePaperBalanceInitialized();
      console.log(`[BOOT] Paper trading balance: $${balance.toFixed(2)}`);
    }

    // 5. Fetch historical candles over HTTP REST to pre-fill strategy memory
    await backfillHistoricalData();

    // 6. Fire up the live real-time Binance market-data stream
    //    (this only ever reads market data — it never places live orders,
    //    regardless of TRADING_MODE, since TRADING_MODE=live is refused above)
    initializeMarketFeed();

    console.log("[BOOT] BOT_01 is running. Press Ctrl+C to stop.");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[BOOT FATAL] Core initialization halted:", message);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[SHUTDOWN] Received ${signal}. Closing connections...`);
    try {
      if (shutdownMarketFeed) {
        shutdownMarketFeed();
        console.log("[SHUTDOWN] Market data WebSocket(s) closed.");
      }
      if (pool) {
        await pool.end();
        console.log("[SHUTDOWN] Postgres pool closed.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[SHUTDOWN] Error while closing Postgres pool:", message);
    }
    console.log("[SHUTDOWN] Clean exit.");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

bootSystemEngine();
