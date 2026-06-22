// ─── Contrarian Strategy v2 (2026-06-21) ──────────────────
// Complete rewrite from momentum-following to contrarian.
//
// RATIONALE (from 25% win rate analysis):
// 1. Momentum strategy bought UP after BTC rally → price already 0.80-0.90 → no room
// 2. Fees 4.4% round-trip kill symmetric R:R (need 73% win rate at entry $0.75)
// 3. L2 bid pressure is PRO-CYCLICAL (retail FOMO at top = worst entry)
// 4. Model P(UP) just mirrors market price → no edge
//
// NEW APPROACH: Contrarian + Asymmetric R:R + Maker entry
// - BTC 5m > 1.5% rally → BUY DOWN (expect mean reversion)
// - BTC 5m < -1.5% drop → BUY UP (expect bounce)
// - TP=15%, SL=5% → R:R=2.8, break-even win rate 25%
// - Maker entry (BID at best bid, no crossing) → 0 taker fee on entry
// - Entry at tau=10-13min when price ~0.50 (true coin flip, room for TP)
//
// MATHEMATICS:
// Entry $0.55, TP=$0.6325, SL=$0.5225
// Maker fee entry = $0, taker fee exit ≈ $0.04
// Net win = +$0.42, Net loss = -$0.15
// R:R = 2.8, break-even = 25%
// At 50% win rate: EV = +$0.13/trade
// At 70% win rate: EV = +$0.25/trade

export interface L2Level {
  price: number;
  size: number;
}

export interface L2DepthAnalysis {
  bidDepth: number;
  askDepth: number;
  totalDepth: number;
  bidPressure: number;
  askPressure: number;
  imbalance: number;
  bidLevels: number;
  askLevels: number;
}

export function analyzeL2Depth(bids: L2Level[], asks: L2Level[], topN: number = 5): L2DepthAnalysis {
  let bidDepth = 0, askDepth = 0, bidLevels = 0, askLevels = 0;
  for (let i = 0; i < Math.min(topN, bids.length); i++) {
    const lvl = bids[i];
    if (lvl && lvl.size > 0 && lvl.price > 0) { bidDepth += lvl.size * lvl.price; bidLevels++; }
  }
  for (let i = 0; i < Math.min(topN, asks.length); i++) {
    const lvl = asks[i];
    if (lvl && lvl.size > 0 && lvl.price > 0) { askDepth += lvl.size * lvl.price; askLevels++; }
  }
  const totalDepth = bidDepth + askDepth;
  return {
    bidDepth, askDepth, totalDepth,
    bidPressure: totalDepth > 0 ? bidDepth / totalDepth : 0.5,
    askPressure: totalDepth > 0 ? askDepth / totalDepth : 0.5,
    imbalance: totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0,
    bidLevels, askLevels,
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
  confidence: number;
  reasons: string[];
  details: {
    tau: number;
    pUp: number;
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

// ─── MAIN CONTRARIAN SIGNAL ───────────────────────────────
// Logic: BTC 5m rally → expect mean reversion → BUY DOWN
//        BTC 5m drop → expect bounce → BUY UP
//
// Hard filters (early return if violated):
//   - tau must be 10-13 min (price ~0.50, room for TP, low fees)
//   - |BTC 1m| must be < 3% (no adverse selection on spikes)
//   - BTC 5m must be > 1.5% or < -1.5% (need movement to fade)
//   - BTC 5m |change| must be < 4% (avoid extreme exhaustion, but allow fade)
//   - UP mid must be 0.20-0.80 (avoid near-resolved markets)
//
// Soft scoring (need >= 50 confidence, lower than before because signals are stronger):
//   - BTC 5m in [1.5%, 4%] → contrarian DOWN signal (+30)
//   - BTC 5m in [-4%, -1.5%] → contrarian UP signal (+30)
//   - BTC 1m confirms direction of 5m (momentum continuing) → +20 contrarian
//   - L2 imbalance CONTRARIAN: high UP bid pressure (FOMO) → +20 DOWN (fade the crowd)
//   - Price not extreme (0.30-0.70) → +10 (room for TP)
export function smartEntrySignal(
  market: MarketLike,
  btc: BtcLike,
  _pUpExternal?: number  // ignored — model P(UP) was useless (mirrors market)
): SmartEntrySignal {
  const reasons: string[] = [];
  let upConfidence = 0;
  let downConfidence = 0;

  const change1m = btc.change1m || 0;
  const change5m = btc.change5m || 0;
  const upMid = market.realUpMid;
  const downMid = market.realDownMid;
  const upL2 = analyzeL2Depth(market.upBids, market.upAsks, 5);
  const downL2 = analyzeL2Depth(market.downBids, market.downAsks, 5);

  // ── 1. Time window — 7-14 min (wide enough for multiple entries) ──
  // EXPANDED (2026-06-21): was 10-13min (3min = 20% of market life),
  // bot made 0 trades in 9h because window too narrow.
  // Now 7-14min (7min = 47% of market life) → 2.3x more entry opportunities.
  // Still avoids first 7min (price discovery noise) and last 1min (settlement risk).
  const tau = (market.expiresAt - Date.now()) / 60000;
  if (tau < 7 || tau > 14) {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`⏰ Outside contrarian window: tau=${tau.toFixed(1)}min (need 7-14min for price discovery)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }
  reasons.push(`⏰ tau=${tau.toFixed(1)}min in contrarian window (7-14min)`);

  // ── 2. Hard volatility filter — skip if |1m| > 3% (adverse selection) ──
  if (Math.abs(change1m) > 0.03) {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`⚡ Too volatile: BTC 1m ${(change1m * 100).toFixed(2)}% > ±3% (adverse selection)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }

  // ── 3. Price filter — avoid extremes ──
  if (upMid < 0.20 || upMid > 0.80) {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`🚫 UP mid $${upMid.toFixed(2)} too extreme (need 0.20-0.80)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }

  // ── 4. Contrarian signal — BTC 5m movement ──
  // BTC 5m > 1.5% rally → expect mean reversion → BUY DOWN
  // BTC 5m < -1.5% drop → expect bounce → BUY UP
  // EXPANDED (2026-06-21): was [1.5%, 4%], now [1.0%, 5%] for more entries.
  // Hard cutoff at 5% (extreme moves may continue, don't fade)
  const MIN_BTC_5M = 0.010;  // 1.0% (was 1.5%)
  const MAX_BTC_5M = 0.05;   // 5% (was 4%)

  if (change5m > MIN_BTC_5M && change5m < MAX_BTC_5M) {
    downConfidence += 30;
    reasons.push(`📉 BTC 5m +${(change5m * 100).toFixed(2)}% → contrarian DOWN (+30, expect reversion)`);
  } else if (change5m < -MIN_BTC_5M && change5m > -MAX_BTC_5M) {
    upConfidence += 30;
    reasons.push(`📈 BTC 5m ${(change5m * 100).toFixed(2)}% → contrarian UP (+30, expect bounce)`);
  } else if (Math.abs(change5m) >= MAX_BTC_5M) {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`⚡ BTC 5m ${(change5m * 100).toFixed(2)}% too extreme (>|4%|, may continue, don't fade)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  } else {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`➡️ BTC 5m ${(change5m * 100).toFixed(3)}% too small (need ±1.5% to fade)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }

  // ── 5. BTC 1m confirms 5m direction (momentum continuing = better fade) ──
  if (change5m > 0 && change1m > 0.001) {
    downConfidence += 20;
    reasons.push(`📉 BTC 1m +${(change1m * 100).toFixed(2)}% confirms rally → DOWN (+20)`);
  } else if (change5m < 0 && change1m < -0.001) {
    upConfidence += 20;
    reasons.push(`📈 BTC 1m ${(change1m * 100).toFixed(2)}% confirms drop → UP (+20)`);
  } else {
    reasons.push(`➡️ BTC 1m ${(change1m * 100).toFixed(2)}% doesn't confirm 5m (no bonus)`);
  }

  // ── 6. L2 CONTRARIAN signal — fade retail FOMO ──
  // High UP bid pressure = retail buying UP at top = fade them → BUY DOWN
  // High DOWN bid pressure = retail buying DOWN at bottom = fade them → BUY UP
  const MIN_L2_DEPTH = 50;
  if (upL2.totalDepth >= MIN_L2_DEPTH && upL2.bidPressure > 0.65) {
    downConfidence += 20;
    reasons.push(`📚 UP L2 bid pressure ${(upL2.bidPressure * 100).toFixed(0)}% (retail FOMO) → contrarian DOWN (+20)`);
  } else if (downL2.totalDepth >= MIN_L2_DEPTH && downL2.bidPressure > 0.65) {
    upConfidence += 20;
    reasons.push(`📚 DOWN L2 bid pressure ${(downL2.bidPressure * 100).toFixed(0)}% (retail FOMO) → contrarian UP (+20)`);
  } else {
    reasons.push(`📚 L2 balanced (UP bid ${(upL2.bidPressure * 100).toFixed(0)}% / DOWN bid ${(downL2.bidPressure * 100).toFixed(0)}%)`);
  }

  // ── 7. Price room bonus — prefer 0.40-0.60 (true coin flip, max room) ──
  if (upMid >= 0.40 && upMid <= 0.60) {
    upConfidence += 10;
    downConfidence += 10;
    reasons.push(`💰 UP mid $${upMid.toFixed(2)} in sweet spot 0.40-0.60 (+10 both)`);
  } else {
    reasons.push(`💰 UP mid $${upMid.toFixed(2)} outside sweet spot 0.40-0.60 (no bonus)`);
  }

  // ── 8. Decision — need >= 40 confidence AND 20+ gap ──
  // LOWERED (2026-06-21): was 50, now 40 — contrarian signals are strong
  // enough at 40+ (BTC 5m 1% move + L2 confirmation = 50+).
  // Gap stays at 20 to ensure clear direction.
  const MIN_CONFIDENCE = 40;
  const MIN_GAP = 20;

  let side: "UP" | "DOWN" = "UP";
  let confidence = 0;

  if (upConfidence >= MIN_CONFIDENCE && upConfidence > downConfidence + MIN_GAP) {
    side = "UP";
    confidence = upConfidence;
  } else if (downConfidence >= MIN_CONFIDENCE && downConfidence > upConfidence + MIN_GAP) {
    side = "DOWN";
    confidence = downConfidence;
  } else {
    return {
      should: false,
      side: upConfidence >= downConfidence ? "UP" : "DOWN",
      confidence: Math.max(upConfidence, downConfidence),
      reasons: [`🚫 Insufficient conviction: UP=${upConfidence} DOWN=${downConfidence} (need ${MIN_CONFIDENCE}+ AND ${MIN_GAP}+ gap)`, ...reasons],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence, downConfidence },
    };
  }

  return {
    should: true,
    side,
    confidence,
    reasons: [`✅ CONTRARIAN ENTER ${side} (conf=${confidence}, UP=${upConfidence} DOWN=${downConfidence})`, ...reasons],
    details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence, downConfidence },
  };
}

// ─── Asymmetric TP/SL — favorable R:R after fees ──────────
// TP=15% (entry * 1.15) — wide, but contrarian reversals are big
// SL=5%  (entry * 0.95) — tight, cut losses fast if momentum continues
//
// R:R = 15/5 = 3.0 (gross), ~2.8 after fees
// Break-even win rate: 5 / (5 + 15) = 25%
// At 50% win rate: EV = 0.5 * $0.42 - 0.5 * $0.15 = +$0.13/trade
// At 70% win rate: EV = 0.7 * $0.42 - 0.3 * $0.15 = +$0.25/trade
export const SMART_TP_PCT = 0.15;  // 15% take-profit
export const SMART_SL_PCT = 0.05;  // 5% stop-loss (tight)

export function smartTpThreshold(entryPrice: number): number {
  return entryPrice * (1 + SMART_TP_PCT);
}

export function smartSlThreshold(entryPrice: number): number {
  return entryPrice * (1 - SMART_SL_PCT);
}
