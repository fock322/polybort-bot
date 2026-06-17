#!/usr/bin/env node
/**
 * Standalone Backtest Runner
 * ==========================
 * Runs the backtest engine against historical data from SQLite.
 * 
 * Usage:
 *   node scripts/run_backtest.js                       # Default config
 *   node scripts/run_backtest.js --spread 0.05         # Custom spread
 *   node scripts/run_backtest.js --balance 5000        # Custom starting balance
 *   node scripts/run_backtest.js --days 1              # Last 1 day only
 *   node scripts/run_backtest.js --sweep                # Run parameter sweep
 */

const Database = require("better-sqlite3");
const path = require("path");

// ─── Load Data from SQLite ────────────────────────────────────
function loadMarkets(db, daysBack) {
  let query;
  if (daysBack) {
    query = `
      SELECT condition_id, slug, question, start_date, end_date,
             up_token_id, down_token_id, outcome, outcome_prices,
             volume, liquidity, taker_base_fee, maker_base_fee, neg_risk, slot_ts
      FROM historical_markets
      WHERE outcome != 'Unknown'
        AND end_date >= datetime('now', '-${daysBack} days')
      ORDER BY end_date ASC
    `;
  } else {
    query = `
      SELECT condition_id, slug, question, start_date, end_date,
             up_token_id, down_token_id, outcome, outcome_prices,
             volume, liquidity, taker_base_fee, maker_base_fee, neg_risk, slot_ts
      FROM historical_markets
      WHERE outcome != 'Unknown'
      ORDER BY end_date ASC
    `;
  }

  return db.prepare(query).all().map(r => {
    let outcomePrices = [0.5, 0.5];
    try {
      const parsed = JSON.parse(r.outcome_prices);
      if (Array.isArray(parsed)) outcomePrices = parsed.map(Number);
    } catch {}

    return {
      conditionId: r.condition_id,
      slug: r.slug,
      question: r.question,
      startDate: r.start_date,
      endDate: r.end_date,
      upTokenId: r.up_token_id,
      downTokenId: r.down_token_id,
      outcome: r.outcome,
      outcomePrices,
      volume: r.volume,
      liquidity: r.liquidity,
      takerBaseFee: r.taker_base_fee,
      makerBaseFee: r.maker_base_fee,
      negRisk: Boolean(r.neg_risk),
      slotTs: r.slot_ts,
    };
  });
}

function loadTrades(db) {
  const rows = db.prepare(`
    SELECT condition_id, side, outcome, outcome_index, size, price, timestamp
    FROM historical_trades
    ORDER BY timestamp ASC
  `).all();

  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.condition_id)) map.set(r.condition_id, []);
    map.get(r.condition_id).push({
      conditionId: r.condition_id,
      side: r.side,
      outcome: r.outcome,
      outcomeIndex: r.outcome_index,
      size: r.size,
      price: r.price,
      timestamp: r.timestamp,
    });
  }
  return map;
}

function loadKlines(db) {
  return db.prepare(`
    SELECT open_time, open_price, high_price, low_price, close_price, volume, num_trades
    FROM btc_klines
    ORDER BY open_time ASC
  `).all().map(r => ({
    openTime: r.open_time,
    open: r.open_price,
    high: r.high_price,
    low: r.low_price,
    close: r.close_price,
    volume: r.volume,
    numTrades: r.num_trades,
  }));
}

// ─── Backtest Engine (pure JS, same logic as backtest-v2.ts) ──
const TICK_SIZE = 0.01;
function tickRound(p) { return Math.round(p / TICK_SIZE) * TICK_SIZE; }
function tickFloor(p) { return Math.floor(p / TICK_SIZE) * TICK_SIZE; }
function tickCeil(p) { return Math.ceil(p / TICK_SIZE) * TICK_SIZE; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function calcTakerFee(shares, price, feeRate = 0.072) { return shares * feeRate * price * (1 - price); }
function calcMakerRebate(shares, price, feeRate = 0.072) { return shares * feeRate * price * (1 - price) * 0.20; }

function computeAtrFromKlines(klines, periods = 14) {
  if (klines.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const prev = klines[i - 1], curr = klines[i];
    trs.push(Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)));
  }
  if (trs.length === 0) return 0;
  return trs.slice(-periods).reduce((s, v) => s + v, 0) / Math.min(trs.length, periods);
}

function computeBtcContext(klines, currentTs) {
  const currentMs = currentTs * 1000;
  const relevant = klines.filter(k => k.openTime <= currentMs);
  if (relevant.length < 2) return { price: 0, atr5m: 0, change1m: 0, change5m: 0, trend: "neutral" };

  const last = relevant[relevant.length - 1];
  const price = last.close;
  const atr5m = computeAtrFromKlines(relevant.slice(-5), 5);

  const k1m = relevant.length >= 2 ? relevant[relevant.length - 2] : last;
  const k5m = relevant.length >= 6 ? relevant[relevant.length - 6] : relevant[0];
  const change1m = price > 0 ? (price - k1m.close) / k1m.close * 100 : 0;
  const change5m = price > 0 ? (price - k5m.close) / k5m.close * 100 : 0;

  const avg5 = relevant.slice(-5).reduce((s, k) => s + k.close, 0) / Math.min(relevant.length, 5);
  let trend = "neutral";
  if (price > avg5 * 1.0002) trend = "up";
  else if (price < avg5 * 0.9998) trend = "down";

  return { price, atr5m, change1m, change5m, trend };
}

function parseStrikePrice(question) {
  const match = question.match(/\$([\d,]+)/);
  return match ? parseFloat(match[1].replace(/,/g, "")) : 0;
}

function calcUpProbability(strikePrice, expiresAtMs, currentTsMs, btc) {
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
    return clamp(pUp, 0.01, 0.99);
  }

  if (tau <= 0) return trend === "up" ? 0.99 : trend === "down" ? 0.01 : 0.5;
  const momentumSignal = (change1m * 2 + change5m) / 3;
  const trendBias = trend === "up" ? 0.02 : trend === "down" ? -0.02 : 0;
  const atrPct = atr5m > 0 ? (atr5m / price) * 100 : 0.1;
  const volatilityFactor = Math.max(atrPct * 10, 0.001);
  let raw = sigmoid((momentumSignal + trendBias) / volatilityFactor * 10);
  if (tau < 3) {
    raw = raw > 0.5 ? Math.min(raw + (1 - raw) * 0.5, 0.99) : Math.max(raw - raw * 0.5, 0.01);
  }
  return clamp(raw, 0.01, 0.99);
}

function runBacktest(markets, tradesByMarket, klines, config) {
  const cash = { balance: config.startingBalance };
  let realizedPnl = 0;
  const btTrades = [];
  const equityCurve = [];
  const positions = new Map();
  const inventory = new Map();

  let makerTrades = 0, takerTrades = 0;
  let totalFees = 0, totalRebates = 0;
  let maxEquity = config.startingBalance, maxDrawdown = 0;
  let circuitBreaker = false;
  let winningTrades = 0, losingTrades = 0;
  let totalHoldingTime = 0, settledPositions = 0;
  const marketsTradedSet = new Set();

  const sortedMarkets = markets
    .filter(m => m.outcome !== "Unknown")
    .sort((a, b) => {
      // Fallback: use endDate - 900s (15min window), NOT startDate (listing time ~24h before)
      const tsA = a.slotTs || (new Date(a.endDate).getTime() / 1000 - 900);
      const tsB = b.slotTs || (new Date(b.endDate).getTime() / 1000 - 900);
      return tsA - tsB;
    });

  for (const market of sortedMarkets) {
    if (circuitBreaker) break;

    // Use slot_ts for the actual 15-min window start, not startDate (which is the listing time ~24h before)
    // The window is slot_ts → endDate, always ~15 minutes
    const marketStartTs = market.slotTs || (new Date(market.endDate).getTime() / 1000 - 900);
    const marketEndTs = new Date(market.endDate).getTime() / 1000;
    const marketEndMs = marketEndTs * 1000;
    const durationMin = (marketEndTs - marketStartTs) / 60;
    if (durationMin < 5 || durationMin > 30) continue;

    const btc = computeBtcContext(klines, marketStartTs);
    if (btc.price <= 0) continue;

    const strike = parseStrikePrice(market.question);
    const marketTrades = tradesByMarket.get(market.conditionId) || [];
    if (marketTrades.length === 0) continue;

    const feeRate = (market.takerBaseFee || 1000) / 14000;

    // Get initial mid from first trades
    const firstUp = marketTrades.find(t => t.outcome === "Up");
    const firstDown = marketTrades.find(t => t.outcome === "Down");
    const realUpMid = firstUp ? tickRound(firstUp.price) : 0.5;
    const realDownMid = firstDown ? tickRound(firstDown.price) : 0.5;

    // Our model
    const modelPUp = calcUpProbability(strike, marketEndMs, marketStartTs * 1000, btc);
    const modelSignal = (modelPUp - 0.5) * 0.3;
    const pUp = clamp(tickRound(realUpMid + modelSignal), TICK_SIZE, 1 - TICK_SIZE);

    // ── v3 IMPROVEMENT 1: Skip markets with extreme probability (already decided) ──
    // If our model strongly disagrees with market, skip — likely a fast move we'll lose on
    const marketImpliedUp = realUpMid;
    const disagreement = Math.abs(modelPUp - marketImpliedUp);
    if (disagreement > (config.maxDisagreement || 0.30)) continue;

    // Skip markets where probability is already extreme (low edge, high settle risk)
    if (pUp > (config.maxProbEntry || 0.80) || pUp < (config.minProbEntry || 0.20)) continue;

    // ── v3 IMPROVEMENT 2: Directional mode — only quote side model agrees with ──
    // If model P_UP > 0.55: only BID_UP + ASK_UP (we believe UP will win)
    // If model P_UP < 0.45: only BID_DOWN + ASK_DOWN
    // If neutral: quote both sides (market-making mode)
    let quoteUp = true, quoteDown = true;
    if (config.directionalMode) {
      if (pUp > 0.55) { quoteDown = false; }       // bullish: only UP
      else if (pUp < 0.45) { quoteUp = false; }    // bearish: only DOWN
    }

    // ── v3 IMPROVEMENT 3: Confidence-based sizing ──
    // Smaller positions when |pUp - 0.5| is small (uncertain)
    const confidence = Math.abs(pUp - 0.5) * 2;  // 0..1
    const sizeMultiplier = clamp(0.5 + confidence * 0.5, 0.5, 1.0);  // 0.5x..1.0x

    // Spread
    const inv = inventory.get(market.conditionId) || 0;
    const atrFactor = (btc.atr5m / btc.price) * 100;
    const timeFactor = 1 + Math.max(0, (1 - durationMin / 15)) * 2;
    const inventoryFactor = 1 + Math.abs(inv) * 0.02;
    const spread = tickRound(Math.max(
      Math.min(config.baseSpread * (1 + atrFactor * config.atrMultiplier) * timeFactor * inventoryFactor, 0.15),
      0.01,
    ));
    const skew = tickRound(inv * config.inventorySkewFactor);

    // Quotes
    const bidUp = Math.max(TICK_SIZE, tickFloor(pUp - spread / 2 - skew));
    const askUp = Math.min(1 - TICK_SIZE, tickCeil(pUp + spread / 2 - skew));
    const bidDown = Math.max(TICK_SIZE, tickFloor((1 - pUp) - spread / 2 + skew));
    const askDown = Math.min(1 - TICK_SIZE, tickCeil((1 - pUp) + spread / 2 + skew));
    const qty = Math.max(1, Math.round((config.quoteSize * sizeMultiplier) / Math.max(pUp, TICK_SIZE)));

    // ── v3 IMPROVEMENT 4: Aggressive exit windows ──
    // At T-exitMin: convert ASK to market (sell at any price > 0)
    // At T-stopMin: full stop-loss exit (sell even at loss)
    const normalExitTs = marketEndTs - config.autoExitMinutes * 60;
    const aggressiveExitTs = marketEndTs - (config.aggressiveExitMin || 5) * 60;

    // ── BID_UP: buy UP tokens (only if quoteUp allows) ──
    const upPosKey = `${market.conditionId}_UP`;
    if (!quoteUp) {
      // skip BID_UP entirely in directional mode
    } else {
    // A BID gets filled when the market price drops TO or BELOW our bid.
    // We don't filter by BUY/SELL side — any trade at that price level indicates the market was there.
    const upSellTrades = marketTrades.filter(
      t => t.outcome === "Up" && t.price <= bidUp &&
      t.timestamp >= marketStartTs && t.timestamp < normalExitTs,
    );

    if (cash.balance > bidUp * qty + calcTakerFee(qty, bidUp, feeRate)) {
      if (upSellTrades.length > 0) {
        // Taker fill
        const fillTrade = upSellTrades[0];
        const fillPrice = tickRound(fillTrade.price);
        const fillQty = Math.min(qty, config.maxPositionSize);
        const fee = calcTakerFee(fillQty, fillPrice, feeRate);
        totalFees += fee; takerTrades++;
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
          ts: fillTrade.timestamp, slug: market.slug,
          side: "BID_UP", price: fillPrice, qty: fillQty,
          fee, rebate: 0, pnl: 0, reason: "taker_fill", cash: cash.balance,
        });
      } else {
        // Maker fill (probabilistic)
        const upNearBid = marketTrades.filter(
          t => t.outcome === "Up" && t.timestamp >= marketStartTs && t.timestamp < normalExitTs &&
          Math.abs(t.price - bidUp) <= 0.05,
        );
        // More trades near our price = higher fill chance (up to 2x base rate)
        const fillProb = config.makerFillRate * Math.min(upNearBid.length / 5, 2.0);
        const hash = (market.slotTs * 7 + Math.floor(bidUp * 1000)) % 100;
        if (hash < fillProb * 100) {
          const fillPrice = bidUp;
          const fillQty = Math.min(qty, config.maxPositionSize);
          const rebate = calcMakerRebate(fillQty, fillPrice, feeRate);
          totalRebates += rebate; makerTrades++;
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
              openedAt: marketStartTs + config.latencySeconds, marketSlug: market.slug,
            });
          }
          inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) + fillQty);
          marketsTradedSet.add(market.conditionId);

          btTrades.push({
            ts: marketStartTs + config.latencySeconds, slug: market.slug,
            side: "BID_UP", price: fillPrice, qty: fillQty,
            fee: 0, rebate, pnl: 0, reason: "maker_fill", cash: cash.balance,
          });
        }
      }
    }
    } // end if quoteUp

    // ── BID_DOWN: buy DOWN tokens (only if quoteDown allows) ──
    const downPosKey = `${market.conditionId}_DOWN`;
    if (!quoteDown) {
      // skip BID_DOWN entirely in directional mode
    } else {
    // A BID gets filled when the market price drops TO or BELOW our bid.
    // We don't filter by BUY/SELL side — any trade at that price level indicates the market was there.
    const downSellTrades = marketTrades.filter(
      t => t.outcome === "Down" && t.price <= bidDown &&
      t.timestamp >= marketStartTs && t.timestamp < normalExitTs,
    );

    if (cash.balance > bidDown * qty + calcTakerFee(qty, bidDown, feeRate)) {
      if (downSellTrades.length > 0) {
        const fillTrade = downSellTrades[0];
        const fillPrice = tickRound(fillTrade.price);
        const fillQty = Math.min(qty, config.maxPositionSize);
        const fee = calcTakerFee(fillQty, fillPrice, feeRate);
        totalFees += fee; takerTrades++;
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
          ts: fillTrade.timestamp, slug: market.slug,
          side: "BID_DOWN", price: fillPrice, qty: fillQty,
          fee, rebate: 0, pnl: 0, reason: "taker_fill", cash: cash.balance,
        });
      } else {
        const downNearBid = marketTrades.filter(
          t => t.outcome === "Down" && t.timestamp >= marketStartTs && t.timestamp < normalExitTs &&
          Math.abs(t.price - bidDown) <= 0.05,
        );
        // More trades near our price = higher fill chance (up to 2x base rate)
        const fillProb = config.makerFillRate * Math.min(downNearBid.length / 5, 2.0);
        const hash = (market.slotTs * 11 + Math.floor(bidDown * 1000)) % 100;
        if (hash < fillProb * 100) {
          const fillPrice = bidDown;
          const fillQty = Math.min(qty, config.maxPositionSize);
          const rebate = calcMakerRebate(fillQty, fillPrice, feeRate);
          totalRebates += rebate; makerTrades++;
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
              openedAt: marketStartTs + config.latencySeconds, marketSlug: market.slug,
            });
          }
          inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) - fillQty);
          marketsTradedSet.add(market.conditionId);

          btTrades.push({
            ts: marketStartTs + config.latencySeconds, slug: market.slug,
            side: "BID_DOWN", price: fillPrice, qty: fillQty,
            fee: 0, rebate, pnl: 0, reason: "maker_fill", cash: cash.balance,
          });
        }
      }
    }
    } // end if quoteDown

    // ── ASK_UP: sell UP tokens (with v3 aggressive exit + stop-loss) ──
    const upPos = positions.get(upPosKey);
    if (upPos && upPos.quantity > 0 && askUp > 0) {
      // ── v3 IMPROVEMENT 4: Aggressive exit at T-Xmin ──
      // After aggressiveExitTs, accept ANY price > stopLossPrice to exit
      // ── v3 IMPROVEMENT 5: Stop-loss on position ──
      // If best available price implies loss > stopLossPct, still exit (cut losses)
      const stopLossPrice = upPos.entryPrice * (1 - (config.stopLossPct || 0.30));

      // An ASK gets filled when the market price rises TO or ABOVE our ask.
      // We don't filter by BUY/SELL side — any trade at that price level indicates the market was there.
      let upBuyTrades = marketTrades.filter(
        t => t.outcome === "Up" && t.price >= askUp &&
        t.timestamp >= marketStartTs && t.timestamp < normalExitTs,
      );

      // If no normal fill, try aggressive exit window (any price > stopLoss)
      if (upBuyTrades.length === 0) {
        upBuyTrades = marketTrades.filter(
          t => t.outcome === "Up" && t.price >= stopLossPrice &&
          t.timestamp >= aggressiveExitTs && t.timestamp < marketEndTs,
        );
      }
      if (upBuyTrades.length > 0) {
        const fillTrade = upBuyTrades[0];
        const fillPrice = tickRound(fillTrade.price);
        const sellQty = Math.min(upPos.quantity, qty, config.maxPositionSize);
        const fee = calcTakerFee(sellQty, fillPrice, feeRate);
        totalFees += fee; takerTrades++;
        const closeValue = fillPrice * sellQty - fee;
        const entryCost = upPos.entryPrice * sellQty;
        const tradePnl = closeValue - entryCost;
        cash.balance += closeValue; realizedPnl += tradePnl;
        upPos.quantity -= sellQty; upPos.costBasis -= entryCost;
        if (upPos.quantity <= 0) {
          totalHoldingTime += fillTrade.timestamp - upPos.openedAt;
          settledPositions++; positions.delete(upPosKey);
        } else { upPos.entryPrice = upPos.costBasis / upPos.quantity; }
        inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) - sellQty);
        if (tradePnl > 0) winningTrades++; else if (tradePnl < 0) losingTrades++;

        btTrades.push({
          ts: fillTrade.timestamp, slug: market.slug,
          side: "ASK_UP", price: fillPrice, qty: sellQty,
          fee, rebate: 0, pnl: tradePnl, reason: "taker_fill", cash: cash.balance,
        });
      }
    }

    // ── ASK_DOWN: sell DOWN tokens (with v3 aggressive exit + stop-loss) ──
    const downPos = positions.get(downPosKey);
    if (downPos && downPos.quantity > 0 && askDown > 0) {
      const stopLossPriceDown = downPos.entryPrice * (1 - (config.stopLossPct || 0.30));

      let downBuyTrades = marketTrades.filter(
        t => t.outcome === "Down" && t.price >= askDown &&
        t.timestamp >= marketStartTs && t.timestamp < normalExitTs,
      );

      // If no normal fill, try aggressive exit window
      if (downBuyTrades.length === 0) {
        downBuyTrades = marketTrades.filter(
          t => t.outcome === "Down" && t.price >= stopLossPriceDown &&
          t.timestamp >= aggressiveExitTs && t.timestamp < marketEndTs,
        );
      }
      if (downBuyTrades.length > 0) {
        const fillTrade = downBuyTrades[0];
        const fillPrice = tickRound(fillTrade.price);
        const sellQty = Math.min(downPos.quantity, qty, config.maxPositionSize);
        const fee = calcTakerFee(sellQty, fillPrice, feeRate);
        totalFees += fee; takerTrades++;
        const closeValue = fillPrice * sellQty - fee;
        const entryCost = downPos.entryPrice * sellQty;
        const tradePnl = closeValue - entryCost;
        cash.balance += closeValue; realizedPnl += tradePnl;
        downPos.quantity -= sellQty; downPos.costBasis -= entryCost;
        if (downPos.quantity <= 0) {
          totalHoldingTime += fillTrade.timestamp - downPos.openedAt;
          settledPositions++; positions.delete(downPosKey);
        } else { downPos.entryPrice = downPos.costBasis / downPos.quantity; }
        inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) + sellQty);
        if (tradePnl > 0) winningTrades++; else if (tradePnl < 0) losingTrades++;

        btTrades.push({
          ts: fillTrade.timestamp, slug: market.slug,
          side: "ASK_DOWN", price: fillPrice, qty: sellQty,
          fee, rebate: 0, pnl: tradePnl, reason: "taker_fill", cash: cash.balance,
        });
      }
    }

    // ── v3 IMPROVEMENT 6: Smart hedge settlement risk ──
    // If we still hold a position and the opposite side is trading BELOW our entry,
    // buying it locks in a risk-free profit. Hedge when:
    //   - We have an open position
    //   - Opposite side's price < our entry price ( profitable hedge )
    //   - Trade occurs in last hedgeWindow minutes
    const hedgeWindowStart = marketEndTs - (config.hedgeWindowMin || 10) * 60;
    if (config.hedgeSettlement !== false) {
      const upPosH = positions.get(upPosKey);
      const downPosH = positions.get(downPosKey);

      // Hedge UP position: buy DOWN tokens (in case UP loses)
      // Profitable if hedgePrice < upPosH.entryPrice
      if (upPosH && upPosH.quantity > 0) {
        const hedgeTrades = marketTrades.filter(
          t => t.outcome === "Down" &&
          t.timestamp >= hedgeWindowStart && t.timestamp < marketEndTs &&
          t.price < upPosH.entryPrice * 0.95,  // 5% buffer below entry
        );
        if (hedgeTrades.length > 0) {
          const hedgeTrade = hedgeTrades[0];
          const hedgePrice = tickRound(hedgeTrade.price);
          const hedgeQty = Math.min(upPosH.quantity, config.maxPositionSize);
          const hedgeCost = hedgePrice * hedgeQty + calcTakerFee(hedgeQty, hedgePrice, feeRate);
          if (cash.balance >= hedgeCost) {
            cash.balance -= hedgeCost;
            const hedgeFee = calcTakerFee(hedgeQty, hedgePrice, feeRate);
            totalFees += hedgeFee; takerTrades++;
            const downHedgeKey = `${market.conditionId}_DOWN`;
            const existing = positions.get(downHedgeKey);
            if (existing) {
              existing.quantity += hedgeQty;
              existing.costBasis += hedgeCost;
              existing.entryPrice = existing.costBasis / existing.quantity;
            } else {
              positions.set(downHedgeKey, {
                side: "DOWN", entryPrice: hedgePrice, quantity: hedgeQty,
                costBasis: hedgeCost, openedAt: hedgeTrade.timestamp, marketSlug: market.slug,
              });
            }
            inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) - hedgeQty);
            btTrades.push({
              ts: hedgeTrade.timestamp, slug: market.slug,
              side: "HEDGE_DOWN", price: hedgePrice, qty: hedgeQty,
              fee: hedgeFee, rebate: 0, pnl: 0,
              reason: "hedge_up_pos", cash: cash.balance,
            });
          }
        }
      }

      // Hedge DOWN position: buy UP tokens (in case DOWN loses)
      if (downPosH && downPosH.quantity > 0) {
        const hedgeTrades = marketTrades.filter(
          t => t.outcome === "Up" &&
          t.timestamp >= hedgeWindowStart && t.timestamp < marketEndTs &&
          t.price < downPosH.entryPrice * 0.95,
        );
        if (hedgeTrades.length > 0) {
          const hedgeTrade = hedgeTrades[0];
          const hedgePrice = tickRound(hedgeTrade.price);
          const hedgeQty = Math.min(downPosH.quantity, config.maxPositionSize);
          const hedgeCost = hedgePrice * hedgeQty + calcTakerFee(hedgeQty, hedgePrice, feeRate);
          if (cash.balance >= hedgeCost) {
            cash.balance -= hedgeCost;
            const hedgeFee = calcTakerFee(hedgeQty, hedgePrice, feeRate);
            totalFees += hedgeFee; takerTrades++;
            const upHedgeKey = `${market.conditionId}_UP`;
            const existing = positions.get(upHedgeKey);
            if (existing) {
              existing.quantity += hedgeQty;
              existing.costBasis += hedgeCost;
              existing.entryPrice = existing.costBasis / existing.quantity;
            } else {
              positions.set(upHedgeKey, {
                side: "UP", entryPrice: hedgePrice, quantity: hedgeQty,
                costBasis: hedgeCost, openedAt: hedgeTrade.timestamp, marketSlug: market.slug,
              });
            }
            inventory.set(market.conditionId, (inventory.get(market.conditionId) || 0) + hedgeQty);
            btTrades.push({
              ts: hedgeTrade.timestamp, slug: market.slug,
              side: "HEDGE_UP", price: hedgePrice, qty: hedgeQty,
              fee: hedgeFee, rebate: 0, pnl: 0,
              reason: "hedge_down_pos", cash: cash.balance,
            });
          }
        }
      }
    }

    // ── Settlement ──
    const upWins = market.outcome === "Up";
    for (const [posKey, pos] of positions) {
      if (!posKey.startsWith(market.conditionId)) continue;
      const isUp = pos.side === "UP";
      const resolvedPrice = (isUp && upWins) || (!isUp && !upWins) ? 1.0 : 0.0;
      const settleValue = pos.quantity * resolvedPrice;
      const tradePnl = settleValue - pos.costBasis;
      cash.balance += settleValue; realizedPnl += tradePnl;
      totalHoldingTime += marketEndTs - pos.openedAt; settledPositions++;
      if (tradePnl > 0) winningTrades++; else if (tradePnl < 0) losingTrades++;

      btTrades.push({
        ts: marketEndTs, slug: market.slug,
        side: `SETTLE_${pos.side}`, price: resolvedPrice, qty: pos.quantity,
        fee: 0, rebate: 0, pnl: tradePnl, reason: upWins ? "settle_up_wins" : "settle_down_wins",
        cash: cash.balance,
      });
      positions.delete(posKey);
    }
    inventory.delete(market.conditionId);

    // Track equity
    const totalPnl = cash.balance - config.startingBalance;
    equityCurve.push({ ts: marketEndTs * 1000, equity: cash.balance, cash: cash.balance });
    if (cash.balance > maxEquity) maxEquity = cash.balance;
    const dd = (maxEquity - cash.balance) / maxEquity;
    if (dd > maxDrawdown) maxDrawdown = dd;

    if (-totalPnl / config.startingBalance > config.circuitBreakerPct) {
      circuitBreaker = true;
      console.error(`[BT] CIRCUIT BREAKER at ${market.slug}: pnl=$${totalPnl.toFixed(2)}`);
    }
  }

  // Final metrics
  const totalPnl = cash.balance - config.startingBalance;
  const profitableTrades = btTrades.filter(t => t.pnl > 0).length;
  const winRate = btTrades.length > 0 ? profitableTrades / btTrades.length : 0;
  const avgTradePnl = btTrades.length > 0 ? totalPnl / btTrades.length : 0;
  const avgHoldingMin = settledPositions > 0 ? (totalHoldingTime / settledPositions / 60) : 0;

  const returns = equityCurve.slice(1).map((e, i) => {
    const prev = equityCurve[i].equity;
    return prev > 0 ? (e.equity - prev) / prev : 0;
  });
  const avgReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1))
    : 1;
  const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(35040) : 0;

  return {
    totalPnl, realizedPnl, totalTrades: btTrades.length,
    makerTrades, takerTrades, winRate, avgTradePnl,
    maxDrawdown, sharpeRatio, totalFees, totalRebates,
    totalMarkets: sortedMarkets.length, marketsTraded: marketsTradedSet.size,
    winningTrades, losingTrades, avgHoldingMin,
    equityCurve, trades: btTrades,
  };
}

// ─── Main ─────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      opts[key] = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
      i++;
    }
  }

  const dbPath = path.join(__dirname, "..", "prisma", "historical.db");
  const db = new Database(dbPath, { readonly: true });

  console.log("Loading historical data...");
  const markets = loadMarkets(db, opts.days ? parseInt(opts.days) : undefined);
  const tradesByMarket = loadTrades(db);
  const klines = loadKlines(db);
  db.close();

  const totalTrades = [...tradesByMarket.values()].reduce((s, t) => s + t.length, 0);
  console.log(`  Markets: ${markets.length} | Trades: ${totalTrades.toLocaleString()} | Klines: ${klines.length}`);

  if (markets.length === 0) {
    console.error("No historical data! Run: python scripts/collect_data.py");
    process.exit(1);
  }

  if (opts.sweep) {
    // Parameter sweep
    const spreads = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.10];
    const fillRates = [0.01, 0.02, 0.03, 0.05, 0.08, 0.10];
    const quoteSizes = [5, 10, 15, 20, 30];

    console.log("\n" + "=".repeat(90));
    console.log("  PARAMETER SWEEP: Spread × FillRate × QuoteSize");
    console.log("=".repeat(90));

    const results = [];
    for (const spread of spreads) {
      for (const fillRate of fillRates) {
        for (const qs of quoteSizes) {
          const config = {
            startingBalance: 1000,
            baseSpread: spread,
            atrMultiplier: 10,
            autoExitMinutes: 3,
            quoteSize: qs,
            maxPositionSize: 30,
            maxInventory: 50,
            inventorySkewFactor: 0.005,
            circuitBreakerPct: 0.25,
            makerFillRate: fillRate,
            latencySeconds: 2,
          };
          const result = runBacktest(markets, tradesByMarket, klines, config);
          results.push({ spread, fillRate, qs, ...result });
        }
      }
    }

    // Sort by Sharpe ratio
    results.sort((a, b) => b.sharpeRatio - a.sharpeRatio);

    console.log("\n  Top 20 configurations (by Sharpe ratio):");
    console.log("  " + "-".repeat(86));
    console.log("  " + "Spread".padEnd(8) + "FillRate".padEnd(10) + "QuoteSz".padEnd(9) +
      "PnL".padStart(10) + "Trades".padStart(8) + "WinRate".padStart(9) +
      "MaxDD".padStart(8) + "Sharpe".padStart(8) + "Mkts".padStart(6));
    console.log("  " + "-".repeat(86));

    for (const r of results.slice(0, 20)) {
      console.log("  " +
        r.spread.toFixed(2).padEnd(8) +
        r.fillRate.toFixed(2).padEnd(10) +
        String(r.qs).padEnd(9) +
        (`$${r.totalPnl.toFixed(2)}`).padStart(10) +
        String(r.totalTrades).padStart(8) +
        (`${(r.winRate * 100).toFixed(1)}%`).padStart(9) +
        (`${(r.maxDrawdown * 100).toFixed(1)}%`).padStart(8) +
        r.sharpeRatio.toFixed(2).padStart(8) +
        String(r.marketsTraded).padStart(6)
      );
    }
    console.log("  " + "-".repeat(86));
  } else {
    // Single run
    const config = {
      startingBalance: parseFloat(opts.balance) || 1000,
      baseSpread: parseFloat(opts.spread) || 0.03,
      atrMultiplier: parseFloat(opts.atr) || 10,
      autoExitMinutes: parseFloat(opts.exit) || 3,
      quoteSize: parseFloat(opts.quote) || 10,
      maxPositionSize: parseFloat(opts.maxpos) || 30,
      maxInventory: parseFloat(opts.maxinv) || 50,
      inventorySkewFactor: parseFloat(opts.skew) || 0.005,
      circuitBreakerPct: parseFloat(opts.circuit) || 0.25,
      makerFillRate: parseFloat(opts.fill) || 0.03,
      latencySeconds: parseFloat(opts.latency) || 2,
      // v3 improvements
      directionalMode: opts.directional !== "false",
      maxDisagreement: parseFloat(opts.disagree) || 0.30,
      maxProbEntry: parseFloat(opts.maxprob) || 0.80,
      minProbEntry: parseFloat(opts.minprob) || 0.20,
      aggressiveExitMin: parseFloat(opts.aggr) || 5,
      stopLossPct: parseFloat(opts.stop) || 0.30,
      hedgeSettlement: opts.hedge !== "false",
      hedgeWindowMin: parseFloat(opts.hedgeMin) || 10,
    };

    console.log("\n  Config:", JSON.stringify(config, null, 2));
    console.log("\n  Running backtest...");

    const result = runBacktest(markets, tradesByMarket, klines, config);

    console.log("\n" + "=".repeat(60));
    console.log("  BACKTEST RESULTS");
    console.log("=".repeat(60));
    console.log(`  Total PnL:          $${result.totalPnl.toFixed(2)}`);
    console.log(`  Realized PnL:       $${result.realizedPnl.toFixed(2)}`);
    console.log(`  Total Trades:       ${result.totalTrades}`);
    console.log(`  Maker / Taker:      ${result.makerTrades} / ${result.takerTrades}`);
    console.log(`  Win Rate:           ${(result.winRate * 100).toFixed(1)}%`);
    console.log(`  Winning / Losing:   ${result.winningTrades} / ${result.losingTrades}`);
    console.log(`  Max Drawdown:       ${(result.maxDrawdown * 100).toFixed(1)}%`);
    console.log(`  Sharpe Ratio:       ${result.sharpeRatio.toFixed(2)}`);
    console.log(`  Total Fees Paid:    $${result.totalFees.toFixed(2)}`);
    console.log(`  Total Rebates:      $${result.totalRebates.toFixed(2)}`);
    console.log(`  Net Fees:           $${(result.totalFees - result.totalRebates).toFixed(2)}`);
    console.log(`  Markets Traded:     ${result.marketsTraded} / ${result.totalMarkets}`);
    console.log(`  Avg Holding Time:   ${result.avgHoldingMin.toFixed(1)} min`);
    console.log(`  Avg Trade PnL:      $${result.avgTradePnl.toFixed(4)}`);
    console.log(`  Final Balance:      $${result.trades.length > 0 ? result.trades[result.trades.length - 1].cash.toFixed(2) : config.startingBalance.toFixed(2)}`);
    console.log("=".repeat(60));

    // Sample trades
    console.log("\n  Last 20 trades:");
    for (const t of result.trades.slice(-20)) {
      const date = new Date(t.ts * 1000).toISOString().slice(0, 19);
      console.log(`    ${date}  ${t.side.padEnd(12)} price=${t.price.toFixed(2)} qty=${t.qty} pnl=$${t.pnl.toFixed(4)} ${t.reason}`);
    }

    // Save detailed results as JSON
    const fs = require("fs");
    const outPath = path.join(__dirname, "..", "download", "backtest_v3_result.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ config, result: {
      totalPnl: result.totalPnl,
      realizedPnl: result.realizedPnl,
      totalTrades: result.totalTrades,
      makerTrades: result.makerTrades,
      takerTrades: result.takerTrades,
      winRate: result.winRate,
      maxDrawdown: result.maxDrawdown,
      sharpeRatio: result.sharpeRatio,
      totalFees: result.totalFees,
      totalRebates: result.totalRebates,
      marketsTraded: result.marketsTraded,
      totalMarkets: result.totalMarkets,
      winningTrades: result.winningTrades,
      losingTrades: result.losingTrades,
      avgHoldingMin: result.avgHoldingMin,
      avgTradePnl: result.avgTradePnl,
      equityCurve: result.equityCurve,
      trades: result.trades,  // ALL trades for v3 analysis
    }}, null, 2));
    console.log(`\n  Detailed results saved to: ${outPath}`);
  }
}

main();
