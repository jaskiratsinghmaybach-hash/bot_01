/**
 * Regime filter sweep.
 *
 * Tests each new entry-context filter (EMA slope, ATR percentile band,
 * higher-timeframe trend) independently, then combined, against the same
 * full historical dataset — using runBacktestWithRegimeFilters, which
 * reuses the original engine's fee/slippage/sizing logic unchanged.
 *
 * Row 1 ("baseline, all filters off") should reproduce the same numbers
 * as `npm run backtest` — that's a built-in correctness check. If it
 * doesn't match, something in this fork diverged and the other rows
 * shouldn't be trusted yet.
 *
 * Diagnostic only — historical replay, not a live guarantee.
 */
import "dotenv/config";
import environment from "../config/environment.js";
import { loadCandleRange } from "../infrastructure/candle-repository.js";
import { runBacktestWithRegimeFilters } from "../backtest/engine-with-regime.js";
import { pool } from "../infrastructure/database.js";
import type { RegimeFilterConfig } from "../strategies/regime-filters.js";

interface SweepRow {
  label: string;
  regimeFilterConfig: Partial<RegimeFilterConfig>;
}

const ROWS: SweepRow[] = [
  { label: "baseline (all filters off)", regimeFilterConfig: {} },
  { label: "EMA slope only", regimeFilterConfig: { requireEmaSlope: true } },
  { label: "ATR band only", regimeFilterConfig: { requireAtrBand: true } },
  { label: "HTF trend (4h) only", regimeFilterConfig: { requireHtfTrend: true } },
  {
    label: "EMA slope + ATR band",
    regimeFilterConfig: { requireEmaSlope: true, requireAtrBand: true },
  },
  {
    label: "EMA slope + HTF trend",
    regimeFilterConfig: { requireEmaSlope: true, requireHtfTrend: true },
  },
  {
    label: "ATR band + HTF trend",
    regimeFilterConfig: { requireAtrBand: true, requireHtfTrend: true },
  },
  {
    label: "ALL THREE combined",
    regimeFilterConfig: { requireEmaSlope: true, requireAtrBand: true, requireHtfTrend: true },
  },
];

async function main() {
  console.log("=============================================");
  console.log("        REGIME FILTER SWEEP (DIAGNOSTIC)      ");
  console.log("=============================================");

  const candles = await loadCandleRange(environment.SYMBOL, "1h");

  if (candles.length === 0) {
    console.error(`[SWEEP] No candles found for ${environment.SYMBOL} (1h). Run the deep backfill first.`);
    await pool.end();
    process.exit(1);
  }

  console.log(`Loaded ${candles.length} candles for ${environment.SYMBOL} (1h)\n`);
  console.log(
    "Config".padEnd(28) + " | Trades | Rejected | Wins | Losses | WinRate | ExpR    | NetPnL($) | PF    | MaxDD($)"
  );
  console.log("-".repeat(115));

  for (const row of ROWS) {
    const result = runBacktestWithRegimeFilters(candles, {
      regimeFilterConfig: row.regimeFilterConfig,
      riskAmountUsd: environment.RISK_PER_TRADE_USD,
      maxPositionUsd: environment.MAX_POSITION_USD,
      startingEquityUsd: environment.PAPER_STARTING_BALANCE_USD,
    });

    const winRate = result.winRate !== null ? (result.winRate * 100).toFixed(1) + "%" : "n/a";
    const expectancy = result.expectancyR !== null ? result.expectancyR.toFixed(3) + "R" : "n/a";
    const pf = result.profitFactor !== null ? result.profitFactor.toFixed(2) : "n/a";

    console.log(
      row.label.padEnd(28) + " | " +
      String(result.totalTrades).padStart(6) + " | " +
      String(result.rejectedByRegimeFilter).padStart(8) + " | " +
      String(result.wins).padStart(4) + " | " +
      String(result.losses).padStart(6) + " | " +
      winRate.padStart(7) + " | " +
      expectancy.padStart(7) + " | " +
      result.cumulativeNetPnlUsd.toFixed(2).padStart(9) + " | " +
      pf.padStart(5) + " | " +
      result.maxDrawdownUsd.toFixed(2).padStart(8)
    );
  }

  console.log("\nDiagnostic sweep only — historical replay, not a guarantee of future performance.");
  console.log("Sanity check: row 1 should match `npm run backtest`'s current output exactly.");
  console.log("Watch for filters that cut trade count a lot AND flip expectancy positive —");
  console.log("that's the signature of a filter removing genuinely bad setups, not just luck.");

  await pool.end();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[SWEEP FATAL]", message);
  process.exit(1);
});