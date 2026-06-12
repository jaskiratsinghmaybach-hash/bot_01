interface Environment {
  BINANCE_API_KEY: string;
  BINANCE_SECRET_KEY: string;
  DATABASE_URL: string;
  SYMBOL: "SOLUSDC";
}

const environment: Environment = {
  BINANCE_API_KEY: process.env.BINANCE_API_KEY || "",
  BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY || "",
  DATABASE_URL: process.env.DATABASE_URL || "",
  SYMBOL: "SOLUSDC",
};

export default environment;