/**
 * Live execution adapter — NOT YET IMPLEMENTED.
 *
 * This is Phase B of the BOT_01 project: real, signed Binance Spot API
 * order submission with authenticated requests, request signing,
 * recvWindow handling, real order-ID tracking, and reconciliation against
 * actual exchange responses.
 *
 * It is intentionally left unimplemented here rather than filled in with
 * placeholder logic that could be mistaken for real execution. Building
 * this requires: (1) explicit sign-off that Phase A has been reviewed and
 * paper-traded, and (2) real Binance API credentials with SPOT trading
 * permission (and withdrawal permission disabled) to test signing against
 * Binance's testnet or a live account with minimal capital.
 *
 * If you reach this file while TRADING_MODE=live, the application should
 * refuse to start rather than silently doing nothing or fabricating a fill
 * — see main.ts.
 */

export function assertLiveModeNotImplemented(): never {
  throw new Error(
    "TRADING_MODE=live is not yet implemented in this build. " +
      "Live order execution (request signing, real Binance order submission, " +
      "reconciliation) is Phase B of this project and has not been built yet. " +
      "Use TRADING_MODE=dry-run or TRADING_MODE=paper."
  );
}
