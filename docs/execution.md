# Execution

## Three modes, one router

`TRADING_MODE` (env var: `dry-run` | `paper` | `live`) selects exactly one
execution adapter via `src/execution/router.ts`. This is the only place
that branches on `TRADING_MODE` for execution — keeping the branch in one
place makes it straightforward to verify `live` can never be silently
reached without the credential checks already enforced in
`config/environment.ts`.

### `dry-run` (default)

`src/execution/dry-run-adapter.ts`. Logs what would have been submitted —
side, quantity, price, notional, stop-loss, take-profit — and does
nothing else. No database row is written. No balance is tracked. This is
the safest mode and requires no Binance credentials at all.

### `paper`

`src/execution/paper-adapter.ts`. Fetches the **real, current** Binance
price for the configured symbol (`GET /api/v3/ticker/price` — a public,
unauthenticated endpoint), then simulates a fill:

```
slippedPrice = side === 'BUY'
  ? marketPrice * (1 + PAPER_SLIPPAGE_FRACTION)
  : marketPrice * (1 - PAPER_SLIPPAGE_FRACTION)
```

Slippage is always applied **against** the trader — a worse fill than the
raw market price — never in their favor. A taker fee
(`PAPER_FEE_FRACTION`) is applied to notional. A simulated quote-currency
balance (seeded from `PAPER_STARTING_BALANCE_USD`) is debited on a BUY
and credited on a SELL; if the simulated balance can't cover the notional
plus fee, the order is marked `REJECTED`, not silently under-filled.

Every paper order is persisted to `order_history` with
`provenance = 'PAPER'`, and every synthetic order ID is prefixed `paper_`
so it can never be mistaken for a real Binance order ID in a query or a
report.

**Limitation:** the paper adapter models quote-currency balance only — it
does not track base-asset inventory across trades (i.e., it doesn't
simulate "you can't sell what you don't hold"). Each trade's PnL is
computed independently. This is adequate for validating the strategy →
risk → execution pipeline and cost assumptions, but is not a full
portfolio simulator.

### `live`

`src/execution/live-adapter.ts`. Real, HMAC-SHA256 signed requests to
Binance's Spot API: authenticated account balance fetch (for
`RISK_MODEL=percent-balance`), a signed `MARKET BUY`, and a signed OCO
`SELL` bracket (`STOP_LOSS_LIMIT` + take-profit `LIMIT`) placed immediately
after the entry fills.

**Verification status — read this before enabling live mode.** The
HMAC-SHA256 request-signing implementation
(`src/exchange/binance-signing.ts`) is verified byte-for-byte against
Binance's own published worked example, independently cross-checked
against raw OpenSSL (see `binance-signing.test.ts` — the expected
signature in that test was computed via
`echo -n "<payload>" | openssl dgst -sha256 -hmac "<secret>"` and matches
exactly). **The actual HTTP calls this adapter makes to Binance's live
order endpoints have not been verified against a real or testnet Binance
account** — outbound network access to `api.binance.com` was unavailable
in this project's development environment. Test against Binance's
**testnet** before any mainnet use.

Because of this, booting with `TRADING_MODE=live` requires an additional
explicit environment variable, `I_HAVE_TESTED_LIVE_EXECUTION=true` — this
is not a technical requirement, it's a deliberate extra confirmation step
so going live can never happen by accident (e.g. from a copy-pasted
`.env`). See `main.ts`.

**Safety guards before any order is placed:**
- **Single open position at a time** (`hasOpenPosition`) — refuses a new
  entry if any order for the symbol is in an unresolved state (`CREATED`
  through `FILLED_UNHEDGED`).
- **Duplicate-signal guard** (`hasActiveOrderForCandle`) — refuses a
  second order for the same symbol + signal candle, enforced both in
  application logic and by a database-level partial unique index
  (`order_history_symbol_candle_active_uidx`) so it can't be bypassed by
  a race condition or a bug in the application-level check alone —
  verified by a test that the database itself rejects the duplicate
  insert.
- **Exchange-precision normalization and risk caps** — routes through the
  same `evaluateRisk()` / `normalizeOrder()` used by paper trading (see
  `docs/risk-management.md`), so live orders are never sized outside what
  Binance's LOT_SIZE/MIN_NOTIONAL rules or the configured risk limits
  allow.
- **`FILLED_UNHEDGED` state** — if the entry `MARKET BUY` fills but the
  protective OCO bracket then fails to place (network error, Binance
  rejection, etc.), the order is marked `FILLED_UNHEDGED`, not silently
  reported as a normal `FILLED` order. This state means: a real position
  is open on the real exchange with **no automated stop-loss**. The
  adapter throws a loud, explicit error in this case rather than
  swallowing it — this is the single most dangerous state the system can
  reach and it is never hidden.

**Risk model:** controlled by `RISK_MODEL`:
- `fixed-usd` — risk `RISK_PER_TRADE_USD` dollars per trade regardless of
  balance.
- `percent-balance` — risk `RISK_PERCENT_OF_BALANCE` of the live quote-asset
  balance (fetched from Binance's `/api/v3/account`) per trade, with an
  independent `MAX_BALANCE_FRACTION` ceiling (default 98%) so a position
  can never be sized to consume the entire balance even under a very
  tight stop-loss.

Dry-run and paper modes always use `fixed-usd` sizing regardless of
`RISK_MODEL`, since `percent-balance` requires a real account balance
that only exists in live mode.

**Not yet implemented — known gap.** There is currently no order
*reconciliation* logic: if a network error occurs after Binance may have
already processed a request (e.g. the response never arrives, but the
order might have gone through), the order is marked `REJECTED` in
`order_history` on the assumption it failed — but it's possible Binance
actually received and processed it. A production-grade system would
query `GET /api/v3/order` by `clientOrderId` after any ambiguous failure
to confirm the true state before concluding it was rejected, and use the
`UNKNOWN` status while that's being resolved. This gap is a real,
material limitation of the current live adapter, not a theoretical one —
do not assume a `REJECTED` status is always accurate without adding this.

## Honest order lifecycle

`OrderStatus` (see `src/types/index.ts`):

```
CREATED → SUBMITTED → ACKNOWLEDGED → PARTIALLY_FILLED → FILLED
                                                        → CANCELED
                                                        → REJECTED
                                                        → EXPIRED
                                                        → UNKNOWN
```

`status` only becomes `FILLED` when a real exchange fill (`provenance:
LIVE`, not yet implemented) or a documented simulated fill
(`provenance: PAPER`, implemented) has actually occurred — never on order
construction alone. This replaced an earlier version of the codebase that
wrote `FILLED` immediately upon computing an order, with a fabricated
order ID, regardless of whether anything had actually happened.
