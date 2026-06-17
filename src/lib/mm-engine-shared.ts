// ─── Shared MM Constants & Functions ───────────────────────
// Used by both mm-engine and backtest to avoid circular imports

// ─── CLOB Tick Size ──────────────────────────────────────
export const TICK_SIZE = 0.01;
export function tickRound(price: number): number {
  return Math.round(price / TICK_SIZE) * TICK_SIZE;
}

// ─── Fee Constants ───────────────────────────────────────
export const DEFAULT_TAKER_FEE_RATE = 0.072;
export const DEFAULT_MAKER_FEE_RATE = 0;
export const MAKER_REBATE_PCT = 0.20;

export function calcTakerFee(shares: number, price: number, feeRate: number = DEFAULT_TAKER_FEE_RATE): number {
  return shares * feeRate * price * (1 - price);
}

export function calcMakerRebate(shares: number, price: number, feeRate: number = DEFAULT_TAKER_FEE_RATE): number {
  return shares * feeRate * price * (1 - price) * MAKER_REBATE_PCT;
}

// ─── Sigmoid ─────────────────────────────────────────────
export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
