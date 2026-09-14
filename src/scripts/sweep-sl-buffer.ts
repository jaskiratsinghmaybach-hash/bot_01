/**
 * One-off sweep: tries several slBufferFraction values against the same
 * historical candles used by `npm run backtest`, to see whether the stop
 * placement (not the entry logic) is what's driving the losses.
 *
 * This is diagnostic only — historical replay, not a live guarantee.
 * Delete this file once you're done experimenting.
 */
import "dotenv/config";
import environment from "../config/environment.js";
import { loadCandleRange } from "../infrastructure/candle-repository.js";
import { runBacktest } from "../backtest/engine.js";
import { pool } from "../infrastructure/database.js";

const BUFFER_VALUES = [0.002, 0.005, 0.008, 0.01, 0.015, 0.02];

async function main() {
  console.log("=============================================");
  console.log("     SL BUFFER SWEEP (HISTORICAL, DIAGNOSTIC) ");
  console.log("=============================================");

  const candles = await loadCandleRange(environment.SYMBOL, "1h");

  if (candles.length === 0) {
    console.error(`[SWEEP] No candles found for ${environment.SYMBOL} (1h). Run the app once first.`);
    await pool.end();
    process.exit(1);
  }

  console.log(`Loaded ${candles.length} candles for ${environment.SYMBOL} (1h)\n`);
  console.log("slBufferFraction | Trades | Wins | Losses | WinRate | ExpectancyR | NetPnL($) | ProfitFactor | MaxDD($)");
  console.log("-----------------|--------|------|--------|---------|-------------|-----------|--------------|----------");

  for (const buf of BUFFER_VALUES) {
    const result = runBacktest(candles, {
      strategyConfig: { slBufferFraction: buf },
      riskAmountUsd: environment.RISK_PER_TRADE_USD,
      maxPositionUsd: environment.MAX_POSITION_USD,
      startingEquityUsd: environment.PAPER_STARTING_BALANCE_USD,
    });

    const winRate = result.winRate !== null ? (result.winRate * 100).toFixed(1) + "%" : "n/a";
    const expectancy = result.expectancyR !== null ? result.expectancyR.toFixed(3) + "R" : "n/a";
    const pf = result.profitFactor !== null ? result.profitFactor.toFixed(2) : "n/a";

    console.log(
      `${(buf * 100).toFixed(1).padStart(15)}% | ` +
      `${String(result.totalTrades).padStart(6)} | ` +
      `${String(result.wins).padStart(4)} | ` +
      `${String(result.losses).padStart(6)} | ` +
      `${winRate.padStart(7)} | ` +
      `${expectancy.padStart(11)} | ` +
      `${result.cumulativeNetPnlUsd.toFixed(2).padStart(9)} | ` +
      `${pf.padStart(12)} | ` +
      `${result.maxDrawdownUsd.toFixed(2).padStart(8)}`
    );
  }

  console.log("\nDiagnostic sweep only — historical replay, not a guarantee of future performance.");
  console.log("If a wider buffer clearly helps, that supports the 'stop too tight' hypothesis.");
  console.log("If nothing helps much, the entry logic itself likely needs the bigger look.");

  await pool.end();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[SWEEP FATAL]", message);
  process.exit(1);
});