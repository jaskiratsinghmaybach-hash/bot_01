# BOT_01

A Binance market-data pipeline, long-only trend-continuation strategy
engine, risk engine, and paper/dry-run execution framework for
cryptocurrency swing trading — written in strict TypeScript, backed by
PostgreSQL.

**Live trading execution now exists but has not been verified against
real or testnet Binance from this project's development environment.**
See [Limitations](#limitations-read-this-before-buying-or-deploying)
before enabling `TRADING_MODE=live`.

## Features

- **Real Binance market data** — REST historical backfill + WebSocket
  live kline stream, closed-candle-only processing, automatic reconnect
- **Deterministic strategy engine** — EMA trend filter, ATR volatility
  filter, higher-low swing structure detection, exact 1:2 risk/reward
  enforcement — pure functions, fully unit-tested, no look-ahead bias
  (verified by a dedicated test)
- **Risk engine** — position sizing from risk parameters (fixed-USD or
  percent-of-balance, selectable via `RISK_MODEL`), exchange precision
  normalization (LOT_SIZE/PRICE_FILTER/MIN_NOTIONAL), always floors
  (never rounds up) so normalization can only reduce risk
- **Live execution** — HMAC-SHA256 signed Binance order submission
  (MARKET BUY + OCO stop-loss/take-profit bracket), verified byte-for-byte
  against Binance's own published signing example; duplicate-order and
  single-open-position guards enforced at both the application and
  database level; an explicit `FILLED_UNHEDGED` state if a bracket
  placement fails after entry, never silently hidden
- **Honest order lifecycle** — `CREATED → SUBMITTED → ... → FILLED`, with
  a `provenance` field (`LIVE`/`PAPER`/`DRY_RUN`) so a simulated fill can
  never be confused with a real one
- **PostgreSQL persistence** — candles, order history, simulated paper
  balance, idempotent schema creation at boot
- **Backtest engine** — historical replay of the real strategy/risk logic
  under documented fee/slippage assumptions, look-ahead-safe by
  construction (expanding window, verified by test)
- **88 automated tests** — strategy math, risk math, exchange precision,
  Binance request signing (verified against Binance's own published
  example), candle validation, backtest mechanics, duplicate-order/
  open-position guards, and real-database integration tests (not mocked)
- **VPS deployment path** — systemd service, graceful shutdown on
  SIGINT/SIGTERM

## Architecture

```
Binance (REST + WebSocket) → market_candles (Postgres)
                                     ↓
                          Strategy Engine (pure)
                                     ↓
                            Risk Engine (pure)
                                     ↓
                       Execution Router (TRADING_MODE)
                          ↙          ↓          ↘
                    dry-run       paper      live (not built)
                                     ↓
                     order_history (Postgres, honest lifecycle)
```

Full detail: [`docs/architecture.md`](docs/architecture.md).

## Strategy

Long-only trend continuation: EMA(50) uptrend filter + ascending
higher-low swing structure + ATR-bounded stop distance, with a fixed 1:2
risk/reward target. Full filter chain and formulas:
[`docs/strategy.md`](docs/strategy.md),
[`docs/mathematics.md`](docs/mathematics.md).

## Risk Management

Position size = risk amount ÷ stop distance, capped at a hard maximum
notional, normalized to the exchange's real LOT_SIZE/tick-size rules
(flooring only — never rounds up into more risk than configured).
Detail: [`docs/risk-management.md`](docs/risk-management.md).

## Data Pipeline

REST backfill + WebSocket stream, closed-candles only, validated before
persistence, upserted with a unique constraint to prevent duplicates.
Detail: [`docs/data-pipeline.md`](docs/data-pipeline.md).

## Execution

Three modes via `TRADING_MODE`:

| Mode | Behavior | Credentials needed |
|---|---|---|
| `dry-run` (default) | Logs what would be submitted. No persistence. | None |
| `paper` | Simulates a fill against a real fetched Binance price, with configurable slippage/fees, tracked against a simulated balance in Postgres. | None |
| `live` | Real signed Binance orders (MARKET BUY + OCO stop-loss/take-profit bracket). Requires `I_HAVE_TESTED_LIVE_EXECUTION=true` as an explicit extra confirmation. **HTTP calls to Binance have not been verified from this project's dev environment — see Limitations.** | `BINANCE_API_KEY`, `BINANCE_SECRET_KEY` |

Detail: [`docs/execution.md`](docs/execution.md).

## Installation

```bash
npm install
cp .env.example .env      # fill in DATABASE_URL at minimum
npm run build
```

## Configuration

See [`.env.example`](.env.example) for every variable and its default.
At minimum you need a `DATABASE_URL`. `TRADING_MODE` defaults to
`dry-run` — it is never `live` by default.

## Verification

```bash
npm run verify
```

Read-only diagnostic: connects to Postgres, runs the real strategy math
against recent candles, prints indicator values and filter pass/fail
status. Never places an order. Detail:
[`docs/verification.md`](docs/verification.md).

## Testing

```bash
npm test
```

88 automated tests. Database-integration tests are skipped automatically
if `DATABASE_URL` isn't set (not silently passed — reported as
`skipped`). To run the full suite including real-Postgres integration
tests:

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/bot_01
npm test
```

## Backtesting

```bash
npm run backtest
```

Replays historical candles already in `market_candles` through the real
strategy and risk logic, printing win rate, average R-multiple,
expectancy, cumulative PnL, max drawdown, and profit factor — under
explicitly stated fee/slippage assumptions. This is historical replay,
**not a guarantee of future performance**, and is never mixed with paper
or live results. Full methodology: [`docs/backtesting.md`](docs/backtesting.md).

## VPS Deployment

Systemd service, database setup, update procedure:
[`docs/deployment.md`](docs/deployment.md).

## Security

API key permissions, secret handling, firewall guidance:
[`docs/security.md`](docs/security.md).

## Limitations (read this before buying or deploying)

- **Live execution HTTP calls have not been verified against real or
  testnet Binance.** The HMAC-SHA256 request signing is proven correct —
  verified byte-for-byte against Binance's own published worked example,
  independently cross-checked against raw OpenSSL. But the actual order
  placement calls (`MARKET BUY`, OCO bracket, account balance fetch) have
  not been exercised against a live or testnet account, since outbound
  network access to `api.binance.com` was unavailable in this project's
  development environment. **Test against Binance's testnet before any
  mainnet use.** See [`docs/verification.md`](docs/verification.md).
- **No order reconciliation.** If a network error occurs after Binance
  may have already processed a request, the current code assumes
  rejection rather than querying Binance to confirm the true state. See
  [`docs/execution.md`](docs/execution.md) for detail — this is a real
  gap, not a theoretical one.
- **Long-only, single-symbol, single-strategy.** No shorting, no
  multi-symbol portfolio logic.
- **No circuit breaker / daily loss limit / multi-position portfolio
  risk.** Single open position at a time is enforced, but there's no
  protection against a losing streak beyond each trade's own stop-loss.
- **No built-in health-check HTTP endpoint** for automated monitoring —
  see `docs/deployment.md` for what monitoring options exist today.
- **The paper-trading balance model tracks quote-currency balance only**
  — it does not simulate base-asset inventory constraints across trades.

## License

See [`LICENSE.md`](LICENSE.md) — proprietary, non-exclusive commercial
license (draft; confirm against your marketplace's own license terms
before listing). Third-party dependency licenses:
[`NOTICE.md`](NOTICE.md).
