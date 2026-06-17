// ─── Market Maker Engine v3 ──────────────────────────────────
// Live + Paper trading engine for Polymarket BTC 15-min Up/Down
//
// v3 changes (live trading):
// 1. neg_risk flag in Market — parsed from Gamma API
// 2. neg_risk passed to CLOB client for correct EIP-712 signing
// 3. Environment variables for private key, funder address
// 4. Safety checks for live mode (min balance, max daily loss)
// 5. Real position sync from CLOB fills
// 6. Live settlement: CLOB handles resolution, we sync balance
// 7. Circuit breaker with real PnL tracking
//
// v2 fixes (preserved):
// 1. Cannot sell tokens you don't own (was phantom profit bug)
// 2. CLOB-compliant tick size (0.01 rounding on all prices)
// 3. Settlement model at expiry (UP→$1 if BTC>strike, else $0)
// 4. Strike price parsed from question and used in probability model
// 5. Honest PnL: MtM uses real mid, settlement uses real resolution
// 6. Daemon loop via setInterval (not API-triggered)

import { getBtcPrice, type BtcPriceData } from "./btc-feed";
import { getClobClient, initClobClient, destroyClobClient, type ClobClientConfig } from "./clob-client";
import {
  submitOrder as clobSubmit,
  cancelAllOrders as clobCancelAll,
  reconcile as clobReconcile,
  getRealBalance,
  replaceOrders,
  resetOrderManager,
  getOrderManagerStats,
  type ManagedOrder,
} from "./order-manager";

// ─── CLOB Tick Size ────────────────────────────────────────
const TICK_SIZE = 0.01;
function tickRound(price: number): number {
  return Math.round(price / TICK_SIZE) * TICK_SIZE;
}
function tickFloor(price: number): number {
  return Math.floor(price / TICK_SIZE) * TICK_SIZE;
}
function tickCeil(price: number): number {
  return Math.ceil(price / TICK_SIZE) * TICK_SIZE;
}

// ─── Fee Constants ─────────────────────────────────────────
const DEFAULT_TAKER_FEE_RATE = 0.072;
const DEFAULT_MAKER_FEE_RATE = 0;
const MAKER_REBATE_PCT = 0.20;
const MIN_MAKER_FILL_DELAY_MS = 2000;

// ─── Live Mode Safety ─────────────────────────────────────
const LIVE_MIN_BALANCE = 10;        // Don't trade if balance < $10
const LIVE_MAX_DAILY_LOSS_PCT = 0.15; // Circuit breaker at 15% daily loss
const LIVE_MAX_POSITION_PCT = 0.30;   // Max 30% of balance in single position

// ─── Types ─────────────────────────────────────────────────
export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface Market {
  id: string;
  question: string;
  slug: string;
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  expiresAt: number;
  strikePrice: number;
  negRisk: boolean;             // true for BTC 15-min markets — changes EIP-712 domain
  // Real prices from Polymarket CLOB
  realUpMid: number;
  realUpBestBid: number;
  realUpBestAsk: number;
  realDownMid: number;
  realDownBestBid: number;
  realDownBestAsk: number;
  realSpreadUp: number;
  realSpreadDown: number;
  // Full order book
  upBids: OrderBookLevel[];
  upAsks: OrderBookLevel[];
  downBids: OrderBookLevel[];
  downAsks: OrderBookLevel[];
  // Metadata
  volume: number;
  liquidity: number;
  feeRate: number;
  makerFeeRate: number;
  isReal: boolean;
  active: boolean;
  // Our model
  lastUpPrice: number;
  lastDownPrice: number;
}

export interface Position {
  id: string;
  marketId: string;
  side: "UP" | "DOWN";
  entryPrice: number;
  quantity: number;
  costBasis: number;
  currentValue: number;
  unrealizedPnl: number;
  openedAt: number;
  marketQuestion: string;
  isRealPosition: boolean;  // true = from CLOB fill, false = paper
}

export interface Trade {
  id: string;
  marketId: string;
  side: string;
  price: number;
  quantity: number;
  totalCost: number;
  fee: number;
  slippage: number;
  reason: string;
  executedAt: number;
  isPaperTrade: boolean;
}

export interface Quote {
  id: string;
  marketId: string;
  side: "BID_UP" | "ASK_UP" | "BID_DOWN" | "ASK_DOWN";
  price: number;
  quantity: number;
  status: "active" | "filled" | "cancelled" | "rejected";
  createdAt: number;
  marketQuestion: string;
  rejectReason?: string;
}

export interface PnLSnapshot {
  timestamp: number;
  totalPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  portfolioValue: number;
  cashBalance: number;
  positionCount: number;
  activeMarkets: number;
}

export interface BotConfig {
  startingBalance: number;
  maxPositionSize: number;
  minPositionSize: number;
  baseSpread: number;
  atrMultiplier: number;
  autoExitMinutes: number;
  circuitBreakerPct: number;
  maxInventory: number;
  quoteSize: number;
  inventorySkewFactor: number;
  cycleIntervalMs: number;
  // Live trading config
  liveMode: boolean;
  clobPrivateKey?: string;    // Hex private key for signing (or from env)
  clobFunderAddress?: string; // Deposit wallet address (for POLY_1271)
}

export interface BotStatus {
  running: boolean;
  balance: number;
  cashBalance: number;
  startingBalance: number;
  positionCount: number;
  activeMarkets: number;
  totalPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  circuitBreaker: boolean;
  uptime: number;
  btcPrice: number;
  btcTrend: string;
  quoteCount: number;
  tradeCount: number;
  isPaperTrade: boolean;
  lastCycleAt: number;
  // Live mode status
  liveMode: boolean;
  clobConnected: boolean;
  clobAddress: string;
  clobError: string;
  openClobOrders: number;
  totalClobSubmitted: number;
  totalClobFilled: number;
  totalClobRejected: number;
  realBalance: number;
  dailyPnl: number;
  dailyStartBalance: number;
}

// ─── Global State ──────────────────────────────────────────
const g = globalThis as unknown as {
  __mm_running?: boolean;
  __mm_cash?: number;
  __mm_realizedPnl?: number;
  __mm_startTime?: number;
  __mm_circuitBreaker?: boolean;
  __mm_tradeCycleCount?: number;
  __mm_markets?: Map<string, Market>;
  __mm_positions?: Map<string, Position>;
  __mm_trades?: Trade[];
  __mm_quotes?: Map<string, Quote>;
  __mm_pnlHistory?: PnLSnapshot[];
  __mm_inventory?: Map<string, number>;
  __mm_lastScanTime?: number;
  __mm_lastPnLSnapshotTime?: number;
  __mm_knownSlugs?: Set<string>;
  __mm_daemonTimer?: ReturnType<typeof setInterval>;
  __mm_lastCycleAt?: number;
  __mm_dailyStartBalance?: number;
  __mm_dailyResetDate?: string;
};

// ─── State ─────────────────────────────────────────────────
const config: BotConfig = {
  startingBalance: 1000,
  maxPositionSize: 30,
  minPositionSize: 5,
  baseSpread: 0.03,
  atrMultiplier: 10,
  autoExitMinutes: 3,
  circuitBreakerPct: 0.25,
  maxInventory: 50,
  quoteSize: 10,
  inventorySkewFactor: 0.005,
  cycleIntervalMs: 10000,
  liveMode: false,
};

let cashBalance = g.__mm_cash ?? 1000;
let realizedPnl = g.__mm_realizedPnl ?? 0;
let running = g.__mm_running ?? false;
let startTime = g.__mm_startTime ?? 0;
let circuitBreaker = g.__mm_circuitBreaker ?? false;
let tradeCycleCount = g.__mm_tradeCycleCount ?? 0;
let lastCycleAt = g.__mm_lastCycleAt ?? 0;

// Daily PnL tracking for live safety
let dailyStartBalance = g.__mm_dailyStartBalance ?? 0;
let dailyResetDate = g.__mm_dailyResetDate ?? "";

const markets = g.__mm_markets ?? new Map<string, Market>();
const positions = g.__mm_positions ?? new Map<string, Position>();
const trades: Trade[] = g.__mm_trades ?? [];
const quotes = g.__mm_quotes ?? new Map<string, Quote>();
const pnlHistory: PnLSnapshot[] = g.__mm_pnlHistory ?? [];
const inventory = g.__mm_inventory ?? new Map<string, number>();

let lastScanTime = g.__mm_lastScanTime ?? 0;
let lastPnLSnapshotTime = g.__mm_lastPnLSnapshotTime ?? 0;
const knownSlugs = g.__mm_knownSlugs ?? new Set<string>();

// Last known real balance from CLOB
let lastRealBalance = 0;

function persistState() {
  g.__mm_running = running;
  g.__mm_cash = cashBalance;
  g.__mm_realizedPnl = realizedPnl;
  g.__mm_startTime = startTime;
  g.__mm_circuitBreaker = circuitBreaker;
  g.__mm_tradeCycleCount = tradeCycleCount;
  g.__mm_markets = markets;
  g.__mm_positions = positions;
  g.__mm_trades = trades;
  g.__mm_quotes = quotes;
  g.__mm_pnlHistory = pnlHistory;
  g.__mm_inventory = inventory;
  g.__mm_lastScanTime = lastScanTime;
  g.__mm_lastPnLSnapshotTime = lastPnLSnapshotTime;
  g.__mm_knownSlugs = knownSlugs;
  g.__mm_lastCycleAt = lastCycleAt;
  g.__mm_dailyStartBalance = dailyStartBalance;
  g.__mm_dailyResetDate = dailyResetDate;
}

// ─── Helpers ───────────────────────────────────────────────
function uid(): string {
  return Math.random().toString(36).substring(2, 8) + Date.now().toString(36);
}
function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
function sigmoid(x: number) {
  return 1 / (1 + Math.exp(-x));
}

// ─── Daily PnL Reset ──────────────────────────────────────
function checkDailyReset(): void {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (dailyResetDate !== today) {
    dailyResetDate = today;
    dailyStartBalance = cashBalance;
  }
}

// ─── Strike Price Parser ──────────────────────────────────
function parseStrikePrice(question: string): number {
  const match = question.match(/\$([\d,]+)/);
  if (match) {
    return parseFloat(match[1].replace(/,/g, ""));
  }
  return 0;
}

// ─── Fee Calculation ──────────────────────────────────────
function calcTakerFee(shares: number, price: number, feeRate: number = DEFAULT_TAKER_FEE_RATE): number {
  return shares * feeRate * price * (1 - price);
}

function calcMakerRebate(shares: number, price: number, feeRate: number = DEFAULT_TAKER_FEE_RATE): number {
  return shares * feeRate * price * (1 - price) * MAKER_REBATE_PCT;
}

// ─── 15-Minute Slot ───────────────────────────────────────
function getCurrentSlotTimestamp(): number {
  const now = Math.floor(Date.now() / 1000);
  const interval = 15 * 60;
  return Math.floor(now / interval) * interval;
}

function generateSlug(slotTs: number): string {
  // Try both known slug patterns for BTC 15M markets
  // Active markets use "btc-updown-15m-{ts}"
  // Some closed/historical markets use "btc-up-or-down-15m-{ts}"
  return `btc-updown-15m-${slotTs}`;
}

const SLUG_PATTERNS = [
  (ts: number) => `btc-updown-15m-${ts}`,
  (ts: number) => `btc-up-or-down-15m-${ts}`,
];

// ─── Order Book Fetcher ───────────────────────────────────
async function fetchOrderBook(tokenId: string): Promise<{
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  bestBid: number;
  bestAsk: number;
  mid: number;
  spread: number;
} | null> {
  try {
    const [bookRes, midRes] = await Promise.all([
      fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`, {
        signal: AbortSignal.timeout(5000),
      }),
      fetch(`https://clob.polymarket.com/midpoint?token_id=${tokenId}`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => null),
    ]);

    if (!bookRes?.ok) return null;

    const data = await bookRes.json();
    const rawBids = data.bids ?? [];
    const rawAsks = data.asks ?? [];

    const bids: OrderBookLevel[] = rawBids
      .map((b: { price: string; size: string }) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
      .filter((b: OrderBookLevel) => b.price > 0 && b.size > 0)
      .sort((a: OrderBookLevel, b: OrderBookLevel) => b.price - a.price);

    const asks: OrderBookLevel[] = rawAsks
      .map((a: { price: string; size: string }) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
      .filter((a: OrderBookLevel) => a.price > 0 && a.size > 0)
      .sort((a: OrderBookLevel, b: OrderBookLevel) => a.price - b.price);

    const bestBid = bids.length > 0 ? tickFloor(bids[0].price) : 0;
    const bestAsk = asks.length > 0 ? tickCeil(asks[0].price) : 0;

    let mid = 0;
    if (midRes?.ok) {
      try {
        const midData = await midRes.json();
        if (midData.mid && parseFloat(midData.mid) > 0) {
          mid = tickRound(parseFloat(midData.mid));
        }
      } catch { /* fallback */ }
    }
    if (mid <= 0) {
      mid = bestBid > 0 && bestAsk > 0 ? tickRound((bestBid + bestAsk) / 2) : bestBid || bestAsk || 0.5;
    }

    const spread = tickRound(bestAsk - bestBid);

    return { bids, asks, bestBid, bestAsk, mid, spread };
  } catch {
    return null;
  }
}

// ─── Market Discovery ─────────────────────────────────────
async function fetchMarketBySlug(slug: string): Promise<Market | null> {
  try {
    const res = await fetch(
      `https://gamma-api.polymarket.com/markets/slug/${slug}`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.active || data.closed) return null;

    let tokenIds: string[] = [];
    const raw = data.clobTokenIds;
    if (typeof raw === "string") {
      try { tokenIds = JSON.parse(raw); } catch { tokenIds = []; }
    } else if (Array.isArray(raw)) {
      tokenIds = raw;
    }
    if (tokenIds.length < 2) return null;

    let expiresAt = Date.now() + 15 * 60 * 1000;
    if (data.endDate) expiresAt = new Date(data.endDate).getTime();

    const [upBook, downBook] = await Promise.all([
      fetchOrderBook(tokenIds[0]),
      fetchOrderBook(tokenIds[1]),
    ]);

    let takerFeeRate = DEFAULT_TAKER_FEE_RATE;
    let makerFeeRate = DEFAULT_MAKER_FEE_RATE;
    try {
      const takerBaseBPS = parseInt(data.takerBaseFee || "0", 10);
      const makerBaseBPS = parseInt(data.makerBaseFee || "0", 10);
      if (takerBaseBPS > 0) takerFeeRate = takerBaseBPS / 14000;
      if (makerBaseBPS > 0) makerFeeRate = makerBaseBPS / 10000;
    } catch { /* defaults */ }

    const question = data.question || slug;
    const strike = parseStrikePrice(question);

    // ── Parse neg_risk flag ──
    // Determines which exchange contract we sign orders with:
    //   neg_risk=true  → NEG_RISK_EXCHANGE_V2
    //   neg_risk=false → CTF_EXCHANGE_V2
    // NOTE: Current BTC 15-min "Up or Down" markets have neg_risk=undefined/empty
    //   This means they use CTF_EXCHANGE_V2, NOT NEG_RISK
    const negRisk = data.neg_risk === true || data.neg_risk === "true" || data.negRisk === true;

    const upMid = upBook?.mid ?? 0.5;
    const downMid = downBook?.mid ?? 0.5;

    return {
      id: data.id || slug,
      question, slug,
      conditionId: data.conditionId || "",
      upTokenId: tokenIds[0],
      downTokenId: tokenIds[1],
      expiresAt,
      strikePrice: strike,
      negRisk,
      realUpMid: upMid,
      realUpBestBid: upBook?.bestBid ?? 0,
      realUpBestAsk: upBook?.bestAsk ?? 0,
      realDownMid: downMid,
      realDownBestBid: downBook?.bestBid ?? 0,
      realDownBestAsk: downBook?.bestAsk ?? 0,
      realSpreadUp: upBook?.spread ?? 0,
      realSpreadDown: downBook?.spread ?? 0,
      upBids: upBook?.bids ?? [],
      upAsks: upBook?.asks ?? [],
      downBids: downBook?.bids ?? [],
      downAsks: downBook?.asks ?? [],
      volume: parseFloat(data.volume24hr || data.volume || "0"),
      liquidity: parseFloat(data.liquidity || "0"),
      feeRate: takerFeeRate,
      makerFeeRate,
      isReal: true,
      active: data.active && !data.closed,
      lastUpPrice: upMid,
      lastDownPrice: downMid,
    };
  } catch {
    return null;
  }
}

async function scanMarkets(_btc: BtcPriceData): Promise<void> {
  const now = Date.now();
  if (now - lastScanTime < 30000) return;
  lastScanTime = now;

  const discovered: Market[] = [];

  const currentSlot = getCurrentSlotTimestamp();
  const slotsToCheck = [
    currentSlot,
    currentSlot + 15 * 60,
  ];

  for (const slotTs of slotsToCheck) {
    // Try both slug patterns for each slot
    let foundMarket = false;
    for (const slugFn of SLUG_PATTERNS) {
      const slug = slugFn(slotTs);

      const existing = Array.from(markets.values()).find(m => m.slug === slug);
      if (existing && existing.active && existing.expiresAt > now + 60000) {
        try {
          const [upBook, downBook] = await Promise.all([
            fetchOrderBook(existing.upTokenId).catch(() => null),
            fetchOrderBook(existing.downTokenId).catch(() => null),
          ]);

          if (upBook) {
            existing.realUpMid = upBook.mid;
            existing.realUpBestBid = upBook.bestBid;
            existing.realUpBestAsk = upBook.bestAsk;
            existing.realSpreadUp = upBook.spread;
            existing.upBids = upBook.bids;
            existing.upAsks = upBook.asks;
            existing.lastUpPrice = upBook.mid;
          }
          if (downBook) {
            existing.realDownMid = downBook.mid;
            existing.realDownBestBid = downBook.bestBid;
            existing.realDownBestAsk = downBook.bestAsk;
            existing.realSpreadDown = downBook.spread;
            existing.downBids = downBook.bids;
            existing.downAsks = downBook.asks;
            existing.lastDownPrice = downBook.mid;
          }

          discovered.push(existing);
          foundMarket = true;
          break; // Found with this pattern, skip others
        } catch {
          discovered.push(existing);
          foundMarket = true;
          break;
        }
      }

      try {
        const market = await fetchMarketBySlug(slug);
        if (market) {
          discovered.push(market);
          knownSlugs.add(slug);
          foundMarket = true;
          break; // Found with this pattern, skip others
        }
      } catch { /* skip */ }
    } // end slug pattern loop
  }

  // Refresh existing active markets not in current slots
  for (const [id, existing] of markets) {
    if (existing.expiresAt > now && existing.active && !discovered.find(d => d.slug === existing.slug)) {
      try {
        const fresh = await fetchMarketBySlug(existing.slug);
        if (fresh) discovered.push(fresh);
        else discovered.push(existing);
      } catch {
        discovered.push(existing);
      }
    }
  }

  for (const m of discovered) markets.set(m.id, m);

  // Cleanup expired + settle
  const cutoff = now - 30 * 60 * 1000;
  for (const [id, m] of markets) {
    if (m.expiresAt < cutoff) {
      markets.delete(id);
      settleMarket(id, m);
    }
  }

  persistState();
}

// ─── Settlement ───────────────────────────────────────────
function settleMarket(marketId: string, market: Market): void {
  const btc = cachedBtcPrice;
  if (btc <= 0) {
    closePositionsForMarket(marketId, "expiry_no_price");
    return;
  }

  const upWins = btc > market.strikePrice;

  for (const [posId, pos] of positions) {
    if (pos.marketId !== marketId) continue;

    const resolvedPrice = (pos.side === "UP" && upWins) || (pos.side === "DOWN" && !upWins) ? 1.0 : 0.0;
    const settleValue = pos.quantity * resolvedPrice;

    // In live mode, CLOB handles settlement — we just update our bookkeeping
    const fee = 0; // No fee on redemption in Polymarket

    cashBalance += settleValue - fee;
    realizedPnl += (settleValue - fee) - pos.costBasis;

    trades.push({
      id: uid(), marketId, side: `SETTLE_${pos.side}`,
      price: resolvedPrice, quantity: pos.quantity,
      totalCost: settleValue, fee,
      slippage: 0, reason: upWins ? "settle_up_wins" : "settle_down_wins",
      executedAt: Date.now(), isPaperTrade: !config.liveMode,
    });

    positions.delete(posId);
  }

  inventory.delete(marketId);

  for (const [, q] of quotes) {
    if (q.marketId === marketId && q.status === "active") q.status = "cancelled";
  }

  // In live mode, cancel any remaining CLOB orders for this market
  if (config.liveMode && market.conditionId) {
    const client = getClobClient();
    if (client?.connected) {
      client.cancelMarketOrders(market.conditionId).catch(err =>
        console.error("[MM] Failed to cancel market orders on settlement:", err)
      );
    }
  }
}

// Cached BTC price for settlement
let cachedBtcPrice = 0;

// ─── Probability Model ────────────────────────────────────
function calcUpProbability(market: Market, btc: BtcPriceData): number {
  const { price, atr5m, change1m, change5m, trend } = btc;
  if (price <= 0) return 0.5;

  const strike = market.strikePrice;

  if (strike > 0) {
    const tau = (market.expiresAt - Date.now()) / 60000;
    if (tau <= 0) return price > strike ? 0.99 : 0.01;

    const distPct = (price - strike) / price;
    const atrPct = atr5m > 0 ? (atr5m / price) : 0.001;
    const expectedMove = atrPct * Math.sqrt(tau / 5);
    const zScore = expectedMove > 0 ? distPct / expectedMove : (distPct > 0 ? 5 : -5);

    let pUp = sigmoid(zScore * 3);

    const momentumSignal = (change1m * 2 + change5m) / 3;
    const trendBias = trend === "up" ? 0.02 : trend === "down" ? -0.02 : 0;
    pUp = clamp(pUp + (momentumSignal + trendBias) * 0.1, 0.01, 0.99);

    if (tau < 3) {
      pUp = price > strike
        ? Math.min(pUp + (1 - pUp) * 0.5, 0.99)
        : Math.max(pUp - pUp * 0.5, 0.01);
    }

    return clamp(pUp, 0.01, 0.99);
  }

  // Fallback: pure momentum model
  const tau = (market.expiresAt - Date.now()) / 60000;
  if (tau <= 0) return trend === "up" ? 0.99 : trend === "down" ? 0.01 : 0.5;

  const momentumSignal = (change1m * 2 + change5m) / 3;
  const trendBias = trend === "up" ? 0.02 : trend === "down" ? -0.02 : 0;
  const atrPct = (atr5m / price) * 100;
  const volatilityFactor = Math.max(atrPct * 10, 0.001);
  const raw = sigmoid((momentumSignal + trendBias) / volatilityFactor * 10);

  let adjusted = raw;
  if (tau < 3) {
    adjusted = raw > 0.5
      ? Math.min(raw + (1 - raw) * 0.5, 0.99)
      : Math.max(raw - raw * 0.5, 0.01);
  }

  return clamp(adjusted, 0.01, 0.99);
}

// ─── Spread ───────────────────────────────────────────────
function calcSpread(market: Market, inv: number, btc: BtcPriceData): number {
  const { atr5m, price } = btc;
  const tau = (market.expiresAt - Date.now()) / 60000;

  const atrFactor = (atr5m / price) * 100;
  const timeFactor = 1 + Math.max(0, (1 - tau / 15)) * 2;
  const inventoryFactor = 1 + Math.abs(inv) * 0.02;

  const realSpread = Math.max(market.realSpreadUp, market.realSpreadDown, 0.01);

  return tickRound(Math.max(
    Math.min(config.baseSpread * (1 + atrFactor * config.atrMultiplier) * timeFactor * inventoryFactor, 0.15),
    realSpread
  ));
}

// ─── Quotes (CLOB-compliant: tick-rounded prices) ─────────
function generateQuotes(btc: BtcPriceData): void {
  // Cancel old quotes
  for (const [, q] of quotes) {
    if (q.status === "active") q.status = "cancelled";
  }

  for (const [marketId, market] of markets) {
    const tau = (market.expiresAt - Date.now()) / 60000;
    if (tau < config.autoExitMinutes) continue;
    if (!market.active) continue;

    const inv = inventory.get(marketId) || 0;
    if (Math.abs(inv) > config.maxInventory) continue;

    const realPUp = market.realUpMid > 0 ? market.realUpMid : 0.5;
    const modelPUp = calcUpProbability(market, btc);

    const modelSignal = (modelPUp - 0.5) * 0.3;
    const pUp = clamp(tickRound(realPUp + modelSignal), TICK_SIZE, 1 - TICK_SIZE);

    const spread = calcSpread(market, inv, btc);
    const skew = tickRound(inv * config.inventorySkewFactor);

    // ASK requires owning tokens
    const upPosition = positions.get(`${marketId}_UP`);
    const downPosition = positions.get(`${marketId}_DOWN`);
    const upQtyOwned = upPosition?.quantity ?? 0;
    const downQtyOwned = downPosition?.quantity ?? 0;

    const bidUp = tickFloor(clamp(pUp - spread / 2 - skew, TICK_SIZE, 1 - TICK_SIZE));
    const askUp = tickCeil(clamp(pUp + spread / 2 - skew, bidUp + TICK_SIZE, 1 - TICK_SIZE));
    const bidDown = tickFloor(clamp((1 - pUp) - spread / 2 + skew, TICK_SIZE, 1 - TICK_SIZE));
    const askDown = tickCeil(clamp((1 - pUp) + spread / 2 + skew, bidDown + TICK_SIZE, 1 - TICK_SIZE));

    const qty = Math.max(1, Math.round(config.quoteSize / Math.max(pUp, TICK_SIZE)));
    const question = market.question.substring(0, 60);

    // ── Live mode safety: limit position size to % of balance ──
    const maxQty = config.liveMode
      ? Math.min(qty, Math.floor((cashBalance * LIVE_MAX_POSITION_PCT) / Math.max(pUp, TICK_SIZE)))
      : qty;

    const finalQty = Math.max(1, maxQty);

    if (askUp > bidUp && askUp - bidUp >= TICK_SIZE) {
      const id1 = uid();
      quotes.set(id1, { id: id1, marketId, side: "BID_UP", price: bidUp, quantity: finalQty, status: "active", createdAt: Date.now(), marketQuestion: question });

      if (upQtyOwned >= finalQty) {
        const id2 = uid();
        quotes.set(id2, { id: id2, marketId, side: "ASK_UP", price: askUp, quantity: finalQty, status: "active", createdAt: Date.now(), marketQuestion: question });
      }
    }

    if (askDown > bidDown && askDown - bidDown >= TICK_SIZE) {
      const id3 = uid();
      quotes.set(id3, { id: id3, marketId, side: "BID_DOWN", price: bidDown, quantity: finalQty, status: "active", createdAt: Date.now(), marketQuestion: question });

      if (downQtyOwned >= finalQty) {
        const id4 = uid();
        quotes.set(id4, { id: id4, marketId, side: "ASK_DOWN", price: askDown, quantity: finalQty, status: "active", createdAt: Date.now(), marketQuestion: question });
      }
    }

    market.lastUpPrice = pUp;
    market.lastDownPrice = tickRound(1 - pUp);
  }
}

// ─── Fill Simulation (Paper mode) ─────────────────────────
function simulateFills(_btc: BtcPriceData): void {
  const now = Date.now();

  for (const [, quote] of quotes) {
    if (quote.status !== "active") continue;
    const market = markets.get(quote.marketId);
    if (!market) continue;

    const tau = (market.expiresAt - Date.now()) / 60000;
    if (tau < config.autoExitMinutes) continue;

    if (now - quote.createdAt < MIN_MAKER_FILL_DELAY_MS) continue;

    // ASK ownership re-check
    if (quote.side === "ASK_UP" || quote.side === "ASK_DOWN") {
      const posSide = quote.side.includes("UP") ? "UP" : "DOWN";
      const pos = positions.get(`${quote.marketId}_${posSide}`);
      if (!pos || pos.quantity < quote.quantity) {
        quote.status = "rejected";
        quote.rejectReason = "insufficient_holdings";
        continue;
      }
    }

    // Taker fill: crossing the book
    let wouldCross = false;
    let fillPrice = quote.price;
    let fillQty = 0;
    let isTaker = false;

    if (quote.side === "BID_UP") {
      let remaining = quote.quantity;
      let totalCost = 0;
      for (const ask of market.upAsks) {
        if (ask.price <= quote.price && ask.size > 0 && remaining > 0) {
          const take = Math.min(remaining, ask.size);
          totalCost += take * ask.price;
          fillQty += take;
          remaining -= take;
          wouldCross = true;
        }
      }
      if (wouldCross) {
        fillPrice = fillQty > 0 ? tickRound(totalCost / fillQty) : quote.price;
        isTaker = true;
      }
    } else if (quote.side === "ASK_UP") {
      let remaining = quote.quantity;
      let totalValue = 0;
      for (const bid of market.upBids) {
        if (bid.price >= quote.price && bid.size > 0 && remaining > 0) {
          const take = Math.min(remaining, bid.size);
          totalValue += take * bid.price;
          fillQty += take;
          remaining -= take;
          wouldCross = true;
        }
      }
      if (wouldCross) {
        fillPrice = fillQty > 0 ? tickRound(totalValue / fillQty) : quote.price;
        isTaker = true;
      }
    } else if (quote.side === "BID_DOWN") {
      let remaining = quote.quantity;
      let totalCost = 0;
      for (const ask of market.downAsks) {
        if (ask.price <= quote.price && ask.size > 0 && remaining > 0) {
          const take = Math.min(remaining, ask.size);
          totalCost += take * ask.price;
          fillQty += take;
          remaining -= take;
          wouldCross = true;
        }
      }
      if (wouldCross) {
        fillPrice = fillQty > 0 ? tickRound(totalCost / fillQty) : quote.price;
        isTaker = true;
      }
    } else if (quote.side === "ASK_DOWN") {
      let remaining = quote.quantity;
      let totalValue = 0;
      for (const bid of market.downBids) {
        if (bid.price >= quote.price && bid.size > 0 && remaining > 0) {
          const take = Math.min(remaining, bid.size);
          totalValue += take * bid.price;
          fillQty += take;
          remaining -= take;
          wouldCross = true;
        }
      }
      if (wouldCross) {
        fillPrice = fillQty > 0 ? tickRound(totalValue / fillQty) : quote.price;
        isTaker = true;
      }
    }

    if (wouldCross && fillQty > 0) {
      const rejectionHash = (tradeCycleCount * 7 + Math.floor(fillPrice * 100) + Math.floor(market.volume)) % 20;
      if (rejectionHash === 0) {
        quote.status = "rejected";
        quote.rejectReason = "clob_rejection_simulated";
        continue;
      }

      executeFill(quote, market, fillPrice, fillQty, isTaker);
      continue;
    }

    // Maker fill: probability-based
    const mid = quote.side.includes("UP") ? market.realUpMid : market.realDownMid;
    if (mid <= 0) continue;

    const ourPrice = quote.price;
    const distFromMid = Math.abs(ourPrice - mid);
    const distFactor = Math.max(0, 1 - distFromMid / 0.10);

    let ourSideDepth = 0;
    let oppositeDepth = 0;
    if (quote.side === "BID_UP" || quote.side === "ASK_DOWN") {
      const bids = quote.side.includes("UP") ? market.upBids : market.downBids;
      const asks = quote.side.includes("UP") ? market.upAsks : market.downAsks;
      for (const b of bids) { if (Math.abs(b.price - mid) <= 0.10) ourSideDepth += b.size; }
      for (const a of asks) { if (Math.abs(a.price - mid) <= 0.10) oppositeDepth += a.size; }
    } else {
      const asks = quote.side.includes("UP") ? market.upAsks : market.downAsks;
      const bids = quote.side.includes("UP") ? market.upBids : market.downBids;
      for (const a of asks) { if (Math.abs(a.price - mid) <= 0.10) ourSideDepth += a.size; }
      for (const b of bids) { if (Math.abs(b.price - mid) <= 0.10) oppositeDepth += b.size; }
    }
    const totalDepth = ourSideDepth + oppositeDepth;
    const imbalanceFactor = totalDepth > 0 ? (oppositeDepth / totalDepth) : 0.5;

    const volLiqRatio = market.liquidity > 0 ? Math.min(market.volume / market.liquidity, 1) : 0.1;
    const activityFactor = 0.3 + 0.7 * volLiqRatio;

    const timeFactor = tau < 5 ? 1.5 : tau < 10 ? 1.0 : 0.7;

    const inv = inventory.get(quote.marketId) || 0;
    const invFactor = Math.abs(inv) > config.maxInventory * 0.7 ? 0.3 : 1.0;

    const queueAge = (now - quote.createdAt) / 1000;
    const queueFactor = Math.min(queueAge / 30, 1.0);

    const baseRate = 0.015;
    const makerFillProb = baseRate * distFactor * imbalanceFactor * activityFactor * timeFactor * invFactor * queueFactor;

    const cycleHash = (tradeCycleCount * 7 + quote.createdAt % 13 + Math.floor(market.volume)) % 100;
    const threshold = Math.floor(makerFillProb * 100);

    if (cycleHash < threshold) {
      const makerRejHash = (tradeCycleCount * 11 + Math.floor(ourPrice * 1000)) % 33;
      if (makerRejHash === 0) {
        quote.status = "rejected";
        quote.rejectReason = "maker_queue_timeout";
        continue;
      }

      executeFill(quote, market, ourPrice, quote.quantity, false);
    }
  }
}

// ─── Execute Fill (Paper mode: honest, checks ownership) ──
function executeFill(quote: Quote, market: Market, fillPrice: number, fillQty: number, isTaker: boolean): void {
  fillPrice = tickRound(fillPrice);
  fillQty = Math.min(fillQty, Math.floor(config.maxPositionSize / Math.max(fillPrice, TICK_SIZE)));
  if (fillQty <= 0) return;

  const totalCost = fillPrice * fillQty;
  const feeRate = market.feeRate || DEFAULT_TAKER_FEE_RATE;
  const fee = isTaker ? calcTakerFee(fillQty, fillPrice, feeRate) : 0;
  const rebate = !isTaker ? calcMakerRebate(fillQty, fillPrice, feeRate) : 0;

  const side = quote.side;

  if (side.startsWith("BID")) {
    const totalWithFee = totalCost + fee;
    if (cashBalance < totalWithFee) {
      quote.status = "rejected";
      quote.rejectReason = "insufficient_cash";
      return;
    }
    cashBalance -= totalWithFee;
  } else {
    const posSide = side.includes("UP") ? "UP" : "DOWN";
    const posId = `${quote.marketId}_${posSide}`;
    const pos = positions.get(posId);

    if (!pos || pos.quantity < fillQty) {
      quote.status = "rejected";
      quote.rejectReason = `insufficient_holdings: need ${fillQty} ${posSide}, have ${pos?.quantity ?? 0}`;
      return;
    }

    pos.quantity -= fillQty;
    pos.costBasis -= pos.entryPrice * fillQty;
    if (pos.quantity <= 0) {
      positions.delete(posId);
    } else {
      pos.entryPrice = pos.costBasis / pos.quantity;
    }

    cashBalance += totalCost - fee + rebate;
    realizedPnl += (totalCost - fee + rebate) - (fillQty * (pos?.entryPrice ?? fillPrice));
  }

  const inv = inventory.get(quote.marketId) || 0;
  if (side === "BID_UP") inventory.set(quote.marketId, inv + fillQty);
  else if (side === "ASK_UP") inventory.set(quote.marketId, inv - fillQty);
  else if (side === "BID_DOWN") inventory.set(quote.marketId, inv - fillQty);
  else if (side === "ASK_DOWN") inventory.set(quote.marketId, inv + fillQty);

  if (side.startsWith("BID")) {
    const posSide = side.includes("UP") ? "UP" : "DOWN";
    const posId = `${quote.marketId}_${posSide}`;
    const existing = positions.get(posId);
    if (existing) {
      existing.quantity += fillQty;
      existing.costBasis += totalCost + fee;
      existing.entryPrice = existing.costBasis / existing.quantity;
    } else {
      positions.set(posId, {
        id: posId, marketId: quote.marketId,
        side: posSide,
        entryPrice: fillPrice, quantity: fillQty,
        costBasis: totalCost + fee,
        currentValue: totalCost, unrealizedPnl: 0,
        openedAt: Date.now(),
        marketQuestion: market.question.substring(0, 60),
        isRealPosition: false,
      });
    }
  }

  quote.status = "filled";

  trades.push({
    id: uid(), marketId: quote.marketId, side,
    price: fillPrice, quantity: fillQty,
    totalCost, fee, slippage: Math.abs(fillPrice - quote.price),
    reason: isTaker ? "taker_fill" : "maker_fill",
    executedAt: Date.now(),
    isPaperTrade: true,
  });
}

// ─── Mark to Market ───────────────────────────────────────
function markToMarket(_btc: BtcPriceData): void {
  let totalUnrealized = 0;
  for (const [, pos] of positions) {
    const market = markets.get(pos.marketId);
    if (!market) continue;

    const realPrice = pos.side === "UP" ? market.realUpMid : market.realDownMid;
    const pToken = realPrice > 0 ? realPrice : 0;

    pos.currentValue = pos.quantity * pToken;
    pos.unrealizedPnl = pos.currentValue - pos.costBasis;
    totalUnrealized += pos.unrealizedPnl;
  }

  const totalPnl = (cashBalance - config.startingBalance) + totalUnrealized;
  if (-totalPnl / config.startingBalance > config.circuitBreakerPct) {
    circuitBreaker = true;
    console.error(`[MM] CIRCUIT BREAKER: totalPnl=${totalPnl.toFixed(2)}, threshold=${config.circuitBreakerPct}`);
  }

  // Live mode: daily loss check
  if (config.liveMode) {
    checkDailyReset();
    const dailyPnl = cashBalance - dailyStartBalance;
    if (dailyStartBalance > 0 && -dailyPnl / dailyStartBalance > LIVE_MAX_DAILY_LOSS_PCT) {
      circuitBreaker = true;
      console.error(`[MM] DAILY LOSS CIRCUIT BREAKER: dailyPnl=${dailyPnl.toFixed(2)}, maxLoss=${(LIVE_MAX_DAILY_LOSS_PCT * 100).toFixed(0)}%`);
    }
  }
}

// ─── Auto-Exit ────────────────────────────────────────────
function autoExit(): void {
  for (const [marketId, market] of markets) {
    const tau = (market.expiresAt - Date.now()) / 60000;
    if (tau < config.autoExitMinutes && tau > -1) {
      closePositionsForMarket(marketId, "auto_exit_time");
    }
  }
}

function closePositionsForMarket(marketId: string, reason: string): void {
  const market = markets.get(marketId);
  if (!market) return;

  for (const [posId, pos] of positions) {
    if (pos.marketId !== marketId) continue;

    const realBid = pos.side === "UP" ? market.realUpBestBid : market.realDownBestBid;
    const closePrice = clamp(
      realBid > 0 ? tickFloor(realBid) : 0,
      TICK_SIZE, 1 - TICK_SIZE
    );

    if (closePrice <= 0) continue;

    const closeValue = pos.quantity * closePrice;
    const feeRate = market.feeRate || DEFAULT_TAKER_FEE_RATE;
    const fee = calcTakerFee(pos.quantity, closePrice, feeRate);

    cashBalance += closeValue - fee;
    realizedPnl += (closeValue - fee) - pos.costBasis;

    trades.push({
      id: uid(), marketId, side: `SELL_${pos.side}`,
      price: closePrice, quantity: pos.quantity, totalCost: closeValue,
      fee, slippage: 0, reason, executedAt: Date.now(),
      isPaperTrade: !config.liveMode,
    });

    positions.delete(posId);
  }
  inventory.delete(marketId);

  for (const [, q] of quotes) {
    if (q.marketId === marketId && q.status === "active") q.status = "cancelled";
  }

  // In live mode, also cancel CLOB orders for this market
  if (config.liveMode && market.conditionId) {
    const client = getClobClient();
    if (client?.connected) {
      client.cancelMarketOrders(market.conditionId).catch(() => {});
    }
  }
}

// ─── PnL Snapshot ─────────────────────────────────────────
function takePnLSnapshot(): void {
  const now = Date.now();
  if (now - lastPnLSnapshotTime < 30000) return;
  lastPnLSnapshotTime = now;

  let totalUnrealized = 0;
  for (const [, pos] of positions) totalUnrealized += pos.unrealizedPnl;

  let activeMarkets = 0;
  for (const [, m] of markets) if (m.expiresAt > now && m.active) activeMarkets++;

  pnlHistory.push({
    timestamp: now,
    totalPnl: (cashBalance - config.startingBalance) + totalUnrealized,
    realizedPnl, unrealizedPnl: totalUnrealized,
    portfolioValue: cashBalance + Array.from(positions.values()).reduce((s, p) => s + p.currentValue, 0),
    cashBalance, positionCount: positions.size, activeMarkets,
  });
  if (pnlHistory.length > 500) pnlHistory.shift();
}

// ─── Trading Cycle ────────────────────────────────────────
export async function runTradingCycle(): Promise<void> {
  if (!running || circuitBreaker) return;

  const btc = await getBtcPrice();
  if (btc.price <= 0) return;

  cachedBtcPrice = btc.price;
  tradeCycleCount++;
  lastCycleAt = Date.now();

  await scanMarkets(btc);
  generateQuotes(btc);

  if (config.liveMode) {
    await liveTradingCycle(btc);
  } else {
    simulateFills(btc);
  }

  markToMarket(btc);
  autoExit();
  takePnLSnapshot();

  persistState();

  // Cleanup
  if (tradeCycleCount % 12 === 0) {
    for (const [id, q] of quotes) {
      if (q.status !== "active" && Date.now() - q.createdAt > 60000) quotes.delete(id);
    }
    while (trades.length > 300) trades.shift();
  }
}

// ─── Live Trading Cycle ──────────────────────────────────
// Replaces simulateFills() in live mode:
// 1. Safety checks (balance, daily loss)
// 2. Reconcile fills from CLOB trade history
// 3. Submit new orders from generated quotes (with neg_risk)
// 4. Cancel stale CLOB orders
// 5. Sync real balance from CLOB
async function liveTradingCycle(_btc: BtcPriceData): Promise<void> {
  const client = getClobClient();
  if (!client || !client.connected) {
    // Try to re-authenticate
    console.warn("[MM] CLOB disconnected, attempting re-auth...");
    try {
      const reauthed = await client?.reauth();
      if (!reauthed) {
        console.error("[MM] CLOB re-auth failed, skipping cycle");
        return;
      }
    } catch {
      console.error("[MM] CLOB re-auth error, skipping cycle");
      return;
    }
  }

  // ── Safety check: minimum balance ──
  if (cashBalance < LIVE_MIN_BALANCE) {
    console.warn(`[MM] Balance too low for live trading: $${cashBalance.toFixed(2)} < $${LIVE_MIN_BALANCE}`);
    // Don't submit new orders, but still reconcile existing ones
  }

  // 1. Reconcile: check for fills on existing CLOB orders
  const filledOrders = await clobReconcile();
  for (const filled of filledOrders) {
    const market = markets.get(filled.marketId);
    if (!market) continue;

    const matchingQuote = Array.from(quotes.values()).find(
      q => q.marketId === filled.marketId && q.side === filled.side && q.status === "active"
    );

    if (matchingQuote) {
      const isTaker = Date.now() - matchingQuote.createdAt < 5000;
      const feeRate = market.feeRate || DEFAULT_TAKER_FEE_RATE;
      const fee = isTaker ? calcTakerFee(filled.filledSize, filled.fillPrice, feeRate) : 0;
      const rebate = !isTaker ? calcMakerRebate(filled.filledSize, filled.fillPrice, feeRate) : 0;
      const totalCost = filled.fillPrice * filled.filledSize;

      if (filled.side.startsWith("BID")) {
        const totalWithFee = totalCost + fee;
        if (cashBalance >= totalWithFee) {
          cashBalance -= totalWithFee;
        } else {
          // Balance drift — will sync from CLOB later
          cashBalance = Math.max(0, cashBalance - totalWithFee);
        }

        // Update position
        const posSide = filled.side.includes("UP") ? "UP" : "DOWN";
        const posId = `${filled.marketId}_${posSide}`;
        const existing = positions.get(posId);
        if (existing) {
          existing.quantity += filled.filledSize;
          existing.costBasis += totalCost + fee;
          existing.entryPrice = existing.costBasis / existing.quantity;
          existing.isRealPosition = true;
        } else {
          positions.set(posId, {
            id: posId, marketId: filled.marketId,
            side: posSide as "UP" | "DOWN",
            entryPrice: filled.fillPrice, quantity: filled.filledSize,
            costBasis: totalCost + fee,
            currentValue: totalCost, unrealizedPnl: 0,
            openedAt: Date.now(),
            marketQuestion: market.question.substring(0, 60),
            isRealPosition: true,
          });
        }
      } else {
        // SELL fill — close/reduce position
        const posSide = filled.side.includes("UP") ? "UP" : "DOWN";
        const posId = `${filled.marketId}_${posSide}`;
        const pos = positions.get(posId);

        if (pos) {
          pos.quantity -= filled.filledSize;
          pos.costBasis -= pos.entryPrice * filled.filledSize;
          realizedPnl += (totalCost - fee + rebate) - (filled.filledSize * pos.entryPrice);
          if (pos.quantity <= 0) {
            positions.delete(posId);
          } else {
            pos.entryPrice = pos.costBasis / pos.quantity;
          }
        }

        cashBalance += totalCost - fee + rebate;
      }

      // Update inventory
      const inv = inventory.get(filled.marketId) || 0;
      if (filled.side === "BID_UP") inventory.set(filled.marketId, inv + filled.filledSize);
      else if (filled.side === "ASK_UP") inventory.set(filled.marketId, inv - filled.filledSize);
      else if (filled.side === "BID_DOWN") inventory.set(filled.marketId, inv - filled.filledSize);
      else if (filled.side === "ASK_DOWN") inventory.set(filled.marketId, inv + filled.filledSize);

      matchingQuote.status = "filled";
      trades.push({
        id: uid(), marketId: filled.marketId, side: filled.side,
        price: filled.fillPrice, quantity: filled.filledSize,
        totalCost, fee, slippage: Math.abs(filled.fillPrice - matchingQuote.price),
        reason: isTaker ? "live_taker_fill" : "live_maker_fill",
        executedAt: Date.now(), isPaperTrade: false,
      });

      console.log(
        `[MM] LIVE FILL: ${filled.side} ${filled.filledSize}@${filled.fillPrice} ` +
        `fee=$${fee.toFixed(4)} rebate=$${rebate.toFixed(4)}`
      );
    }
  }

  // 2. Submit new quotes as real CLOB orders (with neg_risk)
  if (cashBalance >= LIVE_MIN_BALANCE) {
    const activeQuotes = Array.from(quotes.values()).filter(q => q.status === "active");
    if (activeQuotes.length > 0) {
      const ordersToSubmit = activeQuotes.map(q => {
        const market = markets.get(q.marketId);
        const tokenId = q.side.includes("UP") ? (market?.upTokenId ?? "") : (market?.downTokenId ?? "");
        return {
          marketId: q.marketId,
          side: q.side as "BID_UP" | "ASK_UP" | "BID_DOWN" | "ASK_DOWN",
          tokenId,
          price: q.price,
          size: q.quantity,
          negRisk: market?.negRisk ?? false,  // Default false — current BTC markets are NOT neg_risk
        };
      }).filter(o => o.tokenId.length > 0);

      if (ordersToSubmit.length > 0) {
        const submitted = await replaceOrders(ordersToSubmit);
        console.log(`[MM] Submitted ${submitted.length}/${ordersToSubmit.length} orders to CLOB`);
      }
    }
  }

  // 3. Sync real balance from CLOB (every ~60s)
  if (tradeCycleCount % 6 === 0) {
    try {
      const realBal = await getRealBalance();
      if (realBal > 0) {
        lastRealBalance = realBal;
        const diff = realBal - cashBalance;
        if (Math.abs(diff) > 1) {
          console.log(
            `[MM] Balance sync: local=$${cashBalance.toFixed(2)} ` +
            `CLOB=$${realBal.toFixed(2)} diff=$${diff.toFixed(2)}`
          );
          // In live mode, trust the real balance
          cashBalance = realBal;
        }
      }
    } catch (err) {
      console.error("[MM] Balance sync failed:", err);
    }
  }
}

// ─── Daemon Loop ──────────────────────────────────────────
function startDaemon(): void {
  if (g.__mm_daemonTimer) return;

  g.__mm_daemonTimer = setInterval(async () => {
    try {
      await runTradingCycle();
    } catch (err) {
      console.error("[MM] Daemon cycle error:", err);
    }
  }, config.cycleIntervalMs);

  console.log(`[MM] Daemon started — cycle every ${config.cycleIntervalMs}ms`);
}

function stopDaemon(): void {
  if (g.__mm_daemonTimer) {
    clearInterval(g.__mm_daemonTimer);
    g.__mm_daemonTimer = undefined;
  }
}

// ─── Resolve private key from env or config ───────────────
function getPrivateKey(): `0x${string}` | undefined {
  // Priority: config > env variable
  if (config.clobPrivateKey) return config.clobPrivateKey as `0x${string}`;

  // Check environment variables (available in Next.js server-side)
  const envKey = process.env.CLOB_PRIVATE_KEY || process.env.NEXT_PUBLIC_CLOB_PRIVATE_KEY;
  if (envKey) {
    const formatted = envKey.startsWith("0x") ? envKey : `0x${envKey}`;
    return formatted as `0x${string}`;
  }

  return undefined;
}

function getFunderAddress(): `0x${string}` | undefined {
  if (config.clobFunderAddress) return config.clobFunderAddress as `0x${string}`;

  const envAddr = process.env.CLOB_FUNDER_ADDRESS || process.env.NEXT_PUBLIC_CLOB_FUNDER_ADDRESS;
  if (envAddr) {
    const formatted = envAddr.startsWith("0x") ? envAddr : `0x${envAddr}`;
    return formatted as `0x${string}`;
  }

  return undefined;
}

// ─── Public API ───────────────────────────────────────────
export function startEngine(): void {
  if (running) return;
  running = true;
  startTime = Date.now();
  circuitBreaker = false;
  tradeCycleCount = 0;
  checkDailyReset();
  dailyStartBalance = dailyStartBalance || cashBalance;

  // If live mode, initialize CLOB client
  if (config.liveMode) {
    const pk = getPrivateKey();
    if (!pk) {
      console.error("[MM] LIVE MODE: No private key! Set CLOB_PRIVATE_KEY env var or config.clobPrivateKey");
      console.warn("[MM] Falling back to PAPER mode");
      config.liveMode = false;
    } else {
      try {
        const funder = getFunderAddress();
        const clobConfig: ClobClientConfig = {
          privateKey: pk,
          funderAddress: funder,
          signatureType: funder ? 3 : 0, // POLY_1271 if funder set, else EOA
        };
        const client = initClobClient(clobConfig);

        // Init is async — don't block startEngine
        client.init().then(() => {
          client.startHeartbeat();
          console.log(`[MM] CLOB connected: ${client.address.slice(0, 10)}... (sigType=${funder ? "POLY_1271" : "EOA"})`);

          // Sync real balance
          client.getBalance().then(bal => {
            if (bal.balance > 0) {
              console.log(`[MM] Real balance: $${bal.balance.toFixed(2)} USDC (allowance: $${bal.allowance.toFixed(2)})`);
              cashBalance = bal.balance;
              dailyStartBalance = bal.balance;
              config.startingBalance = bal.balance;
            }
          }).catch(() => {});
        }).catch(err => {
          console.error("[MM] CLOB init failed:", err);
          config.liveMode = false;
          console.warn("[MM] Falling back to PAPER mode");
        });
      } catch (err) {
        console.error("[MM] CLOB client creation failed:", err);
        config.liveMode = false;
      }
    }
  }

  persistState();
  startDaemon();
  console.log(`[MM] Engine started — ${config.liveMode ? "🔴 LIVE" : "📄 PAPER"} trading with CLOB-compliant prices`);
}

export function stopEngine(): void {
  running = false;
  stopDaemon();

  // In live mode, cancel all open orders and stop heartbeat
  if (config.liveMode) {
    clobCancelAll().catch(() => {});
    destroyClobClient();
  }

  for (const [, q] of quotes) {
    if (q.status === "active") q.status = "cancelled";
  }
  persistState();
  console.log("[MM] Engine stopped");
}

export function resetEngine(): void {
  stopEngine();
  cashBalance = config.startingBalance;
  realizedPnl = 0;
  circuitBreaker = false;
  markets.clear();
  positions.clear();
  trades.length = 0;
  quotes.clear();
  pnlHistory.length = 0;
  inventory.clear();
  knownSlugs.clear();
  cachedBtcPrice = 0;
  lastRealBalance = 0;
  dailyStartBalance = 0;
  dailyResetDate = "";
  resetOrderManager();
  persistState();
  console.log("[MM] Engine reset");
}

export function getStatus(btc: BtcPriceData): BotStatus {
  let totalUnrealized = 0;
  for (const [, pos] of positions) totalUnrealized += pos.unrealizedPnl;
  const totalPnl = (cashBalance - config.startingBalance) + totalUnrealized;

  const clob = getClobClient();
  const omStats = getOrderManagerStats();

  checkDailyReset();
  const dailyPnl = cashBalance - dailyStartBalance;

  return {
    running, balance: cashBalance, cashBalance,
    startingBalance: config.startingBalance,
    positionCount: positions.size, activeMarkets: markets.size,
    totalPnl, realizedPnl, unrealizedPnl: totalUnrealized,
    circuitBreaker, uptime: running ? Date.now() - startTime : 0,
    btcPrice: btc.price, btcTrend: btc.trend,
    quoteCount: Array.from(quotes.values()).filter(q => q.status === "active").length,
    tradeCount: trades.length,
    isPaperTrade: !config.liveMode,
    lastCycleAt,
    // Live mode status
    liveMode: config.liveMode,
    clobConnected: clob?.connected ?? false,
    clobAddress: clob?.address ?? "",
    clobError: clob?.lastError ?? "",
    openClobOrders: omStats.openOrders,
    totalClobSubmitted: omStats.totalSubmitted,
    totalClobFilled: omStats.totalFilled,
    totalClobRejected: omStats.totalRejected,
    realBalance: lastRealBalance,
    dailyPnl,
    dailyStartBalance,
  };
}

export function getMarkets(btc: BtcPriceData) {
  return Array.from(markets.values()).map(m => ({
    id: m.id,
    question: m.question,
    slug: m.slug,
    conditionId: m.conditionId,
    upTokenId: m.upTokenId,
    downTokenId: m.downTokenId,
    expiresAt: m.expiresAt,
    strikePrice: m.strikePrice,
    negRisk: m.negRisk,
    lastUpPrice: m.lastUpPrice,
    lastDownPrice: m.lastDownPrice,
    volume: m.volume,
    liquidity: m.liquidity,
    feeRate: m.feeRate,
    makerFeeRate: m.makerFeeRate,
    isReal: m.isReal,
    active: m.active,
    realUpMid: m.realUpMid,
    realUpBestBid: m.realUpBestBid,
    realUpBestAsk: m.realUpBestAsk,
    realDownMid: m.realDownMid,
    realDownBestBid: m.realDownBestBid,
    realDownBestAsk: m.realDownBestAsk,
    realSpreadUp: m.realSpreadUp,
    realSpreadDown: m.realSpreadDown,
    timeToExpiry: Math.max(0, (m.expiresAt - Date.now()) / 60000).toFixed(1),
    inventory: inventory.get(m.id) || 0,
    ourUpPrice: calcUpProbability(m, btc),
  }));
}

export function getPositions() {
  return Array.from(positions.values());
}

export function getTrades(limit = 50) {
  return trades.slice(-limit).reverse();
}

export function getQuotes() {
  return Array.from(quotes.values()).filter(q => q.status === "active");
}

export function getPnl(limit = 100) {
  return pnlHistory.slice(-limit);
}

export function getConfig() {
  const { clobPrivateKey, ...safe } = { ...config };
  return { ...safe, clobPrivateKey: clobPrivateKey ? "***redacted***" : undefined };
}

export function updateConfig(updates: Partial<BotConfig>) {
  const oldInterval = config.cycleIntervalMs;
  Object.assign(config, updates);

  // If live mode was toggled, need to reinitialize
  if (updates.liveMode !== undefined && running) {
    if (updates.liveMode) {
      // Switching to live — need CLOB client
      const pk = getPrivateKey();
      if (!pk) {
        console.error("[MM] Cannot enable LIVE mode without private key");
        config.liveMode = false;
        return { ...config };
      }
      console.log("[MM] Switching to LIVE mode — CLOB client will init on next cycle");
    } else {
      // Switching to paper — destroy CLOB client
      destroyClobClient();
      console.log("[MM] Switched to PAPER mode");
    }
  }

  if (updates.cycleIntervalMs && updates.cycleIntervalMs !== oldInterval && running) {
    stopDaemon();
    startDaemon();
  }
  return { ...config };
}

export function isRunning() {
  return running;
}
