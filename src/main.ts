import "dotenv/config";
import environment from "./config/environment.js";

async function bootSystemEngine() {
  console.log("=============================================");
  console.log("      INITIALIZING BOT_01 TRADING CORE       ");
  console.log("=============================================");
  console.log(`[BOOT] Symbol: ${environment.SYMBOL} | Trading mode: ${environment.TRADING_MODE.toUpperCase()}`);

  if (environment.TRADING_MODE === "live") {
    // Live execution now exists (src/execution/live-adapter.ts), but its
    // HTTP calls to Binance's real order endpoints have not been verified
    // against a live or testnet account from this project's own
    // development environment (outbound network to api.binance.com was
    // unavailable there — see docs/verification.md). As an extra safety
    // gate beyond just setting TRADING_MODE=live, boot also requires an
    // explicit I_HAVE_TESTED_LIVE_EXECUTION=true acknowledgement — this is
    // not a technical requirement, it exists specifically so going live
    // is a deliberate, informed choice rather than an accidental one
    // (e.g. a copy-pasted .env from a tutorial).
    if (process.env.I_HAVE_TESTED_LIVE_EXECUTION !== "true") {
      console.error(
        "[BOOT FATAL] TRADING_MODE=live requires I_HAVE_TESTED_LIVE_EXECUTION=true to be set. " +
          "This is a deliberate extra confirmation step — live execution has not been verified " +
          "against Binance from this project's own development environment. Test against " +
          "Binance's testnet first. See docs/execution.md and docs/verification.md."
      );
      process.exit(1);
    }
    console.warn(
      "[BOOT] TRADING_MODE=live — real orders may be placed with real funds. " +
        "Ensure you have tested against Binance's testnet first."
    );
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
