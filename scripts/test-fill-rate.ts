#!/usr/bin/env bun
/**
 * Fill Rate Simulator — verifies that the MM engine produces mostly MAKER fills.
 *
 * Creates a synthetic Polymarket BTC 15-min Up/Down market with a realistic
 * order book, runs N cycles of generateQuotes + simulateFills, and reports:
 *   - total fills
 *   - maker fills (we want ≥ 50%)
 *   - taker fills (we want ≤ 10%)
 *   - bid/ask placement vs real book (must be INSIDE the spread, never crossing)
 *
 * Usage: bun run scripts/test-fill-rate.ts [cycles]
 */

// We can't directly import the engine (it has Next.js globals), so we
// reimplement the exact same logic here and stress-test it in isolation.

const TICK_SIZE = 0.01;
const DEFAULT_TAKER_FEE_RATE = 0.072;
const MAKER_REBATE_PCT = 0.20;
const MIN_MAKER_FILL_DELAY_MS = 2000;

function tickRound(p: number) { return Math.round(p / TICK_SIZE) * TICK_SIZE; }
function tickFloor(p: number) { return Math.floor(p / TICK_SIZE) * TICK_SIZE; }
function tickCeil(p: number) { return Math.ceil(p / TICK_SIZE) * TICK_SIZE; }
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function calcTakerFee(shares: number, price: number, feeRate = DEFAULT_TAKER_FEE_RATE) {
  return shares * feeRate * price * (1 - price);
}
function calcMakerRebate(shares: number, price: number, feeRate = DEFAULT_TAKER_FEE_RATE) {
  return shares * feeRate * price * (1 - price) * MAKER_REBATE_PCT;
}

// ── Config (mirrors mm-engine.ts BotConfig) ──
const CONFIG = {
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
};

// ── Synthetic Market ──
interface OrderBookLevel { price: number; size: number; }
interface Market {
  id: string;
  question: string;
  expiresAt: number;
  strikePrice: number;
  realUpMid: number;
  realUpBestBid: number;
  realUpBestAsk: number;
  realDownMid: number;
  realDownBestBid: number;
  realDownBestAsk: number;
  realSpreadUp: number;
  realSpreadDown: number;
  upBids: OrderBookLevel[];
  upAsks: OrderBookLevel[];
  downBids: OrderBookLevel[];
  downAsks: OrderBookLevel[];
  volume: number;
  liquidity: number;
  feeRate: number;
  active: boolean;
}

interface Quote {
  id: string;
  marketId: string;
  side: "BID_UP" | "ASK_UP" | "BID_DOWN" | "ASK_DOWN";
  price: number;
  quantity: number;
  status: "active" | "filled" | "cancelled" | "rejected";
  createdAt: number;
  rejectReason?: string;
}

// ── State ──
let cashBalance = CONFIG.startingBalance;
let tradeCycleCount = 0;
const positions = new Map<string, { side: "UP" | "DOWN"; quantity: number; entryPrice: number; costBasis: number; }>();
const quotes = new Map<string, Quote>();
const inventory = new Map<string, number>();
const trades: Array<{ side: string; price: number; quantity: number; isTaker: boolean; reason: string; }> = [];

// ── Build a realistic BTC 15-min Up/Down order book ──
function buildOrderBook(mid: number, spread: number): { bids: OrderBookLevel[]; asks: OrderBookLevel[]; bestBid: number; bestAsk: number; } {
  const bestBid = tickFloor(mid - spread / 2);
  const bestAsk = tickCeil(mid + spread / 2);
  const bids: OrderBookLevel[] = [];
  const asks: OrderBookLevel[] = [];
  for (let i = 0; i < 8; i++) {
    bids.push({ price: tickFloor(bestBid - i * TICK_SIZE), size: 50 + Math.random() * 100 });
    asks.push({ price: tickCeil(bestAsk + i * TICK_SIZE), size: 50 + Math.random() * 100 });
  }
  return { bids, asks, bestBid, bestAsk };
}

function createMarket(scenario: { upMid: number; spread: number; volume: number; liquidity: number; }): Market {
  const now = Date.now();
  const upMid = scenario.upMid;
  const upSpread = scenario.spread;
  const upBook = buildOrderBook(upMid, upSpread);
  // DOWN = 1 - UP (perfectly negatively correlated on a binary market)
  const downMid = tickRound(1 - upMid);
  const downSpread = upSpread;
  const downBook = buildOrderBook(downMid, downSpread);

  return {
    id: "test-market",
    question: "Will BTC be above $105,000 at 15:30 UTC?",
    expiresAt: now + 15 * 60 * 1000, // 15 min from now
    strikePrice: 105000,
    realUpMid: upMid,
    realUpBestBid: upBook.bestBid,
    realUpBestAsk: upBook.bestAsk,
    realDownMid: downMid,
    realDownBestBid: downBook.bestBid,
    realDownBestAsk: downBook.bestAsk,
    realSpreadUp: upSpread,
    realSpreadDown: downSpread,
    upBids: upBook.bids,
    upAsks: upBook.asks,
    downBids: downBook.bids,
    downAsks: downBook.asks,
    volume: scenario.volume,
    liquidity: scenario.liquidity,
    feeRate: DEFAULT_TAKER_FEE_RATE,
    active: true,
  };
}

// ── Quote generation (copy of the fixed generateQuotes) ──
function generateQuotes(market: Market, now: number): void {
  // Don't cancel fresh quotes — let them age towards maker-fill eligibility.
  // Only cancel quotes older than QUOTE_LIFETIME_MS (60s = 6 cycles).
  const QUOTE_LIFETIME_MS = 60_000;
  for (const [, q] of quotes) {
    if (q.status === "active" && now - q.createdAt > QUOTE_LIFETIME_MS) {
      q.status = "cancelled";
    }
  }

  const marketId = market.id;
  const tau = (market.expiresAt - now) / 60000;
  if (tau < CONFIG.autoExitMinutes) return;
  if (!market.active) return;

  const inv = inventory.get(marketId) || 0;
  if (Math.abs(inv) > CONFIG.maxInventory) return;

  const upBestBid = market.realUpBestBid;
  const upBestAsk = market.realUpBestAsk;
  const downBestBid = market.realDownBestBid;
  const downBestAsk = market.realDownBestAsk;
  const upRealMid = market.realUpMid;
  const downRealMid = market.realDownMid;

  // Model skew: ±1 tick (mock — real engine uses calcUpProbability)
  const modelPUp = upRealMid + (Math.random() - 0.5) * 0.1;
  const modelSignalSkew = clamp((modelPUp - upRealMid) * 0.1, -TICK_SIZE, TICK_SIZE);

  const skewTicks = Math.round(inv * CONFIG.inventorySkewFactor / TICK_SIZE) * TICK_SIZE;
  const upSkew = skewTicks + modelSignalSkew;
  const downSkew = -skewTicks - modelSignalSkew;

  const targetSpread = 0.04;

  // UP side
  let bidUp: number, askUp: number;
  {
    let b = tickFloor(upBestBid + TICK_SIZE + upSkew);
    let a = tickCeil(upBestAsk - TICK_SIZE + upSkew);
    const mktSpread = upBestAsk - upBestBid;
    if (mktSpread >= targetSpread + 2 * TICK_SIZE) {
      const m = (upBestBid + upBestAsk) / 2;
      b = tickFloor(m - targetSpread / 2 + upSkew);
      a = tickCeil(m + targetSpread / 2 + upSkew);
    }
    b = Math.min(b, tickFloor(upBestAsk - TICK_SIZE));
    a = Math.max(a, tickCeil(upBestBid + TICK_SIZE));
    b = clamp(b, TICK_SIZE, 1 - TICK_SIZE);
    a = clamp(a, TICK_SIZE, 1 - TICK_SIZE);
    bidUp = b; askUp = a;
  }
  // DOWN side
  let bidDown: number, askDown: number;
  {
    let b = tickFloor(downBestBid + TICK_SIZE + downSkew);
    let a = tickCeil(downBestAsk - TICK_SIZE + downSkew);
    const mktSpread = downBestAsk - downBestBid;
    if (mktSpread >= targetSpread + 2 * TICK_SIZE) {
      const m = (downBestBid + downBestAsk) / 2;
      b = tickFloor(m - targetSpread / 2 + downSkew);
      a = tickCeil(m + targetSpread / 2 + downSkew);
    }
    b = Math.min(b, tickFloor(downBestAsk - TICK_SIZE));
    a = Math.max(a, tickCeil(downBestBid + TICK_SIZE));
    b = clamp(b, TICK_SIZE, 1 - TICK_SIZE);
    a = clamp(a, TICK_SIZE, 1 - TICK_SIZE);
    bidDown = b; askDown = a;
  }

  const qty = Math.max(1, Math.round(CONFIG.quoteSize / Math.max(upRealMid, TICK_SIZE)));
  const finalQty = Math.max(1, qty);

  const upPos = positions.get(`${marketId}_UP`);
  const downPos = positions.get(`${marketId}_DOWN`);
  const upQtyOwned = upPos?.quantity ?? 0;
  const downQtyOwned = downPos?.quantity ?? 0;

  // Crossing safety check
  if (bidUp >= upBestAsk) {
    console.error(`❌ CROSSING! bidUp=${bidUp} >= upBestAsk=${upBestAsk}`);
    process.exit(1);
  }
  if (askUp <= upBestBid) {
    console.error(`❌ CROSSING! askUp=${askUp} <= upBestBid=${upBestBid}`);
    process.exit(1);
  }

  // Helper: find existing active quote for a side
  const findActive = (side: Quote["side"]) =>
    Array.from(quotes.values()).find(
      q => q.marketId === marketId && q.side === side && q.status === "active"
    );
  const REFRESH_TICK_THRESHOLD = 2;

  if (askUp > bidUp && askUp - bidUp >= TICK_SIZE) {
    const existingBid = findActive("BID_UP");
    if (!existingBid || Math.abs(existingBid.price - bidUp) >= REFRESH_TICK_THRESHOLD * TICK_SIZE) {
      if (existingBid) existingBid.status = "cancelled";
      const id1 = Math.random().toString(36).slice(2);
      quotes.set(id1, { id: id1, marketId, side: "BID_UP", price: bidUp, quantity: finalQty, status: "active", createdAt: now });
    }
    if (upQtyOwned >= finalQty) {
      const existingAsk = findActive("ASK_UP");
      if (!existingAsk || Math.abs(existingAsk.price - askUp) >= REFRESH_TICK_THRESHOLD * TICK_SIZE) {
        if (existingAsk) existingAsk.status = "cancelled";
        const id2 = Math.random().toString(36).slice(2);
        quotes.set(id2, { id: id2, marketId, side: "ASK_UP", price: askUp, quantity: finalQty, status: "active", createdAt: now });
      }
    }
  }
  if (askDown > bidDown && askDown - bidDown >= TICK_SIZE) {
    const existingBid = findActive("BID_DOWN");
    if (!existingBid || Math.abs(existingBid.price - bidDown) >= REFRESH_TICK_THRESHOLD * TICK_SIZE) {
      if (existingBid) existingBid.status = "cancelled";
      const id3 = Math.random().toString(36).slice(2);
      quotes.set(id3, { id: id3, marketId, side: "BID_DOWN", price: bidDown, quantity: finalQty, status: "active", createdAt: now });
    }
    if (downQtyOwned >= finalQty) {
      const existingAsk = findActive("ASK_DOWN");
      if (!existingAsk || Math.abs(existingAsk.price - askDown) >= REFRESH_TICK_THRESHOLD * TICK_SIZE) {
        if (existingAsk) existingAsk.status = "cancelled";
        const id4 = Math.random().toString(36).slice(2);
        quotes.set(id4, { id: id4, marketId, side: "ASK_DOWN", price: askDown, quantity: finalQty, status: "active", createdAt: now });
      }
    }
  }
}

// ── Fill simulation (copy of the fixed simulateFills) ──
function simulateFills(market: Market, now: number): void {
  for (const [, quote] of quotes) {
    if (quote.status !== "active") continue;
    const tau = (market.expiresAt - now) / 60000;
    if (tau < CONFIG.autoExitMinutes) continue;
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
      if (wouldCross) { fillPrice = fillQty > 0 ? tickRound(totalCost / fillQty) : quote.price; isTaker = true; }
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
      if (wouldCross) { fillPrice = fillQty > 0 ? tickRound(totalValue / fillQty) : quote.price; isTaker = true; }
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
      if (wouldCross) { fillPrice = fillQty > 0 ? tickRound(totalCost / fillQty) : quote.price; isTaker = true; }
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
      if (wouldCross) { fillPrice = fillQty > 0 ? tickRound(totalValue / fillQty) : quote.price; isTaker = true; }
    }

    if (wouldCross && fillQty > 0) {
      executeFill(quote, market, fillPrice, fillQty, isTaker);
      continue;
    }

    // Maker fill (fixed formula)
    const mid = quote.side.includes("UP") ? market.realUpMid : market.realDownMid;
    if (mid <= 0) continue;
    const ourPrice = quote.price;
    const distFromMid = Math.abs(ourPrice - mid);
    const distFactor = Math.max(0.4, 1 - distFromMid / 0.10);
    const volLiqRatio = market.liquidity > 0 ? Math.min(market.volume / market.liquidity, 1) : 0.1;
    const activityFactor = 0.5 + 0.5 * volLiqRatio;
    const timeFactor = tau < 5 ? 1.4 : tau < 10 ? 1.1 : 0.8;
    const queueAge = (now - quote.createdAt) / 1000;
    const queueFactor = Math.min(Math.max(queueAge - 2, 0) / 8, 1.0);
    const baseRate = 0.10;
    const makerFillProb = clamp(baseRate * distFactor * activityFactor * timeFactor * queueFactor, 0, 0.5);

    const roll = (tradeCycleCount * 137 + Math.floor(quote.createdAt % 997) + Math.floor(ourPrice * 1000)) % 1000;
    const thresholdMille = Math.floor(makerFillProb * 1000);
    if (roll < thresholdMille) {
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

function executeFill(quote: Quote, market: Market, fillPrice: number, fillQty: number, isTaker: boolean): void {
  fillPrice = tickRound(fillPrice);
  fillQty = Math.min(fillQty, Math.floor(CONFIG.maxPositionSize / Math.max(fillPrice, TICK_SIZE)));
  if (fillQty <= 0) return;

  const totalCost = fillPrice * fillQty;
  const feeRate = market.feeRate || DEFAULT_TAKER_FEE_RATE;
  const fee = isTaker ? calcTakerFee(fillQty, fillPrice, feeRate) : 0;
  const rebate = !isTaker ? calcMakerRebate(fillQty, fillPrice, feeRate) : 0;
  const side = quote.side;

  if (side.startsWith("BID")) {
    const totalWithFee = totalCost + fee;
    if (cashBalance < totalWithFee) { quote.status = "rejected"; quote.rejectReason = "insufficient_cash"; return; }
    cashBalance -= totalWithFee;
  } else {
    const posSide = side.includes("UP") ? "UP" : "DOWN";
    const posId = `${quote.marketId}_${posSide}`;
    const pos = positions.get(posId);
    if (!pos || pos.quantity < fillQty) { quote.status = "rejected"; quote.rejectReason = "insufficient_holdings"; return; }
    pos.quantity -= fillQty;
    pos.costBasis -= pos.entryPrice * fillQty;
    if (pos.quantity <= 0) positions.delete(posId);
    else pos.entryPrice = pos.costBasis / pos.quantity;
    cashBalance += totalCost - fee + rebate;
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
      positions.set(posId, { side: posSide as "UP" | "DOWN", entryPrice: fillPrice, quantity: fillQty, costBasis: totalCost + fee });
    }
  }

  quote.status = "filled";
  trades.push({ side, price: fillPrice, quantity: fillQty, isTaker, reason: isTaker ? "taker_fill" : "maker_fill" });
}

// ── Run simulation ──
async function main() {
  const cycles = parseInt(process.argv[2] || "200", 10);
  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  Fill Rate Simulator — ${cycles} cycles × 10s = ${cycles * 10 / 60} min simulated`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  const scenarios = [
    { name: "Tight market (50/50, 2¢ spread)", upMid: 0.50, spread: 0.02, volume: 5000, liquidity: 8000 },
    { name: "Wide market (60/40, 5¢ spread)",  upMid: 0.60, spread: 0.05, volume: 3000, liquidity: 4000 },
    { name: "Extreme market (85/15, 3¢ spread)", upMid: 0.85, spread: 0.03, volume: 8000, liquidity: 6000 },
    { name: "Low-liquidity (50/50, 2¢ spread)", upMid: 0.50, spread: 0.02, volume: 500, liquidity: 1500 },
  ];

  for (const sc of scenarios) {
    // Reset state
    cashBalance = CONFIG.startingBalance;
    tradeCycleCount = 0;
    positions.clear();
    quotes.clear();
    inventory.clear();
    trades.length = 0;

    const market = createMarket(sc);
    // Extend expiry so we get cycles * 10s of trading
    market.expiresAt = Date.now() + cycles * 10 * 1000 + 60 * 1000;

    const startTime = Date.now();
    for (let i = 0; i < cycles; i++) {
      const now = startTime + i * 10 * 1000;
      tradeCycleCount = i + 1;
      // Random walk the mid price slightly each cycle (simulate BTC movement)
      const drift = (Math.random() - 0.5) * 0.005;
      market.realUpMid = clamp(tickRound(market.realUpMid + drift), 0.05, 0.95);
      market.realDownMid = tickRound(1 - market.realUpMid);
      const upBook = buildOrderBook(market.realUpMid, sc.spread);
      market.realUpBestBid = upBook.bestBid;
      market.realUpBestAsk = upBook.bestAsk;
      market.upBids = upBook.bids;
      market.upAsks = upBook.asks;
      const downBook = buildOrderBook(market.realDownMid, sc.spread);
      market.realDownBestBid = downBook.bestBid;
      market.realDownBestAsk = downBook.bestAsk;
      market.downBids = downBook.bids;
      market.downAsks = downBook.asks;

      generateQuotes(market, now);
      simulateFills(market, now);
    }

    // Report
    const total = trades.length;
    const maker = trades.filter(t => !t.isTaker).length;
    const taker = trades.filter(t => t.isTaker).length;
    const makerPct = total > 0 ? (maker / total * 100).toFixed(1) : "0.0";
    const takerPct = total > 0 ? (taker / total * 100).toFixed(1) : "0.0";
    const totalFees = trades.filter(t => t.isTaker).reduce((s, t) => s + calcTakerFee(t.quantity, t.price), 0);
    const totalRebates = trades.filter(t => !t.isTaker).reduce((s, t) => s + calcMakerRebate(t.quantity, t.price), 0);
    const inv = inventory.get(market.id) || 0;

    console.log(`📊 ${sc.name}`);
    console.log(`   upMid=${sc.upMid} spread=${sc.spread}¢ vol=$${sc.volume} liq=$${sc.liquidity}`);
    console.log(`   Total fills:    ${total}`);
    console.log(`   Maker fills:    ${maker}  (${makerPct}%)  ${maker >= total * 0.5 ? "✅" : "❌"}`);
    console.log(`   Taker fills:    ${taker}  (${takerPct}%)  ${taker <= total * 0.1 ? "✅" : "❌"}`);
    console.log(`   Fees paid:      $${totalFees.toFixed(2)}`);
    console.log(`   Rebates earned: $${totalRebates.toFixed(2)}`);
    console.log(`   Net fees:       $${(totalRebates - totalFees).toFixed(2)}  ${totalRebates > totalFees ? "✅ PROFITABLE" : "❌"}`);
    console.log(`   Final cash:     $${cashBalance.toFixed(2)}  (started $${CONFIG.startingBalance})`);
    console.log(`   Inventory:      ${inv} tokens`);
    console.log(`   Positions:      UP=${positions.get(`${market.id}_UP`)?.quantity ?? 0} DOWN=${positions.get(`${market.id}_DOWN`)?.quantity ?? 0}`);
    console.log("");
  }

  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log(`  PASS CRITERIA: Maker ≥ 50%, Taker ≤ 10%, Net fees positive`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
