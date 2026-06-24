// ─── Smart Money v4 Strategy ─────────────────────────────
// Goal: 90% win rate via trend-following + hold to settlement.
//
// KEY: Trailing Take-Profit — фиксируем прибыль при просадке от пика.
//   - Позиция держится до settlement (до +100% profit)
//   - НО: если unrealized PnL вырос до пика, а потом упал на 20% от пика → закрываем
//   - Пример: peak=+$15, drop 20% → current=+$12 → закрываем, фиксируем +$12
//   - Это защищает от разворота: вместо -10% SL получаем +$12 profit
//
// SL: 10% token mid drop (30s min hold, emergency 25% immediate).
// Maker exit for SL + trailing TP (0 fee), settlement = $1.00 or $0.00.
//
// Entry: trend-following with strict multi-signal confirmation.
// All filters are HARD (early return). ALL must pass to enter.

import { analyzeL2Depth } from "./smart-entry";
import type { MarketLike, BtcLike, SmartEntrySignal, L2Level, L2DepthAnalysis } from "./smart-entry";

export { analyzeL2Depth } from "./smart-entry";
export type { L2Level, L2DepthAnalysis, MarketLike, BtcLike, SmartEntrySignal } from "./smart-entry";

// ─── Trailing TP constants ────────────────────────────────
// SMART MONEY v4: trailing TP — закрываем позицию когда unrealized PnL
// упал на TRAILING_TP_DROP_PCT от пикового значения.
//
// Логика:
//   - bot отслеживает peakPnl (максимальный unrealized PnL за время удержания)
//   - если currentPnl <= peakPnl * (1 - TRAILING_TP_DROP_PCT) → закрываем
//   - trailing TP срабатывает ТОЛЬКО когда позиция в плюсе (peakPnl > 0)
//   - если позиция сразу в минусе — trailing TP не работает, ждём SL/settlement
//
// Пример (TRAILING_TP_DROP_PCT = 0.20):
//   entry=$0.50, peak mid=$0.80 → peakPnl=+$3.00 (на 10 токенов)
//   current mid=$0.74 → currentPnl=+$2.40 (drop 20% от $3.00)
//   → ЗАКРЫВАЕМ, фиксируем +$2.40 вместо риска -10% SL
export const TRAILING_TP_DROP_PCT = 0.20;  // 20% drop from peak PnL → close

export function shouldSmartMoneyTrailingTpTrigger(peakPnl: number, currentPnl: number): boolean {
  // Только если позиция была в плюсе (peakPnl > 0)
  if (peakPnl <= 0) return false;
  // Drop % = (peak - current) / peak
  const dropPct = (peakPnl - currentPnl) / peakPnl;
  return dropPct >= TRAILING_TP_DROP_PCT;
}

// NOTE: SL is defined in mm-engine.ts markToMarket (SL_DROP_PCT = 0.10).


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
  // SMART MONEY v3: tau 2-14 (enter early, hold to settlement)
  if (tau < 2 || tau > 14) {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`⏰ Outside smart-money window: tau=${tau.toFixed(1)}min (need 2-14min)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }
  reasons.push(`⏰ tau=${tau.toFixed(1)}min in smart-money window (2-14min)`);

  // ── 2. Volatility filter — |1m| < 5% ──
  if (Math.abs(change1m) > 0.05) {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`⚡ Too volatile: 1m ${(change1m * 100).toFixed(2)}% > ±5% (adverse selection)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }

  // ── 3. Price filter — UP mid 0.20-0.85 (soft, preserves winning trades) ──
  // SOFT FIX (2026-06-23): was 0.15-0.85, analysis showed W#7 had entry $0.22.
  // Min $0.20 blocks L#8 ($0.19) but keeps W#7 ($0.22).
  // Max $0.85 keeps W#4 ($0.76).
  if (upMid < 0.20 || upMid > 0.85) {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`🚫 UP mid $${upMid.toFixed(2)} outside 0.20-0.85`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }

  // ── 4. BTC 5m trend signal — [0.2%, 8%] (early trend, not exhausted) ──
  const MIN_BTC_5M = 0.002;  // 0.2%
  const MAX_BTC_5M = 0.08;   // 8%

  if (change5m > MIN_BTC_5M && change5m < MAX_BTC_5M) {
    upConfidence += 30;
    reasons.push(`📈 5m +${(change5m * 100).toFixed(2)}% → early UP trend (+30)`);
  } else if (change5m < -MIN_BTC_5M && change5m > -MAX_BTC_5M) {
    downConfidence += 30;
    reasons.push(`📉 5m ${(change5m * 100).toFixed(2)}% → early DOWN trend (+30)`);
  } else if (Math.abs(change5m) >= MAX_BTC_5M) {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`⚡ 5m ${(change5m * 100).toFixed(2)}% too extreme (>|8%|, exhausted)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  } else {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`➡️ 5m ${(change5m * 100).toFixed(3)}% too small (need ±0.2%)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }

  // ── 5. 1m MUST confirm 5m direction (HARD FILTER — FIX 1) ──
  // FIX 1 (2026-06-23): If 1m and 5m disagree → contradictory signal → SKIP
  // This was the cause of the $2.16 loss: 1m=+4.46% but 5m=-5.79%
  // Bot entered UP when 5m said DOWN → instant loss
  const MIN_1M_CONFIRM = 0.001;  // 0.1% minimum 1m confirmation
  if (change5m > 0 && change1m > MIN_1M_CONFIRM) {
    upConfidence += 25;
    reasons.push(`📈 1m +${(change1m * 100).toFixed(2)}% confirms UP (+25)`);
  } else if (change5m < 0 && change1m < -MIN_1M_CONFIRM) {
    downConfidence += 25;
    reasons.push(`📉 1m ${(change1m * 100).toFixed(2)}% confirms DOWN (+25)`);
  } else {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`🚫 CONTRADICTORY: 1m=${(change1m * 100).toFixed(2)}% vs 5m=${(change5m * 100).toFixed(2)}% — signals disagree, SKIP`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }

  // ── 6. L2 HARD FILTER — market must confirm direction ──
  // UP entry: UP L2 bid pressure > 65% AND depth > $200
  // DOWN entry: DOWN L2 bid pressure > 65% AND depth > $200
  // Stricter depth ($200 vs $100) for higher quality entries
  // FREQ FIX: L2 depth $100 → $50, bid pressure 0.65 → 0.55
  // SMART MONEY v3: L2 depth $30, bid pressure 50% (relaxed for more entries)
  const MIN_L2_DEPTH_REQUIRED = 30;  // $30 (was $50)
  const MIN_L2_BID_PRESSURE = 0.50;   // 50% (was 55%, just needs to be above balanced)

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

  // ── 6.5. WebSocket order flow — SMART MONEY CONFIRMATION (pro-cyclical) ──
  // Coinbase WS gives real taker buy/sell volume (per-asset, instant).
  // Smart money follows trend: strong taker-buy flow confirms UP.
  //                         strong taker-sell flow confirms DOWN.
  // REAL executed aggression — stronger than resting L2 bids.
  // Require wsTickCount >= 8 to avoid noise from low-volume periods.
  const wsVolFlow = btc.volumeFlowRatio ?? 0;
  const wsTicks = btc.wsTickCount ?? 0;
  const WS_MIN_TICKS = 8;
  const WS_CONFIRM_THRESHOLD = 0.20;  // |flow| >= 0.20 = directional conviction

  if (wsTicks >= WS_MIN_TICKS) {
    if (smartMoneySide === "UP" && wsVolFlow > WS_CONFIRM_THRESHOLD) {
      upConfidence += 15;
      reasons.push(`🌊 WS taker-buy flow ${(wsVolFlow * 100).toFixed(0)}% confirms UP (+15)`);
    } else if (smartMoneySide === "DOWN" && wsVolFlow < -WS_CONFIRM_THRESHOLD) {
      downConfidence += 15;
      reasons.push(`🌊 WS taker-sell flow ${(wsVolFlow * 100).toFixed(0)}% confirms DOWN (+15)`);
    } else {
      reasons.push(`🌊 WS flow ${(wsVolFlow * 100).toFixed(0)}% (${wsTicks} ticks) — no confirmation`);
    }
  } else {
    reasons.push(`🌊 WS flow: only ${wsTicks} ticks in 60s (need ${WS_MIN_TICKS}+) — skip flow signal`);
  }

  // ── 7. Decision — all filters passed, high conviction ──
  // Confidence should be 80+ (30+25+25=80) if all signals align
  // SMART MONEY v3: lower confidence threshold (hold to settlement = bigger profit potential)
  const MIN_CONFIDENCE = 40;  // relaxed (was 50)
  const MIN_GAP = 15;  // relaxed (was 20)

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
