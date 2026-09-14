import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQueryString, signQueryString, buildSignedQuery } from "./binance-signing.js";

// This test vector is Binance's own official published example
// (developers.binance.com/docs — "Request Security"). The expected
// signature was independently cross-checked against OpenSSL directly
// during development, not just against this code's own output:
//
//   echo -n "<payload>" | openssl dgst -sha256 -hmac "<secretKey>"
//   -> c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71
//
// matching this test's expected value exactly.
const BINANCE_OFFICIAL_PAYLOAD =
  "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
const BINANCE_OFFICIAL_SECRET = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
const BINANCE_OFFICIAL_SIGNATURE = "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71";

test("signQueryString matches Binance's official published worked example exactly", () => {
  const signature = signQueryString(BINANCE_OFFICIAL_PAYLOAD, BINANCE_OFFICIAL_SECRET);
  assert.equal(signature, BINANCE_OFFICIAL_SIGNATURE);
});

test("buildQueryString reproduces Binance's official example payload from structured params", () => {
  const query = buildQueryString({
    symbol: "LTCBTC",
    side: "BUY",
    type: "LIMIT",
    timeInForce: "GTC",
    quantity: 1,
    price: 0.1,
    recvWindow: 5000,
    timestamp: 1499827319559,
  });
  assert.equal(query, BINANCE_OFFICIAL_PAYLOAD);
});

test("buildQueryString URL-encodes special characters in values", () => {
  const query = buildQueryString({ symbol: "BTC/USD", note: "a&b=c" });
  assert.equal(query, "symbol=BTC%2FUSD&note=a%26b%3Dc");
});

test("buildSignedQuery appends timestamp, recvWindow, and a correct signature", () => {
  const result = buildSignedQuery(
    { symbol: "LTCBTC", side: "BUY", type: "LIMIT", timeInForce: "GTC", quantity: 1, price: 0.1 },
    BINANCE_OFFICIAL_SECRET,
    1499827319559,
    5000
  );
  assert.equal(
    result,
    `${BINANCE_OFFICIAL_PAYLOAD}&signature=${BINANCE_OFFICIAL_SIGNATURE}`
  );
});

test("signQueryString is deterministic — same payload and secret always produce the same signature", () => {
  const a = signQueryString("foo=bar", "secret123");
  const b = signQueryString("foo=bar", "secret123");
  assert.equal(a, b);
});

test("signQueryString produces different signatures for different secrets (sanity check it's actually using the key)", () => {
  const a = signQueryString("foo=bar", "secret123");
  const b = signQueryString("foo=bar", "differentSecret");
  assert.notEqual(a, b);
});

test("signQueryString produces different signatures for different payloads (sanity check it's actually hashing content)", () => {
  const a = signQueryString("foo=bar", "secret123");
  const b = signQueryString("foo=baz", "secret123");
  assert.notEqual(a, b);
});
