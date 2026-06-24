// ─── Momentum v4 Strategy (2026-06-23) ───────────────────
// ПОЛНАЯ ПЕРЕРАБОТКА: "покупай уверенного победителя на последних 5 минутах"
//
// THESIS:
// - На последних 5 минутах Polymarket рынок уже почти решил кто победит
// - Если UP mid = $0.85+, шанс что UP победит на settlement > 85%
// - Покупаем за $0.85, на settlement получаем $1.00 = +17.6%
// - При win rate 85%: EV = 0.85 * 0.176 - 0.15 * 1.00 = +15% / trade ✅
// - При win rate 90%: EV = 0.90 * 0.176 - 0.10 * 1.00 = +5.8% / trade ✅
//
// ВХОД:
// - tau 0.5-5 минут (последние 5 минут рынка)
// - mid >= MIN_TARGET_MID (0.85 по умолчанию — шанс таргета >85%)
// - L2 bid pressure > 50% (единственный жёсткий фильтр)
// - Ослаблены: 1m/5m тренд, волатильность, WS flow — НЕ обязательны
//
// SL: ДИНАМИЧЕСКИЙ по tau (как hold-tp):
//   - tau > 4 min:  SL = 60% (есть время восстановиться)
//   - tau 2-4 min:  SL = 30%
//   - tau < 2 min:  taker exit (последний шанс до settlement)
//   - NO emergency 25% SL
//
// TP: НЕТ фиксированного TP — держим до settlement ($1.00 или $0.00)
// Это максимизирует profit: +17.6% при $0.85 entry → settlement $1.00
//
// RISK: если угадали сторону но цена развернулась → loss -60%/-30%/-100%
// MITIGATION: L2 bid pressure подтверждает направление (народ тоже ставит на эту сторону)

import { analyzeL2Depth } from "./smart-entry";
import type { MarketLike, BtcLike, SmartEntrySignal } from "./smart-entry";

export { analyzeL2Depth } from "./smart-entry";
export type { L2Level, L2DepthAnalysis, MarketLike, BtcLike, SmartEntrySignal } from "./smart-entry";

// ═══ НАСТРАИВАЕМЫЕ ПАРАМЕТРЫ (для тестирования с разными фильтрами) ═══
// Меняй эти значения и смотри как меняется результат на дашборде.

// Минимальный mid для входа — шанс таргета > X%
// v4.1: 0.85 → 0.80 — раньше входить, больше profit potential (+25% вместо +18%)
// 0.80 = шанс 80%+, win +25%, need WR 80% to break even (агрессивнее)
// 0.85 = шанс 85%+, win +17.6%, need WR 85% to break even
// 0.90 = шанс 90%+, win +11.1%, need WR 90% to break even (консервативнее)
export const MIN_TARGET_MID = 0.80;

// tau окно (минут до settlement)
export const MIN_TAU = 0.5;   // не входим в последнюю 30 сек (некогда исполнить)
export const MAX_TAU = 5.0;   // последние 5 минут

// L2 фильтр (единственный жёсткий)
export const MIN_L2_DEPTH = 30;       // минимальная глубина книги ($)
export const MIN_L2_BID_PRESSURE = 0.50;  // bid pressure на нашей стороне

// Динамический SL по tau (как hold-tp)
export interface DynSl {
  tauMin: number;
  tauMax: number;
  slPct: number;
  label: string;
}

export const DYNAMIC_SL: DynSl[] = [
  { tauMin: 4, tauMax: 99, slPct: 0.60, label: "60% (tau>4min, есть время)" },
  { tauMin: 2, tauMax: 4,  slPct: 0.30, label: "30% (tau 2-4min)" },
  // tau < 2 min → taker exit (handled in markToMarket)
];

export function getMomentumSlForTau(tauMin: number): { slPct: number; label: string } {
  for (const tier of DYNAMIC_SL) {
    if (tauMin >= tier.tauMin && tauMin < tier.tauMax) {
      return { slPct: tier.slPct, label: tier.label };
    }
  }
  return { slPct: 0, label: "taker exit (<2min до settlement)" };
}

// Compatibility exports (для старого mm-engine кода, не используется в v4)
export const TRAILING_TP_DROP_PCT = 0.08;  // не используется (no TP, hold to settlement)
export const MOMENTUM_SL_PCT = 0.30;       // не используется (dynamic SL instead)

export function momentumSlThreshold(entryPrice: number): number {
  return entryPrice * (1 - MOMENTUM_SL_PCT);
}

export function shouldTrailingTpTrigger(_peakValue: number, _currentValue: number): boolean {
  // v4: no trailing TP — hold to settlement
  return false;
}

// ─── MAIN MOMENTUM v4 SIGNAL ──────────────────────────────
// "Покупай уверенного победителя":
// 1. tau 0.5-5 мин (последние 5 минут)
// 2. mid >= 0.85 на одной из сторон (шанс таргета >85%)
// 3. L2 bid pressure > 50% на этой стороне (народ подтверждает)
// 4. Входим в сторону с высоким mid (UP если UP mid >= 0.85, DOWN если DOWN mid >= 0.85)
export function momentumEntrySignal(
  market: MarketLike,
  _btc: BtcLike  // не используется в v4 — не зависим от BTC price
): SmartEntrySignal {
  const reasons: string[] = [];
  const upMid = market.realUpMid;
  const downMid = market.realDownMid;
  const upL2 = analyzeL2Depth(market.upBids, market.upAsks, 5);
  const downL2 = analyzeL2Depth(market.downBids, market.downAsks, 5);

  // ── 1. Time window — последние 5 минут ──
  const tau = (market.expiresAt - Date.now()) / 60000;
  if (tau < MIN_TAU || tau > MAX_TAU) {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`⏰ Outside momentum-v4 window: tau=${tau.toFixed(1)}min (need ${MIN_TAU}-${MAX_TAU}min, последние 5 мин)`],
      details: { tau, pUp: upMid, btcChange1m: 0, btcChange5m: 0, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }
  const dynSl = getMomentumSlForTau(tau);
  reasons.push(`⏰ tau=${tau.toFixed(1)}min (последние 5 мин) → SL=${dynSl.label}`);

  // ── 2. Определяем "уверенного победителя" ──
  // UP mid >= MIN_TARGET_MID → UP победит с шансом >85% → BUY UP
  // DOWN mid >= MIN_TARGET_MID → DOWN победит с шансом >85% → BUY DOWN
  let side: "UP" | "DOWN" = "UP";
  let entryMid = 0;
  let l2ForSide: typeof upL2;

  if (upMid >= MIN_TARGET_MID) {
    side = "UP";
    entryMid = upMid;
    l2ForSide = upL2;
    reasons.push(`🎯 UP mid $${upMid.toFixed(3)} ≥ $${MIN_TARGET_MID} → шанс UP победы >${(MIN_TARGET_MID * 100).toFixed(0)}%`);
  } else if (downMid >= MIN_TARGET_MID) {
    side = "DOWN";
    entryMid = downMid;
    l2ForSide = downL2;
    reasons.push(`🎯 DOWN mid $${downMid.toFixed(3)} ≥ $${MIN_TARGET_MID} → шанс DOWN победы >${(MIN_TARGET_MID * 100).toFixed(0)}%`);
  } else {
    return {
      should: false, side: "UP", confidence: 0,
      reasons: [`🚫 Нет уверенного победителя: UP=$${upMid.toFixed(3)} DOWN=$${downMid.toFixed(3)} (нужно ≥$${MIN_TARGET_MID} = >${(MIN_TARGET_MID * 100).toFixed(0)}% шанс)`],
      details: { tau, pUp: upMid, btcChange1m: 0, btcChange5m: 0, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }

  // ── 3. L2 HARD FILTER (единственный жёсткий) ──
  // bid pressure > 50% на нашей стороне = народ тоже ставит на эту сторону
  if (l2ForSide.totalDepth < MIN_L2_DEPTH) {
    return {
      should: false, side, confidence: 0,
      reasons: [`🚫 ${side} L2 too thin: $${l2ForSide.totalDepth.toFixed(0)} < $${MIN_L2_DEPTH}`],
      details: { tau, pUp: side === "UP" ? upMid : downMid, btcChange1m: 0, btcChange5m: 0, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }
  if (l2ForSide.bidPressure < MIN_L2_BID_PRESSURE) {
    return {
      should: false, side, confidence: 0,
      reasons: [`🚫 ${side} L2 bid pressure ${(l2ForSide.bidPressure * 100).toFixed(0)}% < ${(MIN_L2_BID_PRESSURE * 100).toFixed(0)}% (народ не подтверждает)`],
      details: { tau, pUp: side === "UP" ? upMid : downMid, btcChange1m: 0, btcChange5m: 0, upL2, downL2, upMid, downMid, upConfidence: 0, downConfidence: 0 },
    };
  }
  reasons.push(`📚 ${side} L2 OK: bid ${(l2ForSide.bidPressure * 100).toFixed(0)}% depth $${l2ForSide.totalDepth.toFixed(0)}`);

  // ── 4. Расчёт потенциальной прибыли ──
  const profitIfWin = (1.00 - entryMid) / entryMid * 100;  // settlement at $1.00
  const lossIfLose = -100;  // settlement at $0.00
  reasons.push(`💰 Entry $${entryMid.toFixed(3)} → settlement: win +${profitIfWin.toFixed(1)}%, loss ${lossIfLose.toFixed(0)}%`);

  // ── 5. Decision ──
  // Confidence = шанс победы (приблизительно = mid price)
  const confidence = Math.round(entryMid * 100);  // 0.85 → 85

  return {
    should: true,
    side,
    confidence,
    reasons: [`✅ MOMENTUM-v4 ENTER ${side} (conf=${confidence}/100, шанс победы ~${(entryMid * 100).toFixed(0)}%, hold to settlement, SL=${dynSl.label})`, ...reasons],
    details: { tau, pUp: side === "UP" ? upMid : downMid, btcChange1m: 0, btcChange5m: 0, upL2, downL2, upMid, downMid, upConfidence: confidence, downConfidence: 0 },
  };
}
