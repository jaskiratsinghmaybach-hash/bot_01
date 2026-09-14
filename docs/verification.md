# Verification

## `npm run verify`

Runs `src/scripts/verify-strategy.ts`, which:

1. Connects to the configured Postgres database
2. Loads the most recent strategy candles for `SYMBOL`
3. Runs the real EMA/ATR/higher-low calculations and prints their values
4. Runs `evaluateStrategy()` and prints which filters passed/failed
5. Prints the resulting trade candidate (entry/SL/TP/R:R) if one exists

This is a **read-only diagnostic** — it never places an order, never
writes to `order_history`, and works regardless of `TRADING_MODE`. It
requires `market_candles` to already have data for the configured symbol
(populate via a normal app boot, which backfills automatically).

Sample structure of the output:

```
BOT_01 STRATEGY VERIFICATION

Symbol: SOLUSDC
Interval: 1h
Candles loaded: <N>

EMA(50): <value>
ATR(14): <value>

Trend filter:       PASS/FAIL
Higher-low filter:  PASS/FAIL
Risk distance:      PASS/FAIL
Volatility filter:  PASS/FAIL

Signal: BUY / NO TRADE

Entry: <value>
Stop Loss: <value>
Take Profit: <value>
Risk/Reward: 2.00
```

## `npm test`

Runs the automated test suite (`node --test`) across every `*.test.ts`
file. As of this codebase's last verified run: **88 tests**, covering:

| Area | File | Count |
|---|---|---|
| Exchange precision normalization | `exchange/precision.test.ts` | 10 |
| Binance request signing (verified against Binance's own published example) | `exchange/binance-signing.test.ts` | 7 |
| Risk engine (fixed-usd + percent-balance models) | `risk/risk-engine.test.ts` | 18 |
| Backtest engine | `backtest/engine.test.ts` | 10 |
| Candle validation | `infrastructure/candle-validation.test.ts` | 14 |
| Strategy engine | `strategies/core-logic.test.ts` | 22 |
| Order repository + guards (real Postgres) | `infrastructure/order-repository.integration.test.ts` | 7 |

The integration tests **require `DATABASE_URL` to be set** and are
automatically skipped (not silently passed — `node --test` reports them
as `skipped`, not `pass`) if it isn't. They were verified during
development against a real, locally-installed PostgreSQL 16 instance —
not a mock — including catching and fixing a real schema bug (a
`VARCHAR(10)` column too narrow for realistic asset-name values) via a
failing test before it was trusted.

Run with database integration tests included:

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/bot_01
npm test
```

## `npm run build`

Runs `tsc` in strict mode. A clean build (`tsc --noEmit` exits 0) was
confirmed at every commit in this codebase's history — the project did
not compile at all before the first commit in this development session
(`ws` was imported but never declared as a dependency).

## Binance request-signing verification

Unlike everything else Binance-facing in this project, the HMAC-SHA256
request signing (`src/exchange/binance-signing.ts`) **was** verified
against ground truth, not just internal consistency. Binance's own API
documentation publishes a worked signing example (payload, secret key,
and implicitly its expected signature via an OpenSSL command). During
development:

1. The published payload and secret were run through this project's
   `signQueryString()` function.
2. The same payload and secret were independently run through raw
   OpenSSL (`echo -n "<payload>" | openssl dgst -sha256 -hmac "<secret>"`).
3. Both produced the exact same signature:
   `c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71`.

This is a real, ground-truth verification — not a self-consistency check
— and is preserved as a permanent regression test in
`binance-signing.test.ts`. It confirms the **signing algorithm** is
correct. It does not confirm the live adapter's actual HTTP request
construction, headers, or Binance's response handling are correct —
those still require testing against a real or testnet Binance account.

## What has and hasn't been verified against live Binance

Everything Postgres-facing in this codebase (schema, candle persistence,
order persistence, paper-trading balance tracking) was verified against a
real PostgreSQL instance during development.

Everything Binance-facing that involves an actual HTTP call
(`exchangeInfo`, ticker price, REST kline backfill, WebSocket kline
stream, account balance fetch, MARKET BUY, OCO bracket placement) was
code-reviewed and type-checked, but **could not be verified against live
Binance from the development sandbox this project was built in** —
outbound network access to `api.binance.com` was blocked by that
sandbox's own network policy. The one exception is the HMAC-SHA256
signing algorithm itself, which was verified against ground truth (see
above) — that's the cryptographic correctness of the signature, not
confirmation that Binance accepts and correctly processes the resulting
signed requests.

If you are evaluating or deploying this codebase: verify the market-data
paths yourself first (run `npm run dev` in `dry-run` mode from an
environment with normal internet access and confirm candles are actually
being backfilled and streamed), then verify `paper` mode's price-fetch
path, and — critically — test `live` mode against Binance's **testnet**
before ever pointing it at a real account with real funds. Nothing in
this codebase should be treated as "live-execution-ready" until that
testnet verification has actually been done and the results reviewed.
