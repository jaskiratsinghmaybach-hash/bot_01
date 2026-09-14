/**
 * Binance signed-request helpers: HMAC-SHA256 signing and query-string
 * construction. Pure functions — no network calls, no credentials read
 * from environment directly (the secret is passed in explicitly), so this
 * is fully unit-testable without hitting Binance or needing real
 * credentials in a test environment.
 */

import { createHmac } from "node:crypto";

/**
 * Builds the exact query string Binance expects: all params in
 * insertion order, URL-encoded, joined with '&'. This exact string
 * (before the signature is appended) is what gets HMAC-signed.
 */
export function buildQueryString(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

/** HMAC-SHA256 signs a query string with the Binance API secret, returning a lowercase hex digest. */
export function signQueryString(queryString: string, secret: string): string {
  return createHmac("sha256", secret).update(queryString).digest("hex");
}

/**
 * Builds a fully signed query string for a Binance signed endpoint:
 * appends timestamp + recvWindow to the given params, signs the result,
 * and appends the signature. `timestamp` is accepted as a parameter
 * (rather than always using Date.now() internally) specifically so this
 * function is deterministic and testable.
 */
export function buildSignedQuery(
  params: Record<string, string | number>,
  secret: string,
  timestamp: number,
  recvWindowMs: number
): string {
  const base = buildQueryString({ ...params, recvWindow: recvWindowMs, timestamp });
  const signature = signQueryString(base, secret);
  return `${base}&signature=${signature}`;
}
