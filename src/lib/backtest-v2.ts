// ─── Backtest Engine v2 ────────────────────────────────────────
// Replays historical BTC 15-min market data through the MM strategy.
// Uses REAL market outcomes + REAL trade data + REAL BTC prices.
//
// Key improvements over v1:
// 1. Full UP + DOWN logic (v1 had abbreviated DOWN side)
// 2. Trade-based fill simulation (use real trades, not random probability)
// 3. Proper settlement using actual market outcomes
// 4. ATR computation from real BTC klines
// 5. Inventory tracking with skew
// 6. Fee model: convex taker fee + maker rebate
// 7. Circuit breaker / max drawdown checks

import { tickRound, calcTakerFee, calcMakerRebate, TICK_SIZE, sigmoid } from "./mm-engine-shared";

// ─── Types ────────────────────────────────────────────────────
export interface HistoricalMarket {
  conditionId: string;
  slug: string;
  question: string;
  startDate: string;
  endDate: string;
  upTokenId: string;
  downTokenId: string;
  outcome: "Up" | "Down" | "Unknown";
  outcomePrices: number[];  // [upPrice, downPrice] at settlement
  volume: number;
  liquidity: number;
  takerBaseFee: number;
  makerBaseFee: number;
  negRisk: boolean;
  slotTs: number;
}

export interface HistoricalTrade {
  conditionId: string;
  side: "BUY" | "SELL";
  outcome: "Up" | "Down";
  outcomeIndex: number;
  size: number;
  price: number;
  timestamp: number;  // Unix seconds
}

export interface BtcKline {
  openTime: number;    // ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  numTrades: number;
}

export interface BacktestConfig {
  startingBalance: number;
  baseSpread: number;
  atrMultiplier: number;
  autoExitMinutes: number;
  quoteSize: number;        // USDC per quote
  maxPositionSize: number;  // Max shares per position
  maxInventory: number;     // Max net inventory skew
  inventorySkewFactor: number;
  circuitBreakerPct: number;
  // Backtest-specific
  makerFillRate: number;     // Probability of maker fill per 10s cycle (0-1)
  latencySeconds: number;    // Simulated order-to-fill latency
  tickIntervalSeconds: number; // Simulation tick interval (default 10s)
}

export interface BacktestResult {
  config: BacktestConfig;
  totalPnl: number;
  realizedPnl: number;
  totalTrades: number;
  makerTrades: number;
  takerTrades: number;
  winRate: number;
  avgTradePnl: number;
  maxDrawdown: number;
  sharpeRatio: number;
  totalFeesPaid: number;
  totalRebatesEarned: number;
  totalMarkets: number;
  marketsTraded: number;
  winningTrades: number;
  losingTrades: number;
  avgHoldingTimeMinutes: number;
  equityCurve: Array<{ timestamp: number; equity: number; cash: number }>;
  tradeLog: BacktestTrade[];
  dailyPnl: Array<{ date: string; pnl: number; trades: number }>;
}

export interface BacktestTrade {
  timestamp: number;
  marketSlug: string;
  side: string;       // "BID_UP", "ASK_UP", "BID_DOWN", "ASK_DOWN", "SETTLE_UP", "SETTLE_DOWN"
  price: number;
  quantity: number;
  fee: number;
  rebate: number;
  pnl: number;        // Realized PnL for this trade (0 for entries)
  reason: string;
  cashAfter: number;
}

// ─── Default Config ───────────────────────────────────────────
export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  startingBalance: 1000,
  baseSpread: 0.03,
  atrMultiplier: 10,
  autoExitMinutes: 3,
  quoteSize: 10,
  maxPositionSize: 30,
  maxInventory: 50,
  inventorySkewFactor: 0.005,
  circuitBreakerPct: 0.25,
  makerFillRate: 0.10,
  latencySeconds: 2,
  tickIntervalSeconds: 10,
};

// ─── ATR Calculator from Klines ───────────────────────────────
function computeAtrFromKlines(klines: BtcKline[], periods: number = 14): number {
  if (klines.length < 2) return 0;

  const trueRanges: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const prev = klines[i - 1];
    const curr = klines[i];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length === 0) return 0;

  // Simple moving average of last `periods` true ranges
  const recent = trueRanges.slice(-periods);
  return recent.reduce((s, v) => s + v, 0) / recent.length;
}

function computeBtcContext(klines: BtcKline[], currentTs: number): {
  price: number;
  atr1m: number;
  atr5m: number;
  atr15m: number;
  change1m: number;
  change5m: number;
  trend: "up" | "down" | "neutral";
} {
  // Find klines up to currentTs
  const currentMs = currentTs * 1000;
  const relevantKlines = klines.filter(k => k.openTime <= currentMs);
  if (relevantKlines.length < 2) {
    return { price: 0, atr1m: 0, atr5m: 0, atr15m: 0, change1m: 0, change5m: 0, trend: "neutral" };
  }

  const lastKline = relevantKlines[relevantKlines.length - 1];
  const price = lastKline.close;

  // ATR over different windows
  const atr1m = computeAtrFromKlines(relevantKlines.slice(-1), 1);
  const atr5m = computeAtrFromKlines(relevantKlines.slice(-5), 5);
  const atr15m = computeAtrFromKlines(relevantKlines.slice(-15), 14);

  // Price changes
  const k1m = relevantKlines.length >= 2 ? relevantKlines[relevantKlines.length - 2] : lastKline;
  const k5m = relevantKlines.length >= 6 ? relevantKlines[relevantKlines.length - 6] : relevantKlines[0];

  const change1m = price > 0 ? (price - k1m.close) / k1m.close * 100 : 0;
  const change5m = price > 0 ? (price - k5m.close) / k5m.close * 100 : 0;

  // Trend: simple EMA-like detection
  const recent5 = relevantKlines.slice(-5);
  const avgPrice5 = recent5.reduce((s, k) => s + k.close, 0) / recent5.length;
  let trend: "up" | "down" | "neutral" = "neutral";
  if (price > avgPrice5 * 1.0002) trend = "up";
  else if (price < avgPrice5 * 0.9998) trend = "down";

  return { price, atr1m, atr5m, atr15m, change1m, change5m, trend };
}

// ─── Strike Price Parser ──────────────────────────────────────
function parseStrikePrice(question: string): number {
  const match = question.match(/\$([\d,]+)/);
  if (match) return parseFloat(match[1].replace(/,/g, ""));
  return 0;
}

// ─── Probability Model (same as mm-engine) ───────────────────
function calcUpProbability(
  strikePrice: number,
  expiresAtMs: number,
  currentTsMs: number,
  btc: ReturnType<typeof computeBtcContext>,
): number {
  const { price, atr5m, change1m, change5m, trend } = btc;
  if (price <= 0) return 0.5;

  const tau = (expiresAtMs - currentTsMs) / 60000;

  if (strikePrice > 0) {
    if (tau <= 0) return price > strikePrice ? 0.99 : 0.01;

    const distPct = (price - strikePrice) / price;
    const atrPct = atr5m > 0 ? atr5m / price : 0.001;
    const expectedMove = atrPct * Math.sqrt(Math.max(tau, 0.1) / 5);
    const zScore = expectedMove > 0 ? distPct / expectedMove : (distPct > 0 ? 5 : -5);

    let pUp = sigmoid(zScore * 3);

    const momentumSignal = (change1m * 2 + change5m) / 3;
    const trendBias = trend === "up" ? 0.02 : trend === "down" ? -0.02 : 0;
    pUp = pUp + (momentumSignal + trendBias) * 0.1;

    if (tau < 3) {
      pUp = price > strikePrice
        ? Math.min(pUp + (1 - pUp) * 0.5, 0.99)
        : Math.max(pUp - pUp * 0.5, 0.01);
    }

    return Math.max(0.01, Math.min(0.99, pUp));
  }

  // Fallback: momentum model
  if (tau <= 0) return trend === "up" ? 0.99 : trend === "down" ? 0.01 : 0.5;

  const momentumSignal = (change1m * 2 + change5m) / 3;
  const trendBias = trend === "up" ? 0.02 : trend === "down" ? -0.02 : 0;
  const atrPct = atr5m > 0 ? (atr5m / price) * 100 : 0.1;
  const volatilityFactor = Math.max(atrPct * 10, 0.001);
  const raw = sigmoid((momentumSignal + trendBias) / volatilityFactor * 10);

  if (tau < 3) {
    return raw > 0.5
      ? Math.min(raw + (1 - raw) * 0.5, 0.99)
      : Math.max(raw - raw * 0.5, 0.01);
  }

  return Math.max(0.01, Math.min(0.99, raw));
}

// ─── Spread Calculation ───────────────────────────────────────
function calcSpread(
  baseSpread: number,
  atrMultiplier: number,
  atr5m: number,
  btcPrice: number,
  tauMinutes: number,
  inventory: number,
  marketSpread: number,
): number {
  const atrFactor = (atr5m / btcPrice) * 100;
  const timeFactor = 1 + Math.max(0, (1 - tauMinutes / 15)) * 2;
  const inventoryFactor = 1 + Math.abs(inventory) * 0.02;

  return tickRound(Math.max(
    Math.min(baseSpread * (1 + atrFactor * atrMultiplier) * timeFactor * inventoryFactor, 0.15),
    marketSpread > 0 ? marketSpread : 0.01,
  ));
}

// ─── Trade-Based Price Reconstruction ─────────────────────────
interface PricePoint {
  timestamp: number;  // seconds
  upPrice: number;
  downPrice: number;
  upBestBid: number;
  upBestAsk: number;
  downBestBid: number;
  downBestAsk: number;
  upSpread: number;
  downSpread: number;
}

function reconstructPricesFromTrades(trades: HistoricalTrade[]): PricePoint[] {
  // Group trades by timestamp (rounded to 10s intervals)
  const priceMap = new Map<number, { upTrades: number[]; downTrades: number[] }>();

  for (const t of trades) {
    const bucket = Math.floor(t.timestamp / 10) * 10;  // 10-second buckets
    if (!priceMap.has(bucket)) {
      priceMap.set(bucket, { upTrades: [], downTrades: [] });
    }
    const entry = priceMap.get(bucket)!;
    if (t.outcome === "Up") {
      entry.upTrades.push(t.price);
    } else {
      entry.downTrades.push(t.price);
    }
  }

  const points: PricePoint[] = [];
  const sortedBuckets = [...priceMap.keys()].sort((a, b) => a - b);

  let lastUpMid = 0.5;
  let lastDownMid = 0.5;

  for (const bucket of sortedBuckets) {
    const entry = priceMap.get(bucket)!;

    let upMid = lastUpMid;
    let downMid = lastDownMid;

    if (entry.upTrades.length > 0) {
      upMid = entry.upTrades.reduce((s, p) => s + p, 0) / entry.upTrades.length;
      lastUpMid = upMid;
    }
    if (entry.downTrades.length > 0) {
      downMid = entry.downTrades.reduce((s, p) => s + p, 0) / entry.downTrades.length;
      lastDownMid = downMid;
    }

    // Ensure complementary: upMid + downMid ≈ 1
    const upAdj = tickRound(upMid);
    const downAdj = tickRound(1 - upAdj);

    // Simulate bid/ask spread from trade prices
    const upTrades = entry.upTrades.sort((a, b) => a - b);
    const downTrades = entry.downTrades.sort((a, b) => a - b);

    const upBestBid = upTrades.length > 1 ? tickRound(upTrades[Math.floor(upTrades.length * 0.3)]) : tickRound(upAdj - 0.01);
    const upBestAsk = upTrades.length > 1 ? tickRound(upTrades[Math.floor(upTrades.length * 0.7)]) : tickRound(upAdj + 0.01);
    const downBestBid = downTrades.length > 1 ? tickRound(downTrades[Math.floor(downTrades.length * 0.3)]) : tickRound(downAdj - 0.01);
    const downBestAsk = downTrades.length > 1 ? tickRound(downTrades[Math.floor(downTrades.length * 0.7)]) : tickRound(downAdj + 0.01);

    points.push({
      timestamp: bucket,
      upPrice: upAdj,
      downPrice: downAdj,
      upBestBid: Math.max(upBestBid, TICK_SIZE),
      upBestAsk: Math.min(upBestAsk, 1 - TICK_SIZE),
      downBestBid: Math.max(downBestBid, TICK_SIZE),
      downBestAsk: Math.min(downBestAsk, 1 - TICK_SIZE),
      upSpread: tickRound(upBestAsk - upBestBid),
      downSpread: tickRound(downBestAsk - downBestBid),
    });
  }

  return points;
}

// ─── Main Backtest Runner ─────────────────────────────────────
export function runBacktest(
  markets: HistoricalMarket[],
  tradesByMarket: Map<string, HistoricalTrade[]>,
  klines: BtcKline[],
  config: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
): BacktestResult {
  const cash = { balance: config.startingBalance };
  let realizedPnl = 0;
  const btTrades: BacktestTrade[] = [];
  const equityCurve: Array<{ timestamp: number; equity: number; cash: number }> = [];
  const dailyPnlMap = new Map<string, { pnl: number; trades: number }>();

  // Position tracking
  interface Position {
    side: "UP" | "DOWN";
    entryPrice: number;
    quantity: number;
    costBasis: number;
    openedAt: number;  // Unix seconds
    marketSlug: string;
  }
  const positions = new Map<string, Position>();  // key: marketId_SIDE
  const inventory = new Map<string, number>();

  // Stats
  let makerTrades = 0;
  let takerTrades = 0;
  let totalFees = 0;
  let totalRebates = 0;
  let maxEquity = config.startingBalance;
  let maxDrawdown = 0;
  let circuitBreaker = false;
  let winningTrades = 0;
  let losingTrades = 0;
  let totalHoldingTime = 0;
  let settledPositions = 0;
  const marketsTradedSet = new Set<string>();

  // Sort markets by start time
  const sortedMarkets = [...markets]
    .filter(m => m.outcome !== "Unknown")
    .sort((a, b) => {
      const tsA = a.slotTs || new Date(a.startDate).getTime() / 1000;
      const tsB = b.slotTs || new Date(b.startDate).getTime() / 1000;
      return tsA - tsB;
    });

  // Process each market chronologically
  for (const market of sortedMarkets) {
    if (circuitBreaker) break;

    const marketStartTs = new Date(market.startDate).getTime() / 1000;
    const marketEndTs = new Date(market.endDate).getTime() / 1000;
    const marketEndMs = marketEndTs * 1000;
    const durationMinutes = (marketEndTs - marketStartTs) / 60;

    if (durationMinutes < 10 || durationMinutes > 20) continue; // Skip weird markets

    // Get BTC context at market start
    const btc = computeBtcContext(klines, marketStartTs);
    if (btc.price <= 0) continue;

    // Parse strike price
    const strike = parseStrikePrice(market.question);

    // Get market trades and reconstruct price series
    const marketTrades = tradesByMarket.get(market.conditionId) || [];
    if (marketTrades.length === 0) continue;

    const pricePoints = reconstructPricesFromTrades(marketTrades);
    if (pricePoints.length === 0) continue;

    // Compute fee rates
    const takerBaseBPS = market.takerBaseFee || 1000;
    const feeRate = takerBaseBPS / 14000;

    // ── Simulate trading within this market ──
    const inv = inventory.get(market.conditionId) || 0;

    // Get the mid-market price at the start of trading
    const firstPrice = pricePoints[0];
    const realUpMid = firstPrice.upPrice;
    const realDownMid = firstPrice.downPrice;
    const upBestBid = firstPrice.upBestBid > 0 ? firstPrice.upBestBid : Math.max(TICK_SIZE, realUpMid - 0.02);
    const upBestAsk = firstPrice.upBestAsk > 0 ? firstPrice.upBestAsk : Math.min(1 - TICK_SIZE, realUpMid + 0.02);
    const downBestBid = firstPrice.downBestBid > 0 ? firstPrice.downBestBid : Math.max(TICK_SIZE, realDownMid - 0.02);
    const downBestAsk = firstPrice.downBestAsk > 0 ? firstPrice.downBestAsk : Math.min(1 - TICK_SIZE, realDownMid + 0.02);

    // Our model probability (used for skew only — NOT for crossing the book).
    // The previous code shifted pUp by (modelPUp - 0.5) * 0.3 (up to ±15¢),
    // which made bid/ask cross the real book 99% of the time → 99% taker fills.
    const modelPUp = calcUpProbability(strike, marketEndMs, marketStartTs * 1000, btc);
    // Tiny ±1 tick skew from model (so we still tilt inventory gently).
    const modelSignalSkew = Math.max(-TICK_SIZE, Math.min(TICK_SIZE, (modelPUp - realUpMid) * 0.1));

    // Calculate spread (target capture)
    const marketSpread = Math.max(firstPrice.upSpread, firstPrice.downSpread, 0.01);
    const spread = calcSpread(
      config.baseSpread, config.atrMultiplier,
      btc.atr5m, btc.price, durationMinutes, inv, marketSpread,
    );

    const skewTicks = Math.round(inv * config.inventorySkewFactor / TICK_SIZE) * TICK_SIZE;
    const upSkew = skewTicks + modelSignalSkew;
    const downSkew = -skewTicks - modelSignalSkew;

    // ── MM quotes: ALWAYS inside the real spread (never cross the book) ──
    // UP side
    let bidUp: number;
    let askUp: number;
    {
      let b = tickRound(upBestBid + TICK_SIZE + upSkew);
      let a = tickRound(upBestAsk - TICK_SIZE + upSkew);
      const upMktSpread = upBestAsk - upBestBid;
      if (upMktSpread >= spread + 2 * TICK_SIZE) {
        const m = (upBestBid + upBestAsk) / 2;
        b = tickRound(m - spread / 2 + upSkew);
        a = tickRound(m + spread / 2 + upSkew);
      }
      // Hard clamps: never cross
      b = Math.min(b, tickRound(upBestAsk - TICK_SIZE));
      a = Math.max(a, tickRound(upBestBid + TICK_SIZE));
      b = Math.max(TICK_SIZE, Math.min(1 - TICK_SIZE, b));
      a = Math.max(TICK_SIZE, Math.min(1 - TICK_SIZE, a));
      bidUp = b;
      askUp = a;
    }
    // DOWN side
    let bidDown: number;
    let askDown: number;
    {
      let b = tickRound(downBestBid + TICK_SIZE + downSkew);
      let a = tickRound(downBestAsk - TICK_SIZE + downSkew);
      const dnMktSpread = downBestAsk - downBestBid;
      if (dnMktSpread >= spread + 2 * TICK_SIZE) {
        const m = (downBestBid + downBestAsk) / 2;
        b = tickRound(m - spread / 2 + downSkew);
        a = tickRound(m + spread / 2 + downSkew);
      }
      b = Math.min(b, tickRound(downBestAsk - TICK_SIZE));
      a = Math.max(a, tickRound(downBestBid + TICK_SIZE));
      b = Math.max(TICK_SIZE, Math.min(1 - TICK_SIZE, b));
      a = Math.max(TICK_SIZE, Math.min(1 - TICK_SIZE, a));
      bidDown = b;
      askDown = a;
    }

    const qty = Math.max(1, Math.round(config.quoteSize / Math.max(realUpMid, TICK_SIZE)));
    const feeRateVal = feeRate;

    // ── Try BID_UP (buy UP tokens) ──
    const upPosKey = `${market.conditionId}_UP`;
    const upPos = positions.get(upPosKey);

    // Check if our bid would be filled by a market sell (taker fill)
    // This happens when a trade occurs at or below our bid price
    const upTradesBelowOurBid = marketTrades.filter(
      t => t.outcome === "Up" && t.side === "SELL" && t.price <= bidUp &&
      t.timestamp >= marketStartTs && t.timestamp < marketEndTs - config.autoExitMinutes * 60,
    );

    // Maker fill: check if any trade crossed through our bid level
    const upTradesNearOurBid = marketTrades.filter(
      t => t.outcome === "Up" && t.timestamp >= marketStartTs &&
      t.timestamp < marketEndTs - config.autoExitMinutes * 60 &&
      Math.abs(t.price - bidUp) <= 0.03,
    );

    if (cash.balance > bidUp * qty + calcTakerFee(qty, bidUp, feeRateVal)) {
      if (upTradesBelowOurBid.length > 0) {
        // Taker fill — we crossed the book
        const fillTrade = upTradesBelowOurBid[0];
        const fillPrice = tickRound(fillTrade.price);
        const fillQty = Math.min(qty, config.maxPositionSize);
        const fee = calcTakerFee(fillQty, fillPrice, feeRateVal);
        totalFees += fee;
        takerTrades++;

        cash.balance -= fillPrice * fillQty + fee;
        const existing = positions.get(upPosKey);
        if (existing) {
          existing.quantity += fillQty;
          existing.costBasis += fillPrice * fillQty + fee;
          existing.entryPrice = existing.costBasis / existing.quantity;
        } else {
          positions.set(upPosKey, {
            side: "UP", entryPrice: fillPrice, quantity: fillQty,
            costBasis: fillPrice * fillQty + fee,
            openedAt: fillTrade.timestamp, marketSlug: market.slug,
          });
        }
        inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) + fillQty);
        marketsTradedSet.add(market.conditionId);

        btTrades.push({
          timestamp: fillTrade.timestamp, marketSlug: market.slug,
          side: "BID_UP", price: fillPrice, quantity: fillQty,
          fee, rebate: 0, pnl: 0, reason: "taker_fill", cashAfter: cash.balance,
        });
      } else if (upTradesNearOurBid.length > 0) {
        // Probabilistic maker fill
        const fillProb = config.makerFillRate * Math.min(upTradesNearOurBid.length / 10, 1);
        // Deterministic "randomness" based on market data
        const hash = (market.slotTs * 7 + Math.floor(bidUp * 1000)) % 100;
        if (hash < fillProb * 100) {
          const fillPrice = bidUp;
          const fillQty = Math.min(qty, config.maxPositionSize);
          const rebate = calcMakerRebate(fillQty, fillPrice, feeRateVal);
          totalRebates += rebate;
          makerTrades++;

          cash.balance -= fillPrice * fillQty;
          cash.balance += rebate;

          const existing = positions.get(upPosKey);
          if (existing) {
            existing.quantity += fillQty;
            existing.costBasis += fillPrice * fillQty;
            existing.entryPrice = existing.costBasis / existing.quantity;
          } else {
            positions.set(upPosKey, {
              side: "UP", entryPrice: fillPrice, quantity: fillQty,
              costBasis: fillPrice * fillQty,
              openedAt: marketStartTs + config.latencySeconds,
              marketSlug: market.slug,
            });
          }
          inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) + fillQty);
          marketsTradedSet.add(market.conditionId);

          btTrades.push({
            timestamp: marketStartTs + config.latencySeconds,
            marketSlug: market.slug, side: "BID_UP",
            price: fillPrice, quantity: fillQty,
            fee: 0, rebate, pnl: 0, reason: "maker_fill", cashAfter: cash.balance,
          });
        }
      }
    }

    // ── Try BID_DOWN (buy DOWN tokens) ──
    const downPosKey = `${market.conditionId}_DOWN`;
    const downTradesBelowOurBid = marketTrades.filter(
      t => t.outcome === "Down" && t.side === "SELL" && t.price <= bidDown &&
      t.timestamp >= marketStartTs && t.timestamp < marketEndTs - config.autoExitMinutes * 60,
    );

    if (cash.balance > bidDown * qty + calcTakerFee(qty, bidDown, feeRateVal)) {
      if (downTradesBelowOurBid.length > 0) {
        const fillTrade = downTradesBelowOurBid[0];
        const fillPrice = tickRound(fillTrade.price);
        const fillQty = Math.min(qty, config.maxPositionSize);
        const fee = calcTakerFee(fillQty, fillPrice, feeRateVal);
        totalFees += fee;
        takerTrades++;

        cash.balance -= fillPrice * fillQty + fee;
        const existing = positions.get(downPosKey);
        if (existing) {
          existing.quantity += fillQty;
          existing.costBasis += fillPrice * fillQty + fee;
          existing.entryPrice = existing.costBasis / existing.quantity;
        } else {
          positions.set(downPosKey, {
            side: "DOWN", entryPrice: fillPrice, quantity: fillQty,
            costBasis: fillPrice * fillQty + fee,
            openedAt: fillTrade.timestamp, marketSlug: market.slug,
          });
        }
        inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) - fillQty);
        marketsTradedSet.add(market.conditionId);

        btTrades.push({
          timestamp: fillTrade.timestamp, marketSlug: market.slug,
          side: "BID_DOWN", price: fillPrice, quantity: fillQty,
          fee, rebate: 0, pnl: 0, reason: "taker_fill", cashAfter: cash.balance,
        });
      } else {
        // Probabilistic maker fill for DOWN
        const downTradesNearOurBid = marketTrades.filter(
          t => t.outcome === "Down" && t.timestamp >= marketStartTs &&
          t.timestamp < marketEndTs - config.autoExitMinutes * 60 &&
          Math.abs(t.price - bidDown) <= 0.03,
        );
        const fillProb = config.makerFillRate * Math.min(downTradesNearOurBid.length / 10, 1);
        const hash = (market.slotTs * 11 + Math.floor(bidDown * 1000)) % 100;
        if (hash < fillProb * 100) {
          const fillPrice = bidDown;
          const fillQty = Math.min(qty, config.maxPositionSize);
          const rebate = calcMakerRebate(fillQty, fillPrice, feeRateVal);
          totalRebates += rebate;
          makerTrades++;

          cash.balance -= fillPrice * fillQty;
          cash.balance += rebate;

          const existing = positions.get(downPosKey);
          if (existing) {
            existing.quantity += fillQty;
            existing.costBasis += fillPrice * fillQty;
            existing.entryPrice = existing.costBasis / existing.quantity;
          } else {
            positions.set(downPosKey, {
              side: "DOWN", entryPrice: fillPrice, quantity: fillQty,
              costBasis: fillPrice * fillQty,
              openedAt: marketStartTs + config.latencySeconds,
              marketSlug: market.slug,
            });
          }
          inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) - fillQty);
          marketsTradedSet.add(market.conditionId);

          btTrades.push({
            timestamp: marketStartTs + config.latencySeconds,
            marketSlug: market.slug, side: "BID_DOWN",
            price: fillPrice, quantity: fillQty,
            fee: 0, rebate, pnl: 0, reason: "maker_fill", cashAfter: cash.balance,
          });
        }
      }
    }

    // ── Try ASK_UP (sell UP tokens if we own them) ──
    const upPosForSell = positions.get(upPosKey);
    if (upPosForSell && upPosForSell.quantity > 0 && askUp > 0) {
      const upBuyTradesAtOurAsk = marketTrades.filter(
        t => t.outcome === "Up" && t.side === "BUY" && t.price >= askUp &&
        t.timestamp >= marketStartTs && t.timestamp < marketEndTs - config.autoExitMinutes * 60,
      );
      if (upBuyTradesAtOurAsk.length > 0) {
        const fillTrade = upBuyTradesAtOurAsk[0];
        const fillPrice = tickRound(fillTrade.price);
        const sellQty = Math.min(upPosForSell.quantity, qty, config.maxPositionSize);
        const fee = calcTakerFee(sellQty, fillPrice, feeRateVal);
        totalFees += fee;
        takerTrades++;

        const closeValue = fillPrice * sellQty - fee;
        const entryCost = upPosForSell.entryPrice * sellQty;
        const tradePnl = closeValue - entryCost;

        cash.balance += closeValue;
        realizedPnl += tradePnl;

        upPosForSell.quantity -= sellQty;
        upPosForSell.costBasis -= entryCost;
        if (upPosForSell.quantity <= 0) {
          totalHoldingTime += fillTrade.timestamp - upPosForSell.openedAt;
          settledPositions++;
          positions.delete(upPosKey);
        } else {
          upPosForSell.entryPrice = upPosForSell.costBasis / upPosForSell.quantity;
        }
        inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) - sellQty);

        if (tradePnl > 0) winningTrades++;
        else if (tradePnl < 0) losingTrades++;

        btTrades.push({
          timestamp: fillTrade.timestamp, marketSlug: market.slug,
          side: "ASK_UP", price: fillPrice, quantity: sellQty,
          fee, rebate: 0, pnl: tradePnl, reason: "taker_fill", cashAfter: cash.balance,
        });
      }
    }

    // ── Try ASK_DOWN (sell DOWN tokens if we own them) ──
    const downPosForSell = positions.get(downPosKey);
    if (downPosForSell && downPosForSell.quantity > 0 && askDown > 0) {
      const downBuyTradesAtOurAsk = marketTrades.filter(
        t => t.outcome === "Down" && t.side === "BUY" && t.price >= askDown &&
        t.timestamp >= marketStartTs && t.timestamp < marketEndTs - config.autoExitMinutes * 60,
      );
      if (downBuyTradesAtOurAsk.length > 0) {
        const fillTrade = downBuyTradesAtOurAsk[0];
        const fillPrice = tickRound(fillTrade.price);
        const sellQty = Math.min(downPosForSell.quantity, qty, config.maxPositionSize);
        const fee = calcTakerFee(sellQty, fillPrice, feeRateVal);
        totalFees += fee;
        takerTrades++;

        const closeValue = fillPrice * sellQty - fee;
        const entryCost = downPosForSell.entryPrice * sellQty;
        const tradePnl = closeValue - entryCost;

        cash.balance += closeValue;
        realizedPnl += tradePnl;

        downPosForSell.quantity -= sellQty;
        downPosForSell.costBasis -= entryCost;
        if (downPosForSell.quantity <= 0) {
          totalHoldingTime += fillTrade.timestamp - downPosForSell.openedAt;
          settledPositions++;
          positions.delete(downPosKey);
        } else {
          downPosForSell.entryPrice = downPosForSell.costBasis / downPosForSell.quantity;
        }
        inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) + sellQty);

        if (tradePnl > 0) winningTrades++;
        else if (tradePnl < 0) losingTrades++;

        btTrades.push({
          timestamp: fillTrade.timestamp, marketSlug: market.slug,
          side: "ASK_DOWN", price: fillPrice, quantity: sellQty,
          fee, rebate: 0, pnl: tradePnl, reason: "taker_fill", cashAfter: cash.balance,
        });
      }
    }

    // ── Settlement: close any remaining positions at expiry ──
    const upWins = market.outcome === "Up";
    for (const [posKey, pos] of positions) {
      if (!posKey.startsWith(market.conditionId)) continue;

      const isUp = pos.side === "UP";
      const resolvedPrice = (isUp && upWins) || (!isUp && !upWins) ? 1.0 : 0.0;
      const settleValue = pos.quantity * resolvedPrice;

      const tradePnl = settleValue - pos.costBasis;
      cash.balance += settleValue;
      realizedPnl += tradePnl;

      totalHoldingTime += marketEndTs - pos.openedAt;
      settledPositions++;

      if (tradePnl > 0) winningTrades++;
      else if (tradePnl < 0) losingTrades++;

      btTrades.push({
        timestamp: marketEndTs, marketSlug: market.slug,
        side: `SETTLE_${pos.side}`, price: resolvedPrice,
        quantity: pos.quantity, fee: 0, rebate: 0,
        pnl: tradePnl, reason: upWins ? "settle_up_wins" : "settle_down_wins",
        cashAfter: cash.balance,
      });

      positions.delete(posKey);
    }
    inventory.delete(market.conditionId);

    // ── Track equity & daily PnL ──
    const totalPnl = cash.balance - config.startingBalance;
    const equity = cash.balance;  // All positions settled at this point

    equityCurve.push({
      timestamp: marketEndTs * 1000,  // ms for chart compatibility
      equity,
      cash: cash.balance,
    });

    if (equity > maxEquity) maxEquity = equity;
    const dd = (maxEquity - equity) / maxEquity;
    if (dd > maxDrawdown) maxDrawdown = dd;

    // Daily PnL
    const dayStr = new Date(marketEndTs * 1000).toISOString().slice(0, 10);
    const dayEntry = dailyPnlMap.get(dayStr) || { pnl: 0, trades: 0 };
    dayEntry.pnl += totalPnl - (dailyPnlMap.size > 0 ?
      [...dailyPnlMap.values()].reduce((s, d) => s + d.pnl, 0) : 0);
    dayEntry.trades++;
    dailyPnlMap.set(dayStr, dayEntry);

    // Circuit breaker check
    if (-totalPnl / config.startingBalance > config.circuitBreakerPct) {
      circuitBreaker = true;
      console.error(`[Backtest] CIRCUIT BREAKER at market ${market.slug}: totalPnl=${totalPnl.toFixed(2)}`);
    }
  }

  // ── Calculate Final Metrics ──
  const totalPnl = cash.balance - config.startingBalance;
  const totalTrades = btTrades.length;
  const profitableTrades = btTrades.filter(t => t.pnl > 0).length;
  const winRate = totalTrades > 0 ? profitableTrades / totalTrades : 0;
  const avgTradePnl = totalTrades > 0 ? totalPnl / totalTrades : 0;
  const avgHoldingTimeMinutes = settledPositions > 0 ? (totalHoldingTime / settledPositions / 60) : 0;

  // Sharpe ratio (annualized from per-market returns)
  const returns = equityCurve.slice(1).map((e, i) => {
    const prev = equityCurve[i].equity;
    return prev > 0 ? (e.equity - prev) / prev : 0;
  });
  const avgReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1))
    : 1;
  // Annualize: ~96 markets/day * 365 days = 35,040 markets/year
  const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(35040) : 0;

  // Build daily PnL array
  const dailyPnl = [...dailyPnlMap.entries()]
    .map(([date, data]) => ({ date, pnl: data.pnl, trades: data.trades }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    config,
    totalPnl,
    realizedPnl,
    totalTrades,
    makerTrades,
    takerTrades,
    winRate,
    avgTradePnl,
    maxDrawdown,
    sharpeRatio,
    totalFeesPaid: totalFees,
    totalRebatesEarned: totalRebates,
    totalMarkets: sortedMarkets.length,
    marketsTraded: marketsTradedSet.size,
    winningTrades,
    losingTrades,
    avgHoldingTimeMinutes,
    equityCurve,
    tradeLog: btTrades,
    dailyPnl,
  };
}
