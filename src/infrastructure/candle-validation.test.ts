import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidClosedCandle } from "./candle-validation.js";
import type { Candle } from "../types/index.js";

function validCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    symbol: "SOLUSDC",
    interval: "1h",
    openingTime: 1_700_000_000_000,
    closeTime: 1_700_003_600_000,
    open: 150.1,
    high: 151.5,
    low: 149.8,
    close: 150.9,
    volume: 12345.6789,
    source: "binance",
    isClosed: true,
    ...overrides,
  };
}

test("isValidClosedCandle accepts a well-formed closed candle", () => {
  assert.equal(isValidClosedCandle(validCandle()), true);
});

test("isValidClosedCandle rejects an unfinished (isClosed=false) candle", () => {
  assert.equal(isValidClosedCandle(validCandle({ isClosed: false })), false);
});

test("isValidClosedCandle rejects impossible OHLC where high < low", () => {
  assert.equal(isValidClosedCandle(validCandle({ high: 100, low: 200 })), false);
});

test("isValidClosedCandle rejects impossible OHLC where high < open", () => {
  assert.equal(isValidClosedCandle(validCandle({ high: 100, open: 150 })), false);
});

test("isValidClosedCandle rejects impossible OHLC where high < close", () => {
  assert.equal(isValidClosedCandle(validCandle({ high: 100, close: 150 })), false);
});

test("isValidClosedCandle rejects impossible OHLC where low > open", () => {
  assert.equal(isValidClosedCandle(validCandle({ low: 200, open: 150 })), false);
});

test("isValidClosedCandle rejects impossible OHLC where low > close", () => {
  assert.equal(isValidClosedCandle(validCandle({ low: 200, close: 150 })), false);
});

test("isValidClosedCandle rejects negative prices/volume", () => {
  assert.equal(isValidClosedCandle(validCandle({ open: -1 })), false);
  assert.equal(isValidClosedCandle(validCandle({ volume: -1 })), false);
});

test("isValidClosedCandle rejects NaN/Infinity in any OHLCV field", () => {
  assert.equal(isValidClosedCandle(validCandle({ close: NaN })), false);
  assert.equal(isValidClosedCandle(validCandle({ high: Infinity })), false);
});

test("isValidClosedCandle rejects closeTime <= openingTime", () => {
  assert.equal(isValidClosedCandle(validCandle({ closeTime: 1_700_000_000_000 })), false);
  assert.equal(isValidClosedCandle(validCandle({ closeTime: 1_699_999_000_000 })), false);
});

test("isValidClosedCandle rejects non-integer timestamps", () => {
  assert.equal(isValidClosedCandle(validCandle({ openingTime: 1_700_000_000_000.5 })), false);
});

test("isValidClosedCandle rejects an empty symbol", () => {
  assert.equal(isValidClosedCandle(validCandle({ symbol: "" })), false);
});

test("isValidClosedCandle rejects a source other than 'binance'", () => {
  // @ts-expect-error intentionally testing an invalid source value
  assert.equal(isValidClosedCandle(validCandle({ source: "coinbase" })), false);
});

test("isValidClosedCandle accepts both supported intervals", () => {
  assert.equal(isValidClosedCandle(validCandle({ interval: "1m", closeTime: 1_700_000_060_000 })), true);
  assert.equal(isValidClosedCandle(validCandle({ interval: "1h" })), true);
});
