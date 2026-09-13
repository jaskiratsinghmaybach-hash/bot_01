import 'dotenv/config';
import environment from '../config/environment.js';
import { pool } from '../infrastructure/database.js'; // Using the established pool instance
import { loadStrategyCandles } from '../infrastructure/candle-repository.js';
import {
  evaluateStrategy,
  computeEMA,
  computeATR,
  findSwingLowIndices,
  detectHigherLow,
  DEFAULT_STRATEGY_CONFIG,
} from '../strategies/core-logic.js';

const SYMBOL = environment.SYMBOL;

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Strategy Verification — real Binance 1H candles from Postgres');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Verify the pool is responsive
  await pool.query('SELECT NOW()');

  const candles = await loadStrategyCandles(SYMBOL);

  if (!candles || candles.length === 0) {
    console.error('❌  No candles returned from Postgres. Cannot run strategy.');
    process.exit(1);
  }

  console.log(`✅  Loaded ${candles.length} closed 1H candles for ${SYMBOL}`);
  const first = candles[0];
  const last = candles[candles.length - 1];
  
  // FIXED: Adjusted to use Codex's 'openingTime' naming convention
  console.log(`    Range: ${new Date(first.openingTime).toISOString()} → ${new Date(last.openingTime).toISOString()}\n`);

  // ------------------------------------------------------------------
  // Individual indicator spot-checks
  // ------------------------------------------------------------------

  const cfg = DEFAULT_STRATEGY_CONFIG;
  const closes = candles.map((c) => c.close);

  // EMA
  const emaValues = computeEMA(closes, cfg.emaPeriod);
  const latestEMA = emaValues[emaValues.length - 1];
  console.log(`📊  EMA(${cfg.emaPeriod}):`);
  console.log(`    Latest EMA : ${isNaN(latestEMA) ? 'NaN — not enough candles' : latestEMA.toFixed(4)}`);
  console.log(`    Latest Close: ${last.close}`);
  console.log(`    Close > EMA: ${last.close > latestEMA}\n`);

  // ATR
  const atrValues = computeATR(candles, cfg.atrPeriod);
  const latestATR = atrValues[atrValues.length - 1];
  console.log(`📊  ATR(${cfg.atrPeriod}):`);
  console.log(`    Latest ATR : ${isNaN(latestATR) ? 'NaN — not enough candles' : latestATR.toFixed(4)}\n`);

  // Swing Lows
  const swingIndices = findSwingLowIndices(candles, cfg.swingLookback);
  console.log(`📊  Swing Lows (lookback=${cfg.swingLookback}):`);
  console.log(`    Found ${swingIndices.length} swing lows`);
  if (swingIndices.length > 0) {
    const last5 = swingIndices.slice(-5).map((i) => ({
      index: i,
      low: candles[i].low,
      // FIXED: Adjusted to use Codex's 'openingTime'
      time: new Date(candles[i].openingTime).toISOString(),
    }));
    console.log('    Most recent (up to 5):');
    last5.forEach((s) => console.log(`      [${s.index}] ${s.time}  low=${s.low}`));
  }
  console.log();

  // Higher Low
  const hlResult = detectHigherLow(candles, cfg.swingLookback, cfg.minSwingLows);
  console.log(`📊  Higher Low Detection:`);
  console.log(`    Confirmed : ${hlResult.confirmed}`);
  console.log(`    Floor Price: ${hlResult.hlFloorPrice ?? 'N/A'}`);
  console.log(`    Reason    : ${hlResult.reason}\n`);

  // ------------------------------------------------------------------
  // Full strategy evaluation
  // ------------------------------------------------------------------

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Full Strategy Evaluation');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const candidate = evaluateStrategy(candles);

  console.log(`  shouldEnter     : ${candidate.shouldEnter}`);
  console.log(`  direction       : ${candidate.direction ?? 'null'}`);
  console.log(`  reason          : ${candidate.reason}`);
  console.log();
  console.log(`  entryPrice      : ${candidate.entryPrice ?? 'N/A'}`);
  console.log(`  stopLoss        : ${candidate.stopLoss?.toFixed(4) ?? 'N/A'}`);
  console.log(`  takeProfit      : ${candidate.takeProfit?.toFixed(4) ?? 'N/A'}`);
  console.log(`  riskDistance    : ${candidate.riskDistance?.toFixed(4) ?? 'N/A'}`);
  console.log(`  rewardDistance  : ${candidate.rewardDistance?.toFixed(4) ?? 'N/A'}`);
  console.log(`  riskRewardRatio : ${candidate.riskRewardRatio?.toFixed(2) ?? 'N/A'}`);
  console.log();
  console.log(`  higherLowPrice  : ${candidate.higherLowPrice ?? 'N/A'}`);
  console.log(`  emaValue        : ${candidate.emaValue?.toFixed(4) ?? 'N/A'}`);
  console.log(`  atr14           : ${candidate.atr14?.toFixed(4) ?? 'N/A'}`);
  console.log();
  console.log(`  passedFilters   : [${candidate.passedFilters.join(', ')}]`);
  console.log(`  failedFilters   : [${candidate.failedFilters.join(', ')}]`);
  console.log(`  candleOpenTime  : ${new Date(candidate.candleOpenTime).toISOString()}`);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (candidate.shouldEnter) {
    console.log(`  ✅  VALID TRADE CANDIDATE — TRADING_MODE is currently "${environment.TRADING_MODE}"`);
    console.log('      (dry-run: logged only. paper: simulated fill. live: not yet implemented.)');
  } else {
    console.log('  ⏸️   No trade candidate — see failedFilters above');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Safely close out the active Postgres pool connections
  await pool.end();
}

main().catch((err) => {
  console.error('Fatal error in verify-strategy:', err);
  process.exit(1);
});