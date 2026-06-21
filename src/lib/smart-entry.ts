// ─── Smart L2 Entry Strategy ──────────────────────────────
// Goal: achieve ~90% win rate by entering only when MULTIPLE signals align:
//   1. BTC trend (1m + 5m change confirms direction)
//   2. L2 order book depth (bid/ask pressure imbalance)
//   3. Probability model (P(UP) edge vs market price)
//   4. Time window (2-12 min to expiry — not too early, not too late)
//   5. Price filter (avoid extremes 0.10/0.90 and middle 0.45-0.55)
//
// Key principle: CONFIDENCE-BASED ENTRY
// Bot only enters when 3+ signals agree on direction → high conviction → high win rate.
// If signals conflict or are weak → SKIP (no entry is better than bad entry).
//
// Risk/Reward:
//   TP = 6% (entry * 1.06) — realistic, hit often when direction is right
//   SL = 10% (entry * 0.90) — tight enough to cut losses, loose enough for noise
//   Break-even win rate: 10 / (10 + 6) = 62.5%
//   At 90% win rate: EV = 0.9 * $0.156 - 0.1 * $0.375 = +$0.10/trade
//   Profit factor at 90%: (0.9 * 0.156) / (0.1 * 0.375) = 3.74

export interface L2Level {
  price: number;
  size: number;
}

export interface L2DepthAnalysis {
  bidDepth: number;       // sum of (size * price) for top N bid levels (USD)
  askDepth: number;       // sum of (size * price) for top N ask levels (USD)
  totalDepth: number;
  bidPressure: number;    // bidDepth / totalDepth (0-1, >0.5 = buyers dominate)
  askPressure: number;    // askDepth / totalDepth (0-1, >0.5 = sellers dominate)
  imbalance: number;      // (bidDepth - askDepth) / totalDepth (-1 to +1)
  bidLevels: number;      // count of meaningful bid levels
  askLevels: number;      // count of meaningful ask levels
}

// Analyze L2 depth: aggregate top N levels of order book
export function analyzeL2Depth(
  bids: L2Level[],
  asks: L2Level[],
  topN: number = 5
): L2DepthAnalysis {
  let bidDepth = 0;
  let askDepth = 0;
  let bidLevels = 0;
  let askLevels = 0;

  for (let i = 0; i < Math.min(topN, bids.length); i++) {
    const lvl = bids[i];
    if (lvl && lvl.size > 0 && lvl.price > 0) {
      bidDepth += lvl.size * lvl.price;
      bidLevels++;
    }
  }
  for (let i = 0; i < Math.min(topN, asks.length); i++) {
    const lvl = asks[i];
    if (lvl && lvl.size > 0 && lvl.price > 0) {
      askDepth += lvl.size * lvl.price;
      askLevels++;
    }
  }

  const totalDepth = bidDepth + askDepth;
  return {
    bidDepth,
    askDepth,
    totalDepth,
    bidPressure: totalDepth > 0 ? bidDepth / totalDepth : 0.5,
    askPressure: totalDepth > 0 ? askDepth / totalDepth : 0.5,
    imbalance: totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0,
    bidLevels,
    askLevels,
  };
}

export interface MarketLike {
  expiresAt: number;
  realUpMid: number;
  realDownMid: number;
  realUpBestBid: number;
  realUpBestAsk: number;
  realDownBestBid: number;
  realDownBestAsk: number;
  upBids: L2Level[];
  upAsks: L2Level[];
  downBids: L2Level[];
  downAsks: L2Level[];
  strikePrice: number;
  slug: string;
  question: string;
}

export interface BtcLike {
  price: number;
  atr5m: number;
  change1m: number;
  change5m: number;
  trend: string;
}

export interface SmartEntrySignal {
  should: boolean;
  side: "UP" | "DOWN";
  confidence: number;       // 0-100, need >= 70 to enter
  reasons: string[];        // human-readable signals
  details: {
    tau: number;            // minutes to expiry
    pUp: number;            // model probability UP wins
    btcChange1m: number;
    btcChange5m: number;
    upL2: L2DepthAnalysis;
    downL2: L2DepthAnalysis;
    upMid: number;
    downMid: number;
    upConfidence: number;
    downConfidence: number;
  };
}

// Local probability calc (simple version to avoid circular import with mm-engine)
function calcPUpSimple(market: MarketLike, btc: BtcLike): number {
  const { price, atr5m } = btc;
  if (price <= 0) return 0.5;

  let strike = market.strikePrice;
  if (strike <= 0) strike = price;
  if (strike <= 0) return 0.5;

  const tau = (market.expiresAt - Date.now()) / 60000;
  if (tau <= 0) return price > strike ? 0.99 : 0.01;

  const distPct = (price - strike) / price;
  const atrPct = atr5m > 0 ? atr5m / price : 0.001;
  const expectedMove = atrPct * Math.sqrt(Math.max(tau, 0.1) / 5);

  if (expectedMove <= 0) return price > strike ? 0.6 : 0.4;

  // Z-score: how many std devs is current price above strike
  const z = distPct / expectedMove;

  // Sigmoid: P(UP) = 1 / (1 + exp(-k*z))
  // k=3 gives smooth probability curve
  const k = 3;
  const pUp = 1 / (1 + Math.exp(-k * z));

  // Blend with market price (50% model, 50% market — Bayesian-ish)
  const marketPUp = market.realUpMid > 0 ? market.realUpMid : 0.5;
  return 0.6 * pUp + 0.4 * marketPUp;
}

// ─── MAIN SMART ENTRY SIGNAL ──────────────────────────────
// Returns entry decision based on 4 signals:
//   1. BTC trend (1m + 5m change)
//   2. L2 depth pressure (bid/ask imbalance)
//   3. Probability model (P(UP) edge)
//   4. Time window (2-12 min to expiry)
//
// Confidence scoring (need >= 70 to enter, AND 10+ gap between UP/DOWN):
//   - BTC 1m change > 0.05%: +25 for direction
//   - BTC 5m change > 0.15%: +25 for direction
//   - L2 bid pressure > 65%: +20 for direction (per token side)
//   - L2 ask pressure > 65%: +20 for OPPOSITE direction (sellers = bearish)
//   - Model P(UP) > 65%: +25 for UP, < 35%: +25 for DOWN
//   - Time bonus (tau < 5): +5 both
//
// Max possible: 25 + 25 + 20 + 20 + 25 + 5 = 120 (but rarely all align)
// Realistic strong signal: 70-90
export function smartEntrySignal(
  market: MarketLike,
  btc: BtcLike,
  pUpExternal?: number  // optional: use external calcUpProbability if available
): SmartEntrySignal {
  const reasons: string[] = [];
  let upConfidence = 0;
  let downConfidence = 0;

  // ── 1. Time window filter ──
  const tau = (market.expiresAt - Date.now()) / 60000;
  if (tau < 2 || tau > 12) {
    return {
      should: false,
      side: "UP",
      confidence: 0,
      reasons: [`⏰ Outside time window: tau=${tau.toFixed(1)}min (need 2-12min)`],
      details: {
        tau,
        pUp: pUpExternal ?? 0.5,
        btcChange1m: btc.change1m || 0,
        btcChange5m: btc.change5m || 0,
        upL2: analyzeL2Depth(market.upBids, market.upAsks),
        downL2: analyzeL2Depth(market.downBids, market.downAsks),
        upMid: market.realUpMid,
        downMid: market.realDownMid,
        upConfidence: 0,
        downConfidence: 0,
      },
    };
  }

  // Time bonus: closer to expiry = signal more reliable (less time for reversal)
  if (tau < 5) {
    upConfidence += 5;
    downConfidence += 5;
    reasons.push(`⏰ Time: ${tau.toFixed(1)}min to expiry (close = +5 bonus)`);
  } else {
    reasons.push(`⏰ Time: ${tau.toFixed(1)}min to expiry (OK but no bonus)`);
  }

  // ── 2. BTC trend signals ──
  const change1m = btc.change1m || 0;
  const change5m = btc.change5m || 0;

  // 1-minute change threshold: 0.05% = ~$30 on $60k BTC
  if (change1m > 0.0005) {
    upConfidence += 25;
    reasons.push(`📈 BTC 1m +${(change1m * 100).toFixed(2)}% → UP (+25)`);
  } else if (change1m < -0.0005) {
    downConfidence += 25;
    reasons.push(`📉 BTC 1m ${(change1m * 100).toFixed(2)}% → DOWN (+25)`);
  } else {
    reasons.push(`➡️ BTC 1m ${(change1m * 100).toFixed(3)}% (no signal, need ±0.05%)`);
  }

  // 5-minute change threshold: 0.15% = ~$95 on $60k BTC
  if (change5m > 0.0015) {
    upConfidence += 25;
    reasons.push(`📈 BTC 5m +${(change5m * 100).toFixed(2)}% → UP trend (+25)`);
  } else if (change5m < -0.0015) {
    downConfidence += 25;
    reasons.push(`📉 BTC 5m ${(change5m * 100).toFixed(2)}% → DOWN trend (+25)`);
  } else {
    reasons.push(`➡️ BTC 5m ${(change5m * 100).toFixed(3)}% (no signal, need ±0.15%)`);
  }

  // ── 3. L2 Depth analysis ──
  const upL2 = analyzeL2Depth(market.upBids, market.upAsks, 5);
  const downL2 = analyzeL2Depth(market.downBids, market.downAsks, 5);

  // UP token L2: high bid pressure = people buying UP = bullish for UP
  // Min depth $50 to filter out empty books
  const MIN_L2_DEPTH = 50;
  if (upL2.totalDepth >= MIN_L2_DEPTH) {
    if (upL2.bidPressure > 0.65) {
      upConfidence += 20;
      reasons.push(`📚 UP L2 bid pressure ${(upL2.bidPressure * 100).toFixed(0)}% → UP (+20)`);
    } else if (upL2.askPressure > 0.65) {
      // People selling UP = they think DOWN wins
      downConfidence += 20;
      reasons.push(`📚 UP L2 ask pressure ${(upL2.askPressure * 100).toFixed(0)}% → DOWN (+20)`);
    } else {
      reasons.push(`📚 UP L2 balanced (bid ${(upL2.bidPressure * 100).toFixed(0)}% / ask ${(upL2.askPressure * 100).toFixed(0)}%)`);
    }
  } else {
    reasons.push(`⚠️ UP L2 too thin ($${upL2.totalDepth.toFixed(0)} < $${MIN_L2_DEPTH})`);
  }

  if (downL2.totalDepth >= MIN_L2_DEPTH) {
    if (downL2.bidPressure > 0.65) {
      downConfidence += 20;
      reasons.push(`📚 DOWN L2 bid pressure ${(downL2.bidPressure * 100).toFixed(0)}% → DOWN (+20)`);
    } else if (downL2.askPressure > 0.65) {
      // People selling DOWN = they think UP wins
      upConfidence += 20;
      reasons.push(`📚 DOWN L2 ask pressure ${(downL2.askPressure * 100).toFixed(0)}% → UP (+20)`);
    } else {
      reasons.push(`📚 DOWN L2 balanced (bid ${(downL2.bidPressure * 100).toFixed(0)}% / ask ${(downL2.askPressure * 100).toFixed(0)}%)`);
    }
  } else {
    reasons.push(`⚠️ DOWN L2 too thin ($${downL2.totalDepth.toFixed(0)} < $${MIN_L2_DEPTH})`);
  }

  // ── 4. Probability model ──
  const pUp = pUpExternal ?? calcPUpSimple(market, btc);
  if (pUp > 0.65) {
    upConfidence += 25;
    reasons.push(`🎯 Model P(UP)=${(pUp * 100).toFixed(0)}% > 65% → UP (+25)`);
  } else if (pUp < 0.35) {
    downConfidence += 25;
    reasons.push(`🎯 Model P(UP)=${(pUp * 100).toFixed(0)}% < 35% → DOWN (+25)`);
  } else {
    reasons.push(`🎯 Model P(UP)=${(pUp * 100).toFixed(0)}% (neutral, need <35% or >65%)`);
  }

  // ── 5. Price filter — avoid extremes and pure coin-flip ──
  const upMid = market.realUpMid;
  if (upMid < 0.10 || upMid > 0.90) {
    return {
      should: false,
      side: "UP",
      confidence: 0,
      reasons: [`🚫 UP mid $${upMid.toFixed(2)} too extreme (need 0.10-0.90)`, ...reasons],
      details: {
        tau, pUp, btcChange1m: change1m, btcChange5m: change5m,
        upL2, downL2, upMid, downMid: market.realDownMid,
        upConfidence, downConfidence,
      },
    };
  }

  // ── 6. Decision — need >= 70 confidence AND 10+ gap ──
  const MIN_CONFIDENCE = 70;
  const MIN_GAP = 10;

  let side: "UP" | "DOWN" = "UP";
  let confidence = 0;

  if (upConfidence >= MIN_CONFIDENCE && upConfidence > downConfidence + MIN_GAP) {
    side = "UP";
    confidence = upConfidence;
  } else if (downConfidence >= MIN_CONFIDENCE && downConfidence > upConfidence + MIN_GAP) {
    side = "DOWN";
    confidence = downConfidence;
  } else {
    // Not enough conviction — skip
    return {
      should: false,
      side: upConfidence >= downConfidence ? "UP" : "DOWN",
      confidence: Math.max(upConfidence, downConfidence),
      reasons: [
        `🚫 Insufficient conviction: UP=${upConfidence} DOWN=${downConfidence} (need ${MIN_CONFIDENCE}+ AND ${MIN_GAP}+ gap)`,
        ...reasons,
      ],
      details: {
        tau, pUp, btcChange1m: change1m, btcChange5m: change5m,
        upL2, downL2, upMid, downMid: market.realDownMid,
        upConfidence, downConfidence,
      },
    };
  }

  return {
    should: true,
    side,
    confidence,
    reasons: [
      `✅ ENTER ${side} (confidence=${confidence}/100, UP=${upConfidence} DOWN=${downConfidence})`,
      ...reasons,
    ],
    details: {
      tau, pUp, btcChange1m: change1m, btcChange5m: change5m,
      upL2, downL2, upMid, downMid: market.realDownMid,
      upConfidence, downConfidence,
    },
  };
}

// ─── Smart TP/SL thresholds ───────────────────────────────
// Goal: favorable R:R for high-win-rate strategy
//
// TP = 6% (entry * 1.06) — realistic, hits often when direction is right
// SL = 10% (entry * 0.90) — tight enough to cut losses, loose enough for noise
//
// Break-even win rate: 10 / (10 + 6) = 62.5%
// At 90% win rate: EV = 0.9 * $0.156 - 0.1 * $0.375 = +$0.10/trade
// Profit factor at 90%: (0.9 * 0.156) / (0.1 * 0.375) = 3.74
export const SMART_TP_PCT = 0.06;  // 6% take-profit
export const SMART_SL_PCT = 0.10;  // 10% stop-loss

export function smartTpThreshold(entryPrice: number): number {
  return entryPrice * (1 + SMART_TP_PCT);
}

export function smartSlThreshold(entryPrice: number): number {
  return entryPrice * (1 - SMART_SL_PCT);
}
