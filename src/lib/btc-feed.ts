// ─── Binance BTC Price Feed ──────────────────────────────────
// Fetches BTC/USDT price and klines from Binance REST API
// Calculates ATR, volatility, and trend metrics

interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface BtcPriceData {
  price: number;
  atr1m: number;
  atr5m: number;
  atr15m: number;
  volatilityPct: number;
  change1m: number;
  change5m: number;
  trend: "up" | "down" | "neutral";
  timestamp: number;
  klines: Kline[];
  lastUpdate: number;
  connected: boolean;
}

// ─── State ───────────────────────────────────────────────────
let ema5: number | null = null;
let lastFetch = 0;
const FETCH_INTERVAL = 3000; // fetch every 3 seconds
let cached: BtcPriceData | null = null;
let fetchPromise: Promise<BtcPriceData> | null = null;

const defaultData: BtcPriceData = {
  price: 0, atr1m: 0, atr5m: 0, atr15m: 0,
  volatilityPct: 0, change1m: 0, change5m: 0,
  trend: "neutral", timestamp: 0, klines: [],
  lastUpdate: 0, connected: false,
};

// ─── ATR ─────────────────────────────────────────────────────
function trueRange(klines: Kline[], i: number): number {
  if (i === 0) return klines[0].high - klines[0].low;
  const c = klines[i], p = klines[i - 1].close;
  return Math.max(c.high - c.low, Math.abs(c.high - p), Math.abs(c.low - p));
}

function atr(klines: Kline[], period: number): number {
  if (klines.length < 2) return 0;
  const len = Math.min(period, klines.length - 1);
  let sum = 0;
  for (let i = klines.length - len; i < klines.length; i++) sum += trueRange(klines, i);
  return sum / len;
}

// ─── EMA & Trend ─────────────────────────────────────────────
function updateEMA(price: number): void {
  if (ema5 === null) { ema5 = price; return; }
  ema5 = (price - ema5) * (2 / 6) + ema5;
}

function detectTrend(price: number): "up" | "down" | "neutral" {
  if (ema5 === null) return "neutral";
  if (price > ema5 * 1.0002) return "up";
  if (price < ema5 * 0.9998) return "down";
  return "neutral";
}

// ─── REST API ────────────────────────────────────────────────
async function fetchPrice(): Promise<number | null> {
  try {
    const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    return parseFloat((await r.json()).price);
  } catch { return null; }
}

async function fetchKlines(): Promise<Kline[] | null> {
  try {
    const r = await fetch("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=15", { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const data = await r.json();
    return data.map((k: (string | number)[]) => ({
      openTime: Number(k[0]), open: parseFloat(k[1] as string),
      high: parseFloat(k[2] as string), low: parseFloat(k[3] as string),
      close: parseFloat(k[4] as string), volume: parseFloat(k[5] as string),
      closeTime: Number(k[6]),
    }));
  } catch { return null; }
}

// ─── Main Fetch ──────────────────────────────────────────────
export async function getBtcPrice(): Promise<BtcPriceData> {
  const now = Date.now();

  // Return cached if fresh
  if (cached && now - lastFetch < FETCH_INTERVAL) return cached;

  // Deduplicate concurrent calls
  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    try {
      const [price, klines] = await Promise.all([fetchPrice(), fetchKlines()]);

      const data: BtcPriceData = { ...defaultData };

      if (price !== null) {
        data.price = price;
        data.timestamp = now;
        updateEMA(price);
        data.connected = true;
      } else if (cached) {
        data.price = cached.price;
        data.timestamp = cached.timestamp;
      }

      if (klines && klines.length > 0) {
        data.klines = klines;
        // Init EMA from klines
        if (ema5 === null) for (const k of klines) updateEMA(k.close);
      } else if (cached) {
        data.klines = cached.klines;
      }

      // Calculate metrics
      if (data.klines.length >= 2) {
        data.atr1m = atr(data.klines, 1);
        data.atr5m = atr(data.klines, 5);
        data.atr15m = atr(data.klines, 14);
        data.volatilityPct = data.price > 0 ? (data.atr15m / data.price) * Math.sqrt(525600) * 100 : 0;

        const len = data.klines.length;
        data.change1m = len >= 2 && data.klines[len - 2].close > 0
          ? ((data.klines[len - 1].close - data.klines[len - 2].close) / data.klines[len - 2].close) * 100 : 0;
        data.change5m = len >= 6 && data.klines[len - 6].close > 0
          ? ((data.klines[len - 1].close - data.klines[len - 6].close) / data.klines[len - 6].close) * 100 : 0;
      }

      data.trend = detectTrend(data.price);
      data.lastUpdate = now;

      cached = data;
      lastFetch = now;
      return data;
    } catch {
      return cached || defaultData;
    } finally {
      fetchPromise = null;
    }
  })();

  return fetchPromise;
}
