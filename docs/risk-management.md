# Risk Management

## Separation of concerns

Position sizing lives entirely in `src/risk/risk-engine.ts`, a pure
function with no database, network, or exchange-credential dependency.
It is never called with a "trust me" quantity — it always re-derives
size from risk parameters and validates the result against real exchange
rules before anything downstream treats it as executable.

## Inputs

| Parameter | Source |
|---|---|
| `RISK_PER_TRADE_USD` | `.env` — USD risked per trade |
| `MAX_POSITION_USD` | `.env` — hard notional ceiling, independent of risk math |
| Symbol rules (`tickSize`, `stepSize`, `minQty`, `minNotional`) | Live Binance `exchangeInfo`, fetched once at boot |

## What the risk engine rejects

`evaluateRisk()` returns `approved: false` (never a partial or "best
effort" order) for any of:

- Non-finite or non-positive `entryPrice`, `stopLoss`, `riskAmountUsd`,
  or `maxPositionUsd`
- Zero or negative risk distance (stop on the wrong side of entry, or
  equal to entry)
- A computed quantity that, after flooring to the exchange's `stepSize`,
  falls below `minQty`
- A resulting notional below the exchange's `minNotional`
- A post-normalization risk amount that (due to flooring) somehow exceeds
  the requested `riskAmountUsd` — a defensive assertion that should be
  mathematically unreachable given flooring always reduces size, but is
  checked explicitly rather than assumed

Every rejection includes a specific, human-readable `reason` string —
this project never fails silently or falls back to a default quantity.

## Why the risk engine never rounds up

Exchange precision normalization (`exchange/precision.ts`) always floors
quantity and price to the nearest valid step/tick. Rounding to nearest,
or rounding up to meet a minimum, would silently let the actual position
exceed what the risk parameters called for. If flooring pushes a
quantity below the exchange's minimum, the trade is **rejected**, not
bumped up to the minimum — bumping up would mean risking more than
configured, which defeats the purpose of a risk engine.

## Position cap

`MAX_POSITION_USD` is enforced independently of risk-based sizing. A very
tight stop-loss can otherwise imply an extremely large position from risk
math alone (small risk distance → large `riskAmountUsd / riskDistance`).
This was caught as a real bug during development: the backtest engine
initially reimplemented sizing math inline and skipped this cap entirely,
which let a hand-constructed test scenario compute an unrealistic ~197
unit position. It was fixed to route through the same capping logic the
live risk engine uses.

## What this project does NOT do

- No portfolio-level risk (aggregate exposure across multiple concurrent
  positions) — this is a single-position-at-a-time system by strategy
  design (the strategy is long-only, single-symbol).
- No dynamic risk sizing based on account equity or recent win/loss
  streaks (e.g. no Kelly criterion, no equity curve scaling). Risk per
  trade is a fixed USD amount from configuration.
- No circuit breaker for consecutive losses or daily loss limits. A buyer
  wanting this would need to add it — the execution router
  (`execution/router.ts`) is a reasonable place to add such a check before
  Phase B (live execution) is built.
