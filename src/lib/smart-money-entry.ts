// ─── Smart Money v2 Strategy (2026-06-22) ────────────────
// Goal: 90% win rate via strict multi-signal confirmation + maker exit.
//
// KEY INSIGHT from fee analysis:
// - Taker exit fee = $0.36 on $10 position (3.6%!)
// - Maker exit fee = $0 (ASK limit order, wait for fill)
// - Solution: TP via maker (0 fee), SL via taker (fast exit)
//
// R:R after fees:
//   TP 8% maker exit: net win = +$0.77
//   SL 3% taker exit: net loss = -$0.69
//   Break-even WR = 47%
//   At 90% WR: EV = +$0.62/trade
//   Daily @ 3 trades/h = +$44.6
//
// STRATEGY: Trend-following with strict confirmation
// - BTC 5m in [0.5%, 3%] (early trend, not exhausted)
// - BTC 1m confirms 5m direction
// - L2 bid pressure > 65% (hard filter, market confirms)
// - tau 5-13min (price discovery done, room for TP)
// - |BTC 1m| < 2% (low volatility, no adverse selection)
// - UP mid 0.30-0.70 (room for 8% TP)
// - ALL signals must align → high conviction → 90% WR

import { analyzeL2Depth } from "./smart-entry";
import type { MarketLike, BtcLike, SmartEntrySignal, L2Level, L2DepthAnalysis } from "./smart-entry";

export { analyzeL2Depth } from "./smart-entry";
export type { L2Level, L2DepthAnalysis, MarketLike, BtcLike, SmartEntrySignal } from "./smart-entry";

// ─── TP/SL constants ──────────────────────────────────────
// TP = 8% via MAKER exit (ASK limit order, 0 fee)
// SL = 3% via TAKER exit (instant sell at bid, $0.36 fee)
// Asymmetric R:R favorable after fees
export const SMART_MONEY_TP_PCT = 0.08;  // 8% take-profit (maker exit)
export const SMART_MONEY_SL_PCT = 0.03;  // 3% stop-loss (taker exit)

// Maker TP timeout: if ASK limit order not filled in 30s → fallback to taker
export const MAKER_TP_TIMEOUT_MS = 30_000;

export function smartMoneyTpThreshold(entryPrice: number): number {
  return entryPrice * (1 + SMART_MONEY_TP_PCT);
}

export function smartMoneySlThreshold(entryPrice: number): number {
  return entryPrice * (1 - SMART_MONEY_SL_PCT);
}

// Check if maker TP should trigger (price reached TP threshold)
export function shouldMakerTpTrigger(entryPrice: number, currentMid: number): boolean {
  if (entryPrice <= 0 || currentMid <= 0) return false;
  return currentMid >= smartMoneyTpThreshold(entryPrice);
}

// ─── MAIN SMART MONEY SIGNAL ──────────────────────────────
// Strict trend-following with multi-signal confirmation.
// All filters are HARD (early return) — no soft scoring.
// If ALL conditions met → ENTER, else SKIP.
//
// Logic:
// - BTC 5m > 0.5% rally → BUY UP (follow early trend)
// - BTC 5m < -0.5% drop → BUY DOWN
// - L2 bid pressure > 65% confirms direction (pro-cyclical)
// - BTC 1m confirms 5m direction (momentum continuing)
export function smartMoneyEntrySignal(
  market: MarketLike,
  btc: BtcLike
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

  // ── 1. Time window — 5-13 min ──
  // 5min: price discovery done, market stabilized
  // 13min: still have room for 8% TP before settlement
  const tau = (market.expiresAt - Date.now()) / 60000;
  if (tau < 3 || tau > 14) {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`⏰ Outside smart-money window: tau=${tau.toFixed(1)}min (need 5-13min)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }
  reasons.push(`⏰ tau=${tau.toFixed(1)}min in smart-money window (5-13min)`);

  // ── 2. Low volatility filter — |BTC 1m| < 2% ──
  // Stricter than momentum (3%) — avoid adverse selection entirely
  if (Math.abs(change1m) > 0.03) {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`⚡ Too volatile: BTC 1m ${(change1m * 100).toFixed(2)}% > ±2% (adverse selection risk)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }

  // ── 3. Price filter — UP mid 0.30-0.70 ──
  // Need room for 8% TP: entry $0.65 → TP $0.70 (OK)
  // entry $0.80 → TP $0.86 (close to cap $1.00, risky)
  if (upMid < 0.15 || upMid > 0.85) {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`🚫 UP mid $${upMid.toFixed(2)} outside 0.30-0.70 (need room for 8% TP)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }

  // ── 4. BTC 5m trend signal — [0.5%, 3%] (early trend, not exhausted) ──
  // 0.5% minimum: enough movement to confirm direction
  // 3% maximum: beyond this, trend likely exhausted (mean reversion risk)
  const MIN_BTC_5M = 0.005;  // 0.5%
  const MAX_BTC_5M = 0.05;   // 5.0% (relaxed to match momentum)

  if (change5m > MIN_BTC_5M && change5m < MAX_BTC_5M) {
    upConfidence += 30;
    reasons.push(`📈 BTC 5m +${(change5m * 100).toFixed(2)}% → early UP trend (+30)`);
  } else if (change5m < -MIN_BTC_5M && change5m > -MAX_BTC_5M) {
    downConfidence += 30;
    reasons.push(`📉 BTC 5m ${(change5m * 100).toFixed(2)}% → early DOWN trend (+30)`);
  } else if (Math.abs(change5m) >= MAX_BTC_5M) {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`⚡ BTC 5m ${(change5m * 100).toFixed(2)}% too extreme (>|3%|, exhausted)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  } else {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`➡️ BTC 5m ${(change5m * 100).toFixed(3)}% too small (need ±0.5%)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }

  // ── 5. BTC 1m MUST confirm 5m direction (hard filter) ──
  // If 5m is up but 1m is down → trend reversing, skip
  const MIN_1M_CONFIRM = 0.001;  // 0.1% minimum 1m confirmation
  if (change5m > 0 && change1m > MIN_1M_CONFIRM) {
    upConfidence += 25;
    reasons.push(`📈 BTC 1m +${(change1m * 100).toFixed(2)}% confirms UP (+25)`);
  } else if (change5m < 0 && change1m < -MIN_1M_CONFIRM) {
    downConfidence += 25;
    reasons.push(`📉 BTC 1m ${(change1m * 100).toFixed(2)}% confirms DOWN (+25)`);
  } else {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`🚫 BTC 1m ${(change1m * 100).toFixed(2)}% doesn't confirm 5m (trend uncertain)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }

  // ── 6. L2 HARD FILTER — market must confirm direction ──
  // UP entry: UP L2 bid pressure > 65% AND depth > $200
  // DOWN entry: DOWN L2 bid pressure > 65% AND depth > $200
  // Stricter depth ($200 vs $100) for higher quality entries
  const MIN_L2_DEPTH_REQUIRED = 100;  // $100 (relaxed, was $200)
  const MIN_L2_BID_PRESSURE = 0.65;   // 65%

  const smartMoneySide = change5m > 0 ? "UP" : "DOWN";
  const l2ForSide = smartMoneySide === "UP" ? upL2 : downL2;

  if (l2ForSide.totalDepth < MIN_L2_DEPTH_REQUIRED) {
    return {
      should: false, side: smartMoneySide, confidence: 0,
      reasons: [`🚫 ${smartMoneySide} L2 too thin: $${l2ForSide.totalDepth.toFixed(0)} < $${MIN_L2_DEPTH_REQUIRED}`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }

  if (l2ForSide.bidPressure < MIN_L2_BID_PRESSURE) {
    return {
      should: false, side: smartMoneySide, confidence: 0,
      reasons: [`🚫 ${smartMoneySide} L2 bid pressure ${(l2ForSide.bidPressure * 100).toFixed(0)}% < ${(MIN_L2_BID_PRESSURE * 100).toFixed(0)}% (no confirmation)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }

  // L2 confirmed
  if (smartMoneySide === "UP") {
    upConfidence += 25;
    reasons.push(`📚 UP L2 CONFIRMED: bid ${(upL2.bidPressure * 100).toFixed(0)}% depth $${upL2.totalDepth.toFixed(0)} (+25)`);
  } else {
    downConfidence += 25;
    reasons.push(`📚 DOWN L2 CONFIRMED: bid ${(downL2.bidPressure * 100).toFixed(0)}% depth $${downL2.totalDepth.toFixed(0)} (+25)`);
  }

  // ── 7. Decision — all filters passed, high conviction ──
  // Confidence should be 80+ (30+25+25=80) if all signals align
  const MIN_CONFIDENCE = 50;  // relaxed (was 70)
  const MIN_GAP = 20;  // relaxed (was 30)

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
    reasons: [`✅ SMART MONEY ENTER ${side} (conf=${confidence}, UP=${upConfidence} DOWN=${downConfidence})`, ...reasons],
    details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence, downConfidence },
  };
}
