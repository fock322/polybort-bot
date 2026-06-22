// ─── Momentum Strategy (Trend-Following) ─────────────────
// Opposite of Contrarian: follow the trend, not fade it.
//
// LOGIC:
// - BTC 5m > 1.5% rally → BUY UP (momentum continuing)
// - BTC 5m < -1.5% drop → BUY DOWN (momentum continuing)
// - L2 bid pressure CONFIRMS (pro-cyclical: UP bid > 65% → +20 UP)
//
// TRAILING TAKE-PROFIT (no fixed TP ceiling):
// - Track peak value of position
// - When current value drops 10% from peak → SELL (lock profit)
// - No upper limit — let winners run
// - Example: entry $0.50, peak $0.80, drops to $0.72 → sell (lock +44%)
//
// STOP-LOSS: 5% fixed (tight, same as contrarian)
//
// R:R: variable (trailing), minimum 1:1 at breakeven, can be 5:1+ on big trends

import { analyzeL2Depth } from "./smart-entry";
import type { MarketLike, BtcLike, SmartEntrySignal, L2Level, L2DepthAnalysis } from "./smart-entry";
export { analyzeL2Depth } from "./smart-entry";
export type { L2Level, L2DepthAnalysis, MarketLike, BtcLike, SmartEntrySignal } from "./smart-entry";

// ─── Trailing TP constants ────────────────────────────────
// TRAILING_TP_DROP_PCT: sell when price drops this % from peak
// Example: 0.10 = 10% drop from peak triggers sell
//   entry=$0.50, peak=$0.80, current=$0.72 → 10% drop → SELL (lock +44%)
//   entry=$0.50, peak=$0.55, current=$0.495 → 10% drop → SELL (lock -1%)
//
// No upper limit — position can grow indefinitely.
// The bigger the trend, the bigger the profit captured.
export const TRAILING_TP_DROP_PCT = 0.10;  // 10% drop from peak → sell

// Stop-loss: 5% fixed (same as contrarian, tight)
export const MOMENTUM_SL_PCT = 0.05;

export function momentumSlThreshold(entryPrice: number): number {
  return entryPrice * (1 - MOMENTUM_SL_PCT);
}

// Check if trailing TP should trigger
// Returns true if current value has dropped TRAILING_TP_DROP_PCT from peak
export function shouldTrailingTpTrigger(peakValue: number, currentValue: number): boolean {
  if (peakValue <= 0 || currentValue <= 0) return false;
  // Only trigger if we're in profit (peak > entry implies profit at some point)
  // Drop % = (peak - current) / peak
  const dropPct = (peakValue - currentValue) / peakValue;
  return dropPct >= TRAILING_TP_DROP_PCT;
}

// ─── MAIN MOMENTUM SIGNAL ─────────────────────────────────
// Trend-following: buy in direction of BTC movement
// L2 confirmation: bid pressure on our side = trend confirmed
//
// Hard filters (same as contrarian for fair comparison):
//   - tau 7-14 min
//   - |BTC 1m| < 3%
//   - UP mid 0.20-0.80
//   - BTC 5m in [1.0%, 5.0%]
//
// Soft scoring (need >= 40 confidence AND 20+ gap):
//   - BTC 5m in [1.0%, 5.0%] → momentum signal (+30)
//   - BTC 1m confirms → +20
//   - L2 bid pressure confirms (PRO-CYCLICAL) → +20
//   - Sweet spot 0.40-0.60 → +10
export function momentumEntrySignal(
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

  // ── 1. Time window — 7-14 min (same as contrarian) ──
  const tau = (market.expiresAt - Date.now()) / 60000;
  if (tau < 7 || tau > 14) {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`⏰ Outside momentum window: tau=${tau.toFixed(1)}min (need 7-14min)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }
  reasons.push(`⏰ tau=${tau.toFixed(1)}min in momentum window (7-14min)`);

  // ── 2. Hard volatility filter — skip if |1m| > 3% ──
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

  // ── 4. Momentum signal — BTC 5m movement (FOLLOW trend) ──
  // BTC 5m > 1.0% rally → BUY UP (momentum continuing)
  // BTC 5m < -1.0% drop → BUY DOWN (momentum continuing)
  const MIN_BTC_5M = 0.010;  // 1.0%
  const MAX_BTC_5M = 0.05;   // 5.0%

  if (change5m > MIN_BTC_5M && change5m < MAX_BTC_5M) {
    upConfidence += 30;
    reasons.push(`📈 BTC 5m +${(change5m * 100).toFixed(2)}% → momentum UP (+30, follow trend)`);
  } else if (change5m < -MIN_BTC_5M && change5m > -MAX_BTC_5M) {
    downConfidence += 30;
    reasons.push(`📉 BTC 5m ${(change5m * 100).toFixed(2)}% → momentum DOWN (+30, follow trend)`);
  } else if (Math.abs(change5m) >= MAX_BTC_5M) {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`⚡ BTC 5m ${(change5m * 100).toFixed(2)}% too extreme (>|5%|, may reverse)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  } else {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`➡️ BTC 5m ${(change5m * 100).toFixed(3)}% too small (need ±1.0% for momentum)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }

  // ── 5. BTC 1m confirms 5m direction (momentum continuing) ──
  if (change5m > 0 && change1m > 0.001) {
    upConfidence += 20;
    reasons.push(`📈 BTC 1m +${(change1m * 100).toFixed(2)}% confirms rally → UP (+20)`);
  } else if (change5m < 0 && change1m < -0.001) {
    downConfidence += 20;
    reasons.push(`📉 BTC 1m ${(change1m * 100).toFixed(2)}% confirms drop → DOWN (+20)`);
  } else {
    reasons.push(`➡️ BTC 1m ${(change1m * 100).toFixed(2)}% doesn't confirm 5m (no bonus)`);
  }

  // ── 6. L2 PRO-CYCLICAL signal — confirm trend (opposite of contrarian) ──
  // High UP bid pressure = retail buying UP = trend confirmed → BUY UP
  // High DOWN bid pressure = retail buying DOWN = trend confirmed → BUY DOWN
  const MIN_L2_DEPTH = 50;
  if (upL2.totalDepth >= MIN_L2_DEPTH && upL2.bidPressure > 0.65) {
    upConfidence += 20;
    reasons.push(`📚 UP L2 bid pressure ${(upL2.bidPressure * 100).toFixed(0)}% (trend confirm) → momentum UP (+20)`);
  } else if (downL2.totalDepth >= MIN_L2_DEPTH && downL2.bidPressure > 0.65) {
    downConfidence += 20;
    reasons.push(`📚 DOWN L2 bid pressure ${(downL2.bidPressure * 100).toFixed(0)}% (trend confirm) → momentum DOWN (+20)`);
  } else {
    reasons.push(`📚 L2 balanced (UP bid ${(upL2.bidPressure * 100).toFixed(0)}% / DOWN bid ${(downL2.bidPressure * 100).toFixed(0)}%)`);
  }

  // ── 7. Price room bonus — prefer 0.40-0.60 ──
  if (upMid >= 0.40 && upMid <= 0.60) {
    upConfidence += 10;
    downConfidence += 10;
    reasons.push(`💰 UP mid $${upMid.toFixed(2)} in sweet spot 0.40-0.60 (+10 both)`);
  } else {
    reasons.push(`💰 UP mid $${upMid.toFixed(2)} outside sweet spot 0.40-0.60 (no bonus)`);
  }

  // ── 8. Decision — need >= 40 confidence AND 20+ gap ──
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
    reasons: [`✅ MOMENTUM ENTER ${side} (conf=${confidence}, UP=${upConfidence} DOWN=${downConfidence})`, ...reasons],
    details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence, downConfidence },
  };
}
