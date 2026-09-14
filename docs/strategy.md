# Strategy

## Summary

BOT_01 implements a **long-only trend continuation** strategy: it looks
for an established uptrend, waits for a pullback that forms a rising
sequence of swing lows ("higher lows"), and enters on the assumption the
uptrend will continue. It is not a reversal strategy and does not take
short positions — `evaluateStrategy()` never returns `direction: 'SELL'`.

Source: `src/strategies/core-logic.ts`. See `docs/mathematics.md` for the
full worked formulas.

## Filter chain

A candidate must pass every filter, in order, to produce a trade signal:

1. **Sufficient data** — enough candles to seed EMA(50), ATR(14), and the
   swing-low detector. Otherwise: `INSUFFICIENT_DATA`.
2. **EMA trend filter** — the latest close must be above EMA(50).
   Otherwise: `EMA_FILTER`.
3. **Higher-low filter** — at least `minSwingLows` (default 2) swing lows
   must exist, and the most recent chain of swing lows must be strictly
   ascending. Otherwise: `HIGHER_LOW_FILTER`.
4. **Risk distance sanity** — stop loss must be below entry (a positive
   risk distance). Otherwise: `RISK_DISTANCE_FILTER`.
5. **ATR volatility filter** — the risk distance must not exceed
   `atrMultiplierMax` (default 1.5) times ATR(14), and the reward
   distance must not exceed `atrTpMultiplierMax` (default 3.0) times
   ATR(14). This rejects trades where the market is too volatile (stop
   too wide) or the target is unrealistically far given recent range.
   Otherwise: `ATR_FILTER`.

If a candidate clears all four filters, `shouldEnter` is `true` and the
candidate carries `entryPrice`, `stopLoss`, `takeProfit`, and full
diagnostic detail (`passedFilters`, `failedFilters`, `emaValue`, `atr14`,
`higherLowPrice`).

## Risk/reward

Every signal enforces an exact 1:2 risk/reward ratio:

```
riskDistance   = entryPrice - stopLoss
takeProfit     = entryPrice + riskDistance * 2
rewardDistance = takeProfit - entryPrice
riskRewardRatio = rewardDistance / riskDistance   // always exactly 2
```

This is verified by an automated test
(`core-logic.test.ts`: "enforces exactly a 1:2 risk/reward ratio").

## Look-ahead bias

The strategy function itself (`evaluateStrategy`) only ever receives the
candle array it's given and only ever reads the **last** element as "now"
— it has no access to anything beyond what's passed in. Look-ahead safety
is therefore a property of how callers use it, not of the function itself:

- **Live/paper trading**: the candle cache is only refreshed with a candle
  after Binance confirms it as closed (`binance-feed.ts` filters on the
  kline's `x: true` closed flag before persisting or evaluating).
- **Backtesting**: `backtest/engine.ts` explicitly uses an expanding
  window — at simulated index `i`, only `candles[0..i]` is passed to
  `evaluateStrategy`. This is verified by a dedicated test that feeds two
  candle series, identical up to index 20 and wildly different after, and
  asserts the resulting trade entries at or before index 20 are
  byte-identical between the two runs.

## Configuration

All thresholds are overridable via `StrategyConfig` (see
`DEFAULT_STRATEGY_CONFIG` in `core-logic.ts`):

| Field | Default | Meaning |
|---|---|---|
| `emaPeriod` | 50 | EMA trend filter period |
| `swingLookback` | 3 | candles on each side to qualify a swing low |
| `minSwingLows` | 2 | minimum ascending swing lows required |
| `slBufferFraction` | 0.002 | buffer below the HL floor for the stop loss |
| `atrPeriod` | 14 | ATR period |
| `atrMultiplierMax` | 1.5 | max risk distance as a multiple of ATR |
| `atrTpMultiplierMax` | 3.0 | max reward distance as a multiple of ATR |

## Known limitation

This is a single-strategy, single-symbol, long-only system. There is no
short-selling, no multi-symbol portfolio logic, and no strategy-switching.
A buyer wanting those capabilities would need to extend the strategy
layer — the architecture (pure function in, `TradeCandidate` out) is
designed to make that extension straightforward without touching
risk/execution/persistence code.
