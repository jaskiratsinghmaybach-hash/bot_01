export interface Candle {
  symbol: string;
  interval: '1m' | '1h';
  openingTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: 'binance';
  isClosed: boolean;
}

export interface OrderState {
  id: string;
  clientOrderId: string;
  price: number;
  quantity: number;
  side: 'BUY' | 'SELL';
  status: string;
}
