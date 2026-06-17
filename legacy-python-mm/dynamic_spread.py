"""
Dynamic Spread — "Адаптивный спред" маркет-мейкера
====================================================

Задача: Адаптировать спред к текущим рыночным условиям.

Вместо фиксированного спреда, бот расширяет его при:
- Высокой волатильности (цена сильно прыгает → больше риска)
- Сильном тренде (adverse selection → информированные трейдеры нас "проедят")
- Низкой ликвидности (тонкий стакан → больше проскальзывание)

И сужает при:
- Низкой волатильности (цена стабильна → меньше риска)
- Боковике (NEUTRAL → нет направления → можно зарабатывать на спреде)
- Высокой ликвидности (глубокий стакан → меньше риска)

Формула:
    dynamic_spread = base_spread * volatility_mult * trend_mult * liquidity_mult

Где каждый множитель ≥ 1.0 при неблагоприятных условиях,
и может быть < 1.0 при благоприятных (только ликвидность).

Важно: итоговый спред ВСЕГДА ограничен [min_spread, max_spread].
"""

import logging

from .config import BotConfig, DynamicSpreadConfig, SpreadConfig
from .models import MarketRegime, OrderBook, SpreadAdjustment, TrendInfo

logger = logging.getLogger(__name__)


class DynamicSpreadCalculator:
    """
    Калькулятор динамического спреда.
    
    Адаптирует базовый спред на основе:
    - Волатильности (от TrendDetector)
    - Силы тренда (от TrendDetector)
    - Ликвидности стакана (от OrderBook)
    
    Также предоставляет trend_offset — сдвиг цены из-за тренда,
    который применяется ДОПУСТИМО к инвентарному skew_offset.
    """

    def __init__(self, config: BotConfig) -> None:
        self._config = config
        self._spread_cfg = config.spread
        self._dyn_cfg = config.dynamic_spread

        logger.info(
            "DynamicSpreadCalculator инициализирован: "
            "enabled=%s, vol_factor=%.1f, trend_factor=%.1f",
            self._dyn_cfg.enabled,
            self._dyn_cfg.volatility_factor,
            self._dyn_cfg.trend_factor,
        )

    def calculate(
        self,
        order_book: OrderBook,
        trend: TrendInfo,
    ) -> SpreadAdjustment:
        """
        Рассчитать динамический спред.
        
        Args:
            order_book: Текущий снимок стакана
            trend: Информация о тренде от TrendDetector
            
        Returns:
            SpreadAdjustment с итоговым спредом и множителями
        """
        # Если динамический спред выключен — возвращаем базовый
        if not self._dyn_cfg.enabled:
            return SpreadAdjustment(
                spread_cents=self._spread_cfg.spread_cents,
                reason="dynamic spread disabled, using fixed",
            )

        # ── Множитель от волатильности ────────────────────────
        vol_mult = self._volatility_multiplier(trend.volatility)

        # ── Множитель от тренда ───────────────────────────────
        trend_mult = self._trend_multiplier(trend)

        # ── Множитель от ликвидности ──────────────────────────
        liq_mult = self._liquidity_multiplier(order_book)

        # ── Итоговый спред ────────────────────────────────────
        base_spread = self._spread_cfg.spread_cents
        dynamic_spread = base_spread * vol_mult * trend_mult * liq_mult

        # Ограничиваем в допустимом диапазоне
        dynamic_spread = max(
            self._spread_cfg.min_spread_cents,
            min(dynamic_spread, self._spread_cfg.max_spread_cents),
        )

        # Формируем причину корректировки
        reasons = []
        if vol_mult > 1.01:
            reasons.append(f"vol×{vol_mult:.2f}")
        if trend_mult > 1.01:
            reasons.append(f"trend×{trend_mult:.2f}")
        if liq_mult > 1.01:
            reasons.append(f"liq×{liq_mult:.2f}")
        if liq_mult < 0.99:
            reasons.append(f"liq×{liq_mult:.2f} (tight)")
        reason = " | ".join(reasons) if reasons else "no adjustment"

        adjustment = SpreadAdjustment(
            spread_cents=round(dynamic_spread, 2),
            volatility_multiplier=round(vol_mult, 3),
            trend_multiplier=round(trend_mult, 3),
            liquidity_multiplier=round(liq_mult, 3),
            trend_offset_cents=trend.trend_offset_cents,
            reason=reason,
        )

        self._log_adjustment(adjustment, trend)
        return adjustment

    def _volatility_multiplier(self, volatility: float) -> float:
        """
        Множитель спреда от волатильности.
        
        Высокая волатильность = большой риск = широкий спред.
        
        Формула:
            mult = 1.0 + (volatility * volatility_factor)
        
        Примеры (volatility_factor=2.0):
            volatility=0.0 → mult=1.0 (без изменения)
            volatility=0.2 → mult=1.4 (+40%)
            volatility=0.5 → mult=2.0 (удвоение)
            volatility=1.0 → mult=3.0 (утроение)
        """
        mult = 1.0 + (volatility * self._dyn_cfg.volatility_factor)
        return max(1.0, mult)  # Никогда не сужаем от волатильности

    def _trend_multiplier(self, trend: TrendInfo) -> float:
        """
        Множитель спреда от тренда.
        
        Сильный тренд = adverse selection risk = широкий спред.
        Информированные трейдеры торгуют в направлении тренда,
        и мы можем оказаться на неправильной стороне.
        
        Формула:
            mult = 1.0 + (trend_strength * trend_factor)
        
        NEUTRAL / UNKNOWN → multiplier = 1.0 (без изменения)
        BULLISH / BEARISH → multiplier зависит от силы тренда
        """
        if not trend.is_trending:
            # Нейтральный рынок — не расширяем спред
            return 1.0

        mult = 1.0 + (trend.strength * self._dyn_cfg.trend_factor)
        return max(1.0, mult)  # Никогда не сужаем от тренда

    def _liquidity_multiplier(self, order_book: OrderBook) -> float:
        """
        Множитель спреда от ликвидности.
        
        Низкая ликвидность = тонкий стакан = больше риска = широкий спред.
        Высокая ликвидность = глубокий стакан = меньше риска = сужаем спред.
        
        Логика:
        - total_liquidity < low_threshold → low_liquidity_multiplier (шире)
        - total_liquidity > high_threshold → high_liquidity_multiplier (уже)
        - Между → линейная интерполяция
        """
        total_liquidity = (
            order_book.total_bid_liquidity_usd
            + order_book.total_ask_liquidity_usd
        )

        low_threshold = self._dyn_cfg.liquidity_threshold_usd
        high_threshold = self._dyn_cfg.high_liquidity_threshold_usd
        low_mult = self._dyn_cfg.low_liquidity_multiplier
        high_mult = self._dyn_cfg.high_liquidity_multiplier

        if total_liquidity <= low_threshold:
            # Низкая ликвидность — расширяем
            return low_mult

        if total_liquidity >= high_threshold:
            # Высокая ликвидность — сужаем
            return high_mult

        # Линейная интерполяция между low и high
        # При low_threshold → low_mult, при high_threshold → high_mult
        ratio = (total_liquidity - low_threshold) / (high_threshold - low_threshold)
        mult = low_mult + ratio * (high_mult - low_mult)

        return mult

    @staticmethod
    def _log_adjustment(
        adjustment: SpreadAdjustment, trend: TrendInfo
    ) -> None:
        """Логировать результат расчёта спреда."""
        logger.info(
            "Dynamic Spread: %.2fc (base×%.2f×%.2f×%.2f) | %s | trend_offset=%.2fc [%s]",
            adjustment.spread_cents,
            adjustment.volatility_multiplier,
            adjustment.trend_multiplier,
            adjustment.liquidity_multiplier,
            adjustment.reason,
            adjustment.trend_offset_cents,
            trend.regime.value,
        )
