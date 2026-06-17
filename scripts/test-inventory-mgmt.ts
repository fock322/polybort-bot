#!/usr/bin/env bun
/**
 * Inventory Management Simulator
 *
 * Verifies the v2 inventory fixes:
 *   1. Position never exceeds maxInventory (was: 60 tokens > limit 50)
 *   2. Stop-loss triggers when unrealized loss > 15%
 *   3. Rebalance-only mode activates when |inv| > 12
 *   4. Adverse selection skew shifts prices when realMid moves against us
 *
 * Scenarios:
 *   A. Calm market (small drift) — bot should accumulate small inv, earn rebates
 *   B. Adverse trend (price moves against bot) — stop-loss + rebalance should cap losses
 *   C. Favorable trend (price moves with bot) — bot should profit on MtM
 *   D. Sudden crash (price drops 10¢ in 1 cycle) — stop-loss fires immediately
 *
 * Usage: bun run scripts/test-inventory-mgmt.ts [cycles]
 */

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

// ── Config (mirrors mm-engine v2) ──
const CONFIG = {
  startingBalance: 1000,
  maxPositionSize: 30,
  baseSpread: 0.03,
  autoExitMinutes: 3,
  circuitBreakerPct: 0.25,
  maxInventory: 30,
  quoteSize: 10,
  inventorySkewFactor: 0.008,
  rebalanceThreshold: 12,
  adverseSelectionFactor: 3,
  stopLossPct: 0.15,
};

interface Position {
  side: "UP" | "DOWN";
  entryPrice: number;
  quantity: number;
  costBasis: number;
  currentValue: number;
  unrealizedPnl: number;
  entryMid: number;
  peakValue: number;
}
interface Quote {
  id: string;
  marketId: string;
  side: "BID_UP" | "ASK_UP" | "BID_DOWN" | "ASK_DOWN";
  price: number;
  quantity: number;
  status: "active" | "filled" | "cancelled" | "rejected";
  createdAt: number;
}
interface OrderBookLevel { price: number; size: number; }
interface Market {
  id: string;
  expiresAt: number;
  realUpMid: number;
  realUpBestBid: number;
  realUpBestAsk: number;
  realDownMid: number;
  realDownBestBid: number;
  realDownBestAsk: number;
  upBids: OrderBookLevel[];
  upAsks: OrderBookLevel[];
  downBids: OrderBookLevel[];
  downAsks: OrderBookLevel[];
  volume: number;
  liquidity: number;
  active: boolean;
}

// ── State ──
let cashBalance = CONFIG.startingBalance;
let realizedPnl = 0;
let tradeCycleCount = 0;
const positions = new Map<string, Position>();
const quotes = new Map<string, Quote>();
const inventory = new Map<string, number>();
const trades: Array<{ side: string; price: number; quantity: number; isTaker: boolean; reason: string; }> = [];
let maxInvSeen = 0;
let stopLossCount = 0;

function buildBook(mid: number, spread: number) {
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

function makeMarket(upMid: number, spread: number): Market {
  const upBook = buildBook(upMid, spread);
  const downMid = tickRound(1 - upMid);
  const downBook = buildBook(downMid, spread);
  return {
    id: "m", expiresAt: Date.now() + 999 * 60 * 1000,
    realUpMid: upMid, realUpBestBid: upBook.bestBid, realUpBestAsk: upBook.bestAsk,
    realDownMid: downMid, realDownBestBid: downBook.bestBid, realDownBestAsk: downBook.bestAsk,
    upBids: upBook.bids, upAsks: upBook.asks,
    downBids: downBook.bids, downAsks: downBook.asks,
    volume: 5000, liquidity: 8000, active: true,
  };
}

// ── generateQuotes (v2 — with adverse selection + rebalance + price-move cancel) ──
function generateQuotes(market: Market, now: number): void {
  const QUOTE_LIFETIME_MS = 60_000;
  const PRICE_MOVE_CANCEL_TICKS = 4; // cancel quotes that drifted >4 ticks from current mid

  // ── Cancel stale OR drifted-beyond-safety quotes ──
  // When the market moves suddenly (e.g. BTC crash), our old maker bids/asks
  // become toxic: they sit far from the new mid and will be adverse-selected.
  // Cancel any active quote that's now > N ticks away from the current mid.
  for (const [, q] of quotes) {
    if (q.status !== "active") continue;
    if (now - q.createdAt > QUOTE_LIFETIME_MS) {
      q.status = "cancelled";
      continue;
    }
    const currentMid = q.side.includes("UP") ? market.realUpMid : market.realDownMid;
    if (Math.abs(q.price - currentMid) > PRICE_MOVE_CANCEL_TICKS * TICK_SIZE) {
      q.status = "cancelled";  // price drifted too far — cancel to avoid adverse fill
    }
  }

  // ── If in rebalance mode, cancel any stale BIDs on the long side ──
  // Old BID_UP quotes placed before we entered rebalance mode would keep
  // filling and growing the position. Cancel them now.
  const inv = inventory.get(market.id) || 0;
  const rebalanceOnly = Math.abs(inv) > CONFIG.rebalanceThreshold;
  if (rebalanceOnly) {
    for (const [, q] of quotes) {
      if (q.status !== "active") continue;
      if (inv > 0 && q.side === "BID_UP") q.status = "cancelled";
      if (inv < 0 && q.side === "BID_DOWN") q.status = "cancelled";
    }
  }

  const marketId = market.id;
  const upBestBid = market.realUpBestBid;
  const upBestAsk = market.realUpBestAsk;
  const downBestBid = market.realDownBestBid;
  const downBestAsk = market.realDownBestAsk;
  const upRealMid = market.realUpMid;
  const downRealMid = market.realDownMid;

  // Adverse selection
  const upPos = positions.get(`${marketId}_UP`);
  const downPos = positions.get(`${marketId}_DOWN`);
  let adverseUpSkew = 0, adverseDownSkew = 0;
  if (upPos && upPos.entryMid > 0) {
    const movedAgainst = upPos.entryMid - upRealMid;
    if (movedAgainst > 0) adverseUpSkew = -movedAgainst * CONFIG.adverseSelectionFactor;
  }
  if (downPos && downPos.entryMid > 0) {
    const movedAgainst = downPos.entryMid - downRealMid;
    if (movedAgainst > 0) adverseDownSkew = -movedAgainst * CONFIG.adverseSelectionFactor;
  }

  const modelSignalSkew = 0;
  const skewTicks = Math.round(inv * CONFIG.inventorySkewFactor / TICK_SIZE) * TICK_SIZE;
  const upSkew = skewTicks + modelSignalSkew + adverseUpSkew;
  const downSkew = -skewTicks - modelSignalSkew + adverseDownSkew;

  const allowBidUp = !(rebalanceOnly && inv > 0);
  const allowBidDown = !(rebalanceOnly && inv < 0);

  // Adaptive target spread: shrink to fit inside narrow market spreads
  const targetSpreadBase = 0.04;
  const upMktSpread = upBestAsk - upBestBid;
  const dnMktSpread = downBestAsk - downBestBid;
  const targetSpreadUp = Math.max(TICK_SIZE, Math.min(targetSpreadBase, upMktSpread - 2 * TICK_SIZE));
  const targetSpreadDown = Math.max(TICK_SIZE, Math.min(targetSpreadBase, dnMktSpread - 2 * TICK_SIZE));

  // UP side
  let bidUp: number, askUp: number;
  {
    let b = tickFloor(upBestBid + TICK_SIZE + upSkew);
    let a = tickCeil(upBestAsk - TICK_SIZE + upSkew);
    if (upMktSpread >= targetSpreadUp + 2 * TICK_SIZE) {
      const m = (upBestBid + upBestAsk) / 2;
      b = tickFloor(m - targetSpreadUp / 2 + upSkew);
      a = tickCeil(m + targetSpreadUp / 2 + upSkew);
    }
    b = Math.min(b, tickFloor(upBestAsk - TICK_SIZE));
    a = Math.max(a, tickCeil(upBestBid + TICK_SIZE));
    b = clamp(b, TICK_SIZE, 1 - TICK_SIZE);
    a = clamp(a, TICK_SIZE, 1 - TICK_SIZE);
    bidUp = b; askUp = a;
  }
  let bidDown: number, askDown: number;
  {
    let b = tickFloor(downBestBid + TICK_SIZE + downSkew);
    let a = tickCeil(downBestAsk - TICK_SIZE + downSkew);
    if (dnMktSpread >= targetSpreadDown + 2 * TICK_SIZE) {
      const m = (downBestBid + downBestAsk) / 2;
      b = tickFloor(m - targetSpreadDown / 2 + downSkew);
      a = tickCeil(m + targetSpreadDown / 2 + downSkew);
    }
    b = Math.min(b, tickFloor(downBestAsk - TICK_SIZE));
    a = Math.max(a, tickCeil(downBestBid + TICK_SIZE));
    b = clamp(b, TICK_SIZE, 1 - TICK_SIZE);
    a = clamp(a, TICK_SIZE, 1 - TICK_SIZE);
    bidDown = b; askDown = a;
  }

  const invRatio = Math.min(Math.abs(inv) / CONFIG.maxInventory, 1);
  const bidSizeMult = rebalanceOnly ? Math.max(0.3, 1 - invRatio * 0.7) : 1;
  const askSizeMult = rebalanceOnly ? Math.min(2.0, 1 + invRatio * 1.0) : 1;
  const baseQtyUp = Math.max(1, Math.round(CONFIG.quoteSize / Math.max(upRealMid, TICK_SIZE)));
  const baseQtyDown = Math.max(1, Math.round(CONFIG.quoteSize / Math.max(downRealMid, TICK_SIZE)));

  // ── Inventory-aware bid sizing: never place a BID that would push |inv| over maxInventory ──
  // remainingCapacity = maxInventory - |inv| (how much room we have)
  // If we're long UP (inv > 0), a BID_UP adds +qty to inv → cap qty to remainingCapacity.
  // If we're short (inv < 0), a BID_UP reduces |inv| → no cap (it's rebalancing).
  const remainingCapUp = Math.max(0, CONFIG.maxInventory - Math.max(0, inv));   // room to add UP
  const remainingCapDn = Math.max(0, CONFIG.maxInventory - Math.max(0, -inv));  // room to add DOWN
  const qtyBidUpCapped = Math.min(
    Math.max(1, Math.round(baseQtyUp * bidSizeMult)),
    Math.max(1, remainingCapUp)
  );
  const qtyBidDownCapped = Math.min(
    Math.max(1, Math.round(baseQtyDown * bidSizeMult)),
    Math.max(1, remainingCapDn)
  );
  const qtyAskUp = Math.max(1, Math.round(baseQtyUp * askSizeMult));
  const qtyAskDown = Math.max(1, Math.round(baseQtyDown * askSizeMult));
  const qtyBidUp = qtyBidUpCapped;
  const qtyBidDown = qtyBidDownCapped;

  const upQtyOwned = upPos?.quantity ?? 0;
  const downQtyOwned = downPos?.quantity ?? 0;

  const findActive = (side: Quote["side"]) =>
    Array.from(quotes.values()).find(q => q.marketId === marketId && q.side === side && q.status === "active");
  const REFRESH = 2;

  if (askUp > bidUp && askUp - bidUp >= TICK_SIZE) {
    if (allowBidUp) {
      const e = findActive("BID_UP");
      if (!e || Math.abs(e.price - bidUp) >= REFRESH * TICK_SIZE) {
        if (e) e.status = "cancelled";
        const id = Math.random().toString(36).slice(2);
        quotes.set(id, { id, marketId, side: "BID_UP", price: bidUp, quantity: qtyBidUp, status: "active", createdAt: now });
      }
    }
    if (upQtyOwned >= qtyAskUp) {
      const e = findActive("ASK_UP");
      if (!e || Math.abs(e.price - askUp) >= REFRESH * TICK_SIZE) {
        if (e) e.status = "cancelled";
        const id = Math.random().toString(36).slice(2);
        quotes.set(id, { id, marketId, side: "ASK_UP", price: askUp, quantity: Math.min(qtyAskUp, upQtyOwned), status: "active", createdAt: now });
      }
    }
  }
  if (askDown > bidDown && askDown - bidDown >= TICK_SIZE) {
    if (allowBidDown) {
      const e = findActive("BID_DOWN");
      if (!e || Math.abs(e.price - bidDown) >= REFRESH * TICK_SIZE) {
        if (e) e.status = "cancelled";
        const id = Math.random().toString(36).slice(2);
        quotes.set(id, { id, marketId, side: "BID_DOWN", price: bidDown, quantity: qtyBidDown, status: "active", createdAt: now });
      }
    }
    if (downQtyOwned >= qtyAskDown) {
      const e = findActive("ASK_DOWN");
      if (!e || Math.abs(e.price - askDown) >= REFRESH * TICK_SIZE) {
        if (e) e.status = "cancelled";
        const id = Math.random().toString(36).slice(2);
        quotes.set(id, { id, marketId, side: "ASK_DOWN", price: askDown, quantity: Math.min(qtyAskDown, downQtyOwned), status: "active", createdAt: now });
      }
    }
  }
}

// ── simulateFills (same as test-fill-rate) ──
function simulateFills(market: Market, now: number): void {
  for (const [, quote] of quotes) {
    if (quote.status !== "active") continue;
    if (now - quote.createdAt < MIN_MAKER_FILL_DELAY_MS) continue;

    if (quote.side === "ASK_UP" || quote.side === "ASK_DOWN") {
      const posSide = quote.side.includes("UP") ? "UP" : "DOWN";
      const pos = positions.get(`${quote.marketId}_${posSide}`);
      if (!pos || pos.quantity < quote.quantity) { quote.status = "rejected"; continue; }
    }

    let wouldCross = false, fillPrice = quote.price, fillQty = 0, isTaker = false;
    const sides: Record<string, { book: OrderBookLevel[]; isBid: boolean }> = {
      BID_UP:   { book: market.upAsks,   isBid: true  },
      ASK_UP:   { book: market.upBids,   isBid: false },
      BID_DOWN: { book: market.downAsks, isBid: true  },
      ASK_DOWN: { book: market.downBids, isBid: false },
    };
    const s = sides[quote.side];
    if (s) {
      let rem = quote.quantity, total = 0;
      for (const lvl of s.book) {
        const matches = s.isBid ? lvl.price <= quote.price : lvl.price >= quote.price;
        if (matches && lvl.size > 0 && rem > 0) {
          const take = Math.min(rem, lvl.size);
          total += take * lvl.price; fillQty += take; rem -= take; wouldCross = true;
        }
      }
      if (wouldCross) { fillPrice = tickRound(total / fillQty); isTaker = true; }
    }

    if (wouldCross && fillQty > 0) { executeFill(quote, market, fillPrice, fillQty, isTaker); continue; }

    const mid = quote.side.includes("UP") ? market.realUpMid : market.realDownMid;
    if (mid <= 0) continue;
    const distFromMid = Math.abs(quote.price - mid);
    const distFactor = Math.max(0.4, 1 - distFromMid / 0.10);
    const volLiqRatio = market.liquidity > 0 ? Math.min(market.volume / market.liquidity, 1) : 0.1;
    const activityFactor = 0.5 + 0.5 * volLiqRatio;
    const tau = (market.expiresAt - now) / 60000;
    const timeFactor = tau < 5 ? 1.4 : tau < 10 ? 1.1 : 0.8;
    const queueAge = (now - quote.createdAt) / 1000;
    const queueFactor = Math.min(Math.max(queueAge - 2, 0) / 8, 1.0);
    const prob = clamp(0.10 * distFactor * activityFactor * timeFactor * queueFactor, 0, 0.5);
    const roll = (tradeCycleCount * 137 + Math.floor(quote.createdAt % 997) + Math.floor(quote.price * 1000)) % 1000;
    if (roll < Math.floor(prob * 1000)) {
      const rej = (tradeCycleCount * 11 + Math.floor(quote.price * 1000)) % 33;
      if (rej === 0) { quote.status = "rejected"; continue; }
      executeFill(quote, market, quote.price, quote.quantity, false);
    }
  }
}

function executeFill(quote: Quote, market: Market, fillPrice: number, fillQty: number, isTaker: boolean): void {
  fillPrice = tickRound(fillPrice);
  fillQty = Math.min(fillQty, Math.floor(CONFIG.maxPositionSize / Math.max(fillPrice, TICK_SIZE)));
  if (fillQty <= 0) return;

  const totalCost = fillPrice * fillQty;
  const fee = isTaker ? calcTakerFee(fillQty, fillPrice) : 0;
  const rebate = !isTaker ? calcMakerRebate(fillQty, fillPrice) : 0;
  const side = quote.side;

  if (side.startsWith("BID")) {
    if (cashBalance < totalCost + fee) { quote.status = "rejected"; return; }
    cashBalance -= totalCost + fee;
  } else {
    const posSide = side.includes("UP") ? "UP" : "DOWN";
    const posId = `${quote.marketId}_${posSide}`;
    const pos = positions.get(posId);
    if (!pos || pos.quantity < fillQty) { quote.status = "rejected"; return; }
    pos.quantity -= fillQty;
    pos.costBasis -= pos.entryPrice * fillQty;
    if (pos.quantity <= 0) positions.delete(posId);
    else pos.entryPrice = pos.costBasis / pos.quantity;
    cashBalance += totalCost - fee + rebate;
    realizedPnl += (totalCost - fee + rebate) - (fillQty * (pos?.entryPrice ?? fillPrice));
  }

  const inv = inventory.get(quote.marketId) || 0;
  if (side === "BID_UP") inventory.set(quote.marketId, inv + fillQty);
  else if (side === "ASK_UP") inventory.set(quote.marketId, inv - fillQty);
  else if (side === "BID_DOWN") inventory.set(quote.marketId, inv - fillQty);
  else if (side === "ASK_DOWN") inventory.set(quote.marketId, inv + fillQty);

  maxInvSeen = Math.max(maxInvSeen, Math.abs(inventory.get(quote.marketId) || 0));

  if (side.startsWith("BID")) {
    const posSide = side.includes("UP") ? "UP" : "DOWN";
    const posId = `${quote.marketId}_${posSide}`;
    const entryMid = posSide === "UP" ? market.realUpMid : market.realDownMid;
    const existing = positions.get(posId);
    if (existing) {
      existing.quantity += fillQty;
      existing.costBasis += totalCost + fee;
      existing.entryPrice = existing.costBasis / existing.quantity;
      if (existing.entryMid <= 0) existing.entryMid = entryMid;
    } else {
      positions.set(posId, {
        side: posSide as "UP" | "DOWN", entryPrice: fillPrice, quantity: fillQty,
        costBasis: totalCost + fee, currentValue: totalCost, unrealizedPnl: 0,
        entryMid, peakValue: totalCost,
      });
    }
  }
  quote.status = "filled";
  trades.push({ side, price: fillPrice, quantity: fillQty, isTaker, reason: isTaker ? "taker_fill" : "maker_fill" });
}

// ── Mark to Market with stop-loss (v2) ──
function markToMarket(market: Market): void {
  const triggers: string[] = [];
  for (const [posId, pos] of positions) {
    const realPrice = pos.side === "UP" ? market.realUpMid : market.realDownMid;
    pos.currentValue = pos.quantity * realPrice;
    pos.unrealizedPnl = pos.currentValue - pos.costBasis;
    if (pos.currentValue > pos.peakValue) pos.peakValue = pos.currentValue;

    if (pos.costBasis > 0 && pos.unrealizedPnl < 0) {
      const lossPct = -pos.unrealizedPnl / pos.costBasis;
      if (lossPct >= CONFIG.stopLossPct) triggers.push(posId);
    }
  }
  for (const posId of triggers) {
    closePositionById(posId, market, "stop_loss");
    stopLossCount++;
  }
}

function closePositionById(posId: string, market: Market, reason: string): void {
  const pos = positions.get(posId);
  if (!pos) return;
  const realBid = pos.side === "UP" ? market.realUpBestBid : market.realDownBestBid;
  const closePrice = clamp(realBid > 0 ? tickFloor(realBid) : 0, TICK_SIZE, 1 - TICK_SIZE);
  if (closePrice <= 0) return;
  const closeValue = pos.quantity * closePrice;
  const fee = calcTakerFee(pos.quantity, closePrice);
  cashBalance += closeValue - fee;
  realizedPnl += (closeValue - fee) - pos.costBasis;
  trades.push({ side: `SELL_${pos.side}`, price: closePrice, quantity: pos.quantity, isTaker: true, reason });
  const inv = inventory.get(pos.marketId) || 0;
  if (pos.side === "UP") inventory.set(pos.marketId, inv - pos.quantity);
  else inventory.set(pos.marketId, inv + pos.quantity);
  positions.delete(posId);
}

function resetState() {
  cashBalance = CONFIG.startingBalance;
  realizedPnl = 0;
  tradeCycleCount = 0;
  positions.clear();
  quotes.clear();
  inventory.clear();
  trades.length = 0;
  maxInvSeen = 0;
  stopLossCount = 0;
}

// ── Run scenarios ──
async function main() {
  const cycles = parseInt(process.argv[2] || "300", 10);
  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  Inventory Management Simulator — ${cycles} cycles × 10s = ${cycles * 10 / 60} min`);
  console.log(`  maxInventory=${CONFIG.maxInventory} rebalanceThreshold=${CONFIG.rebalanceThreshold}`);
  console.log(`  stopLossPct=${CONFIG.stopLossPct * 100}% adverseSelectionFactor=${CONFIG.adverseSelectionFactor}`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  const scenarios = [
    {
      name: "A. Calm market (50/50, 4¢ spread, ±0.5¢ drift)",
      upMid: 0.50, spread: 0.04,
      drift: () => (Math.random() - 0.5) * 0.005,  // ±0.5¢
    },
    {
      name: "B. Adverse trend (price falls 0.3¢/cycle = 9¢/30min)",
      upMid: 0.50, spread: 0.04,
      drift: () => -0.003 + (Math.random() - 0.5) * 0.002,
    },
    {
      name: "C. Favorable trend (price rises 0.3¢/cycle)",
      upMid: 0.50, spread: 0.04,
      drift: () => 0.003 + (Math.random() - 0.5) * 0.002,
    },
    {
      name: "D. Sudden crash at cycle 100 (price drops 10¢ in 1 cycle)",
      upMid: 0.50, spread: 0.04,
      drift: (i: number) => i === 100 ? -0.10 : (Math.random() - 0.5) * 0.003,
    },
  ];

  for (const sc of scenarios) {
    resetState();
    const market = makeMarket(sc.upMid, sc.spread);
    const startTime = Date.now();

    for (let i = 0; i < cycles; i++) {
      const now = startTime + i * 10 * 1000;
      tradeCycleCount = i + 1;
      // Apply drift — keep raw float (don't tickRound) so small per-cycle drifts
      // accumulate into a real price move over many cycles.
      const d = sc.drift(i);
      market.realUpMid = clamp(market.realUpMid + d, 0.05, 0.95);
      market.realDownMid = 1 - market.realUpMid;
      // Best bid/ask track the mid but snap to tick (CLOB-compliant)
      const upBook = buildBook(market.realUpMid, sc.spread);
      market.realUpBestBid = upBook.bestBid; market.realUpBestAsk = upBook.bestAsk;
      market.upBids = upBook.bids; market.upAsks = upBook.asks;
      const downBook = buildBook(market.realDownMid, sc.spread);
      market.realDownBestBid = downBook.bestBid; market.realDownBestAsk = downBook.bestAsk;
      market.downBids = downBook.bids; market.downAsks = downBook.asks;

      generateQuotes(market, now);
      simulateFills(market, now);
      markToMarket(market);
    }

    // Final MtM
    let totalUnrealized = 0;
    for (const [, pos] of positions) {
      const realPrice = pos.side === "UP" ? market.realUpMid : market.realDownMid;
      pos.currentValue = pos.quantity * realPrice;
      pos.unrealizedPnl = pos.currentValue - pos.costBasis;
      totalUnrealized += pos.unrealizedPnl;
    }

    const total = trades.length;
    const maker = trades.filter(t => !t.isTaker).length;
    const taker = trades.filter(t => t.isTaker).length;
    const stopLoss = trades.filter(t => t.reason === "stop_loss").length;
    const totalPnl = (cashBalance - CONFIG.startingBalance) + totalUnrealized;
    const inv = inventory.get(market.id) || 0;

    console.log(`📊 ${sc.name}`);
    console.log(`   Final upMid:     ${market.realUpMid.toFixed(4)} (started ${sc.upMid.toFixed(2)})`);
    console.log(`   Total fills:     ${total}  (maker ${maker}, taker ${taker})`);
    console.log(`   Stop-loss fires: ${stopLoss}  ${stopLoss > 0 ? "✅" : "—"}  (total stop-loss events: ${stopLossCount})`);
    console.log(`   Max |inventory|: ${maxInvSeen}  ${maxInvSeen <= CONFIG.maxInventory ? "✅ within limit" : "❌ EXCEEDED"} (limit ${CONFIG.maxInventory})`);
    console.log(`   Final inventory: ${inv} tokens`);
    console.log(`   Realized PnL:    $${realizedPnl.toFixed(2)}`);
    console.log(`   Unrealized PnL:  $${totalUnrealized.toFixed(2)}`);
    console.log(`   TOTAL PnL:       $${totalPnl.toFixed(2)}  ${totalPnl > 0 ? "✅" : totalPnl > -10 ? "🟡" : "❌"}`);
    console.log(`   Cash:            $${cashBalance.toFixed(2)} (started $${CONFIG.startingBalance})`);
    console.log("");
  }

  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log(`  PASS CRITERIA:`);
  console.log(`    - Max |inventory| ≤ ${CONFIG.maxInventory} (no position blow-up)`);
  console.log(`    - Stop-loss fires in scenarios B and D (adverse moves)`);
  console.log(`    - Total PnL > -$20 (no catastrophic loss)`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
