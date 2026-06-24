// ─── Hold-to-TP Strategy (2026-06-23) ─────────────────────
// GOAL: максимизировать win rate через "держать до TP, не фиксировать шумовые убытки".
//
// THESIS:
// - 15-мин Polymarket рынки колеблются ±5-15% за минуту
// - Emergency SL 25% фиксировал убытки на шумовых просадках (11 из 31 трейда -$20+)
// - Если угадали сторону — цена почти всегда возвращается к +8% TP
// - Если не угадали — позиция идёт до settlement ($0 или $1)
//
// TP: 8% maker (висит ASK на entry*1.08, 0 fee)
// SL: ДИНАМИЧЕСКИЙ по tau (время до settlement):
//   - tau > 8 min:  SL = 85% (почти нет стопа — есть время восстановиться)
//   - tau 4-8 min:  SL = 60% (поменьше времени, чуть жёстче)
//   - tau 2-4 min:  SL = 30% (мало времени, ограничиваем downside)
//   - tau < 2 min:  taker exit (последний шанс зафиксить до settlement)
// NO emergency 25% SL — убран полностью
//
// MATHEMATICS (при position $10):
//   TP hit (+8%):      +$0.80  (0 fee maker exit)
//   Settlement WIN:    +$10.00 (token → $1.00, минус entry cost)
//   Settlement LOSS:   -$entry (token → $0.00)
//   SL 85% hit:        -$8.50 (редко, только если tau>8min и -85%)
//
// EV при 70% TP, 15% settle-win, 15% settle-loss:
//   0.7 * 0.80 + 0.15 * 10 - 0.15 * 10 = +$0.56/trade ✅
//
// RISK: capital lock — позиция висит до TP/settlement.
//   MITIGATION: max 1 позиция одновременно, position $5.

import { analyzeL2Depth } from "./smart-entry";
import type { MarketLike, BtcLike, SmartEntrySignal } from "./smart-entry";

export { analyzeL2Depth } from "./smart-entry";
export type { L2Level, L2DepthAnalysis, MarketLike, BtcLike, SmartEntrySignal } from "./smart-entry";

// ─── TP/SL constants ──────────────────────────────────────
export const HOLD_TP_PCT = 0.08;  // 8% take-profit (maker exit, 0 fee)

// Dynamic SL thresholds by tau (minutes to settlement)
export interface DynSl {
  tauMin: number;   // tau >= this (minutes)
  tauMax: number;   // tau < this (minutes)
  slPct: number;    // stop-loss as fraction (0.85 = -85%)
  label: string;
}

export const DYNAMIC_SL: DynSl[] = [
  { tauMin: 8,  tauMax: 99, slPct: 0.85, label: "85% (hold — есть время восстановиться)" },
  { tauMin: 4,  tauMax: 8,  slPct: 0.60, label: "60% (поменьше времени)" },
  { tauMin: 2,  tauMax: 4,  slPct: 0.30, label: "30% (мало времени, режем убыток)" },
  // tau < 2 min → taker exit (handled in markToMarket)
];

// Get SL for current tau
export function getHoldSlForTau(tauMin: number): { slPct: number; label: string } {
  for (const tier of DYNAMIC_SL) {
    if (tauMin >= tier.tauMin && tauMin < tier.tauMax) {
      return { slPct: tier.slPct, label: tier.label };
    }
  }
  // tau < 2 min → taker exit
  return { slPct: 0, label: "taker exit (<2min до settlement)" };
}

// ─── MAIN HOLD-TP SIGNAL ──────────────────────────────────
// Trend-following with multi-signal confirmation (как smart-money, но без TP exit).
// Жёсткие фильтры — мы будем держать позицию долго, так что вход должен быть качественным.
//
// Logic:
// - BTC/ETH/SOL 5m trend signal [0.3%, 6%]
// - 1m MUST confirm 5m (HARD — иначе contradictory)
// - L2 bid pressure > 50% + depth > $30 (HARD)
// - WS volume flow confirmation (optional, +15)
// - tau 4-12 min (нужно время чтобы TP 8% сработал)
export function holdTpEntrySignal(
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

  // ── 1. Time window — 2-14.5 min (как momentum — раньше входим) ──
  // Раньше входим → цена ещё 0.40-0.60 → TP 8% реален.
  // При tau 4-12 цена уже extreme (рынок решил кто победит).
  const tau = (market.expiresAt - Date.now()) / 60000;
  if (tau < 2 || tau > 14.5) {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`⏰ Outside hold-tp window: tau=${tau.toFixed(1)}min (need 2-14.5min)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }
  const dynSl = getHoldSlForTau(tau);
  reasons.push(`⏰ tau=${tau.toFixed(1)}min → SL=${dynSl.label}`);

  // ── 2. Volatility filter — |1m| < 5% ──
  if (Math.abs(change1m) > 0.05) {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`⚡ Too volatile: 1m ${(change1m * 100).toFixed(2)}% > ±5%`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }

  // ── 3. Price filter — DYNAMIC по стороне входа ──
  // UP вход: UP mid должен быть 0.20-0.80 (место для +8% TP = entry*1.08 ≤ $0.864)
  // DOWN вход: DOWN mid должен быть 0.20-0.80 (место для +8% TP = entry*1.08 ≤ $0.864)
  // Раньше проверяли только UP mid — блокировало DOWN входы на падающем рынке.
  // РАСШИРЕНО (2026-06-23): было 0.25-0.75, стало 0.20-0.80 — Polymarket 15m рынки
  // быстро уходят от 0.50, к моменту tau<14 цена уже 0.75-0.85. 0.20-0.80 даёт больше входов.
  // v1.2: оставлено 0.20-0.80
  const MIN_MID = 0.20;
  const MAX_MID = 0.80;
  if (upMid < MIN_MID || upMid > MAX_MID) {
    // UP mid вне диапазона — но если DOWN mid в диапазоне, DOWN вход возможен
    // (проверяется ниже после определения стороны по 5m тренду)
    reasons.push(`⚠️ UP mid $${upMid.toFixed(2)} вне 0.25-0.75 — DOWN вход возможен если DOWN mid в диапазоне`);
  }

  // ── 4. Trend signal — 5m в [0.2%, 8%] (v1.2: MIN снижен 0.3% → 0.2% для большего числа входов) ──
  const MIN_5M = 0.002;  // 0.2% (было 0.3% — ловим меньшие движения)
  const MAX_5M = 0.08;  // 8%
  if (change5m > MIN_5M && change5m < MAX_5M) {
    upConfidence += 30;
    reasons.push(`📈 5m +${(change5m * 100).toFixed(2)}% → UP trend (+30)`);
  } else if (change5m < -MIN_5M && change5m > -MAX_5M) {
    downConfidence += 30;
    reasons.push(`📉 5m ${(change5m * 100).toFixed(2)}% → DOWN trend (+30)`);
  } else if (Math.abs(change5m) >= MAX_5M) {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`⚡ 5m ${(change5m * 100).toFixed(2)}% too extreme (>|6%|)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  } else {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`➡️ 5m ${(change5m * 100).toFixed(3)}% too small (need ±0.3%)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }

  // ── 5. 1m MUST confirm 5m (HARD FILTER) ──
  const MIN_1M_CONFIRM = 0.001;
  if (change5m > 0 && change1m > MIN_1M_CONFIRM) {
    upConfidence += 25;
    reasons.push(`📈 1m +${(change1m * 100).toFixed(2)}% confirms UP (+25)`);
  } else if (change5m < 0 && change1m < -MIN_1M_CONFIRM) {
    downConfidence += 25;
    reasons.push(`📉 1m ${(change1m * 100).toFixed(2)}% confirms DOWN (+25)`);
  } else {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`🚫 CONTRADICTORY: 1m=${(change1m * 100).toFixed(2)}% vs 5m=${(change5m * 100).toFixed(2)}% — SKIP`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }

  // ── 6. L2 HARD FILTER + side-specific MID price check ──
  // v1.2: снижены thresholds для большего числа входов (depth $30→$20, bid 50%→45%)
  const MIN_L2_DEPTH = 20;       // $20 (было $30)
  const MIN_L2_BID_PRESSURE = 0.45;  // 45% (было 50%)
  const holdSide = change5m > 0 ? "UP" : "DOWN";
  const l2ForSide = holdSide === "UP" ? upL2 : downL2;
  const midForSide = holdSide === "UP" ? upMid : downMid;

  // MID price check по стороне входа: нужно 0.25-0.75 чтобы TP 8% был достижим
  // (entry*1.08 ≤ $0.81, иначе TP почти $1.00 = нереалистично)
  if (midForSide < MIN_MID || midForSide > MAX_MID) {
    return {
      should: false, side: holdSide, confidence: 0,
      reasons: [`🚫 ${holdSide} mid $${midForSide.toFixed(2)} вне 0.25-0.75 (TP 8% недостижим, нужно место)`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }
  reasons.push(`💰 ${holdSide} mid $${midForSide.toFixed(2)} в диапазоне 0.25-0.75 (TP 8% = $${(midForSide * 1.08).toFixed(3)} достижим)`);

  if (l2ForSide.totalDepth < MIN_L2_DEPTH) {
    return {
      should: false, side: holdSide, confidence: 0,
      reasons: [`🚫 ${holdSide} L2 too thin: $${l2ForSide.totalDepth.toFixed(0)} < $${MIN_L2_DEPTH}`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }
  if (l2ForSide.bidPressure < MIN_L2_BID_PRESSURE) {
    return {
      should: false, side: holdSide, confidence: 0,
      reasons: [`🚫 ${holdSide} L2 bid pressure ${(l2ForSide.bidPressure * 100).toFixed(0)}% < ${(MIN_L2_BID_PRESSURE * 100).toFixed(0)}%`],
      details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }

  if (holdSide === "UP") {
    upConfidence += 25;
    reasons.push(`📚 UP L2 CONFIRMED: bid ${(upL2.bidPressure * 100).toFixed(0)}% depth $${upL2.totalDepth.toFixed(0)} (+25)`);
  } else {
    downConfidence += 25;
    reasons.push(`📚 DOWN L2 CONFIRMED: bid ${(downL2.bidPressure * 100).toFixed(0)}% depth $${downL2.totalDepth.toFixed(0)} (+25)`);
  }

  // ── 7. WebSocket order flow confirmation (optional) ──
  const wsVolFlow = btc.volumeFlowRatio ?? 0;
  const wsTicks = btc.wsTickCount ?? 0;
  const WS_MIN_TICKS = 8;
  const WS_CONFIRM_THRESHOLD = 0.20;

  if (wsTicks >= WS_MIN_TICKS) {
    if (holdSide === "UP" && wsVolFlow > WS_CONFIRM_THRESHOLD) {
      upConfidence += 15;
      reasons.push(`🌊 WS taker-buy flow ${(wsVolFlow * 100).toFixed(0)}% confirms UP (+15)`);
    } else if (holdSide === "DOWN" && wsVolFlow < -WS_CONFIRM_THRESHOLD) {
      downConfidence += 15;
      reasons.push(`🌊 WS taker-sell flow ${(wsVolFlow * 100).toFixed(0)}% confirms DOWN (+15)`);
    } else {
      reasons.push(`🌊 WS flow ${(wsVolFlow * 100).toFixed(0)}% (${wsTicks} ticks) — no confirmation`);
    }
  } else {
    reasons.push(`🌊 WS flow: ${wsTicks} ticks < ${WS_MIN_TICKS} — skip flow signal`);
  }

  // ── 8. Decision ──
  const MIN_CONFIDENCE = 40;
  const MIN_GAP = 15;

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
    reasons: [`✅ HOLD-TP ENTER ${side} (conf=${confidence}, TP=8%, SL=${dynSl.label}, hold to TP/settlement)`, ...reasons],
    details: { tau, pUp: 0.5, btcChange1m: change1m, btcChange5m: change5m, upL2, downL2, upMid, downMid, upConfidence, downConfidence },
  };
}
