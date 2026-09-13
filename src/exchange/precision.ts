/**
 * Quantity/price normalization against Binance's LOT_SIZE / PRICE_FILTER /
 * MIN_NOTIONAL rules.
 *
 * Floating point arithmetic on step sizes like 0.001 is unreliable
 * (0.1 + 0.2 !== 0.3 territory), so all rounding here is done in integer
 * "ticks" of the step/tick size rather than via naive division and
 * Math.floor on raw floats.
 */

import type { SymbolRules } from "./exchange-info.js";

/** Number of decimal places implied by a step/tick size like 0.001 -> 3. */
function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const str = step.toString();
  if (str.includes("e-")) {
    // Handle scientific notation like 1e-8
    const [, exp] = str.split("e-");
    return Number(exp);
  }
  const dot = str.indexOf(".");
  return dot === -1 ? 0 : str.length - dot - 1;
}

/**
 * Rounds `value` DOWN to the nearest multiple of `step`, using integer-tick
 * arithmetic to avoid floating point drift, and returns it fixed to the
 * step's own decimal precision.
 */
/**
 * Converts a finite number to a fixed-point integer string representation
 * (value * 10^decimals, truncated toward zero) without going through
 * floating point division/rounding for the final truncation step. This
 * avoids binary float artifacts like 1234.5599999999999 for 1.23456*1000.
 *
 * We use toFixed with extra guard decimals then string-slice, because
 * toFixed itself performs correct decimal rounding at a given precision
 * (it does NOT suffer from the 0.1+0.2 style binary drift once you fix the
 * number of decimal places), then we truncate any further fractional
 * remainder ourselves so the overall operation is a floor, not a round.
 */
function toIntegerTicks(value: number, decimals: number): number {
  // Render with a couple of extra decimal digits of precision so we can see
  // (and discard) genuine sub-tick remainder rather than have toFixed round
  // it away for us.
  const guardDecimals = Math.min(decimals + 8, 15);
  const fixed = value.toFixed(guardDecimals); // e.g. "1.234560000000"
  const [wholePart, fracPartRaw = ""] = fixed.split(".");
  const fracKept = fracPartRaw.slice(0, decimals); // truncate, don't round
  const fracRemainder = fracPartRaw.slice(decimals); // the guard digits we're discarding

  const sign = wholePart.startsWith("-") ? -1 : 1;
  const wholeDigits = wholePart.replace("-", "");
  let ticks = Number(wholeDigits + fracKept.padEnd(decimals, "0"));

  // If the remainder is all near-zero noise (e.g. "9999999" from float
  // representation of an exact value), toFixed already rounded it into
  // fracKept correctly via standard rounding at guardDecimals precision, so
  // no further adjustment is needed — toFixed's own rounding at
  // guardDecimals is precise enough that genuine sub-tick amounts (like
  // 0.0029999999999 truncated to 6dp -> "002999999") are preserved as real
  // remainder, not noise. We floor by simply truncating fracRemainder,
  // which we already did by slicing it off.
  void fracRemainder;

  return sign * ticks;
}

export function floorToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
    throw new Error(`floorToStep requires finite value/step, got value=${value} step=${step}`);
  }
  const decimals = decimalsOf(step);
  const scale = 10 ** decimals;

  const stepTicks = Math.round(step * scale);
  const valueTicks = toIntegerTicks(value, decimals);

  const steppedTicks = Math.floor(valueTicks / stepTicks) * stepTicks;
  const result = steppedTicks / scale;
  return Number(result.toFixed(decimals));
}

export interface NormalizedOrder {
  quantity: number;
  price: number;
  notional: number;
  /** True if normalization was possible without violating risk/exchange constraints. */
  valid: boolean;
  /** Present when valid is false. */
  rejectionReason?: string;
}

/**
 * Normalizes a raw, mathematically-derived quantity and price into values
 * Binance's LOT_SIZE / PRICE_FILTER / MIN_NOTIONAL filters will accept.
 *
 * Quantity is always floored (never rounded up) to stepSize so we never
 * request MORE size than the risk engine calculated — rounding up would
 * silently increase risk beyond what was intended. If flooring pushes the
 * quantity below minQty, or below the minimum notional, the order is
 * rejected rather than silently bumped up to meet the minimum (which would
 * again mean risking more than intended).
 */
export function normalizeOrder(
  rawQuantity: number,
  rawPrice: number,
  rules: SymbolRules
): NormalizedOrder {
  if (!Number.isFinite(rawQuantity) || rawQuantity <= 0) {
    return { quantity: 0, price: 0, notional: 0, valid: false, rejectionReason: `Invalid raw quantity: ${rawQuantity}` };
  }
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
    return { quantity: 0, price: 0, notional: 0, valid: false, rejectionReason: `Invalid raw price: ${rawPrice}` };
  }

  const price = floorToStep(rawPrice, rules.tickSize);
  if (price < rules.minPrice || price > rules.maxPrice) {
    return {
      quantity: 0,
      price,
      notional: 0,
      valid: false,
      rejectionReason: `Price ${price} outside allowed range [${rules.minPrice}, ${rules.maxPrice}]`,
    };
  }

  const quantity = floorToStep(rawQuantity, rules.stepSize);
  if (quantity < rules.minQty) {
    return {
      quantity,
      price,
      notional: 0,
      valid: false,
      rejectionReason: `Quantity ${quantity} below exchange minQty ${rules.minQty} after step normalization (raw was ${rawQuantity})`,
    };
  }
  if (quantity > rules.maxQty) {
    return {
      quantity,
      price,
      notional: 0,
      valid: false,
      rejectionReason: `Quantity ${quantity} exceeds exchange maxQty ${rules.maxQty}`,
    };
  }

  const notional = quantity * price;
  if (rules.minNotional !== null && notional < rules.minNotional) {
    return {
      quantity,
      price,
      notional,
      valid: false,
      rejectionReason: `Notional ${notional.toFixed(4)} below exchange minNotional ${rules.minNotional}`,
    };
  }

  return { quantity, price, notional, valid: true };
}
