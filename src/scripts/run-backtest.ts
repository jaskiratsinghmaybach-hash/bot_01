/**
 * Backtest CLI.
 *
 * Loads historical candles from Postgres (populated by the REST backfill
 * in binance-feed.ts) and runs them through the backtest engine, printing
 * a clearly-labeled BACKTEST RESULT report.
 *
 * This is historical replay under documented assumptions — NOT a
 * prediction of future performance, and NOT a paper or live result. Never
 * present these numbers as if they came from real trading.
 */
import "dotenv/config";
import environment from "../config/environment.js";
import { loadCandleRange } from "../infrastructure/candle-repository.js";
import { runBacktest, DEFAULT_BACKTEST_CONFIG } from "../backtest/engine.js";
import { pool } from "../infrastructure/database.js";

async function main() {
  console.log("=============================================");
  console.log("           BOT_01 BACKTEST (HISTORICAL)       ");
  console.log("=============================================");
  console.log(`Symbol:   ${environment.SYMBOL}`);
  console.log(`Interval: 1h`);
  console.log(
    `Assumptions: fee=${(DEFAULT_BACKTEST_CONFIG.feeFraction * 100).toFixed(3)}% per fill, ` +
      `slippage=${(DEFAULT_BACKTEST_CONFIG.slippageFraction * 100).toFixed(3)}% per fill, ` +
      `risk=$${environment.RISK_PER_TRADE_USD} per trade`
  );
  console.log("");

  const candles = await loadCandleRange(environment.SYMBOL, "1h");

  if (candles.length === 0) {
    console.error(
      `[BACKTEST] No candles found in the database for ${environment.SYMBOL} (1h). ` +
        `Run the app once with TRADING_MODE=dry-run or paper to backfill historical candles first, ` +
        `or run a dedicated backfill.`
    );
    await pool.end();
    process.exit(1);
  }

  console.log(`Loaded ${candles.length} closed 1h candles ` +
    `(${new Date(candles[0].openingTime).toISOString()} -> ${new Date(candles[candles.length - 1].openingTime).toISOString()})`);
  console.log("");

  const result = runBacktest(candles, {
    riskAmountUsd: environment.RISK_PER_TRADE_USD,
    maxPositionUsd: environment.MAX_POSITION_USD,
    startingEquityUsd: environment.PAPER_STARTING_BALANCE_USD,
  });

  console.log("--- BACKTEST RESULT (historical replay — not a guarantee of future performance) ---");
  console.log(`Closed trades:        ${result.totalTrades}`);
  console.log(`Open at end of data:  ${result.openAtEnd}`);
  console.log(`Wins / Losses:        ${result.wins} / ${result.losses}`);
  console.log(`Win rate:             ${result.winRate !== null ? (result.winRate * 100).toFixed(1) + "%" : "n/a (no closed trades)"}`);
  console.log(`Average R-multiple:   ${result.averageRMultiple !== null ? result.averageRMultiple.toFixed(3) + "R" : "n/a"}`);
  console.log(`Expectancy per trade: ${result.expectancyR !== null ? result.expectancyR.toFixed(3) + "R" : "n/a"}`);
  console.log(`Cumulative net PnL:   $${result.cumulativeNetPnlUsd.toFixed(2)}`);
  console.log(`Max drawdown:         $${result.maxDrawdownUsd.toFixed(2)}${result.maxDrawdownPercent !== null ? ` (${result.maxDrawdownPercent.toFixed(1)}% of peak equity)` : ""}`);
  console.log(`Profit factor:        ${result.profitFactor !== null ? result.profitFactor.toFixed(2) : "n/a (no losing trades or no trades)"}`);
  console.log("");
  console.log("These results assume the fee/slippage parameters above, fills at candle close for");
  console.log("entries, and a conservative stop-hit-first assumption when a single candle's range");
  console.log("touches both the stop-loss and take-profit. Past performance on this historical");
  console.log("dataset does not guarantee future results.");

  await pool.end();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[BACKTEST FATAL]", message);
  process.exit(1);
});
