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

### `live` — NOT YET IMPLEMENTED

`src/execution/live-adapter.ts` exists only as a stub that throws a clear
error. `main.ts` refuses to boot at all if `TRADING_MODE=live` is set,
rather than starting a process labeled "live" that can't actually place
live orders.

Building this out (Phase B of this project) requires, at minimum:

- HMAC-SHA256 request signing using `BINANCE_SECRET_KEY`
- Correct `timestamp` / `recvWindow` handling
- Real `POST /api/v3/order` submission and response parsing
- Mapping Binance's actual order states (`NEW`, `PARTIALLY_FILLED`,
  `FILLED`, `CANCELED`, `REJECTED`, `EXPIRED`) onto this project's
  `OrderStatus` type
- Reconciliation logic (querying order status by ID to resolve `UNKNOWN`
  states after a network error or ambiguous response)
- Testing against Binance's testnet before any mainnet use

None of this has been built. Do not represent this project as
live-trading-capable until Phase B is complete and has itself been
tested — ideally against Binance's testnet with a paper API key first,
then live with minimal capital.

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
