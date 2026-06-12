export interface Candle {
  openingTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderState {
  id: string;
  clientOrderId: string;
  price: number;
  quantity: number;
  side: 'BUY' | 'SELL';
  status: string;
}