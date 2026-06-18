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
  // ── Strategy B: Directional edge filter ──
  // When |modelProb - marketPrice| > edgeThreshold, we have a directional edge.
  // In edge mode we only place BIDs on the side the model favors (never both).
  // When |edge| < edgeThreshold, we fall back to symmetric MM mode.
  edgeThreshold: number;        // in probability units (0.04 = 4¢)
  edgeSizeMultiplier: number;   // size multiplier when in edge mode (e.g. 2.0 = double size)
  // ── Strategy C: Settlement arbitrage ──
  // In the last N minutes, if |z-score| > threshold (BTC far from strike),
  // we buy the side that's almost certain to win at market price (taker).
  settlementArbMinutes: number;   // window before expiry (e.g. 2 = last 2 min)
  settlementArbZThreshold: number; // |z-score| required to trigger (e.g. 3.0)
  settlementArbMaxSize: number;    // max USDC per settlement arb trade
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
  // Per-strategy breakdown
  edgeTrades: number;
  edgeWins: number;
  edgeLosses: number;
  edgeWinRate: number;
  settlementArbTrades: number;
  settlementArbWins: number;
  settlementArbLosses: number;
  settlementArbWinRate: number;
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
  startingBalance: 100,
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
  // Strategy B: edge filter
  edgeThreshold: 0.04,        // 4¢ edge required to enter directional mode
  edgeSizeMultiplier: 2.0,    // double size when we have edge
  // Strategy C: settlement arbitrage
  settlementArbMinutes: 2,      // last 2 minutes before expiry
  settlementArbZThreshold: 7.0, // |z| > 3 → 99.7% confidence
  settlementArbMaxSize: 10,     // $20 max per settlement arb trade
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
  const priceMap = new Map<number, { upBuys: number[]; upSells: number[]; downBuys: number[]; downSells: number[] }>();

  for (const t of trades) {
    const bucket = Math.floor(t.timestamp / 10) * 10;  // 10-second buckets
    if (!priceMap.has(bucket)) {
      priceMap.set(bucket, { upBuys: [], upSells: [], downBuys: [], downSells: [] });
    }
    const entry = priceMap.get(bucket)!;
    if (t.outcome === "Up") {
      if (t.side === "BUY") entry.upBuys.push(t.price);
      else entry.upSells.push(t.price);
    } else {
      if (t.side === "BUY") entry.downBuys.push(t.price);
      else entry.downSells.push(t.price);
    }
  }

  const points: PricePoint[] = [];
  const sortedBuckets = [...priceMap.keys()].sort((a, b) => a - b);

  let lastUpMid = 0.5;
  let lastDownMid = 0.5;
  let lastUpBestBid = 0.49;
  let lastUpBestAsk = 0.51;
  let lastDownBestBid = 0.49;
  let lastDownBestAsk = 0.51;

  for (const bucket of sortedBuckets) {
    const entry = priceMap.get(bucket)!;

    // ── Mid price: volume-weighted average of all trades in this bucket ──
    const upAll = [...entry.upBuys, ...entry.upSells];
    const downAll = [...entry.downBuys, ...entry.downSells];

    let upMid = lastUpMid;
    let downMid = lastDownMid;
    if (upAll.length > 0) {
      upMid = upAll.reduce((s, p) => s + p, 0) / upAll.length;
      lastUpMid = upMid;
    }
    if (downAll.length > 0) {
      downMid = downAll.reduce((s, p) => s + p, 0) / downAll.length;
      lastDownMid = downMid;
    }

    // Ensure complementary: upMid + downMid ≈ 1
    const upAdj = tickRound(upMid);
    const downAdj = tickRound(1 - upAdj);

    // ── Best bid/ask reconstruction from trade sides ──
    // Key insight: a SELL trade executes at the best bid (someone sold into the book),
    //              a BUY trade executes at the best ask (someone bought the book).
    // So:
    //   bestBid ≈ max(recent SELL prices)   — the highest price sellers were able to get
    //   bestAsk ≈ min(recent BUY prices)    — the lowest price buyers were able to get
    //
    // If we have no trades on a side this bucket, carry forward the last known value.

    let upBestBid = lastUpBestBid;
    let upBestAsk = lastUpBestAsk;
    let downBestBid = lastDownBestBid;
    let downBestAsk = lastDownBestAsk;

    if (entry.upSells.length > 0) {
      // Max sell price = best bid (sellers hit the highest bid)
      upBestBid = tickRound(Math.max(...entry.upSells));
      lastUpBestBid = upBestBid;
    }
    if (entry.upBuys.length > 0) {
      // Min buy price = best ask (buyers hit the lowest ask)
      upBestAsk = tickRound(Math.min(...entry.upBuys));
      lastUpBestAsk = upBestAsk;
    }
    if (entry.downSells.length > 0) {
      downBestBid = tickRound(Math.max(...entry.downSells));
      lastDownBestBid = downBestBid;
    }
    if (entry.downBuys.length > 0) {
      downBestAsk = tickRound(Math.min(...entry.downBuys));
      lastDownBestAsk = downBestAsk;
    }

    // Sanity: if we have both sides, ensure bid < ask (no crossed book)
    // If crossed (rare), widen by 1 tick on the violated side
    if (upBestBid >= upBestAsk) {
      upBestBid = tickRound(upBestAsk - TICK_SIZE);
      if (upBestBid < TICK_SIZE) upBestBid = TICK_SIZE;
    }
    if (downBestBid >= downBestAsk) {
      downBestBid = tickRound(downBestAsk - TICK_SIZE);
      if (downBestBid < TICK_SIZE) downBestBid = TICK_SIZE;
    }

    // Fallback: if no recent trades on a side, derive from mid ± 1 tick
    if (upBestBid <= 0) upBestBid = tickRound(upAdj - TICK_SIZE);
    if (upBestAsk <= 0 || upBestAsk <= upBestBid) upBestAsk = tickRound(upAdj + TICK_SIZE);
    if (downBestBid <= 0) downBestBid = tickRound(downAdj - TICK_SIZE);
    if (downBestAsk <= 0 || downBestAsk <= downBestBid) downBestAsk = tickRound(downAdj + TICK_SIZE);

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
    strategy: "mm" | "edge" | "settlement_arb";  // which strategy opened this position
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
  // Strategy tracking
  let edgeTrades = 0;          // B: directional edge entries
  let edgeWins = 0;
  let edgeLosses = 0;
  let settlementArbTrades = 0; // C: settlement arbitrage entries
  let settlementArbWins = 0;
  let settlementArbLosses = 0;
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

    // ── Use slotTs for the actual trading window ──
    // Gamma API's startDate is when the market was CREATED (often 24h before
    // the actual 15-min slot). endDate is when it expires. The real trading
    // window is the 15 minutes before endDate (= slotTs to slotTs + 15min).
    // We use slotTs if available, otherwise derive from endDate - 15 min.
    const marketEndTs = new Date(market.endDate).getTime() / 1000;
    const marketEndMs = marketEndTs * 1000;
    const slotTs = market.slotTs && market.slotTs > 0
      ? market.slotTs
      : marketEndTs - 15 * 60; // fallback: 15 min before end
    const marketStartTs = slotTs;
    const durationMinutes = (marketEndTs - marketStartTs) / 60;

    if (durationMinutes < 10 || durationMinutes > 20) continue; // Skip weird markets

    // Get BTC context at market start
    const btc = computeBtcContext(klines, marketStartTs);
    if (btc.price <= 0) continue;

    // ── Determine strike price ──
    // For Polymarket BTC Up/Down 15-min markets, the question doesn't contain
    // a strike price (e.g. "Bitcoin Up or Down - June 16, 7:30AM-7:45AM ET").
    // The strike is the BTC price at the START of the 15-min slot: if BTC is
    // higher at expiry → UP wins, lower → DOWN wins.
    // So strike = BTC price at marketStartTs (from klines).
    let strike = parseStrikePrice(market.question);
    if (strike <= 0) {
      // BTC Up/Down market: strike = opening BTC price at slot start
      strike = btc.price;
    }

    // Get market trades and reconstruct price series
    const marketTrades = (tradesByMarket.get(market.conditionId) || [])
      .filter(t => t.timestamp >= marketStartTs && t.timestamp <= marketEndTs);
    if (marketTrades.length === 0) continue;

    const pricePoints = reconstructPricesFromTrades(marketTrades);
    if (pricePoints.length === 0) continue;

    // Compute fee rates
    const takerBaseBPS = market.takerBaseFee || 1000;
    const feeRate = takerBaseBPS / 14000;
    const feeRateVal = feeRate;

    // ── Time-stepped trading simulation ──
    // Walk through the market in 10-second cycles (matching live bot's cycleIntervalMs).
    // At each cycle:
    //   1. Look up the current bestBid/bestAsk from reconstructed pricePoints
    //   2. Compute our inside-spread quotes (never cross the book)
    //   3. Check for maker fills (trades at our price) + probabilistic fills
    //   4. Taker fills only if our bid crosses bestAsk (shouldn't happen with clamps)
    //
    // This replaces the old single-shot fill logic that produced 96.9% taker fills.
    const CYCLE_SECONDS = 10;
    const tradingStartTs = marketStartTs + config.latencySeconds;
    // Trade all the way to expiry — auto-exit and settlement arb are handled
    // inside the cycle loop based on minutesToExpiry, not by truncating the loop.
    const tradingEndTs = marketEndTs;

    const upPosKey = `${market.conditionId}_UP`;
    const downPosKey = `${market.conditionId}_DOWN`;

    // Index price points by 10-sec bucket for O(1) lookup
    const priceByBucket = new Map<number, PricePoint>();
    for (const p of pricePoints) priceByBucket.set(p.timestamp, p);

    // Index trades by 10-sec bucket
    const tradesByBucket = new Map<number, HistoricalTrade[]>();
    for (const t of marketTrades) {
      const bucket = Math.floor(t.timestamp / 10) * 10;
      if (bucket < tradingStartTs || bucket >= tradingEndTs) continue;
      if (!tradesByBucket.has(bucket)) tradesByBucket.set(bucket, []);
      tradesByBucket.get(bucket)!.push(t);
    }

    let lastPricePoint: PricePoint | null = pricePoints[0];
    let cycleCount = 0;
    let marketSettlementArbDone = false;  // one settlement arb per market

    for (let cycleTs = tradingStartTs; cycleTs < tradingEndTs; cycleTs += CYCLE_SECONDS) {
      cycleCount++;
      const bucketTs = Math.floor(cycleTs / 10) * 10;

      // ── Get current market state (carry forward if no trades this bucket) ──
      const pp = priceByBucket.get(bucketTs) || lastPricePoint;
      if (!pp) continue;
      lastPricePoint = pp;

      const upBestBid = pp.upBestBid > 0 ? pp.upBestBid : TICK_SIZE;
      const upBestAsk = pp.upBestAsk > 0 ? pp.upBestAsk : 1 - TICK_SIZE;
      const downBestBid = pp.downBestBid > 0 ? pp.downBestBid : TICK_SIZE;
      const downBestAsk = pp.downBestAsk > 0 ? pp.downBestAsk : 1 - TICK_SIZE;
      const upRealMid = pp.upPrice;
      const downRealMid = pp.downPrice;

      // ── BTC context at this cycle (for ATR / momentum) ──
      const btcNow = computeBtcContext(klines, cycleTs);
      if (btcNow.price <= 0) continue;

      // ── Model probability + skew (tiny, ±1 tick, never crosses book) ──
      const modelPUp = calcUpProbability(strike, marketEndMs, cycleTs * 1000, btcNow);
      const modelSignalSkew = Math.max(-TICK_SIZE, Math.min(TICK_SIZE, (modelPUp - upRealMid) * 0.1));

      const inv = inventory.get(market.conditionId) || 0;
      const skewTicks = Math.round(inv * config.inventorySkewFactor / TICK_SIZE) * TICK_SIZE;
      const upSkew = skewTicks + modelSignalSkew;
      const downSkew = -skewTicks - modelSignalSkew;

      // ── Target spread ──
      const marketSpread = Math.max(pp.upSpread, pp.downSpread, 0.01);
      const minutesLeft = (marketEndTs - cycleTs) / 60;
      const targetSpread = calcSpread(
        config.baseSpread, config.atrMultiplier,
        btcNow.atr5m, btcNow.price, minutesLeft, inv, marketSpread,
      );

      // ── Build inside-spread quotes (NEVER cross the book) ──
      let bidUp: number, askUp: number;
      {
        let b = tickRound(upBestBid + TICK_SIZE + upSkew);
        let a = tickRound(upBestAsk - TICK_SIZE + upSkew);
        const ms = upBestAsk - upBestBid;
        if (ms >= targetSpread + 2 * TICK_SIZE) {
          const m = (upBestBid + upBestAsk) / 2;
          b = tickRound(m - targetSpread / 2 + upSkew);
          a = tickRound(m + targetSpread / 2 + upSkew);
        }
        b = Math.min(b, tickRound(upBestAsk - TICK_SIZE));
        a = Math.max(a, tickRound(upBestBid + TICK_SIZE));
        b = Math.max(TICK_SIZE, Math.min(1 - TICK_SIZE, b));
        a = Math.max(TICK_SIZE, Math.min(1 - TICK_SIZE, a));
        bidUp = b; askUp = a;
      }
      let bidDown: number, askDown: number;
      {
        let b = tickRound(downBestBid + TICK_SIZE + downSkew);
        let a = tickRound(downBestAsk - TICK_SIZE + downSkew);
        const ms = downBestAsk - downBestBid;
        if (ms >= targetSpread + 2 * TICK_SIZE) {
          const m = (downBestBid + downBestAsk) / 2;
          b = tickRound(m - targetSpread / 2 + downSkew);
          a = tickRound(m + targetSpread / 2 + downSkew);
        }
        b = Math.min(b, tickRound(downBestAsk - TICK_SIZE));
        a = Math.max(a, tickRound(downBestBid + TICK_SIZE));
        b = Math.max(TICK_SIZE, Math.min(1 - TICK_SIZE, b));
        a = Math.max(TICK_SIZE, Math.min(1 - TICK_SIZE, a));
        bidDown = b; askDown = a;
      }

      const qty = Math.max(1, Math.round(config.quoteSize / Math.max(upRealMid, TICK_SIZE)));

      // ═══ Strategy C: Settlement arbitrage (last N minutes) ═══
      // If BTC is far from strike (|z| > threshold) in the last N minutes,
      // the outcome is almost certain. Buy the winning side at market (taker).
      // ONE trade per market (marketSettlementArbDone flag) — no accumulation.
      const minutesToExpiry = (marketEndTs - cycleTs) / 60;
      let settlementArbTriggered = false;
      if (!marketSettlementArbDone && minutesToExpiry <= config.settlementArbMinutes && strike > 0 && btcNow.atr5m > 0) {
        const distPct = (btcNow.price - strike) / btcNow.price;
        const atrPct = btcNow.atr5m / btcNow.price;
        const expectedMove = atrPct * Math.sqrt(Math.max(minutesToExpiry, 0.05) / 5);
        const zScore = expectedMove > 0 ? distPct / expectedMove : (distPct > 0 ? 5 : -5);

        if (Math.abs(zScore) >= config.settlementArbZThreshold) {
          // Settlement arb: BTC far from strike, outcome nearly certain
          const winningSide: "UP" | "DOWN" = btcNow.price > strike ? "UP" : "DOWN";
          const tokenId = winningSide === "UP" ? "up" : "down";
          const bestAsk = winningSide === "UP" ? upBestAsk : downBestAsk;
          const arbQty = Math.min(
            Math.floor(config.settlementArbMaxSize / Math.max(bestAsk, TICK_SIZE)),
            config.maxPositionSize,
          );

          if (arbQty > 0 && cash.balance > bestAsk * arbQty + calcTakerFee(arbQty, bestAsk, feeRateVal)) {
            // Execute as taker (we pay the ask to get immediate fill)
            const fillPrice = bestAsk;
            const fee = calcTakerFee(arbQty, fillPrice, feeRateVal);
            totalFees += fee;
            takerTrades++;
            settlementArbTrades++;

            cash.balance -= fillPrice * arbQty + fee;

            const arbPosKey = `${market.conditionId}_${winningSide}`;
            const existing = positions.get(arbPosKey);
            if (existing) {
              existing.quantity += arbQty;
              existing.costBasis += fillPrice * arbQty + fee;
              existing.entryPrice = existing.costBasis / existing.quantity;
            } else {
              positions.set(arbPosKey, {
                side: winningSide, entryPrice: fillPrice, quantity: arbQty,
                costBasis: fillPrice * arbQty + fee,
                openedAt: cycleTs, marketSlug: market.slug,
                strategy: "settlement_arb",
              });
            }
            if (winningSide === "UP") {
              inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) + arbQty);
            } else {
              inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) - arbQty);
            }
            marketsTradedSet.add(market.conditionId);

            btTrades.push({
              timestamp: cycleTs, marketSlug: market.slug,
              side: `ARB_${winningSide}`, price: fillPrice, quantity: arbQty,
              fee, rebate: 0, pnl: 0, reason: `settlement_arb_z${zScore.toFixed(1)}`,
              cashAfter: cash.balance,
            });

            settlementArbTriggered = true;
            marketSettlementArbDone = true;
          }
        }
      }

      // ═══ Strategy B: Directional edge filter ═══
      // Compute edge = modelProb - marketPrice. If |edge| > threshold, we have
      // a directional view: only place BIDs on the side the model favors.
      //   edge > 0  → model says UP is underpriced → only BID_UP (skip BID_DOWN)
      //   edge < 0  → model says DOWN is underpriced → only BID_DOWN (skip BID_UP)
      //   |edge| < threshold → no edge, symmetric MM mode (place both BIDs)
      const edge = modelPUp - upRealMid;
      const hasEdgeUp = edge > config.edgeThreshold;     // model says UP underpriced
      const hasEdgeDown = -edge > config.edgeThreshold;  // model says DOWN underpriced
      const inEdgeMode = hasEdgeUp || hasEdgeDown;

      // ── Rebalance mode: skip BID on the long side ──
      const rebalanceOnly = Math.abs(inv) > 12;
      let allowBidUp = !(rebalanceOnly && inv > 0);
      let allowBidDown = !(rebalanceOnly && inv < 0);

      // In edge mode, only place BID on the favored side
      if (inEdgeMode) {
        if (hasEdgeUp) {
          allowBidDown = false;  // only bid UP
        } else {
          allowBidUp = false;    // only bid DOWN
        }
      }

      // ── Inventory-aware bid sizing ──
      const remainingCapUp = Math.max(0, config.maxInventory - Math.max(0, inv));
      const remainingCapDn = Math.max(0, config.maxInventory - Math.max(0, -inv));
      // In edge mode, use larger size (we have conviction)
      const sizeMult = inEdgeMode ? config.edgeSizeMultiplier : 1;
      const qtyBidUp = Math.min(
        Math.max(1, Math.round(qty * sizeMult)),
        Math.max(1, remainingCapUp),
        config.maxPositionSize,
      );
      const qtyBidDown = Math.min(
        Math.max(1, Math.round(qty * sizeMult)),
        Math.max(1, remainingCapDn),
        config.maxPositionSize,
      );

      const bucketTrades = tradesByBucket.get(bucketTs) || [];

      // ═══ BID_UP (buy UP tokens) ═══
      if (allowBidUp && cash.balance > bidUp * qtyBidUp + calcTakerFee(qtyBidUp, bidUp, feeRateVal)) {
        // Maker fill: SELL trade at our bid price (someone sold into our bid)
        const sellsAtOurBid = bucketTrades.filter(t =>
          t.outcome === "Up" && t.side === "SELL" && Math.abs(t.price - bidUp) <= TICK_SIZE
        );
        let filled = false;
        if (sellsAtOurBid.length > 0) {
          // Direct maker fill — our bid was hit
          const fillPrice = bidUp;
          const fillQty = Math.min(qtyBidUp, config.maxPositionSize);
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
              openedAt: cycleTs, marketSlug: market.slug, strategy: hasEdgeUp ? "edge" : "mm",
            });
          }
          inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) + fillQty);
          marketsTradedSet.add(market.conditionId);
          btTrades.push({
            timestamp: cycleTs, marketSlug: market.slug,
            side: "BID_UP", price: fillPrice, quantity: fillQty,
            fee: 0, rebate, pnl: 0, reason: "maker_fill", cashAfter: cash.balance,
          });
          filled = true;
        }
        if (!filled) {
          // Probabilistic maker fill (queue-based, like live bot)
          const sellsNearOurBid = bucketTrades.filter(t =>
            t.outcome === "Up" && t.side === "SELL" && Math.abs(t.price - bidUp) <= 0.03
          );
          const queueAge = Math.min(cycleCount * CYCLE_SECONDS / 8, 1.0); // ramp up over 8s
          const fillProb = config.makerFillRate * Math.min(sellsNearOurBid.length / 10, 1) * queueAge;
          const roll = (cycleTs * 137 + Math.floor(bidUp * 1000)) % 1000;
          if (roll < fillProb * 1000) {
            const fillPrice = bidUp;
            const fillQty = Math.min(qtyBidUp, config.maxPositionSize);
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
                openedAt: cycleTs, marketSlug: market.slug, strategy: hasEdgeUp ? "edge" : "mm",
              });
            }
            inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) + fillQty);
            marketsTradedSet.add(market.conditionId);
            btTrades.push({
              timestamp: cycleTs, marketSlug: market.slug,
              side: "BID_UP", price: fillPrice, quantity: fillQty,
              fee: 0, rebate, pnl: 0, reason: "maker_fill", cashAfter: cash.balance,
            });
          }
        }
      }

      // ═══ BID_DOWN (buy DOWN tokens) ═══
      if (allowBidDown && cash.balance > bidDown * qtyBidDown + calcTakerFee(qtyBidDown, bidDown, feeRateVal)) {
        const sellsAtOurBid = bucketTrades.filter(t =>
          t.outcome === "Down" && t.side === "SELL" && Math.abs(t.price - bidDown) <= TICK_SIZE
        );
        let filled = false;
        if (sellsAtOurBid.length > 0) {
          const fillPrice = bidDown;
          const fillQty = Math.min(qtyBidDown, config.maxPositionSize);
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
              openedAt: cycleTs, marketSlug: market.slug, strategy: hasEdgeDown ? "edge" : "mm",
            });
          }
          inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) - fillQty);
          marketsTradedSet.add(market.conditionId);
          btTrades.push({
            timestamp: cycleTs, marketSlug: market.slug,
            side: "BID_DOWN", price: fillPrice, quantity: fillQty,
            fee: 0, rebate, pnl: 0, reason: "maker_fill", cashAfter: cash.balance,
          });
          filled = true;
        }
        if (!filled) {
          const sellsNearOurBid = bucketTrades.filter(t =>
            t.outcome === "Down" && t.side === "SELL" && Math.abs(t.price - bidDown) <= 0.03
          );
          const queueAge = Math.min(cycleCount * CYCLE_SECONDS / 8, 1.0);
          const fillProb = config.makerFillRate * Math.min(sellsNearOurBid.length / 10, 1) * queueAge;
          const roll = (cycleTs * 149 + Math.floor(bidDown * 1000)) % 1000;
          if (roll < fillProb * 1000) {
            const fillPrice = bidDown;
            const fillQty = Math.min(qtyBidDown, config.maxPositionSize);
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
                openedAt: cycleTs, marketSlug: market.slug, strategy: hasEdgeDown ? "edge" : "mm",
              });
            }
            inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) - fillQty);
            marketsTradedSet.add(market.conditionId);
            btTrades.push({
              timestamp: cycleTs, marketSlug: market.slug,
              side: "BID_DOWN", price: fillPrice, quantity: fillQty,
              fee: 0, rebate, pnl: 0, reason: "maker_fill", cashAfter: cash.balance,
            });
          }
        }
      }

      // ═══ ASK_UP (sell UP tokens if we own them) ═══
      const upPosForSell = positions.get(upPosKey);
      if (upPosForSell && upPosForSell.quantity > 0 && askUp > 0) {
        const sellsAtOurAsk = bucketTrades.filter(t =>
          t.outcome === "Up" && t.side === "BUY" && Math.abs(t.price - askUp) <= TICK_SIZE
        );
        let filled = false;
        if (sellsAtOurAsk.length > 0) {
          const fillPrice = askUp;
          const sellQty = Math.min(upPosForSell.quantity, qty, config.maxPositionSize);
          const rebate = calcMakerRebate(sellQty, fillPrice, feeRateVal);
          totalRebates += rebate;
          makerTrades++;
          const closeValue = fillPrice * sellQty;
          const entryCost = upPosForSell.entryPrice * sellQty;
          const tradePnl = closeValue + rebate - entryCost;
          cash.balance += closeValue + rebate;
          realizedPnl += tradePnl;
          upPosForSell.quantity -= sellQty;
          upPosForSell.costBasis -= entryCost;
          if (upPosForSell.quantity <= 0) {
            totalHoldingTime += cycleTs - upPosForSell.openedAt;
            settledPositions++;
            positions.delete(upPosKey);
          } else {
            upPosForSell.entryPrice = upPosForSell.costBasis / upPosForSell.quantity;
          }
          inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) - sellQty);
          if (tradePnl > 0) winningTrades++;
          else if (tradePnl < 0) losingTrades++;
          btTrades.push({
            timestamp: cycleTs, marketSlug: market.slug,
            side: "ASK_UP", price: fillPrice, quantity: sellQty,
            fee: 0, rebate, pnl: tradePnl, reason: "maker_fill", cashAfter: cash.balance,
          });
          filled = true;
        }
        if (!filled) {
          const buysNearOurAsk = bucketTrades.filter(t =>
            t.outcome === "Up" && t.side === "BUY" && Math.abs(t.price - askUp) <= 0.03
          );
          const queueAge = Math.min(cycleCount * CYCLE_SECONDS / 8, 1.0);
          const fillProb = config.makerFillRate * Math.min(buysNearOurAsk.length / 10, 1) * queueAge;
          const roll = (cycleTs * 163 + Math.floor(askUp * 1000)) % 1000;
          if (roll < fillProb * 1000) {
            const fillPrice = askUp;
            const sellQty = Math.min(upPosForSell.quantity, qty, config.maxPositionSize);
            const rebate = calcMakerRebate(sellQty, fillPrice, feeRateVal);
            totalRebates += rebate;
            makerTrades++;
            const closeValue = fillPrice * sellQty;
            const entryCost = upPosForSell.entryPrice * sellQty;
            const tradePnl = closeValue + rebate - entryCost;
            cash.balance += closeValue + rebate;
            realizedPnl += tradePnl;
            upPosForSell.quantity -= sellQty;
            upPosForSell.costBasis -= entryCost;
            if (upPosForSell.quantity <= 0) {
              totalHoldingTime += cycleTs - upPosForSell.openedAt;
              settledPositions++;
              positions.delete(upPosKey);
            } else {
              upPosForSell.entryPrice = upPosForSell.costBasis / upPosForSell.quantity;
            }
            inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) - sellQty);
            if (tradePnl > 0) winningTrades++;
            else if (tradePnl < 0) losingTrades++;
            btTrades.push({
              timestamp: cycleTs, marketSlug: market.slug,
              side: "ASK_UP", price: fillPrice, quantity: sellQty,
              fee: 0, rebate, pnl: tradePnl, reason: "maker_fill", cashAfter: cash.balance,
            });
          }
        }
      }

      // ═══ ASK_DOWN (sell DOWN tokens if we own them) ═══
      const downPosForSell = positions.get(downPosKey);
      if (downPosForSell && downPosForSell.quantity > 0 && askDown > 0) {
        const buysAtOurAsk = bucketTrades.filter(t =>
          t.outcome === "Down" && t.side === "BUY" && Math.abs(t.price - askDown) <= TICK_SIZE
        );
        let filled = false;
        if (buysAtOurAsk.length > 0) {
          const fillPrice = askDown;
          const sellQty = Math.min(downPosForSell.quantity, qty, config.maxPositionSize);
          const rebate = calcMakerRebate(sellQty, fillPrice, feeRateVal);
          totalRebates += rebate;
          makerTrades++;
          const closeValue = fillPrice * sellQty;
          const entryCost = downPosForSell.entryPrice * sellQty;
          const tradePnl = closeValue + rebate - entryCost;
          cash.balance += closeValue + rebate;
          realizedPnl += tradePnl;
          downPosForSell.quantity -= sellQty;
          downPosForSell.costBasis -= entryCost;
          if (downPosForSell.quantity <= 0) {
            totalHoldingTime += cycleTs - downPosForSell.openedAt;
            settledPositions++;
            positions.delete(downPosKey);
          } else {
            downPosForSell.entryPrice = downPosForSell.costBasis / downPosForSell.quantity;
          }
          inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) + sellQty);
          if (tradePnl > 0) winningTrades++;
          else if (tradePnl < 0) losingTrades++;
          btTrades.push({
            timestamp: cycleTs, marketSlug: market.slug,
            side: "ASK_DOWN", price: fillPrice, quantity: sellQty,
            fee: 0, rebate, pnl: tradePnl, reason: "maker_fill", cashAfter: cash.balance,
          });
          filled = true;
        }
        if (!filled) {
          const buysNearOurAsk = bucketTrades.filter(t =>
            t.outcome === "Down" && t.side === "BUY" && Math.abs(t.price - askDown) <= 0.03
          );
          const queueAge = Math.min(cycleCount * CYCLE_SECONDS / 8, 1.0);
          const fillProb = config.makerFillRate * Math.min(buysNearOurAsk.length / 10, 1) * queueAge;
          const roll = (cycleTs * 179 + Math.floor(askDown * 1000)) % 1000;
          if (roll < fillProb * 1000) {
            const fillPrice = askDown;
            const sellQty = Math.min(downPosForSell.quantity, qty, config.maxPositionSize);
            const rebate = calcMakerRebate(sellQty, fillPrice, feeRateVal);
            totalRebates += rebate;
            makerTrades++;
            const closeValue = fillPrice * sellQty;
            const entryCost = downPosForSell.entryPrice * sellQty;
            const tradePnl = closeValue + rebate - entryCost;
            cash.balance += closeValue + rebate;
            realizedPnl += tradePnl;
            downPosForSell.quantity -= sellQty;
            downPosForSell.costBasis -= entryCost;
            if (downPosForSell.quantity <= 0) {
              totalHoldingTime += cycleTs - downPosForSell.openedAt;
              settledPositions++;
              positions.delete(downPosKey);
            } else {
              downPosForSell.entryPrice = downPosForSell.costBasis / downPosForSell.quantity;
            }
            inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) + sellQty);
            if (tradePnl > 0) winningTrades++;
            else if (tradePnl < 0) losingTrades++;
            btTrades.push({
              timestamp: cycleTs, marketSlug: market.slug,
              side: "ASK_DOWN", price: fillPrice, quantity: sellQty,
              fee: 0, rebate, pnl: tradePnl, reason: "maker_fill", cashAfter: cash.balance,
            });
          }
        }
      }

      // ── Auto-exit: close MM positions near expiry ──
      // Only close MM (market-making) positions via auto-exit. Edge and
      // settlement_arb positions should ride to settlement for full $1/$0
      // payout (that's where their edge comes from).
      // Window: between settlementArbMinutes and autoExitMinutes (e.g. 2-3 min).
      const shouldAutoExit = minutesToExpiry <= config.autoExitMinutes
        && minutesToExpiry > config.settlementArbMinutes;
      if (shouldAutoExit) {
        for (const [posKey, pos] of positions) {
          if (!posKey.startsWith(market.conditionId)) continue;
          if (pos.strategy !== "mm") continue;  // only close MM positions
          const realBid = pos.side === "UP" ? upBestBid : downBestBid;
          const closePrice = tickRound(realBid);
          if (closePrice <= 0) continue;
          const sellQty = pos.quantity;
          const fee = calcTakerFee(sellQty, closePrice, feeRateVal);
          totalFees += fee;
          takerTrades++;
          const closeValue = closePrice * sellQty - fee;
          const entryCost = pos.costBasis;
          const tradePnl = closeValue - entryCost;
          cash.balance += closeValue;
          realizedPnl += tradePnl;
          totalHoldingTime += cycleTs - pos.openedAt;
          settledPositions++;
          if (tradePnl > 0) winningTrades++;
          else if (tradePnl < 0) losingTrades++;
          btTrades.push({
            timestamp: cycleTs, marketSlug: market.slug,
            side: `SELL_${pos.side}`, price: closePrice, quantity: sellQty,
            fee, rebate: 0, pnl: tradePnl, reason: "auto_exit", cashAfter: cash.balance,
          });
          positions.delete(posKey);
        }
        // Don't break — continue cycling to allow settlement arb entries
        // in the last settlementArbMinutes. Only recompute inventory after
        // closing MM positions.
        const remainingInv = Array.from(positions.values())
          .filter(p => p.marketSlug === market.slug)
          .reduce((s, p) => s + (p.side === "UP" ? p.quantity : -p.quantity), 0);
        inventory.set(market.conditionId, remainingInv);
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

      // Track per-strategy win/loss
      if (pos.strategy === "edge") {
        edgeTrades++;
        if (tradePnl > 0) edgeWins++;
        else if (tradePnl < 0) edgeLosses++;
      } else if (pos.strategy === "settlement_arb") {
        settlementArbTrades++;
        if (tradePnl > 0) settlementArbWins++;
        else if (tradePnl < 0) settlementArbLosses++;
      }

      btTrades.push({
        timestamp: marketEndTs, marketSlug: market.slug,
        side: `SETTLE_${pos.side}`, price: resolvedPrice,
        quantity: pos.quantity, fee: 0, rebate: 0,
        pnl: tradePnl, reason: `${pos.strategy}_${upWins ? "up_wins" : "down_wins"}`,
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
    // ── Per-strategy breakdown ──
    edgeTrades,
    edgeWins,
    edgeLosses,
    edgeWinRate: edgeTrades > 0 ? edgeWins / edgeTrades : 0,
    settlementArbTrades,
    settlementArbWins,
    settlementArbLosses,
    settlementArbWinRate: settlementArbTrades > 0 ? settlementArbWins / settlementArbTrades : 0,
    equityCurve,
    tradeLog: btTrades,
    dailyPnl,
  };
}
