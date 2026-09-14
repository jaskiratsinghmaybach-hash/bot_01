# Backtesting

## What this is (and isn't)

The backtest engine (`src/backtest/engine.ts`, run via `npm run backtest`)
replays historical candles from `market_candles` through the **real**
strategy and risk logic under documented, configurable fee/slippage
assumptions. It answers: *"What would this strategy have done historically,
under these stated assumptions?"*

It is **not**:
- A guarantee or prediction of future performance
- A live or paper trading result — never mix these result types
- A source of marketing claims ("this bot makes $X/day") — see the
  disclaimer printed by every backtest run

## Methodology

### Look-ahead bias prevention

The engine uses an **expanding window**: at simulated candle index `i`,
the strategy only ever sees `candles[0..i]` — never anything after. This
is verified by a dedicated test: two candle series that are byte-identical
up to index 20 and diverge sharply afterward produce byte-identical trade
entries for anything opened at or before index 20.

### Entry assumption

A signal detected "at" candle `i` (meaning: the strategy, seeing only
candles 0 through i, decided to enter) is assumed to fill at that
candle's close price, adjusted by slippage. This models a system that
reacts to a closed candle over a live WebSocket feed, which is exactly
how the live/paper execution path actually behaves.

### Exit assumption

Subsequent candles are scanned for the first candle whose `low` touches
the stop-loss or whose `high` touches the take-profit. **If a single
candle's range touches both** (only knowable from OHLC data, not the true
intra-candle price path), the engine conservatively assumes the stop was
hit first — the worse outcome for the trader, not the more favorable one.

### Fees and slippage

Applied on both entry and exit, always against the trader:

```
feeFraction:      default 0.001  (0.1% of notional per fill)
slippageFraction: default 0.0005 (0.05% of price per fill, against the trader)
```

These mirror `PAPER_FEE_FRACTION` / `PAPER_SLIPPAGE_FRACTION` from paper
trading, so backtest and paper-trading cost assumptions stay consistent
with each other by default (both are independently configurable).

### Position sizing

Uses the same risk-based sizing and `MAX_POSITION_USD` cap as the live
risk engine (see `docs/risk-management.md`) — the backtest engine does
not reimplement sizing math separately, specifically to prevent it from
silently diverging from what live/paper trading would actually do. (An
earlier version of this engine did reimplement sizing inline and missed
the position cap; this was caught via a real test run and fixed.)

## Reported metrics

| Metric | Meaning |
|---|---|
| Closed trades | Trades with both an entry and a resolved exit |
| Open at end | Trades still open when historical data ran out — never fabricated an exit |
| Win rate | wins / closed trades |
| Average R-multiple | mean of (netPnl / riskAmountUsd) across closed trades |
| Expectancy | same as average R-multiple — expected return per trade, in units of risk |
| Cumulative net PnL | sum of all closed trades' net PnL |
| Max drawdown ($ and %) | largest peak-to-trough drop in **real account equity** (`startingEquityUsd + cumulativePnl`), not just cumulative PnL alone |
| Profit factor | gross profit / gross loss (null if no losing trades or no trades) |

When there are zero closed trades, win rate/expectancy/profit factor are
reported as `null` (not `0`, not `NaN`) — a null result means "not
enough data to say," not "this performed at exactly zero."

## Running a backtest

```bash
npm run backtest
```

Requires `market_candles` to already contain historical data for the
configured `SYMBOL` (populate this by running the app once in `dry-run`
or `paper` mode, which performs a REST backfill at boot). The CLI will
fail with a clear message, not a raw error, if no candles are found — and
prints the exact date range of data used, the fee/slippage assumptions,
and the full metric table on every run.

## Known limitation

The backtest engine currently evaluates a **single symbol** against
historical Binance candle data already sitting in Postgres. It does not
fetch additional history on its own — the person running it is
responsible for ensuring enough historical range has been backfilled to
draw a meaningful conclusion.
