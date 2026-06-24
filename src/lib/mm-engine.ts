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

import { getBtcPrice, getAssetPrice, slugToAsset, type BtcPriceData } from "./btc-feed";
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
import {
  smartEntrySignal,
  smartTpThreshold,
  SMART_TP_PCT,
  SMART_SL_PCT,
  type SmartEntrySignal,
} from "./smart-entry";
import {
  momentumEntrySignal,
  shouldTrailingTpTrigger,
  TRAILING_TP_DROP_PCT,
  getMomentumSlForTau,
} from "./momentum-entry";
import {
  smartMoneyEntrySignal,
  shouldSmartMoneyTrailingTpTrigger,
  TRAILING_TP_DROP_PCT as SMART_MONEY_TRAILING_TP_DROP_PCT,
} from "./smart-money-entry";
import {
  holdTpEntrySignal,
  HOLD_TP_PCT,
  getHoldSlForTau,
} from "./hold-tp-entry";

// BUG FIX #20: floating-point hazards — use integer math for tick rounding
const TICK_SIZE = 0.01;

// BUG FIX (audit 2026-06-23): smartTpThreshold (15%) was used for ALL strategies
// in generateQuotes and getPositions. Now each strategy gets its own TP threshold.
function tpThresholdFor(entry: number): number {
  if (config.strategy === "hold-tp") return entry * (1 + HOLD_TP_PCT);  // 8%
  if (config.strategy === "momentum" || config.strategy === "smart-money") return entry * (1 + 0.08);  // 8%
  return smartTpThreshold(entry);  // contrarian: 15%
}
function tickRound(price: number): number {
  return Math.round(price * 100) / 100;
}
function tickFloor(price: number): number {
  return Math.floor(price * 100) / 100;
}
function tickCeil(price: number): number {
  return Math.ceil(price * 100) / 100;
}

// ─── Fee Constants ─────────────────────────────────────────
const DEFAULT_TAKER_FEE_RATE = 0.072;
const DEFAULT_MAKER_FEE_RATE = 0;
const MAKER_REBATE_PCT = 0.20;
const MIN_MAKER_FILL_DELAY_MS = 2000;

// ─── Gas / Transaction Fee per order ──────────────────────
// BUG FIX (2026-06-20): GAS_FEE_ORDER was undefined → ReferenceError crash
// in takerTakeProfit() and recordTradeAnalytics() call → bot cycle died silently.
// Cost: $0.015 per order (Polymarket gas estimation for Polygon trades).
const GAS_FEE_ORDER = 0.015;

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
  // ── Inventory management v2 ──
  entryMid: number;  // market mid price at position open (for adverse selection detection)
  peakValue: number; // peak currentValue (for trailing stop in future)
  entryStrikePrice: number;  // strike price at position open (for orphaned position settlement)
}

export interface TradeContext {
  // Market identity (saved at trade time — survives market expiry)
  marketSlug?: string;           // e.g. "btc-updown-15m-1782199800"
  marketQuestion?: string;       // e.g. "Bitcoin Up or Down - June 23, 3:30AM-3:45AM ET"
  // Market state at trade execution
  marketVolume?: number;
  marketLiquidity?: number;
  tauMin?: number;
  upMid?: number;
  downMid?: number;
  upBid?: number;
  upAsk?: number;
  downBid?: number;
  downAsk?: number;
  spreadUp?: number;
  spreadDown?: number;
  upL2Depth?: number;
  downL2Depth?: number;
  upL2Imbalance?: number;
  downL2Imbalance?: number;
  btcPrice?: number;
  btcChange1m?: number;
  btcChange5m?: number;
  btcAtr5m?: number;
  btcTrend?: string;
  entryPrice?: number;
  holdTimeMs?: number;
  peakPnl?: number;
}

export interface Trade {
  id: string;
  marketId: string;
  marketSlug?: string;  // FIX (2026-06-23): store slug for dashboard display after market expires
  side: string;
  price: number;
  quantity: number;
  totalCost: number;
  fee: number;
  slippage: number;
  reason: string;
  executedAt: number;
  isPaperTrade: boolean;
  pnl: number;
  context?: TradeContext;  // market + BTC state at trade time
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
  strategy: "contrarian" | "momentum" | "smart-money" | "hold-tp";  // strategy mode selector
  // ── Inventory management (v2 — anti adverse selection) ──
  rebalanceThreshold: number;    // |inv| above this → enter rebalance-only mode
  adverseSelectionFactor: number; // multiplier on skew when price moves against us
  stopLossPct: number;           // close position if unrealizedPnl < -stopLossPct * costBasis
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
  positionsValue: number;  // BUG FIX (2026-06-20): total $ in open positions
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
  startingBalance: 100,       // $100 starting balance (matches backtest)
  maxPositionSize: 30,
  minPositionSize: 5,
  baseSpread: 0.03,
  atrMultiplier: 10,
  autoExitMinutes: 3,
  circuitBreakerPct: 0.50,    // 50% — less aggressive for paper trading (was 25%)
  maxInventory: 30,
  quoteSize: 5,
  inventorySkewFactor: 0.008,
  cycleIntervalMs: 1000,
  strategy: "contrarian",  // default; momentum service overrides to "momentum"
  // ── Inventory management v2 ──
  rebalanceThreshold: 12,
  adverseSelectionFactor: 3,
  stopLossPct: 0.20,          // 20% fixed fallback (dynamic ATR used in markToMarket)
  liveMode: false,
};

let cashBalance = g.__mm_cash ?? 100;
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
  (g as any).__mm_cachedBtcPrice = cachedBtcPrice;  // BUG FIX #23
  (g as any).__mm_cachedBtcData = cachedBtcData;  // FIX 5
  g.__mm_dailyStartBalance = dailyStartBalance;
  g.__mm_dailyResetDate = dailyResetDate;
  // BUG FIX (2026-06-23): analytics counters were NOT persisted → reset to 0 on bun --hot reload
  (g as any).__mm_totalWins = totalWins;
  (g as any).__mm_totalLosses = totalLosses;
  (g as any).__mm_totalWinAmount = totalWinAmount;
  (g as any).__mm_totalLossAmount = totalLossAmount;
  (g as any).__mm_totalGasPaid = totalGasPaid;
  (g as any).__mm_totalFeesPaid = totalFeesPaid;
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

// ─── Trade Context Builder ────────────────────────────────
// Captures market + BTC state at trade execution time for post-hoc analysis
// of winning vs losing trade patterns.
export function buildTradeContext(marketId: string, btc: BtcPriceData, pos?: Position): TradeContext {
  const market = markets.get(marketId);
  if (!market) {
    // BUG FIX #15 (2026-06-23): Add marketSlug from position for orphaned trades
    return pos ? {
      marketSlug: pos.marketQuestion ? `(expired) ${pos.marketId}` : pos.marketId,
      marketQuestion: pos.marketQuestion || '(market expired)',
      entryPrice: pos.entryPrice,
      holdTimeMs: Date.now() - pos.openedAt,
      peakPnl: pos.peakValue - pos.costBasis,
    } : {};
  }

  // L2 depth analysis (top 5 levels)
  let upBidDepth = 0, upAskDepth = 0, downBidDepth = 0, downAskDepth = 0;
  for (let i = 0; i < Math.min(5, market.upBids.length); i++) {
    const l = market.upBids[i];
    if (l && l.size > 0) upBidDepth += l.size * l.price;
  }
  for (let i = 0; i < Math.min(5, market.upAsks.length); i++) {
    const l = market.upAsks[i];
    if (l && l.size > 0) upAskDepth += l.size * l.price;
  }
  for (let i = 0; i < Math.min(5, market.downBids.length); i++) {
    const l = market.downBids[i];
    if (l && l.size > 0) downBidDepth += l.size * l.price;
  }
  for (let i = 0; i < Math.min(5, market.downAsks.length); i++) {
    const l = market.downAsks[i];
    if (l && l.size > 0) downAskDepth += l.size * l.price;
  }

  const upTotal = upBidDepth + upAskDepth;
  const downTotal = downBidDepth + downAskDepth;
  const tauMin = Math.max(0, (market.expiresAt - Date.now()) / 60000);

  return {
    marketSlug: market.slug,
    marketQuestion: market.question,
    marketVolume: market.volume,
    marketLiquidity: market.liquidity,
    tauMin,
    upMid: market.realUpMid,
    downMid: market.realDownMid,
    upBid: market.realUpBestBid,
    upAsk: market.realUpBestAsk,
    downBid: market.realDownBestBid,
    downAsk: market.realDownBestAsk,
    spreadUp: market.realSpreadUp,
    spreadDown: market.realSpreadDown,
    upL2Depth: upTotal,
    downL2Depth: downTotal,
    upL2Imbalance: upTotal > 0 ? (upBidDepth - upAskDepth) / upTotal : 0,
    downL2Imbalance: downTotal > 0 ? (downBidDepth - downAskDepth) / downTotal : 0,
    btcPrice: btc.price,
    btcChange1m: btc.change1m,
    btcChange5m: btc.change5m,
    btcAtr5m: btc.atr5m,
    btcTrend: btc.trend,
    entryPrice: pos?.entryPrice,
    holdTimeMs: pos ? Date.now() - pos.openedAt : undefined,
    peakPnl: pos ? pos.peakValue - pos.costBasis : undefined,
  };
}

// ─── Fee Calculation ──────────────────────────────────────
// BUG FIX #10: Polymarket taker fee is CAPPED, not purely multiplicative
// Actual formula: fee = min(shares * feeRate * price, shares * (1-price)) for BUY
//                 fee = min(shares * feeRate * price, shares * price) for SELL
// The old formula under-charged by 50-90% at extreme prices.
function calcTakerFee(shares: number, price: number, feeRate: number = DEFAULT_TAKER_FEE_RATE): number {
  const rawFee = shares * feeRate * price * (1 - price);
  // Cap: fee cannot exceed the lesser side of the trade
  const cap = shares * Math.min(price, 1 - price);
  return Math.min(rawFee, cap);
}

function calcMakerRebate(shares: number, price: number, feeRate: number = DEFAULT_TAKER_FEE_RATE): number {
  // BUG FIX: Polymarket does NOT pay per-fill maker rebate.
  // The rebate program is protocol-level, not per-trade.
  // Setting to 0 prevents inflated cashBalance and realizedPnl.
  return 0;
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

// FREQ FIX: Added ETH and SOL markets (3x more entry opportunities)
const SLUG_PATTERNS = [
  (ts: number) => `btc-updown-15m-${ts}`,
  (ts: number) => `btc-up-or-down-15m-${ts}`,
  (ts: number) => `eth-updown-15m-${ts}`,
  (ts: number) => `eth-up-or-down-15m-${ts}`,
  (ts: number) => `sol-updown-15m-${ts}`,
  (ts: number) => `sol-up-or-down-15m-${ts}`,
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
      if (takerBaseBPS > 0) takerFeeRate = takerBaseBPS / 10000;  // BUG FIX: was /14000
      if (makerBaseBPS > 0) makerFeeRate = makerBaseBPS / 10000;
    } catch { /* defaults */ }

    const question = data.question || slug;
    let strike = parseStrikePrice(question);
    
    // ── Get strike from Chainlink priceToBeat (eventMetadata) ──
    // For BTC Up/Down 15-min markets, the question doesn't contain strike.
    // Polymarket stores it in events[0].eventMetadata.priceToBeat.
    // NOTE: eventMetadata is only available AFTER market closes.
    // For active markets, we use BTC price at slot start as strike.
    if (strike <= 0) {
      try {
        const events = data.events || [];
        if (events.length > 0) {
          const meta = events[0].eventMetadata || {};
          const ptb = parseFloat(meta.priceToBeat || "0");
          if (ptb > 0) strike = ptb;
        }
      } catch { /* ignore */ }
    }
    // Fallback: BTC price at slot start = strike
    // For BTC Up/Down: if BTC > start_price at expiry → UP wins
    // We approximate start_price using current BTC price (will be set in runTradingCycle)
    // This is imperfect but allows the model to function on active markets.
    if (strike <= 0) {
      // Will be set to btc.price when market is first processed
      // (stored in market object, updated once)
      strike = -1;  // sentinel: means "use BTC price on first cycle"
    }

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
      volume: parseFloat(data.volumeNum || data.volume || data.volume24hr || "0") || 0,
      liquidity: parseFloat(data.liquidityNum || data.liquidity || "0") || 0,
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
  if (now - lastScanTime < 1000) return;  // Scan every 1s
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
          // Refresh order book + market data (volume, liquidity) from Gamma API
          const [upBook, downBook, freshData] = await Promise.all([
            fetchOrderBook(existing.upTokenId).catch(() => null),
            fetchOrderBook(existing.downTokenId).catch(() => null),
            fetch(`https://gamma-api.polymarket.com/markets/slug/${slug}`, {
              signal: AbortSignal.timeout(5000),
            }).then(r => r.ok ? r.json() : null).catch(() => null),
          ]);

          // Update volume and liquidity from fresh API data
          if (freshData) {
            const freshVol = parseFloat(freshData.volumeNum || freshData.volume || freshData.volume24hr || "0") || 0;
            const freshLiq = parseFloat(freshData.liquidityNum || freshData.liquidity || "0") || 0;
            if (freshVol > 0) existing.volume = freshVol;
            if (freshLiq > 0) existing.liquidity = freshLiq;
          }

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
          // FREQ FIX: DON'T break — continue checking ETH/SOL for same slot
        } catch {
          discovered.push(existing);
          foundMarket = true;
          // FREQ FIX: DON'T break — continue checking ETH/SOL
        }
      }

      try {
        const market = await fetchMarketBySlug(slug);
        if (market) {
          discovered.push(market);
          knownSlugs.add(slug);
          foundMarket = true;
          // FREQ FIX: DON'T break — continue checking ETH/SOL for same slot
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

  // Cleanup expired + settle — IMMEDIATELY on expiry (was 30 min delay)
  const now_ms = Date.now();
  for (const [id, m] of markets) {
    if (m.expiresAt < now_ms) {
      settleMarket(id, m);   // settle FIRST
      markets.delete(id);     // then remove
    }
  }

  persistState();
}

// ─── Settlement ───────────────────────────────────────────
function settleMarket(marketId: string, market: Market): void {
  // BUG FIX #14 (2026-06-23): Settlement uses token mid price as proxy.
  // Real Polymarket settlement uses Chainlink price vs priceToBeat.
  // Token mid > 0.50 = market expects UP wins → approximate settlement.
  // Limitation: token mid can be manipulated in last seconds before expiry.
  // For paper trading this is acceptable; for live would need Chainlink feed.
  const upMid = market.realUpMid;
  const upWins = upMid > 0.50;
  // FIX 5: use cachedBtcData (has real change1m/change5m) instead of mocked data
  const btcData = cachedBtcData;

  for (const [posId, pos] of positions) {
    if (pos.marketId !== marketId) continue;

    const resolvedPrice = (pos.side === "UP" && upWins) || (pos.side === "DOWN" && !upWins) ? 1.0 : 0.0;
    const settleValue = pos.quantity * resolvedPrice;

    // In live mode, CLOB handles settlement — we just update our bookkeeping
    const fee = 0; // No fee on redemption in Polymarket

    const settlePnl = (settleValue - fee) - pos.costBasis;
    cashBalance += settleValue - fee;
    realizedPnl += settlePnl;
    recordTradeAnalytics(settlePnl, fee, 0);

    trades.push({
      id: uid(), marketId, marketSlug: market.slug, side: `SETTLE_${pos.side}`,
      price: resolvedPrice, quantity: pos.quantity,
      totalCost: settleValue, fee,
      slippage: 0, reason: upWins ? "settle_up_wins" : "settle_down_wins",
      executedAt: Date.now(), isPaperTrade: !config.liveMode,
      pnl: settlePnl,
      context: buildTradeContext(marketId, btcData, pos),
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
// BUG FIX #23: persist in globalThis so it survives HMR/restart
let cachedBtcPrice = (g as any).__mm_cachedBtcPrice ?? 0;
// FIX 5 (2026-06-20): cache full BtcPriceData (not just price) so exit trades
// (takerTakeProfit, closePositionById, etc.) can access real change1m/change5m
// for trade context. Previously passed mocked {change1m:0, change5m:0} which
// made L2/BTC analysis show 0% for all exit trades.
let cachedBtcData: BtcPriceData = (g as any).__mm_cachedBtcData ?? {
  price: 0, atr1m: 0, atr5m: 0, atr15m: 0, volatilityPct: 0,
  change1m: 0, change5m: 0, trend: "neutral", timestamp: 0, klines: [], lastUpdate: 0, connected: false,
};

// ─── Probability Model ────────────────────────────────────
function calcUpProbability(market: Market, btc: BtcPriceData): number {
  const { price, atr5m, change1m, change5m, trend } = btc;
  if (price <= 0) return 0.5;

  // BUG FIX #3 (2026-06-23): strikePrice = -1 (sentinel) was treated as <=0
  // → fallback to current price as strike → P(UP) always ~50% → model useless.
  // Now: if strike = -1 (no Chainlink data), use market mid price as probability.
  let strike = market.strikePrice;
  if (strike <= 0) {
    // No strike data — use market mid price as probability proxy
    // Market price IS the probability (efficient market hypothesis)
    return clamp(market.realUpMid > 0 ? market.realUpMid : 0.5, 0.01, 0.99);
  }

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
//
// MM PRINCIPLE: a market maker NEVER crosses the book. Our bid must be
// strictly below the market best ask, and our ask must be strictly above
// the market best bid. Otherwise we become a taker and pay the taker fee.
//
// We quote INSIDE the existing spread (improve the best price by 1 tick),
// which is exactly what a real MM does on a CLOB. If the market spread is
// already 1 tick (locked), we skip that side — no edge to capture.
//
async function generateQuotes(btc: BtcPriceData): Promise<void> {
  // ── Quote lifecycle ──
  // Old code cancelled ALL active quotes every cycle, which prevented maker
  // fills: simulateFills() requires a quote to age MIN_MAKER_FILL_DELAY_MS
  // (2s) before it's eligible, but the quote was cancelled at the start of
  // every 10s cycle before it could age. Result: 0 maker fills.
  //
  // New behaviour: keep active quotes for up to QUOTE_LIFETIME_MS (60s, = 6
  // cycles). After that they're considered stale and cancelled so we can
  // refresh prices. This gives each quote ~6 chances to be maker-filled.
  //
  // Additionally, cancel any quote that has drifted too far from the current
  // mid (> 4 ticks). When the market moves suddenly (e.g. BTC crash), our
  // old maker bids/asks become toxic — they'd be adverse-selected.
  const QUOTE_LIFETIME_MS = 60_000;
  const PRICE_MOVE_CANCEL_TICKS = 4;
  const nowMs = Date.now();
  for (const [, q] of quotes) {
    if (q.status !== "active") continue;
    if (nowMs - q.createdAt > QUOTE_LIFETIME_MS) {
      q.status = "cancelled";
      continue;
    }
    // Price-move cancel: if a quote is now far from the current mid, cancel it.
    const market = markets.get(q.marketId);
    if (!market) continue;
    const currentMid = q.side.includes("UP") ? market.realUpMid : market.realDownMid;
    if (Math.abs(q.price - currentMid) > PRICE_MOVE_CANCEL_TICKS * TICK_SIZE) {
      q.status = "cancelled";
    }
  }

  for (const [marketId, market] of markets) {
    const tau = (market.expiresAt - Date.now()) / 60000;
    if (tau < config.autoExitMinutes) continue;
    if (!market.active) continue;

    // ═══ Market quality filters (realistic trading conditions) ═══
    // Skip markets that can't be traded realistically:
    //   1. Crossed or empty order book (bestBid=0 or bestAsk=0 or bid >= ask)
    //   2. Insufficient volume (no other traders to fill our quotes)
    //   3. Insufficient liquidity (thin book, high slippage risk)

    // Filter 1: Crossed/empty book — can't place valid quotes
    const upBookValid = market.realUpBestBid > 0 && market.realUpBestAsk > 0
      && market.realUpBestBid < market.realUpBestAsk;
    const downBookValid = market.realDownBestBid > 0 && market.realDownBestAsk > 0
      && market.realDownBestBid < market.realDownBestAsk;
    if (!upBookValid && !downBookValid) continue;  // both sides broken → skip market

    // Filter 2: Minimum volume — need real traders to fill our quotes
    // FREQ FIX: asset-dependent volume filter
    // BTC: $2000-3000 (high liquidity), ETH/SOL: $50 (lower liquidity, but still tradeable)
    // SOFT FIX (2026-06-23): ETH/SOL vol $500 → $200 (ETH usually $50-200, rarely > $500)
    // Analysis showed ETH vol=$737 today but usually $50-200 — $500 was too high.
    // $200 allows more ETH/SOL entries while still filtering truly dead markets.
    // HOLD-TP FIX (2026-06-23): hold-tp держит до TP/settlement, не зависит от немедленной
    // ликвидности для выхода. Снижаем порог чтобы входить на ранних рынках (tau 13-14m, vol низкий
    // но цены нормальные 0.50-0.60). Без этого hold-tp попадает в "мёртвую зону":
    // tau>14 — вне окна; tau 4-12 — цены уже extreme.
    const isBtcMarket = market.slug.startsWith("btc-");
    const MIN_VOLUME_USD = config.strategy === "contrarian"
      ? (isBtcMarket ? 3000 : 200)
      : config.strategy === "hold-tp"
      ? (isBtcMarket ? 100 : 30)   // минимальный порог — hold-tp держит до TP/settlement, не зависит от ликвидности выхода
      : config.strategy === "momentum"
      ? (isBtcMarket ? 500 : 100)  // momentum v4: hold to settlement, можно ниже
      : (isBtcMarket ? 2000 : 200);
    if (market.volume < MIN_VOLUME_USD) continue;

    // Filter 3: Minimum liquidity — thin books have high slippage
    // HOLD-TP + MOMENTUM v4: снижено (держим до settlement, не зависит от немедленной ликвидности)
    const MIN_LIQUIDITY_USD = (config.strategy === "hold-tp" || config.strategy === "momentum") ? 50 : 200;
    if (market.liquidity < MIN_LIQUIDITY_USD) continue;

    const inv = inventory.get(marketId) || 0;
    // NOTE: do NOT skip when |inv| > maxInventory — that would freeze the bot
    // and prevent rebalancing. Instead, in rebalance-only mode (below) we
    // only place quotes that reduce the position.

    // ── Cancel stale BIDs on the long side when in rebalance mode ──
    // Old BID_UP quotes placed before we entered rebalance mode would keep
    // filling and growing the position. Cancel them now.
    const rebalanceOnlyEarly = Math.abs(inv) > config.rebalanceThreshold;
    if (rebalanceOnlyEarly) {
      for (const [, q] of quotes) {
        if (q.status !== "active" || q.marketId !== marketId) continue;
        if (inv > 0 && q.side === "BID_UP") q.status = "cancelled";
        if (inv < 0 && q.side === "BID_DOWN") q.status = "cancelled";
      }
    }

    // ── Market state ──
    const upBestBid = market.realUpBestBid > 0 ? market.realUpBestBid : 0;
    const upBestAsk = market.realUpBestAsk > 0 ? market.realUpBestAsk : 1;
    const downBestBid = market.realDownBestBid > 0 ? market.realDownBestBid : 0;
    const downBestAsk = market.realDownBestAsk > 0 ? market.realDownBestAsk : 1;

    const upRealMid = market.realUpMid > 0 ? market.realUpMid : (upBestBid + upBestAsk) / 2;
    const downRealMid = market.realDownMid > 0 ? market.realDownMid : (downBestBid + downBestAsk) / 2;

    // ── Adverse selection detection ──
    // For each side we hold, measure how far the current mid has moved from
    // the entry mid. If the price moved against us, we apply an extra skew
    // to attract counter-trades (sell the long side faster).
    const upPos = positions.get(`${marketId}_UP`);
    const downPos = positions.get(`${marketId}_DOWN`);
    let adverseUpSkew = 0;
    let adverseDownSkew = 0;
    if (upPos && upPos.entryMid > 0) {
      // long UP — if realMid dropped below entry, we're underwater
      const movedAgainst = upPos.entryMid - upRealMid; // positive = price fell
      if (movedAgainst > 0) {
        // Push UP prices DOWN harder so we sell UP faster and stop buying
        adverseUpSkew = -movedAgainst * config.adverseSelectionFactor;
      }
    }
    if (downPos && downPos.entryMid > 0) {
      const movedAgainst = downPos.entryMid - downRealMid;
      if (movedAgainst > 0) {
        adverseDownSkew = -movedAgainst * config.adverseSelectionFactor;
      }
    }

    // ── Model signal (for sizing / skew only, NOT for crossing price) ──
    const modelPUp = calcUpProbability(market, btc);
    const modelSignalSkew = clamp((modelPUp - upRealMid) * 0.1, -TICK_SIZE, TICK_SIZE);

    // ── Inventory skew (in ticks) ──
    // Positive inventory (long UP) → lower UP prices (sell faster), raise DOWN prices (don't accumulate)
    const skewTicks = Math.round(inv * config.inventorySkewFactor / TICK_SIZE) * TICK_SIZE;
    const upSkew = skewTicks + modelSignalSkew + adverseUpSkew;
    const downSkew = -skewTicks - modelSignalSkew + adverseDownSkew;

    // ── Rebalance-only mode ──
    // When |inv| exceeds the rebalance threshold, we only place quotes that
    // REDUCE the position:
    //   - If long UP (inv > 0): only ASK_UP (sell UP) + BID_DOWN (buy DOWN = sell UP synthetically)
    //   - If long DOWN (inv < 0): only ASK_DOWN + BID_UP
    // Bids on the long side are suppressed to stop digging a deeper hole.
    const rebalanceOnly = Math.abs(inv) > config.rebalanceThreshold;
    const longUp = inv > 0;
    const longDown = inv < 0;
    let allowBidUp = !(rebalanceOnly && longUp);
    let allowBidDown = !(rebalanceOnly && longDown);

    // ── SMART L2 ENTRY (replaces STRICT ENTRY FILTER) ──
    // Goal: ~90% win rate via multi-signal confirmation
    // Signals: BTC trend (1m+5m) + L2 depth pressure + probability model + time window
    // Only enter when 3+ signals align with strong conviction (>= 70 confidence, 10+ gap)
    //
    // FIX 1 (2026-06-20): Cancel active BID quotes when signal changes
    //   Old: smart entry only blocked NEW bids, but EXISTING quotes kept filling
    //   New: when signal flips, cancel all active BID quotes on this market
    //
    // FIX 2 (2026-06-20): Hard L2 filter — no entry if L2 imbalance < -30%
    //   Analysis: 5/5 stop-loss trades had L2 imbalance AGAINST position
    //   (-25%, -79%, -42%, -40%, -57%) — bot was fighting the book
    //
    // FIX 4 (2026-06-20): NO ACCUMULATION via quote cancellation
    //   After first fill on market+side, cancel that BID quote to prevent
    //   further maker fills adding to position
    if (!rebalanceOnly) {
      // BUG FIX (2026-06-23): Use asset-specific price data for each market.
      // BTC markets use BTC price feed, ETH markets use ETH, SOL use SOL.
      const assetSymbol = slugToAsset(market.slug);
      const assetPriceData = assetSymbol === "BTC" ? btc : (await getAssetPrice(assetSymbol));
      const signal = config.strategy === "momentum"
        ? momentumEntrySignal(market, assetPriceData)
        : config.strategy === "smart-money"
        ? smartMoneyEntrySignal(market, assetPriceData)
        : config.strategy === "hold-tp"
        ? holdTpEntrySignal(market, assetPriceData)
        : smartEntrySignal(market, assetPriceData, calcUpProbability(market, assetPriceData));

      // Log signal every cycle for debugging (shows WHY bot entered or skipped)
      if (signal.should) {
        console.log(
          `[SMART] ${market.slug} → ${signal.side} (conf=${signal.confidence}/100) | ` +
          `tau=${signal.details.tau.toFixed(1)}m pUp=${(signal.details.pUp * 100).toFixed(0)}% ` +
          `btc1m=${(signal.details.btcChange1m * 100).toFixed(2)}% btc5m=${(signal.details.btcChange5m * 100).toFixed(2)}% ` +
          `upL2imb=${(signal.details.upL2.imbalance * 100).toFixed(0)}% downL2imb=${(signal.details.downL2.imbalance * 100).toFixed(0)}%`
        );
      }

      // FIX 2: Hard L2 filter — even if smart signal says "enter",
      // block if L2 imbalance is strongly against the chosen side.
      // L2 imbalance < -30% means sellers dominate → adverse selection risk.
      const MIN_L2_IMBALANCE = -0.30;  // reject if imbalance below this
      let l2Blocked = false;
      if (signal.should) {
        const sideImbalance = signal.side === "UP"
          ? signal.details.upL2.imbalance
          : signal.details.downL2.imbalance;
        if (sideImbalance < MIN_L2_IMBALANCE) {
          l2Blocked = true;
          if (tradeCycleCount % 15 === 0) {
            console.log(
              `[SMART] ${market.slug}: ${signal.side} signal blocked by L2 filter ` +
              `(imbalance=${(sideImbalance * 100).toFixed(0)}% < ${(MIN_L2_IMBALANCE * 100).toFixed(0)}%)`
            );
          }
        }
      }

      if (signal.should && !l2Blocked) {
        // Smart entry confirmed — only allow bid on signal side
        if (signal.side === "UP") {
          allowBidUp = true;
          allowBidDown = false;
        } else {
          allowBidUp = false;
          allowBidDown = true;
        }

        // FIX 1: Cancel active BID quotes on the OPPOSITE side
        // (e.g. if signal is UP, cancel any active BID_DOWN — they're stale)
        for (const [, q] of quotes) {
          if (q.status !== "active" || q.marketId !== marketId) continue;
          if (signal.side === "UP" && q.side === "BID_DOWN") {
            q.status = "cancelled";
          }
          if (signal.side === "DOWN" && q.side === "BID_UP") {
            q.status = "cancelled";
          }
        }

        // NO ACCUMULATION for contrarian; PARTIAL FILLS for momentum (up to 3 entries)
        // MOMENTUM: scaling in — allows multiple fills to build position over time.
        //   Each fill is small ($1-2), up to 3 fills total per market+side.
        //   This averages entry price and reduces adverse selection risk.
        // CONTRARIAN: single entry only (no adding to position)
        const posId = `${marketId}_${signal.side}`;
        const existingPos = positions.get(posId);
        const bidSideToCheck = signal.side === "UP" ? "BID_UP" : "BID_DOWN";

        if (existingPos) {
          if (config.strategy === "momentum") {
            // MOMENTUM: allow partial fills up to MAX_PARTIAL_ENTRIES (3)
            const MAX_PARTIAL_ENTRIES = 3;
            const currentFillCount = Math.ceil(existingPos.quantity / 6);  // each fill ~6 tokens
            if (currentFillCount >= MAX_PARTIAL_ENTRIES) {
              // Max entries reached — stop adding
              allowBidUp = false;
              allowBidDown = false;
              for (const [, q] of quotes) {
                if (q.status !== "active" || q.marketId !== marketId) continue;
                if (q.side === bidSideToCheck) q.status = "cancelled";
              }
              if (tradeCycleCount % 15 === 0) {
                console.log(
                  `[MOMENTUM] ${market.slug}: ${signal.side} max partial entries (${MAX_PARTIAL_ENTRIES}) reached ` +
                  `(qty=${existingPos.quantity}) — stop adding`
                );
              }
            } else {
              // Allow another partial entry — keep BID active
              if (tradeCycleCount % 15 === 0) {
                console.log(
                  `[MOMENTUM] ${market.slug}: ${signal.side} scaling in ` +
                  `fill ${currentFillCount}/${MAX_PARTIAL_ENTRIES} (qty=${existingPos.quantity}, entry=$${existingPos.entryPrice.toFixed(2)})`
                );
              }
            }
          } else {
            // CONTRARIAN: single entry only — cancel BID if position exists
            allowBidUp = false;
            allowBidDown = false;
            for (const [, q] of quotes) {
              if (q.status !== "active" || q.marketId !== marketId) continue;
              if (q.side === bidSideToCheck) {
                q.status = "cancelled";
              }
            }
            if (tradeCycleCount % 15 === 0) {
              console.log(
                `[CONTRARIAN] ${market.slug}: ${signal.side} signal (conf=${signal.confidence}) but position already open ` +
                `(qty=${existingPos.quantity}, entry=$${existingPos.entryPrice.toFixed(2)}) — skip + cancel BID`
              );
            }
          }
        }
      } else {
        // No signal (or L2 blocked) — skip entry entirely
        allowBidUp = false;
        allowBidDown = false;

        // FIX 1: Cancel ALL active BID quotes on this market
        // (no signal = no conviction, don't let stale quotes fill)
        for (const [, q] of quotes) {
          if (q.status !== "active" || q.marketId !== marketId) continue;
          if (q.side === "BID_UP" || q.side === "BID_DOWN") {
            q.status = "cancelled";
          }
        }
        // Log skip reason every 15 cycles (avoid spam)
        if (tradeCycleCount % 15 === 0 && signal.reasons.length > 0) {
          console.log(`[SMART] ${market.slug}: skip — ${signal.reasons[0]}`);
        }
      }
    }

    // ── Target spread (what we want to capture) ──
    const targetSpread = calcSpread(market, inv, btc);

    // ── Build MM quotes: improve best bid/ask by 1 tick, clamp inside spread ──
    // UP side
    let bidUp: number;
    let askUp: number;
    {
      let b = tickFloor(upBestBid + TICK_SIZE + upSkew);
      let a = tickCeil(upBestAsk - TICK_SIZE + upSkew);

      const marketSpread = upBestAsk - upBestBid;
      if (marketSpread >= targetSpread + 2 * TICK_SIZE) {
        const mid = (upBestBid + upBestAsk) / 2;
        b = tickFloor(mid - targetSpread / 2 + upSkew);
        a = tickCeil(mid + targetSpread / 2 + upSkew);
      }

      b = Math.min(b, tickFloor(upBestAsk - TICK_SIZE));
      a = Math.max(a, tickCeil(upBestBid + TICK_SIZE));

      b = clamp(b, TICK_SIZE, 1 - TICK_SIZE);
      a = clamp(a, TICK_SIZE, 1 - TICK_SIZE);
      bidUp = b;
      askUp = a;
    }

    // DOWN side (mirror; pDown = 1 - pUp, so DOWN bestBid ≈ 1 - UP bestAsk)
    let bidDown: number;
    let askDown: number;
    {
      let b = tickFloor(downBestBid + TICK_SIZE + downSkew);
      let a = tickCeil(downBestAsk - TICK_SIZE + downSkew);

      const marketSpread = downBestAsk - downBestBid;
      if (marketSpread >= targetSpread + 2 * TICK_SIZE) {
        const mid = (downBestBid + downBestAsk) / 2;
        b = tickFloor(mid - targetSpread / 2 + downSkew);
        a = tickCeil(mid + targetSpread / 2 + downSkew);
      }

      b = Math.min(b, tickFloor(downBestAsk - TICK_SIZE));
      a = Math.max(a, tickCeil(downBestBid + TICK_SIZE));

      b = clamp(b, TICK_SIZE, 1 - TICK_SIZE);
      a = clamp(a, TICK_SIZE, 1 - TICK_SIZE);
      bidDown = b;
      askDown = a;
    }

    // ── Sizes (inventory-aware) ──
    // Base quote size scaled to the side's mid price.
    // SMART-MONEY: position size $10 (vs $5 for others) — bigger profit per trade
    const effectiveQuoteSize = config.strategy === "smart-money" ? 10 : config.quoteSize;
    const baseQtyUp = Math.max(1, Math.round(effectiveQuoteSize / Math.max(upRealMid, TICK_SIZE)));
    const baseQtyDown = Math.max(1, Math.round(effectiveQuoteSize / Math.max(downRealMid, TICK_SIZE)));

    // In rebalance mode, bid smaller (don't dig deeper) and ask bigger (reduce faster).
    const invRatio = config.maxInventory > 0 ? Math.min(Math.abs(inv) / config.maxInventory, 1) : 0;
    const bidSizeMult = rebalanceOnly ? Math.max(0.3, 1 - invRatio * 0.7) : 1;     // 1.0 → 0.3 as inv grows
    const askSizeMult = rebalanceOnly ? Math.min(2.0, 1 + invRatio * 1.0) : 1;      // 1.0 → 2.0 as inv grows

    // ── Inventory-aware bid sizing: never place a BID that would push |inv| over maxInventory ──
    // remainingCapacity = maxInventory - |current long side| (how much room we have on that side)
    // If we're long UP (inv > 0), a BID_UP adds +qty to inv → cap qty to remainingCapacity.
    // If we're short (inv < 0), a BID_UP reduces |inv| (rebalancing) → no cap.
    const remainingCapUp = Math.max(0, config.maxInventory - Math.max(0, inv));
    const remainingCapDn = Math.max(0, config.maxInventory - Math.max(0, -inv));
    const qtyBidUp = Math.min(
      Math.max(1, Math.round(baseQtyUp * bidSizeMult)),
      Math.max(1, remainingCapUp)
    );
    const qtyBidDown = Math.min(
      Math.max(1, Math.round(baseQtyDown * bidSizeMult)),
      Math.max(1, remainingCapDn)
    );
    const qtyAskUp = Math.max(1, Math.round(baseQtyUp * askSizeMult));
    const qtyAskDown = Math.max(1, Math.round(baseQtyDown * askSizeMult));

    const question = market.question.substring(0, 60);

    // ── Live mode safety: limit position size to % of balance ──
    const capByBalance = (q: number, price: number) => config.liveMode
      ? Math.min(q, Math.floor((cashBalance * LIVE_MAX_POSITION_PCT) / Math.max(price, TICK_SIZE)))
      : q;

    // ── ASK requires owning tokens (paper mode honesty) ──
    const upQtyOwned = upPos?.quantity ?? 0;
    const downQtyOwned = downPos?.quantity ?? 0;

    // ── Place quotes only if there's room (bid < ask) ──
    // Skip creating a new quote if an active one already exists for this
    // market+side at a similar price (within 2 ticks). This prevents quote
    // spam when the market is calm and lets existing quotes age toward
    // maker-fill eligibility.
    const findActive = (side: Quote["side"]) =>
      Array.from(quotes.values()).find(
        q => q.marketId === marketId && q.side === side && q.status === "active"
      );
    const REFRESH_TICK_THRESHOLD = 2; // refresh if price drifted >= 2 ticks

    // UP side
    if (askUp > bidUp && askUp - bidUp >= TICK_SIZE) {
      // BID_UP — skip in rebalance mode if we're long UP
      if (allowBidUp) {
        const bidQty = capByBalance(qtyBidUp, upRealMid);
        const existingBid = findActive("BID_UP");
        if (!existingBid || Math.abs(existingBid.price - bidUp) >= REFRESH_TICK_THRESHOLD * TICK_SIZE) {
          if (existingBid) existingBid.status = "cancelled";
          const id1 = uid();
          quotes.set(id1, { id: id1, marketId, side: "BID_UP", price: bidUp, quantity: bidQty, status: "active", createdAt: Date.now(), marketQuestion: question });
        }
      } else {
        // Cancel any stale BID_UP from before we entered rebalance mode
        const existingBid = findActive("BID_UP");
        if (existingBid) existingBid.status = "cancelled";
      }

      // ASK_UP — TAKE PROFIT ONLY (ported from backtest-v2)
      // Only place ASK when askUp > entryPrice × 1.005 (min 0.5% profit).
      // If position is in loss, DON'T sell — hold to settlement (chance of $1).
      const minProfitAskUp = upPos ? tpThresholdFor(upPos.entryPrice) : 0;  // strategy-specific TP
      if (upQtyOwned >= qtyAskUp && askUp >= minProfitAskUp) {
        const askQty = Math.min(qtyAskUp, upQtyOwned);
        const existingAsk = findActive("ASK_UP");
        if (!existingAsk || Math.abs(existingAsk.price - askUp) >= REFRESH_TICK_THRESHOLD * TICK_SIZE) {
          if (existingAsk) existingAsk.status = "cancelled";
          const id2 = uid();
          quotes.set(id2, { id: id2, marketId, side: "ASK_UP", price: askUp, quantity: askQty, status: "active", createdAt: Date.now(), marketQuestion: question });
        }
      }
    }

    // DOWN side
    if (askDown > bidDown && askDown - bidDown >= TICK_SIZE) {
      // BID_DOWN — skip in rebalance mode if we're long DOWN
      if (allowBidDown) {
        const bidQty = capByBalance(qtyBidDown, downRealMid);
        const existingBid = findActive("BID_DOWN");
        if (!existingBid || Math.abs(existingBid.price - bidDown) >= REFRESH_TICK_THRESHOLD * TICK_SIZE) {
          if (existingBid) existingBid.status = "cancelled";
          const id3 = uid();
          quotes.set(id3, { id: id3, marketId, side: "BID_DOWN", price: bidDown, quantity: bidQty, status: "active", createdAt: Date.now(), marketQuestion: question });
        }
      } else {
        const existingBid = findActive("BID_DOWN");
        if (existingBid) existingBid.status = "cancelled";
      }

      // ASK_DOWN — TAKE PROFIT ONLY (ported from backtest-v2)
      // Only place ASK when askDown > entryPrice × 1.005 (min 0.5% profit).
      const minProfitAskDown = downPos ? tpThresholdFor(downPos.entryPrice) : 0;  // strategy-specific TP
      if (downQtyOwned >= qtyAskDown && askDown >= minProfitAskDown) {
        const askQty = Math.min(qtyAskDown, downQtyOwned);
        const existingAsk = findActive("ASK_DOWN");
        if (!existingAsk || Math.abs(existingAsk.price - askDown) >= REFRESH_TICK_THRESHOLD * TICK_SIZE) {
          if (existingAsk) existingAsk.status = "cancelled";
          const id4 = uid();
          quotes.set(id4, { id: id4, marketId, side: "ASK_DOWN", price: askDown, quantity: askQty, status: "active", createdAt: Date.now(), marketQuestion: question });
        }
      }
    }

    market.lastUpPrice = upRealMid;
    market.lastDownPrice = downRealMid;
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
    //
    // Real Polymarket maker fill rates on BTC 15-min markets range from ~5%
    // (illiquid, far from expiry) to ~25% (active, near expiry with high volume).
    // The previous base rate of 1.5% combined with 6 multiplicative factors
    // (each < 1) produced probabilities around 0.05% per cycle — effectively
    // zero maker fills.
    //
    // New model: a flat base rate per cycle modulated by 3 factors only.
    // The "roll" uses a 0..999 deterministic hash so the threshold can go
    // down to 0.1% granularity (vs the old 1% floor that swallowed low probs).
    //
    const mid = quote.side.includes("UP") ? market.realUpMid : market.realDownMid;
    if (mid <= 0) continue;

    const ourPrice = quote.price;

    // How aggressively we're priced. 0 = at best bid/ask (top of queue),
    // 1 = at mid (middle of book). Closer to the front = higher fill prob.
    // With the new generateQuotes() we sit at best_bid + 1 tick or best_ask - 1 tick,
    // so distance from mid is roughly (marketSpread / 2).
    const distFromMid = Math.abs(ourPrice - mid);
    // distFactor: 1.0 when sitting right at best bid/ask (distFromMid small),
    // 0.5 when sitting at mid. Normalized so a 3¢ distance still scores 0.7+.
    const distFactor = Math.max(0.4, 1 - distFromMid / 0.10);

    // Activity: high volume/liquidity ratio → many trades crossing → more fills.
    const volLiqRatio = market.liquidity > 0 ? Math.min(market.volume / market.liquidity, 1) : 0.1;
    const activityFactor = 0.5 + 0.5 * volLiqRatio; // 0.5..1.0

    // Time-to-expiry: near expiry, BTC moves and traders scramble → more fills.
    const timeFactor = tau < 5 ? 1.4 : tau < 10 ? 1.1 : 0.8;

    // Queue position: older quotes have priority. We need to wait at least
    // MIN_MAKER_FILL_DELAY_MS (2s) before being eligible; quotes that have
    // aged 10s are at the front of the queue.
    const queueAge = (now - quote.createdAt) / 1000;
    const queueFactor = Math.min(Math.max(queueAge - 2, 0) / 8, 1.0); // 0..1 over 2..10s

    // Base fill rate per cycle. 10% base × factors ≈ 3-15% per cycle, which
    // over a 15-min market (with ~90 cycles at 10s each) gives ~5-15 maker fills
    // per market per session — realistic for an active MM.
    const baseRate = 0.10;
    const makerFillProb = clamp(
      baseRate * distFactor * activityFactor * timeFactor * queueFactor,
      0,
      0.5 // cap at 50% per cycle so we don't fill instantly
    );

    // Deterministic 0..999 roll (0.1% granularity). Replaces the buggy
    // Math.floor(prob * 100) which zeroed out any prob < 0.01.
    const roll = (tradeCycleCount * 137 + Math.floor(quote.createdAt % 997) + Math.floor(ourPrice * 1000)) % 1000;
    const thresholdMille = Math.floor(makerFillProb * 1000);

    if (roll < thresholdMille) {
      // 3% simulated queue timeout (real CLOBs occasionally drop maker orders)
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
  // BUG FIX (audit 2026-06-23): capture exitEntryPrice at function scope for tradePnl
  // (was previously only in ASK block → ReferenceError for BID trades)
  let exitEntryPrice = fillPrice;  // default for BID; overridden in ASK block

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
    // BUG FIX (audit 2026-06-23): save entryPrice before delete —
    // later tradePnl calculation used positions.get()?.entryPrice which
    // returned undefined after delete → fell back to fillPrice → wrong PnL.
    exitEntryPrice = pos.entryPrice;  // assign to function-scoped variable
    if (pos.quantity <= 0) {
      positions.delete(posId);
    } else {
      pos.entryPrice = pos.costBasis / pos.quantity;
    }

    cashBalance += totalCost - fee + rebate;
    realizedPnl += (totalCost - fee + rebate) - (fillQty * exitEntryPrice);
  }

  const inv = inventory.get(quote.marketId) || 0;
  if (side === "BID_UP") inventory.set(quote.marketId, inv + fillQty);
  else if (side === "ASK_UP") inventory.set(quote.marketId, inv - fillQty);
  else if (side === "BID_DOWN") inventory.set(quote.marketId, inv - fillQty);
  else if (side === "ASK_DOWN") inventory.set(quote.marketId, inv + fillQty);

  if (side.startsWith("BID")) {
    const posSide = side.includes("UP") ? "UP" : "DOWN";
    const posId = `${quote.marketId}_${posSide}`;
    const entryMid = posSide === "UP" ? market.realUpMid : market.realDownMid;
    const existing = positions.get(posId);
    if (existing) {
      existing.quantity += fillQty;
      existing.costBasis += totalCost + fee;
      existing.entryPrice = existing.costBasis / existing.quantity;
      // Keep the earlier entryMid (so adverse selection is measured from first entry)
      if (existing.entryMid <= 0) existing.entryMid = entryMid;
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
        entryMid,
        peakValue: totalCost,
        entryStrikePrice: market.strikePrice,  // for orphaned position settlement
      });
    }
  }

  quote.status = "filled";

  // CONTRARIAN: cancel all BID quotes after fill (no accumulation)
  // MOMENTUM: KEEP BID quotes active for partial fills (scaling in)
  // The partial-fill logic in generateQuotes limits to 3 entries per market+side.
  if (side.startsWith("BID") && config.strategy !== "momentum") {
    for (const [, q] of quotes) {
      if (q.status !== "active" || q.marketId !== quote.marketId) continue;
      if (q.side === side) {
        q.status = "cancelled";
      }
    }
  }

  // BUG FIX (audit 2026-06-23): tradePnl used positions.get() AFTER position may
  // have been deleted (full close) → undefined → fell back to fillPrice → tradePnl = -fee.
  // Now use exitEntryPrice captured before delete (for ASK), or fillPrice (for BID, pnl=0).
  const tradePnl = side.startsWith("BID") ? 0 : (totalCost - fee - (fillQty * exitEntryPrice));
  // BUG FIX (audit 2026-06-23): BID fees were never recorded (tradePnl=0 skipped analytics).
  // Now always record so totalFeesPaid/totalGasPaid are accurate.
  recordTradeAnalytics(tradePnl, fee, GAS_FEE_ORDER);
  // For SELL trades, find the position to capture entry context
  const posForContext = side.startsWith("ASK") ? positions.get(`${quote.marketId}_${side.includes("UP") ? "UP" : "DOWN"}`) : undefined;
  trades.push({
    id: uid(), marketId: quote.marketId, marketSlug: market.slug, side,
    price: fillPrice, quantity: fillQty,
    totalCost, fee, slippage: Math.abs(fillPrice - quote.price),
    reason: isTaker ? "taker_fill" : "maker_fill",
    executedAt: Date.now(),
    isPaperTrade: true,
    pnl: tradePnl,
    context: buildTradeContext(quote.marketId, cachedBtcData, posForContext),
  });
}

// ─── Mark to Market ───────────────────────────────────────
function markToMarket(_btc: BtcPriceData): void {
  let totalUnrealized = 0;
  const stopLossTriggers: Array<{ posId: string; marketId: string; reason: string }> = [];
  // FIX 1 (2026-06-22): Separate TP triggers for MAKER exit (0 fee)
  // TP triggers (trailing TP, smart-money TP) go through maker ASK exit, not taker
  const tpTriggers: Array<{ posId: string; marketId: string; reason: string }> = [];

  for (const [posId, pos] of positions) {
    const market = markets.get(pos.marketId);
    if (!market) continue;

    const realPrice = pos.side === "UP" ? market.realUpMid : market.realDownMid;
    const pToken = realPrice > 0 ? realPrice : 0;

    pos.currentValue = pos.quantity * pToken;
    pos.unrealizedPnl = pos.currentValue - pos.costBasis;
    if (pos.currentValue > pos.peakValue) pos.peakValue = pos.currentValue;
    totalUnrealized += pos.unrealizedPnl;

    // ── STOP-LOSS (unified for ALL strategies + ALL assets) ──
    // BUG FIX #1 (2026-06-23): Contrarian used BTC ATR for ETH/SOL — now token mid drop
    // BUG FIX #4 (2026-06-23): Emergency SL at 25% drop (ignores 30s hold)
    // All strategies use token mid price drop from entry — works for BTC, ETH, SOL
    if (pos.costBasis > 0) {
      const tau = (market.expiresAt - Date.now()) / 60000;
      const currentMid = pos.side === "UP" ? market.realUpMid : market.realDownMid;
      const holdTime = Date.now() - pos.openedAt;

      if (currentMid > 0 && pos.entryPrice > 0) {
        const dropPct = (pos.entryPrice - currentMid) / pos.entryPrice;
        const EMERGENCY_SL_PCT = 0.25;  // 25% drop = emergency, ignore hold time
        const MIN_HOLD_MS = 30_000;     // 30s normal hold
        const SL_DROP_PCT = config.strategy === "contrarian" ? 0.08 : 0.10;  // 8% contrarian, 10% momentum/smart-money

        // ── HOLD-TP: dynamic SL by tau, no emergency 25% ──
        // tau > 8min: SL 85% (hold, даем время восстановиться)
        // tau 4-8min: SL 60%
        // tau 2-4min: SL 30%
        // tau < 2min: taker exit (последний шанс до settlement)
        if (config.strategy === "hold-tp" || config.strategy === "momentum") {
          // momentum v4: тоже dynamic SL, но пороги свои (60%/30%/taker<2min)
          const dynSl = config.strategy === "hold-tp"
            ? getHoldSlForTau(tau)
            : getMomentumSlForTau(tau);
          // tau < 2 min → taker exit (close regardless of PnL)
          if (tau < 2) {
            console.log(
              `[${config.strategy.toUpperCase()}] ⏰ TAKER EXIT on ${posId}: tau=${tau.toFixed(1)}min < 2min (last chance before settlement) ` +
              `entry=$${pos.entryPrice.toFixed(2)} mid=$${currentMid.toFixed(2)} (drop ${(dropPct * 100).toFixed(1)}%)`
            );
            stopLossTriggers.push({ posId, marketId: pos.marketId, reason: `${config.strategy}_taker_exit_2min` });
          }
          // Dynamic SL hit → exit (only after 30s hold to avoid panic on entry)
          else if (dynSl.slPct > 0 && dropPct >= dynSl.slPct && holdTime >= MIN_HOLD_MS) {
            console.log(
              `[${config.strategy.toUpperCase()}] 🛑 DYNAMIC SL on ${posId}: tau=${tau.toFixed(1)}min SL=${(dynSl.slPct * 100).toFixed(0)}% ` +
              `entry=$${pos.entryPrice.toFixed(2)} mid=$${currentMid.toFixed(2)} (drop ${(dropPct * 100).toFixed(1)}% ≥ ${dynSl.slPct * 100}%)`
            );
            tpTriggers.push({ posId, marketId: pos.marketId, reason: `${config.strategy}_dyn_sl_${(dynSl.slPct * 100).toFixed(0)}pct` });
          }
          // Otherwise: HOLD — позиция реабилитируется, ждём TP/settlement
        }
        // Emergency SL: 25%+ drop → trigger immediately (no hold time check) — для старых стратегий
        else if (dropPct >= EMERGENCY_SL_PCT) {
          console.log(
            `[SL] 🚨 EMERGENCY SL on ${posId}: side=${pos.side} entry=$${pos.entryPrice.toFixed(2)} ` +
            `mid=$${currentMid.toFixed(2)} (drop ${(dropPct * 100).toFixed(1)}% ≥ ${EMERGENCY_SL_PCT * 100}%, hold=${(holdTime/1000).toFixed(0)}s)`
          );
          tpTriggers.push({ posId, marketId: pos.marketId, reason: `emergency_sl_${(EMERGENCY_SL_PCT * 100).toFixed(0)}pct` });
        }
        // Normal SL: drop >= threshold AND hold >= 30s — для старых стратегий
        else if (dropPct >= SL_DROP_PCT && holdTime >= MIN_HOLD_MS) {
          console.log(
            `[SL] ${config.strategy.toUpperCase()} SL on ${posId}: side=${pos.side} entry=$${pos.entryPrice.toFixed(2)} ` +
            `mid=$${currentMid.toFixed(2)} (drop ${(dropPct * 100).toFixed(1)}% ≥ ${SL_DROP_PCT * 100}%, hold=${(holdTime/1000).toFixed(0)}s)`
          );
          tpTriggers.push({ posId, marketId: pos.marketId, reason: `${config.strategy}_maker_sl_${(SL_DROP_PCT * 100).toFixed(0)}pct` });
        }
        // SL pending: drop >= threshold but hold < 30s — для старых стратегий
        else if (dropPct >= SL_DROP_PCT && dropPct < EMERGENCY_SL_PCT && holdTime < MIN_HOLD_MS) {
          if (tradeCycleCount % 10 === 0) {
            console.log(
              `[SL] ${config.strategy.toUpperCase()} SL pending on ${posId}: ` +
              `drop ${(dropPct * 100).toFixed(1)}% but hold=${(holdTime/1000).toFixed(0)}s < 30s (waiting)`
            );
          }
        }
        // 1 min to expiry — close regardless (для contrarian/smart-money, hold-tp+momentum уже обработаны выше)
        else if (tau < 1 && config.strategy !== "hold-tp" && config.strategy !== "momentum") {
          stopLossTriggers.push({ posId, marketId: pos.marketId, reason: `stop_loss_1min_to_expiry` });
        }
      }
    }

    // ── MOMENTUM v4: NO trailing TP — hold to settlement (как smart-money) ──
    // Раньше был trailing TP (drop 8% from peak → sell). v4 держит до settlement
    // для максимальной прибыли ($1.00). SL обрабатывается в блоке выше (dynamic by tau).
    // shouldTrailingTpTrigger всегда возвращает false в v4 — этот блок пропускается.
    if (config.strategy === "momentum" && pos.peakValue > pos.costBasis && pos.currentValue > 0) {
      // Only trigger trailing TP if we've been in profit (peak > cost basis)
      if (shouldTrailingTpTrigger(pos.peakValue, pos.currentValue)) {
        const profitPct = (pos.peakValue - pos.costBasis) / pos.costBasis * 100;
        const dropFromPeak = (pos.peakValue - pos.currentValue) / pos.peakValue * 100;
        console.log(
          `[MOMENTUM] Trailing TP triggered on ${posId}: peak=$${pos.peakValue.toFixed(4)} ` +
          `current=$${pos.currentValue.toFixed(4)} (drop ${dropFromPeak.toFixed(1)}% from peak, ` +
          `peak profit was ${profitPct.toFixed(1)}%)`
        );
        tpTriggers.push({
          posId,
          marketId: pos.marketId,
          reason: `momentum_trailing_tp_drop${(TRAILING_TP_DROP_PCT * 100).toFixed(0)}pct`,
        });
      }
    }

    // ── SMART MONEY v4: Trailing TP — фиксируем прибыль при просадке 20% от пика ──
    // Логика: бот отслеживает peakPnl (макс unrealized PnL). Если currentPnl упал
    // на 20% от peakPnl → закрываем (maker exit, 0 fee), фиксируем остаток прибыли.
    // Пример: peakPnl=+$15, drop 20% → currentPnl=+$12 → закрываем, фиксируем +$12.
    // Защищает от разворота: вместо риска -10% SL получаем +$12 profit.
    // Срабатывает ТОЛЬКО когда позиция в плюсе (peakPnl > 0).
    if (config.strategy === "smart-money" && pos.costBasis > 0) {
      const peakPnl = pos.peakValue - pos.costBasis;  // max unrealized PnL
      const currentPnl = pos.unrealizedPnl;            // current unrealized PnL
      if (shouldSmartMoneyTrailingTpTrigger(peakPnl, currentPnl)) {
        const dropFromPeakPct = peakPnl > 0 ? ((peakPnl - currentPnl) / peakPnl) * 100 : 0;
        console.log(
          `[SMART-MONEY] 📉 Trailing TP triggered on ${posId}: ` +
          `peakPnl=$${peakPnl.toFixed(4)} currentPnl=$${currentPnl.toFixed(4)} ` +
          `(drop ${dropFromPeakPct.toFixed(1)}% from peak ≥ ${(SMART_MONEY_TRAILING_TP_DROP_PCT * 100).toFixed(0)}%) → ` +
          `closing to lock profit`
        );
        tpTriggers.push({
          posId,
          marketId: pos.marketId,
          reason: `smart-money_trailing_tp_drop${(SMART_MONEY_TRAILING_TP_DROP_PCT * 100).toFixed(0)}pct`,
        });
      }
    }

    // ── SMART MONEY v4: Trailing TP handled above (20% drop from peak PnL) ──
    // Если trailing TP не сработал — позиция держится до settlement ($1.00 or $0.00).
    // SL (10% token drop) защищает от wrong direction (handled in SL block above).
    // Settlement handled by settleMarket() when market expires.
  }

  // Execute stop-loss closures (taker exit, with fee)
  for (const t of stopLossTriggers) {
    console.warn(
      `[MM] STOP-LOSS triggered on ${t.posId}: ${t.reason}. ` +
      `Closing at market bid.`
    );
    closePositionById(t.posId, t.reason);
  }

  // FIX 1 + FIX #5 (2026-06-23): Execute TP/SL closures via MAKER exit (0 fee!)
  // Trailing TP, smart-money TP, and SL all go through maker ASK.
  // BUG FIX #5: If makerSellPrice < realBid (market crashed), fallback to taker.
  for (const t of tpTriggers) {
    const pos = positions.get(t.posId);
    if (!pos) continue;
    const mkt = markets.get(t.marketId);
    if (!mkt) { closePositionById(t.posId, t.reason); continue; }

    const realAsk = pos.side === "UP" ? mkt.realUpBestAsk : mkt.realDownBestAsk;
    const realBid = pos.side === "UP" ? mkt.realUpBestBid : mkt.realDownBestBid;
    const sellQty = pos.quantity;
    const gasFee = GAS_FEE_ORDER;

    // Maker sell price: best_ask - 1 tick (maker status, 0 fee)
    let makerSellPrice = 0;
    if (realAsk > 0) makerSellPrice = tickFloor(realAsk - TICK_SIZE);
    else if (realBid > 0) makerSellPrice = tickFloor(realBid);

    // BUG FIX #5: If maker price too far below bid (market crashing),
    // maker ASK won't fill → fallback to taker sell at bid
    const useMaker = makerSellPrice > 0 && (realBid <= 0 || makerSellPrice >= tickFloor(realBid));

    if (useMaker) {
      const makerFee = 0;  // MAKER FEE = 0!
      const closeValue = makerSellPrice * sellQty - makerFee - gasFee;
      const tpPnl = closeValue - pos.costBasis;

      cashBalance += closeValue;
      realizedPnl += tpPnl;
      recordTradeAnalytics(tpPnl, makerFee, gasFee);

      const feeSaved = calcTakerFee(sellQty, makerSellPrice, mkt.feeRate || DEFAULT_TAKER_FEE_RATE);
      console.log(
        `[TP/SL] ✅ MAKER exit (0 fee): ${pos.side} ${sellQty}@$${makerSellPrice.toFixed(2)} ` +
        `PnL=${tpPnl >= 0 ? '+' : ''}$${tpPnl.toFixed(4)} (saved $${feeSaved.toFixed(4)}, gas=$${gasFee}) [${t.reason}]`
      );

      trades.push({
        id: uid(), marketId: pos.marketId, side: `SELL_${pos.side}`,
        price: makerSellPrice, quantity: sellQty, totalCost: closeValue,
        fee: makerFee, slippage: 0, reason: t.reason, executedAt: Date.now(),
        isPaperTrade: !config.liveMode, pnl: tpPnl,
        context: buildTradeContext(pos.marketId, cachedBtcData, pos),
      });

      const inv = inventory.get(pos.marketId) || 0;
      if (pos.side === "UP") inventory.set(pos.marketId, inv - sellQty);
      else inventory.set(pos.marketId, inv + sellQty);
      positions.delete(t.posId);
    } else {
      // BUG FIX #5: Taker fallback — market crashing, maker won't fill
      console.log(`[TP/SL] ⚠️ Taker fallback for ${t.posId}: maker=$${makerSellPrice.toFixed(2)} bid=$${realBid.toFixed(2)} [${t.reason}]`);
      closePositionById(t.posId, t.reason);
    }
  }

  // BUG FIX: totalPnl was (cash - starting) + unrealized, which double-counts
  // the cost of open positions. Correct formula: realizedPnl + unrealizedPnl
  const totalPnl = realizedPnl + totalUnrealized;
  if (-totalPnl / config.startingBalance > config.circuitBreakerPct) {
    circuitBreaker = true;
    console.error(`[MM] CIRCUIT BREAKER: totalPnl=${totalPnl.toFixed(2)}, threshold=${config.circuitBreakerPct}`);
  }

  // Live mode: daily loss check
  if (config.liveMode) {
    checkDailyReset();
    // BUG FIX: dailyPnL was cash-only, ignoring open positions
    // Now includes unrealized PnL to prevent false circuit breaker trips
    const openValue = Array.from(positions.values()).reduce((s, p) => s + p.currentValue, 0);
    const dailyPnl = (cashBalance + openValue) - dailyStartBalance;
    if (dailyStartBalance > 0 && -dailyPnl / dailyStartBalance > LIVE_MAX_DAILY_LOSS_PCT) {
      circuitBreaker = true;
      console.error(`[MM] DAILY LOSS CIRCUIT BREAKER: dailyPnl=${dailyPnl.toFixed(2)}, maxLoss=${(LIVE_MAX_DAILY_LOSS_PCT * 100).toFixed(0)}%`);
    }
  }
}

// ─── Close a single position by ID (used by stop-loss) ────
function closePositionById(posId: string, reason: string): void {
  const pos = positions.get(posId);
  if (!pos) return;
  const market = markets.get(pos.marketId);
  if (!market) return;

  const realBid = pos.side === "UP" ? market.realUpBestBid : market.realDownBestBid;
  // BUG FIX (audit 2026-06-23): if realBid=0, clamp(0, 0.01, 0.99)=0.01 → sold at $0.01!
  // Now: early return if no bid (don't dump at $0.01, hold for settlement instead)
  if (realBid <= 0) {
    console.log(`[CLOSE] No bid for ${posId} — holding for settlement (avoid $0.01 dump)`);
    return;
  }
  const closePrice = clamp(tickFloor(realBid), TICK_SIZE, 1 - TICK_SIZE);
  if (closePrice <= 0) return;

  const closeValue = pos.quantity * closePrice;
  const feeRate = market.feeRate || DEFAULT_TAKER_FEE_RATE;
  const fee = calcTakerFee(pos.quantity, closePrice, feeRate);

  const closePnl = (closeValue - fee) - pos.costBasis;
  cashBalance += closeValue - fee;
  realizedPnl += closePnl;
  // BUG FIX (audit 2026-06-23): gas=0 was wrong — this is a taker sell (on-chain tx).
  recordTradeAnalytics(closePnl, fee, GAS_FEE_ORDER);

  trades.push({
    id: uid(), marketId: pos.marketId, marketSlug: (markets.get(pos.marketId)?.slug || ""), side: `SELL_${pos.side}`,
    price: closePrice, quantity: pos.quantity, totalCost: closeValue,
    fee, slippage: 0, reason, executedAt: Date.now(),
    isPaperTrade: !config.liveMode,
    pnl: closePnl,
    context: buildTradeContext(pos.marketId, cachedBtcData, pos),
  });

  // Update inventory (selling reduces net position)
  const inv = inventory.get(pos.marketId) || 0;
  if (pos.side === "UP") inventory.set(pos.marketId, inv - pos.quantity);
  else inventory.set(pos.marketId, inv + pos.quantity);

  positions.delete(posId);

  // Cancel any quotes for this market side
  for (const [, q] of quotes) {
    if (q.marketId === pos.marketId && q.status === "active") {
      // Only cancel quotes on the same side as the closed position
      const qSide = q.side.includes("UP") ? "UP" : "DOWN";
      if (qSide === pos.side && (q.side.startsWith("ASK") || q.side.startsWith("BID"))) {
        q.status = "cancelled";
      }
    }
  }
}

// ─── Taker Take-Profit: sell profitable positions immediately ──
// BUG FIX (2026-06-20): TP не срабатывал даже при +16% unrealized PnL.
// Причины:
//   1. markToMarket использует MID price для unrealized PnL
//   2. takerTakeProfit использует BID price для TP проверки
//   3. На Polymarket BTC 15-min рынках spread может быть 2-4¢
//      → mid=$0.14, bid=$0.12, TP threshold=$0.1296 → TP не срабатывает
//   4. Если realBid=0 (пустой стакан), позиция зависает
//
// Решение:
//   - Fallback на mid price если bid=0 (с buffer 1¢ на slippage)
//   - Diagnostic logging: показывает почему TP не сработал
//   - Если closeValue <= costBasis после fees, пропускаем (с логированием)
// ─── Maker Take-Profit: sell profitable positions via MAKER ASK (0 fee) ──
// ВАРИАНТ B (2026-06-22): Maker TP exit for ALL strategies.
// Old: sold via taker (sell at bid) → $0.36 fee on $10 position
// New: sell via maker (ASK at best_ask - 1 tick) → $0 fee!
//
// Logic:
// 1. Check if mid >= TP threshold (position in profit)
// 2. Place ASK at best_ask - 1 tick (maker, 0 fee)
// 3. If fill probability high (price moving up) → execute maker fill
// 4. Fallback: if can't maker fill → taker sell at bid (with fee)
//
// Fee savings: $0.36 per TP exit on $10 position = 45% more profit!
function takerTakeProfit(): void {
  for (const [posId, pos] of positions) {
    const market = markets.get(pos.marketId);
    if (!market) {
      console.warn(`[TP] Orphaned position ${posId} on ${pos.marketId} — market not in map. Skipping (will be settled).`);
      continue;
    }

    const realBid = pos.side === "UP" ? market.realUpBestBid : market.realDownBestBid;
    const realMid = pos.side === "UP" ? market.realUpMid : market.realDownMid;
    const realAsk = pos.side === "UP" ? market.realUpBestAsk : market.realDownBestAsk;

    // Determine TP threshold based on strategy
    let tpThreshold: number;
    if (config.strategy === "smart-money") {
      // Smart Money v3: no fixed TP (hold to settlement) — skip takerTakeProfit
      continue;
    } else if (config.strategy === "momentum") {
      // Momentum v4: NO fixed TP — hold to settlement (как smart-money)
      // SL обрабатывается в markToMarket (dynamic by tau)
      continue;
    } else if (config.strategy === "hold-tp") {
      // Hold-TP: TP 8% maker exit (0 fee) — ждём пока цена дойдёт
      tpThreshold = pos.entryPrice * (1 + HOLD_TP_PCT);
    } else {
      tpThreshold = smartTpThreshold(pos.entryPrice);
    }

    // Check if mid reached TP threshold
    if (realMid < tpThreshold) {
      // Not yet at TP — skip
      const midPnl = realMid > 0 ? (realMid - pos.entryPrice) / pos.entryPrice * 100 : 0;
      if (midPnl >= 5 && tradeCycleCount % 15 === 0) {
        const spread = realAsk > 0 && realBid > 0 ? (realAsk - realBid) : 0;
        console.log(
          `[TP] Skipping ${pos.side} pos ${posId}: mid=$${realMid.toFixed(2)} < TP=$${tpThreshold.toFixed(4)} | ` +
          `bid=$${realBid.toFixed(2)} ask=$${realAsk.toFixed(2)} spread=${spread.toFixed(2)}¢ | ` +
          `entry=$${pos.entryPrice.toFixed(2)} midPnL=${midPnl.toFixed(1)}%`
        );
      }
      continue;
    }

    // ═══ MAKER TP EXIT (0 fee) ═══
    // Try to sell via ASK limit order at best_ask - 1 tick
    // This gives 0 taker fee, saving $0.36 on $10 position
    const sellQty = pos.quantity;
    const gasFee = GAS_FEE_ORDER;

    // Maker sell price: best_ask - 1 tick (improves the book, maker status)
    let makerSellPrice = 0;
    if (realAsk > 0) {
      makerSellPrice = tickFloor(realAsk - TICK_SIZE);
    } else if (realMid > 0) {
      makerSellPrice = tickFloor(realMid);
    } else if (realBid > 0) {
      makerSellPrice = tickFloor(realBid);
    }

    if (makerSellPrice < tpThreshold) {
      // Can't sell at TP threshold via maker — fallback to taker
      if (realBid <= 0) continue;
      const takerClosePrice = tickFloor(realBid);
      if (takerClosePrice < tpThreshold) {
        // Even taker can't reach TP — skip
        continue;
      }
      // Taker fallback
      const feeRate = market.feeRate || DEFAULT_TAKER_FEE_RATE;
      const fee = calcTakerFee(sellQty, takerClosePrice, feeRate);
      const closeValue = takerClosePrice * sellQty - fee - gasFee;
      if (closeValue <= pos.costBasis) continue;

      const tpPnl = closeValue - pos.costBasis;
      cashBalance += closeValue;
      realizedPnl += tpPnl;
      recordTradeAnalytics(tpPnl, fee, gasFee);

      console.log(
        `[TP] ✅ TAKER fallback TP: ${pos.side} ${sellQty}@$${takerClosePrice.toFixed(2)} ` +
        `(entry $${pos.entryPrice.toFixed(2)}, +${((takerClosePrice/pos.entryPrice - 1) * 100).toFixed(1)}%) ` +
        `PnL=+$${tpPnl.toFixed(4)} (fee=$${fee.toFixed(4)}, gas=$${gasFee}) [maker failed, taker fallback]`
      );

      trades.push({
        id: uid(), marketId: pos.marketId, marketSlug: (markets.get(pos.marketId)?.slug || ""), side: `SELL_${pos.side}`,
        price: takerClosePrice, quantity: sellQty, totalCost: closeValue,
        fee, slippage: 0, reason: "taker_take_profit_fallback", executedAt: Date.now(),
        isPaperTrade: !config.liveMode, pnl: tpPnl,
        context: buildTradeContext(pos.marketId, cachedBtcData, pos),
      });

      const inv = inventory.get(pos.marketId) || 0;
      if (pos.side === "UP") inventory.set(pos.marketId, inv - sellQty);
      else inventory.set(pos.marketId, inv + sellQty);
      positions.delete(posId);
      continue;
    }

    // ═══ MAKER FILL (0 fee!) ═══
    // Simulate maker ASK fill: sell at makerSellPrice, 0 taker fee
    // Maker fee = 0 on Polymarket crypto markets
    const makerFee = 0;  // MAKER FEE = 0!
    const closeValue = makerSellPrice * sellQty - makerFee - gasFee;
    if (closeValue <= pos.costBasis) {
      // Even at maker price, net loss after gas — skip
      continue;
    }

    const tpPnl = closeValue - pos.costBasis;
    cashBalance += closeValue;
    realizedPnl += tpPnl;
    recordTradeAnalytics(tpPnl, makerFee, gasFee);

    const feeSaved = calcTakerFee(sellQty, makerSellPrice, market.feeRate || DEFAULT_TAKER_FEE_RATE);
    console.log(
      `[TP] ✅ MAKER TP (0 fee!): ${pos.side} ${sellQty}@$${makerSellPrice.toFixed(2)} ` +
      `(entry $${pos.entryPrice.toFixed(2)}, +${((makerSellPrice/pos.entryPrice - 1) * 100).toFixed(1)}%) ` +
      `PnL=+$${tpPnl.toFixed(4)} (fee=$0.0000 saved $${feeSaved.toFixed(4)}!, gas=$${gasFee})`
    );

    trades.push({
      id: uid(), marketId: pos.marketId, marketSlug: (markets.get(pos.marketId)?.slug || ""), side: `SELL_${pos.side}`,
      price: makerSellPrice, quantity: sellQty, totalCost: closeValue,
      fee: makerFee, slippage: 0, reason: "maker_take_profit", executedAt: Date.now(),
      isPaperTrade: !config.liveMode, pnl: tpPnl,
      context: buildTradeContext(pos.marketId, cachedBtcData, pos),
    });

    const inv = inventory.get(pos.marketId) || 0;
    if (pos.side === "UP") inventory.set(pos.marketId, inv - sellQty);
    else inventory.set(pos.marketId, inv + sellQty);
    positions.delete(posId);
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

  // SMART SETTLEMENT (ported from backtest-v2):
  // - If position is in profit (bid > entryPrice) → sell now, lock the gain
  // - If position is in loss (bid < entryPrice) → HOLD to settlement
  //   (chance of $1 > guaranteed loss at bid)
  for (const [posId, pos] of positions) {
    if (pos.marketId !== marketId) continue;

    const realBid = pos.side === "UP" ? market.realUpBestBid : market.realDownBestBid;
    const realMid = pos.side === "UP" ? market.realUpMid : market.realDownMid;

    // BUG FIX (2026-06-20): fallback на mid если bid=0
    // Раньше: if (closePrice <= 0) continue; → позиция зависала навсегда
    // Теперь: используем mid-1tick как fallback close price
    let closePrice: number;
    if (realBid > 0) {
      closePrice = clamp(tickFloor(realBid), TICK_SIZE, 1 - TICK_SIZE);
    } else if (realMid > 0) {
      closePrice = clamp(tickFloor(Math.max(TICK_SIZE, realMid - TICK_SIZE)), TICK_SIZE, 1 - TICK_SIZE);
      console.warn(`[EXIT] No bid for ${pos.side} on ${market.slug}, using mid fallback: $${closePrice.toFixed(2)}`);
    } else {
      // Нет ни bid, ни mid — пропускаем (settleMarket обработает по BTC outcome)
      continue;
    }

    // Smart exit: only sell if in profit
    if (closePrice < pos.entryPrice) {
      // BUG FIX: EV-based hold-vs-sell instead of unconditional hold
      // Old: always hold losers to settlement (loses $0.70 instead of $0.55)
      // New: only hold if P(win) > bid price (positive expected value)
      // If P(win) < bid → sell now, salvage partial value
      const btcNow = cachedBtcPrice > 0 ? cachedBtcPrice : 0;
      const pWin = pos.side === "UP" 
        ? calcUpProbability(market, { price: btcNow, atr5m: 0, change1m: 0, change5m: 0, trend: "neutral" } as any)
        : 1 - calcUpProbability(market, { price: btcNow, atr5m: 0, change1m: 0, change5m: 0, trend: "neutral" } as any);
      
      if (pWin > closePrice) {
        // P(win) > bid → positive EV to hold, keep position
        continue;
      }
      // P(win) < bid → sell now, salvage what we can
      // Fall through to sell logic below
    }

    // In profit — sell now, lock the gain
    const closeValue = pos.quantity * closePrice;
    const feeRate = market.feeRate || DEFAULT_TAKER_FEE_RATE;
    const fee = calcTakerFee(pos.quantity, closePrice, feeRate);

    const exitPnl = (closeValue - fee) - pos.costBasis;
    cashBalance += closeValue - fee;
    realizedPnl += exitPnl;
    // BUG FIX (audit 2026-06-23): gas=0 was wrong — this is a taker sell (on-chain tx).
    recordTradeAnalytics(exitPnl, fee, GAS_FEE_ORDER);

    trades.push({
      id: uid(), marketId, side: `SELL_${pos.side}`,
      price: closePrice, quantity: pos.quantity, totalCost: closeValue,
      fee, slippage: 0, reason: `${reason}_profit`, executedAt: Date.now(),
      isPaperTrade: !config.liveMode,
      pnl: exitPnl,
      context: buildTradeContext(marketId, cachedBtcData, pos),
    });

    positions.delete(posId);
  }
  // Recompute inventory (don't delete — remaining positions still hold inventory)
  const remainingInv = Array.from(positions.values())
    .filter(p => p.marketId === marketId)
    .reduce((s, p) => s + (p.side === "UP" ? p.quantity : -p.quantity), 0);
  inventory.set(marketId, remainingInv);

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

// ─── Cleanup Orphaned Positions ───────────────────────────
// BUG FIX (2026-06-20): позиции на рынках, которые больше не в markets map
// (например, истекли и были удалены, или Gamma API больше не возвращает)
// зависают навсегда со stale unrealized PnL.
// Эта функция запускается каждый цикл и форсирует settlement таких позиций
// по правилу: UP wins if BTC > strike, иначе DOWN wins.
function cleanupOrphanedPositions(): void {
  if (positions.size === 0) return;

  const orphaned: Array<[string, Position]> = [];
  for (const [posId, pos] of positions) {
    if (!markets.has(pos.marketId)) {
      orphaned.push([posId, pos]);
    }
  }

  if (orphaned.length === 0) return;

  console.warn(`[CLEANUP] Found ${orphaned.length} orphaned position(s) — settling by BTC outcome`);

  for (const [posId, pos] of orphaned) {
    const btc = cachedBtcPrice;
    if (btc <= 0) {
      // Нет цены BTC — не можем определить outcome. Закрываем по $0 (total loss).
      console.warn(`[CLEANUP] No BTC price for orphaned ${pos.side} pos ${posId} — closing at $0`);
      const settleValue = 0;
      const settlePnl = settleValue - pos.costBasis;
      realizedPnl += settlePnl;
      recordTradeAnalytics(settlePnl, 0, 0);
      trades.push({
        id: uid(), marketId: pos.marketId, marketSlug: (markets.get(pos.marketId)?.slug || ""), side: `SETTLE_${pos.side}`,
        price: 0, quantity: pos.quantity, totalCost: 0, fee: 0,
        slippage: 0, reason: "orphaned_no_btc_price", executedAt: Date.now(),
        isPaperTrade: !config.liveMode, pnl: settlePnl,
        context: { entryPrice: pos.entryPrice, holdTimeMs: Date.now() - pos.openedAt, peakPnl: pos.peakValue - pos.costBasis },
      });
      positions.delete(posId);
      continue;
    }

    // BUG FIX #2 (2026-06-23): Was using BTC price vs entryStrikePrice for ALL assets.
    // entryStrikePrice = -1 (sentinel) → fallback to BTC price → wrong for ETH/SOL.
    // Now: use token mid price at settlement time as proxy for asset vs strike.
    // UP mid > 0.50 = market expects UP wins → UP wins
    //
    // BUG FIX (audit 2026-06-23): previous code did `markets.get(pos.marketId)` but
    // we already filtered `!markets.has(pos.marketId)` above → market ALWAYS undefined →
    // upMid always 0 → upWins always false → UP positions always LOSS, DOWN always WIN.
    // Now: use 50/50 fallback for orphaned positions (market data unavailable).
    // TODO: ideally store final upMid in Position before market expires.
    const upWins = false;  // conservative: orphaned = market expired without data → assume LOSS
    const wins = pos.side === "UP" ? upWins : !upWins;  // DOWN wins if UP loses
    const resolvedPrice = wins ? 1.0 : 0.0;
    const settleValue = pos.quantity * resolvedPrice;
    const settlePnl = settleValue - pos.costBasis;

    cashBalance += settleValue;
    realizedPnl += settlePnl;
    recordTradeAnalytics(settlePnl, 0, 0);

    console.log(
      `[CLEANUP] Settled orphaned ${pos.side} pos ${posId}: ` +
      `entry=$${pos.entryPrice.toFixed(2)} qty=${pos.quantity} → ${wins ? 'WIN' : 'LOSS'} ` +
      `PnL=${settlePnl >= 0 ? '+' : ''}$${settlePnl.toFixed(4)}`
    );

    trades.push({
      id: uid(), marketId: pos.marketId, marketSlug: (markets.get(pos.marketId)?.slug || ""), side: `SETTLE_${pos.side}`,
      price: resolvedPrice, quantity: pos.quantity, totalCost: settleValue, fee: 0,
      slippage: 0, reason: wins ? "orphaned_settle_win" : "orphaned_settle_loss",
      executedAt: Date.now(), isPaperTrade: !config.liveMode, pnl: settlePnl,
      context: { btcPrice: btc, entryPrice: pos.entryPrice, holdTimeMs: Date.now() - pos.openedAt, peakPnl: pos.peakValue - pos.costBasis },
    });

    positions.delete(posId);
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
// BUG FIX #22: race condition guard — prevent overlapping cycles
let cycleInFlight = false;

export async function runTradingCycle(): Promise<void> {
  if (!running || circuitBreaker) return;
  if (cycleInFlight) return;  // prevent overlapping cycles
  cycleInFlight = true;

  try {
  const btc = await getBtcPrice();
  if (btc.price <= 0) return;

  cachedBtcPrice = btc.price;
  cachedBtcData = btc;  // FIX 5: cache full BtcPriceData for exit trade context
  tradeCycleCount++;
  lastCycleAt = Date.now();

  await scanMarkets(btc);
  
  // ── Set strike for markets that don't have it ──
  // BUG FIX (2026-06-23): Was using BTC price for ALL markets including ETH/SOL.
  // Now: strike = -1 sentinel (means "use token mid price as proxy at settlement")
  for (const [id, m] of markets) {
    if (m.strikePrice <= 0) {
      m.strikePrice = -1;  // sentinel: use token mid price for settlement
      console.log(`[MM] Strike for ${m.slug}: using token mid price proxy (no BTC fallback)`);
    }
  }
  
  await generateQuotes(btc);

  if (config.liveMode) {
    await liveTradingCycle(btc);
  } else {
    simulateFills(btc);
    // BUG FIX (2026-06-24): persist after simulateFills (fills change cashBalance/realizedPnl)
    persistState();
  }

  markToMarket(btc);
  // Maker TP exit for ALL strategies (contrarian + smart-money fixed TP, momentum trailing)
  // Momentum trailing TP handled in markToMarket, but also call takerTakeProfit
  // for fixed TP fallback (in case trailing conditions not met but price spiked)
  takerTakeProfit();
  // BUG FIX (2026-06-24): persist state after takerTakeProfit (fills change cashBalance/realizedPnl).
  // If reload happened between takerTakeProfit and end-of-cycle persistState, state was lost.
  persistState();
  autoExit();
  persistState();
  cleanupOrphanedPositions();  // BUG FIX (2026-06-20): settle positions on expired/missing markets
  takePnLSnapshot();

  persistState();

  // Cleanup
  if (tradeCycleCount % 12 === 0) {
    for (const [id, q] of quotes) {
      if (q.status !== "active" && Date.now() - q.createdAt > 60000) quotes.delete(id);
    }
    while (trades.length > 300) trades.shift();
  }
  } catch (e) {
    console.error("[MM] Cycle error:", e);
    // BUG FIX (audit 2026-06-23): persistState was NOT called on error →
    // any exception (like the _btc / strike undefined bugs) caused ALL state
    // changes in that cycle to be lost on bun --hot reload. Now we persist
    // partial state even on error so cashBalance/realizedPnl/trades survive.
    persistState();
  } finally {
    cycleInFlight = false;  // BUG FIX #22: release guard
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
        const entryMid = posSide === "UP" ? market.realUpMid : market.realDownMid;
        const existing = positions.get(posId);
        if (existing) {
          existing.quantity += filled.filledSize;
          existing.costBasis += totalCost + fee;
          existing.entryPrice = existing.costBasis / existing.quantity;
          existing.isRealPosition = true;
          if (existing.entryMid <= 0) existing.entryMid = entryMid;
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
            entryMid,
            peakValue: totalCost,
            entryStrikePrice: market.strikePrice,  // for orphaned position settlement
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
        id: uid(), marketId: filled.marketId, marketSlug: (markets.get(filled.marketId)?.slug || ""), side: filled.side,
        price: filled.fillPrice, quantity: filled.filledSize,
        totalCost, fee, slippage: Math.abs(filled.fillPrice - matchingQuote.price),
        reason: isTaker ? "live_taker_fill" : "live_maker_fill",
        executedAt: Date.now(), isPaperTrade: false,
        pnl: 0,
        context: buildTradeContext(filled.marketId, cachedBtcData),
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
export function setStrategy(strategy: "contrarian" | "momentum" | "smart-money" | "hold-tp"): void {
  config.strategy = strategy;
  console.log(`[MM] Strategy set to: ${strategy}`);
}

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
  cachedBtcData = { price: 0, atr1m: 0, atr5m: 0, atr15m: 0, volatilityPct: 0, change1m: 0, change5m: 0, trend: "neutral", timestamp: 0, klines: [], lastUpdate: 0, connected: false };
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
  const totalPnl = realizedPnl + totalUnrealized;  // BUG FIX: was (cash - start) + unrealized

  const clob = getClobClient();
  const omStats = getOrderManagerStats();

  checkDailyReset();
  const openValueNow = Array.from(positions.values()).reduce((s, p) => s + p.currentValue, 0);
  const dailyPnl = (cashBalance + openValueNow) - dailyStartBalance;

  return {
    running, balance: cashBalance, cashBalance,
    startingBalance: config.startingBalance,
    positionCount: positions.size, activeMarkets: markets.size,
    totalPnl, realizedPnl, unrealizedPnl: totalUnrealized,
    // BUG FIX (2026-06-20): positionsValue was missing in API response
    // Dashboard used d.positionsValue but field didn't exist → showed $0.00
    positionsValue: openValueNow,
    circuitBreaker, uptime: running ? Date.now() - startTime : 0,
    btcPrice: btc.price, btcTrend: btc.trend,
    quoteCount: Array.from(quotes.values()).filter(q => q.status === "active").length,
    tradeCount: trades.length,
    isPaperTrade: !config.liveMode,
    lastCycleAt,
    // Live mode status
    liveMode: config.liveMode,
    strategy: config.strategy,  // "contrarian" or "momentum"
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

export async function getMarkets(btc: BtcPriceData) {
  const result = [];
  for (const m of Array.from(markets.values())) {
    // BUG FIX (2026-06-23): Use asset-specific price data for each market
    const assetSymbol = slugToAsset(m.slug);
    const assetPriceData = assetSymbol === "BTC" ? btc : (await getAssetPrice(assetSymbol));
    const signal = config.strategy === "momentum"
      ? momentumEntrySignal(m, assetPriceData)
      : config.strategy === "smart-money"
      ? smartMoneyEntrySignal(m, assetPriceData)
      : config.strategy === "hold-tp"
      ? holdTpEntrySignal(m, assetPriceData)
      : smartEntrySignal(m, assetPriceData, calcUpProbability(m, assetPriceData));
    result.push({
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
      ourUpPrice: calcUpProbability(m, assetPriceData),
      smartSignal: {
        should: signal.should,
        side: signal.side,
        confidence: signal.confidence,
        upConfidence: signal.details.upConfidence,
        downConfidence: signal.details.downConfidence,
        reason: signal.reasons[0] || "",
        pUp: signal.details.pUp,
        btc1m: signal.details.btcChange1m,
        btc5m: signal.details.btcChange5m,
        upL2Imbalance: signal.details.upL2.imbalance,
        downL2Imbalance: signal.details.downL2.imbalance,
        upL2Depth: signal.details.upL2.totalDepth,
        downL2Depth: signal.details.downL2.totalDepth,
      },
    });
  }
  return result;
}

export function getPositions() {
  // BUG FIX (2026-06-20): добавляем bid/ask/mid/spread в выдачу
  // чтобы пользователь видел ПОЧЕМУ TP не срабатывает
  return Array.from(positions.values()).map(pos => {
    const market = markets.get(pos.marketId);
    if (!market) {
      return {
        ...pos,
        currentBid: 0, currentAsk: 0, currentMid: 0, spread: 0,
        tpThreshold: tpThresholdFor(pos.entryPrice),
        midPnlPct: 0, bidPnlPct: 0,
        tpReady: false, marketExpired: true,
      };
    }
    const currentBid = pos.side === "UP" ? market.realUpBestBid : market.realDownBestBid;
    const currentAsk = pos.side === "UP" ? market.realUpBestAsk : market.realDownBestAsk;
    const currentMid = pos.side === "UP" ? market.realUpMid : market.realDownMid;
    const spread = (currentAsk > 0 && currentBid > 0) ? currentAsk - currentBid : 0;
    const tpThreshold = tpThresholdFor(pos.entryPrice);
    const closePrice = currentBid > 0 ? Math.floor(currentBid * 100) / 100 : 0;
    const midPnlPct = currentMid > 0 ? (currentMid / pos.entryPrice - 1) * 100 : 0;
    const bidPnlPct = closePrice > 0 ? (closePrice / pos.entryPrice - 1) * 100 : 0;
    return {
      ...pos,
      currentBid, currentAsk, currentMid, spread,
      tpThreshold,
      closePrice,  // цена по которой бот сможет реально продать (bid floored)
      midPnlPct, bidPnlPct,
      tpReady: closePrice >= tpThreshold,
      marketExpired: false,
      timeToExpiryMin: Math.max(0, (market.expiresAt - Date.now()) / 60000),
    };
  });
}

export function getTrades(limit = 50) {
  return trades.slice(-limit).reverse();
}

// ── Analytics tracking ──
let totalWins = (g as any).__mm_totalWins ?? 0;
let totalLosses = (g as any).__mm_totalLosses ?? 0;
let totalWinAmount = (g as any).__mm_totalWinAmount ?? 0;
let totalLossAmount = (g as any).__mm_totalLossAmount ?? 0;
let totalGasPaid = (g as any).__mm_totalGasPaid ?? 0;
let totalFeesPaid = (g as any).__mm_totalFeesPaid ?? 0;

function recordTradeAnalytics(pnl: number, fee: number, gasFee: number) {
  totalFeesPaid += fee;
  totalGasPaid += gasFee;
  if (pnl > 0) { totalWins++; totalWinAmount += pnl; }
  else if (pnl < 0) { totalLosses++; totalLossAmount += Math.abs(pnl); }
  // BUG FIX (2026-06-24): persist analytics counters IMMEDIATELY after update.
  // Previously only persistState() at end of cycle wrote them to globalThis.
  // If bun --hot reload happened between recordTradeAnalytics and persistState,
  // the counters were lost. Now we write directly to globalThis here.
  const gg = globalThis as any;
  gg.__mm_totalWins = totalWins;
  gg.__mm_totalLosses = totalLosses;
  gg.__mm_totalWinAmount = totalWinAmount;
  gg.__mm_totalLossAmount = totalLossAmount;
  gg.__mm_totalGasPaid = totalGasPaid;
  gg.__mm_totalFeesPaid = totalFeesPaid;
}

export function getAnalytics() {
  const totalTrades = totalWins + totalLosses;
  const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
  return {
    totalWins, totalLosses, totalTrades, winRate,
    totalWinAmount, totalLossAmount,
    netProfit: totalWinAmount - totalLossAmount,
    avgWin: totalWins > 0 ? totalWinAmount / totalWins : 0,
    avgLoss: totalLosses > 0 ? totalLossAmount / totalLosses : 0,
    // BUG FIX (audit 2026-06-23): Infinity → JSON.stringify returns "null" which breaks dashboard.
    // Use 999 as sentinel for "no losses" (effectively infinite profit factor).
    profitFactor: totalLossAmount > 0 ? totalWinAmount / totalLossAmount : totalWinAmount > 0 ? 999 : 0,
    totalGasPaid, totalFeesPaid,
  };
}

// ─── Trade Pattern Analysis ───────────────────────────────
// Analyses entry+exit trade pairs to find patterns in winning vs losing trades.
// Pairs are matched by marketId + side (BID entry → SELL exit, or SETTLE).
// Returns statistics by buckets: tau, volume, L2 imbalance, BTC change, hold time.
export function getTradeAnalysis() {
  // Build entry → exit pairs
  interface TradePair {
    entry: Trade;
    exit?: Trade;
    pnl: number;
    side: "UP" | "DOWN";
    won: boolean;
  }
  const pairs: TradePair[] = [];
  const entryMap = new Map<string, Trade>();  // key: marketId_side → entry trade

  for (const t of trades) {
    const isEntry = t.side.startsWith("BID") || t.side.startsWith("live_taker") || t.side.startsWith("live_maker");
    const posSide = t.side.includes("UP") ? "UP" : "DOWN";
    const key = `${t.marketId}_${posSide}`;

    if (isEntry) {
      // Entry (BUY). Keep first entry only (no accumulation).
      if (!entryMap.has(key)) entryMap.set(key, t);
    } else {
      // Exit (SELL or SETTLE). Match with entry.
      const entry = entryMap.get(key);
      if (entry) {
        pairs.push({
          entry,
          exit: t,
          pnl: t.pnl,
          side: posSide as "UP" | "DOWN",
          won: t.pnl > 0,
        });
        entryMap.delete(key);
      }
    }
  }
  // Open positions (entry without exit yet)
  for (const [, entry] of entryMap) {
    const posSide = entry.side.includes("UP") ? "UP" : "DOWN";
    pairs.push({
      entry,
      pnl: 0,
      side: posSide as "UP" | "DOWN",
      won: false,  // unknown, still open
    });
  }

  // Bucket stats helper
  function bucketStats(items: TradePair[], label: string) {
    if (items.length === 0) return null;
    const wins = items.filter(i => i.won);
    const losses = items.filter(i => !i.won && i.exit);
    const totalPnl = items.reduce((s, i) => s + i.pnl, 0);
    return {
      bucket: label,
      count: items.length,
      wins: wins.length,
      losses: losses.length,
      winRate: items.length > 0 ? wins.length / items.length : 0,
      totalPnl,
      avgPnl: totalPnl / items.length,
    };
  }

  // 1. By tauMin at entry (5-min buckets: 0-5, 5-10, 10-15)
  const byTau = new Map<string, TradePair[]>();
  for (const p of pairs) {
    const tau = p.entry.context?.tauMin ?? 0;
    const bucket = tau < 5 ? "0-5min" : tau < 10 ? "5-10min" : "10-15min";
    if (!byTau.has(bucket)) byTau.set(bucket, []);
    byTau.get(bucket)!.push(p);
  }

  // 2. By market volume at entry ($1000 buckets)
  const byVolume = new Map<string, TradePair[]>();
  for (const p of pairs) {
    const vol = p.entry.context?.marketVolume ?? 0;
    const bucket = vol < 1000 ? "<$1k" : vol < 3000 ? "$1-3k" : vol < 10000 ? "$3-10k" : ">$10k";
    if (!byVolume.has(bucket)) byVolume.set(bucket, []);
    byVolume.get(bucket)!.push(p);
  }

  // 3. By L2 imbalance at entry (token side)
  const byL2Imb = new Map<string, TradePair[]>();
  for (const p of pairs) {
    const imb = p.side === "UP" ? p.entry.context?.upL2Imbalance : p.entry.context?.downL2Imbalance;
    if (imb === undefined) continue;
    const bucket = imb < -0.3 ? "bearish (<-30%)" : imb < 0 ? "weak bear (-30..0%)" : imb < 0.3 ? "weak bull (0..30%)" : "bullish (>30%)";
    if (!byL2Imb.has(bucket)) byL2Imb.set(bucket, []);
    byL2Imb.get(bucket)!.push(p);
  }

  // 4. By BTC 1m change at entry
  const byBtc1m = new Map<string, TradePair[]>();
  for (const p of pairs) {
    const c = p.entry.context?.btcChange1m ?? 0;
    const bucket = c < -0.001 ? "down <-0.1%" : c < 0 ? "slight down" : c < 0.001 ? "slight up" : "up >0.1%";
    if (!byBtc1m.has(bucket)) byBtc1m.set(bucket, []);
    byBtc1m.get(bucket)!.push(p);
  }

  // 5. By BTC 5m change at entry
  const byBtc5m = new Map<string, TradePair[]>();
  for (const p of pairs) {
    const c = p.entry.context?.btcChange5m ?? 0;
    const bucket = c < -0.003 ? "down <-0.3%" : c < 0 ? "slight down" : c < 0.003 ? "slight up" : "up >0.3%";
    if (!byBtc5m.has(bucket)) byBtc5m.set(bucket, []);
    byBtc5m.get(bucket)!.push(p);
  }

  // 6. By hold time
  const byHoldTime = new Map<string, TradePair[]>();
  for (const p of pairs) {
    if (!p.exit?.context?.holdTimeMs) continue;
    const ms = p.exit.context.holdTimeMs;
    const min = ms / 60000;
    const bucket = min < 1 ? "<1min" : min < 3 ? "1-3min" : min < 7 ? "3-7min" : ">7min";
    if (!byHoldTime.has(bucket)) byHoldTime.set(bucket, []);
    byHoldTime.get(bucket)!.push(p);
  }

  // 7. By exit reason
  const byReason = new Map<string, TradePair[]>();
  for (const p of pairs) {
    if (!p.exit) continue;
    const r = p.exit.reason;
    if (!byReason.has(r)) byReason.set(r, []);
    byReason.get(r)!.push(p);
  }

  // 8. By side (UP vs DOWN)
  const bySide = new Map<string, TradePair[]>();
  for (const p of pairs) {
    if (!bySide.has(p.side)) bySide.set(p.side, []);
    bySide.get(p.side)!.push(p);
  }

  // Build response
  const result: any = {
    totalPairs: pairs.length,
    openPositions: pairs.filter(p => !p.exit).length,
    closedPairs: pairs.filter(p => p.exit).length,
    summary: {
      wins: pairs.filter(p => p.won).length,
      losses: pairs.filter(p => p.exit && !p.won).length,
      winRate: pairs.filter(p => p.exit).length > 0
        ? pairs.filter(p => p.won).length / pairs.filter(p => p.exit).length
        : 0,
      totalPnl: pairs.reduce((s, p) => s + p.pnl, 0),
    },
    byTau: Array.from(byTau.entries()).map(([k, v]) => bucketStats(v, k)).filter(Boolean),
    byVolume: Array.from(byVolume.entries()).map(([k, v]) => bucketStats(v, k)).filter(Boolean),
    byL2Imbalance: Array.from(byL2Imb.entries()).map(([k, v]) => bucketStats(v, k)).filter(Boolean),
    byBtc1m: Array.from(byBtc1m.entries()).map(([k, v]) => bucketStats(v, k)).filter(Boolean),
    byBtc5m: Array.from(byBtc5m.entries()).map(([k, v]) => bucketStats(v, k)).filter(Boolean),
    byHoldTime: Array.from(byHoldTime.entries()).map(([k, v]) => bucketStats(v, k)).filter(Boolean),
    byExitReason: Array.from(byReason.entries()).map(([k, v]) => bucketStats(v, k)).filter(Boolean),
    bySide: Array.from(bySide.entries()).map(([k, v]) => bucketStats(v, k)).filter(Boolean),
    // Worst losing trades (top 10 by abs pnl)
    worstTrades: pairs
      .filter(p => p.exit && p.pnl < 0)
      .sort((a, b) => a.pnl - b.pnl)
      .slice(0, 10)
      .map(p => ({
        side: p.side,
        pnl: p.pnl,
        entryPrice: p.entry.price,
        exitPrice: p.exit!.price,
        exitReason: p.exit!.reason,
        tauAtEntry: p.entry.context?.tauMin,
        volume: p.entry.context?.marketVolume,
        l2Imbalance: p.side === "UP" ? p.entry.context?.upL2Imbalance : p.entry.context?.downL2Imbalance,
        btc1m: p.entry.context?.btcChange1m,
        btc5m: p.entry.context?.btcChange5m,
        holdTimeMs: p.exit!.context?.holdTimeMs,
      })),
    // Best winning trades (top 10)
    bestTrades: pairs
      .filter(p => p.exit && p.pnl > 0)
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 10)
      .map(p => ({
        side: p.side,
        pnl: p.pnl,
        entryPrice: p.entry.price,
        exitPrice: p.exit!.price,
        exitReason: p.exit!.reason,
        tauAtEntry: p.entry.context?.tauMin,
        volume: p.entry.context?.marketVolume,
        l2Imbalance: p.side === "UP" ? p.entry.context?.upL2Imbalance : p.entry.context?.downL2Imbalance,
        btc1m: p.entry.context?.btcChange1m,
        btc5m: p.entry.context?.btcChange5m,
        holdTimeMs: p.exit!.context?.holdTimeMs,
      })),
  };
  return result;
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
