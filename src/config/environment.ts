import "dotenv/config";

/**
 * Validated, fail-fast environment configuration.
 *
 * Every value the trading engine depends on is read here, once, at process
 * startup. If something required is missing or malformed we exit immediately
 * with a clear message instead of silently limping along with an empty
 * string or a dangerous default (e.g. an empty API secret, or defaulting to
 * LIVE trading).
 */

export type TradingMode = "dry-run" | "paper" | "live";
export type RiskModel = "fixed-usd" | "percent-balance";

export interface Environment {
  /** Binance API key. Required only when TRADING_MODE=live. */
  BINANCE_API_KEY: string;
  /** Binance API secret. Required only when TRADING_MODE=live. NEVER logged. */
  BINANCE_SECRET_KEY: string;

  /** Single Postgres connection string. Standard pg env, works locally and on any host. */
  DATABASE_URL: string;

  /** Trading pair, e.g. SOLUSDC. Upper-cased on load. */
  SYMBOL: string;

  /**
   * dry-run  — strategy runs, no orders are ever built or persisted as anything but logs.
   * paper    — orders are simulated against real market prices with fees/slippage,
   *            persisted to order_history with clear PAPER provenance. No exchange call.
   * live     — real signed Binance orders. Requires BINANCE_API_KEY/SECRET_KEY.
   */
  TRADING_MODE: TradingMode;

  /** USD risked per trade. Used by the risk engine to size positions when RISK_MODEL=fixed-usd. */
  RISK_PER_TRADE_USD: number;

  /**
   * fixed-usd        — risk a fixed dollar amount per trade (RISK_PER_TRADE_USD),
   *                     regardless of account balance. Predictable, does not
   *                     compound or scale down as balance changes.
   * percent-balance  — risk a percentage of the LIVE account balance per trade
   *                     (RISK_PERCENT_OF_BALANCE). Only meaningful in TRADING_MODE=live,
   *                     since paper/dry-run have no real balance to read; percent-balance
   *                     under paper mode falls back to PAPER_STARTING_BALANCE_USD as the
   *                     balance basis (see docs/risk-management.md).
   */
  RISK_MODEL: RiskModel;

  /** Percent of account balance risked per trade (e.g. 0.02 = 2%). Used only when RISK_MODEL=percent-balance. */
  RISK_PERCENT_OF_BALANCE: number;

  /** Hard ceiling on notional position size in USD, independent of risk sizing. */
  MAX_POSITION_USD: number;

  /**
   * Fraction of available balance treated as the absolute affordability
   * ceiling, independent of risk-based sizing — a defensive clamp so a
   * position can never be sized to consume the entire balance even if
   * risk math alone would imply it (e.g. a very tight stop under
   * percent-balance sizing). Used only when RISK_MODEL=percent-balance.
   */
  MAX_BALANCE_FRACTION: number;

  /** Binance recvWindow in milliseconds for signed requests. Required only for TRADING_MODE=live. */
  RECV_WINDOW_MS: number;

  /**
   * Starting simulated USD balance for PAPER mode only. Irrelevant in dry-run/live.
   */
  PAPER_STARTING_BALANCE_USD: number;

  /** Simulated slippage applied to paper fills, as a fraction of price (e.g. 0.0005 = 5 bps). */
  PAPER_SLIPPAGE_FRACTION: number;

  /** Simulated taker fee applied to paper fills, as a fraction of notional (e.g. 0.001 = 10 bps). */
  PAPER_FEE_FRACTION: number;

  LOG_LEVEL: "debug" | "info" | "warn" | "error";
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function requireString(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value.trim().length === 0) {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalString(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

function requireNumber(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    if (fallback === undefined) {
      throw new ConfigError(`Missing required environment variable: ${name}`);
    }
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ConfigError(`Environment variable ${name} must be a finite number, got "${raw}"`);
  }
  return value;
}

function parseTradingMode(raw: string | undefined): TradingMode {
  const value = (raw ?? "dry-run").trim().toLowerCase();
  if (value === "dry-run" || value === "paper" || value === "live") {
    return value;
  }
  throw new ConfigError(
    `TRADING_MODE must be one of "dry-run", "paper", "live" — got "${raw}". ` +
      `Refusing to start with an unrecognized trading mode rather than guessing.`
  );
}

function parseRiskModel(raw: string | undefined): RiskModel {
  const value = (raw ?? "fixed-usd").trim().toLowerCase();
  if (value === "fixed-usd" || value === "percent-balance") {
    return value;
  }
  throw new ConfigError(
    `RISK_MODEL must be one of "fixed-usd", "percent-balance" — got "${raw}".`
  );
}

function parseLogLevel(raw: string | undefined): Environment["LOG_LEVEL"] {
  const value = (raw ?? "info").trim().toLowerCase();
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

function loadEnvironment(): Environment {
  const TRADING_MODE = parseTradingMode(process.env.TRADING_MODE);

  // DATABASE_URL is always required — this is the one supported way to configure
  // Postgres. (Older revisions of this project also read DB_HOST/DB_USER/etc
  // directly in the database layer; that path has been removed in favor of a
  // single DATABASE_URL to avoid the two silently drifting out of sync.)
  const DATABASE_URL = requireString("DATABASE_URL");

  const SYMBOL = optionalString("SYMBOL", "SOLUSDC").toUpperCase();

  // Binance credentials are only mandatory once the operator has explicitly
  // opted into live trading. Requiring them unconditionally would make it
  // impossible to run dry-run/paper mode (e.g. in CI) without real keys.
  let BINANCE_API_KEY = process.env.BINANCE_API_KEY ?? "";
  let BINANCE_SECRET_KEY = process.env.BINANCE_SECRET_KEY ?? "";
  if (TRADING_MODE === "live") {
    BINANCE_API_KEY = requireString("BINANCE_API_KEY");
    BINANCE_SECRET_KEY = requireString("BINANCE_SECRET_KEY");
  }

  const RISK_PER_TRADE_USD = requireNumber("RISK_PER_TRADE_USD", 25);
  const RISK_MODEL = parseRiskModel(process.env.RISK_MODEL);
  const RISK_PERCENT_OF_BALANCE = requireNumber("RISK_PERCENT_OF_BALANCE", 0.02);
  const MAX_POSITION_USD = requireNumber("MAX_POSITION_USD", 500);
  const MAX_BALANCE_FRACTION = requireNumber("MAX_BALANCE_FRACTION", 0.98);
  const RECV_WINDOW_MS = requireNumber("RECV_WINDOW_MS", 5000);
  const PAPER_STARTING_BALANCE_USD = requireNumber("PAPER_STARTING_BALANCE_USD", 1000);
  const PAPER_SLIPPAGE_FRACTION = requireNumber("PAPER_SLIPPAGE_FRACTION", 0.0005);
  const PAPER_FEE_FRACTION = requireNumber("PAPER_FEE_FRACTION", 0.001);

  if (RISK_PER_TRADE_USD <= 0) {
    throw new ConfigError(`RISK_PER_TRADE_USD must be > 0, got ${RISK_PER_TRADE_USD}`);
  }
  if (MAX_POSITION_USD <= 0) {
    throw new ConfigError(`MAX_POSITION_USD must be > 0, got ${MAX_POSITION_USD}`);
  }
  if (RISK_PER_TRADE_USD > MAX_POSITION_USD) {
    throw new ConfigError(
      `RISK_PER_TRADE_USD (${RISK_PER_TRADE_USD}) cannot exceed MAX_POSITION_USD (${MAX_POSITION_USD})`
    );
  }
  if (RISK_PERCENT_OF_BALANCE <= 0 || RISK_PERCENT_OF_BALANCE > 1) {
    throw new ConfigError(
      `RISK_PERCENT_OF_BALANCE must be between 0 (exclusive) and 1 (inclusive) as a fraction — e.g. 0.02 for 2%. Got ${RISK_PERCENT_OF_BALANCE}`
    );
  }
  if (MAX_BALANCE_FRACTION <= 0 || MAX_BALANCE_FRACTION > 1) {
    throw new ConfigError(
      `MAX_BALANCE_FRACTION must be between 0 (exclusive) and 1 (inclusive) — e.g. 0.98 for 98%. Got ${MAX_BALANCE_FRACTION}`
    );
  }
  if (RECV_WINDOW_MS <= 0) {
    throw new ConfigError(`RECV_WINDOW_MS must be > 0, got ${RECV_WINDOW_MS}`);
  }

  const LOG_LEVEL = parseLogLevel(process.env.LOG_LEVEL);

  return {
    BINANCE_API_KEY,
    BINANCE_SECRET_KEY,
    DATABASE_URL,
    SYMBOL,
    TRADING_MODE,
    RISK_PER_TRADE_USD,
    RISK_MODEL,
    RISK_PERCENT_OF_BALANCE,
    MAX_POSITION_USD,
    MAX_BALANCE_FRACTION,
    RECV_WINDOW_MS,
    PAPER_STARTING_BALANCE_USD,
    PAPER_SLIPPAGE_FRACTION,
    PAPER_FEE_FRACTION,
    LOG_LEVEL,
  };
}

let environment: Environment;
try {
  environment = loadEnvironment();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`[CONFIG FATAL] ${message}`);
  process.exit(1);
}

export default environment;
export { ConfigError };
