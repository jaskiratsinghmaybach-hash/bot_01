import { executeMarketOrder } from "./exchange.js";
import { evaluateMarketStrategy } from "../strategies/core-logic.js";
import WebSocket from "ws";
import { Candle } from "../types/index.js";
import environment from "../config/environment.js";

// This is your live RAM storage. High-speed array holding your math inputs.
export const marketCandles: Candle[] = [];
const MAX_CANDLES_IN_RAM = 200; // Keep RAM light and fast

export function initializeMarketFeed() {
  // Connect straight to Binance raw aggregate trade or candlestick streams
  const wsUrl = `wss://stream.binance.com:9443/ws/${environment.SYMBOL.toLowerCase()}@kline_1m`;
  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    console.log(`[DATA] Live market feed connected to Binance for ${environment.SYMBOL}`);
  });

  ws.on("message", (data: string) => {
    const raw = JSON.parse(data);
    const kline = raw.k;

    if (!kline) return;

    // Is the 1-minute candle fully closed? (Pure true math data)
    if (kline.x) {
      const closedCandle: Candle = {
        openingTime: kline.t,
        open: parseFloat(kline.o),
        high: parseFloat(kline.h),
        low: parseFloat(kline.l),
        close: parseFloat(kline.c),
        volume: parseFloat(kline.v),
      };

      // Push to high-speed RAM array
      marketCandles.push(closedCandle);

      // Keep RAM capped so it never lags out
      if (marketCandles.length > MAX_CANDLES_IN_RAM) {
        marketCandles.shift();
      }

      console.log(`[DATA] New closed candle added to RAM. Total in memory: ${marketCandles.length}`);

      // Feed the live RAM array straight into your pure math filters
      const signal = evaluateMarketStrategy(marketCandles);

      if (signal.shouldEnter && signal.direction) {
        console.log(`[SIGNAL] CRITICAL GREEN TRIGGERED: ${signal.reason}. Routing to exchange engine...`);
        
        // Route direct parameters: Execute Side, Entry Price, $50 Risk Parameter, $2 Stop Loss Window
        executeMarketOrder(signal.direction, closedCandle.close, 50, 2.0).catch(err => {
          console.error('[ROUTE ERROR]', err.message);
        });
      } else {
        console.log(`[SIGNAL] System Scan: ${signal.reason}. Searching for new setups...`);
      }
    }
  });

  ws.on("error", (err: any) => {
    console.error("[DATA] Feed error:", err.message);
  });

  ws.on("close", () => {
    console.log("[DATA] Feed disconnected. Reconnecting in 5s...");
    setTimeout(initializeMarketFeed, 5000);
  });
}