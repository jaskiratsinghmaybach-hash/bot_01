# Mathematics

Worked formulas for every calculation in the strategy and risk engines,
each cross-referenced to its verified test.

## EMA (Exponential Moving Average)

```
k = 2 / (period + 1)
seed[period-1] = average(closes[0..period-1])
ema[i] = closes[i] * k + ema[i-1] * (1 - k)      for i >= period
ema[i] = NaN                                      for i < period-1
```

Worked example (`period=3`, closes `[22, 23, 24, 25]`):

```
seed  = (22+23+24)/3 = 23        -> ema[2] = 23
k     = 2/4 = 0.5
ema[3] = 25*0.5 + 23*0.5 = 24
```

Verified in `core-logic.test.ts` against this exact worked example, plus a
flat-series case (EMA of a constant series equals that constant).

## ATR (Average True Range)

```
trueRange[i] = max(
  high[i] - low[i],
  abs(high[i] - close[i-1]),
  abs(low[i]  - close[i-1])
)
atr[period] = average(trueRange[1..period])
atr[i] = (atr[i-1] * (period-1) + trueRange[i]) / period    for i > period
```

Verified to be `NaN` before seeding and exactly `0` (not negative, not
`NaN`) on a perfectly flat candle series.

## Swing low detection

A candle at index `i` is a confirmed swing low if its `low` is strictly
less than the `low` of every candle within `swingLookback` positions on
**both** sides:

```
isSwingLow(i) = low[i] < low[i-lookback..i-1] AND low[i] < low[i+1..i+lookback]
```

## Higher-low chain confirmation

Given the sequence of swing-low prices found (in chronological order),
the most recent contiguous ascending run is extracted. If its length is
`>= minSwingLows`, the chain is confirmed and its last (highest, most
recent) value becomes the "HL floor price."

Verified against two hand-traced cases:
- `[90, 95, 100]` (genuinely ascending) → confirmed, floor = 100
- `[100, 95, 90]` (descending) → rejected

## Stop loss / take profit

```
stopLoss = hlFloorPrice * (1 - slBufferFraction)   // default buffer 0.2%
riskDistance   = entryPrice - stopLoss
takeProfit     = entryPrice + riskDistance * 2
rewardDistance = takeProfit - entryPrice
riskRewardRatio = rewardDistance / riskDistance     // always exactly 2
```

## Position sizing (risk engine)

```
riskDistance = entryPrice - stopLoss        (BUY)
riskDistance = stopLoss - entryPrice        (SELL — not used by this
                                               strategy today, but
                                               supported by the risk
                                               engine for future
                                               strategies)

rawQuantity  = riskAmountUsd / riskDistance

rawNotional  = rawQuantity * entryPrice
cappedQuantity = rawNotional > maxPositionUsd
  ? maxPositionUsd / entryPrice
  : rawQuantity
```

The capped quantity is then floored to the exchange's `stepSize` (never
rounded up — see below) and rejected if that floors it below `minQty` or
below `minNotional`.

## Exchange precision normalization (floor-only)

Binance requires order quantity and price to be exact multiples of
`stepSize` and `tickSize`. This project always **floors** — never rounds
to nearest, never rounds up — so normalization can only reduce a position
below the risk-calculated size, never silently increase it:

```
normalizedQuantity = floor(rawQuantity / stepSize) * stepSize
normalizedPrice     = floor(rawPrice / tickSize) * tickSize
```

The naive version of this (`Math.floor(value / step) * step`) is
unreliable in JavaScript due to binary floating point representation
(e.g. `0.1 + 0.2 !== 0.3`). `exchange/precision.ts` implements this using
string-based fixed-point truncation instead of raw float division, and is
verified against 12 known-value cases including Binance's smallest real
tick size (`0.00000001`). This was not correct on the first attempt during
development — an earlier version rounded to the nearest tick before
flooring, which defeated the floor guarantee (e.g. `1.23456` with step
`0.001` incorrectly produced `1.235` instead of `1.234`); this was caught
by a failing test and fixed before being trusted.

## Backtest P&L

```
entryFillPrice = entryPrice * (1 + slippageFraction)      // BUY, worse fill
exitFillPrice  = exitPrice  * (1 - slippageFraction)       // worse fill either exit reason

entryFee = entryFillPrice * quantity * feeFraction
exitFee  = exitFillPrice  * quantity * feeFraction
fees     = entryFee + exitFee

grossPnl = (exitFillPrice - entryFillPrice) * quantity
netPnl   = grossPnl - fees
rMultiple = netPnl / riskAmountUsd
```

If a single candle's range touches both the stop-loss and take-profit
levels, the ambiguity (OHLC data alone can't reveal the intra-candle
path) is resolved conservatively: the stop-loss is assumed to have been
hit first.

## Max drawdown

Computed against real account equity, not just cumulative PnL:

```
equity[i] = startingEquityUsd + cumulativePnl[i]
peakEquity = running max of equity[0..i]
drawdown[i] = peakEquity - equity[i]
maxDrawdownUsd = max(drawdown[0..n])
maxDrawdownPercent = maxDrawdownUsd / peakEquityAtThatPoint * 100
```

An earlier version of this expressed drawdown as a percentage of the
cumulative-PnL peak alone (not real equity), which produced a nonsensical
figure (over 1000%) when the PnL peak was small — a $31 drawdown against
a $38 all-time PnL peak, with no starting balance in the denominator. This
was caught by comparing backtest output against manually-computed
expected values, not merely by the code compiling or tests passing in
isolation, and fixed before being trusted.
