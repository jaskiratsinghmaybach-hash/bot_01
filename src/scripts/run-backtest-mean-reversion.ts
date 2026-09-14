/**
 * Mean-reversion backtest CLI.
 *
 * Same reporting format as run-backtest.ts, but replays the mean-reversion
 * strategy (Bollinger Band + RSI) instead of the trend-following one.
 *
 * Historical replay under documented assumptions — NOT a guarantee of
 * future performance, and NOT a paper or live result.
 */
import "dotenv/config";
import environment from "../config/environment.js";
import { loadCandleRange } from "../infrastructure/candle-repository.js";
import { runMeanReversionBacktest } from "../backtest/engine-mean-reversion.js";
import { DEFAULT_MEAN_REVERSION_CONFIG } from "../strategies/mean-reversion.js";
import { pool } from "../infrastructure/database.js";

async function main() {
  console.log("=============================================");
  console.log("   MEAN REVERSION BACKTEST (HISTORICAL)       ");
  console.log("=============================================");
  console.log(`Symbol:   ${environment.SYMBOL}`);
  console.log(`Interval: 1h`);
  console.log(
    `Strategy: BB(${DEFAULT_MEAN_REVERSION_CONFIG.bbPeriod}, ${DEFAULT_MEAN_REVERSION_CONFIG.bbStdDevMultiplier}sd) + ` +
      `RSI(${DEFAULT_MEAN_REVERSION_CONFIG.rsiPeriod}) oversold <= ${DEFAULT_MEAN_REVERSION_CONFIG.rsiOversoldThreshold}, ` +
      `stop = ${DEFAULT_MEAN_REVERSION_CONFIG.atrStopMultiplier}x ATR, target = mean`
  );
  console.log(
    `Assumptions: fee=0.100% per fill, slippage=0.050% per fill, risk=$${environment.RISK_PER_TRADE_USD} per trade`
  );
  console.log("");

  const candles = await loadCandleRange(environment.SYMBOL, "1h");

  if (candles.length === 0) {
    console.error(`[BACKTEST] No candles found for ${environment.SYMBOL} (1h). Run the deep backfill first.`);
    await pool.end();
    process.exit(1);
  }

  console.log(
    `Loaded ${candles.length} closed 1h candles ` +
      `(${new Date(candles[0].openingTime).toISOString()} -> ${new Date(candles[candles.length - 1].openingTime).toISOString()})`
  );
  console.log("");

  const result = runMeanReversionBacktest(candles, {
    riskAmountUsd: environment.RISK_PER_TRADE_USD,
    maxPositionUsd: environment.MAX_POSITION_USD,
    startingEquityUsd: environment.PAPER_STARTING_BALANCE_USD,
  });

  console.log("--- BACKTEST RESULT (historical replay — not a guarantee of future performance) ---");
  console.log(`Closed trades:        ${result.totalTrades}`);
  console.log(`Open at end of data:  ${result.openAtEnd}`);
  console.log(`Wins / Losses:        ${result.wins} / ${result.losses}`);
  console.log(
    `Win rate:             ${result.winRate !== null ? (result.winRate * 100).toFixed(1) + "%" : "n/a (no closed trades)"}`
  );
  console.log(
    `Average R-multiple:   ${result.averageRMultiple !== null ? result.averageRMultiple.toFixed(3) + "R" : "n/a"}`
  );
  console.log(
    `Expectancy per trade: ${result.expectancyR !== null ? result.expectancyR.toFixed(3) + "R" : "n/a"}`
  );
  console.log(`Cumulative net PnL:   $${result.cumulativeNetPnlUsd.toFixed(2)}`);
  console.log(
    `Max drawdown:         $${result.maxDrawdownUsd.toFixed(2)}${result.maxDrawdownPercent !== null ? ` (${result.maxDrawdownPercent.toFixed(1)}% of peak equity)` : ""}`
  );
  console.log(
    `Profit factor:        ${result.profitFactor !== null ? result.profitFactor.toFixed(2) : "n/a (no losing trades or no trades)"}`
  );
  console.log("");
  console.log("This is a genuinely different signal from the trend-following strategy —");
  console.log("compare these numbers directly against `npm run backtest`'s output.");

  await pool.end();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[BACKTEST FATAL]", message);
  process.exit(1);
});