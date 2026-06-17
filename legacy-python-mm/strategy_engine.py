"""
Strategy Engine — "Мозг" маркет-мейкера
========================================

Задача: Рассчитывать цены, по которым бот будет торговать.

Логика:
1. Берём Mid-Price из стакана.
2. Определяем спред (фиксированный или динамический).
3. Отступаем от mid-price на половину спреда:
     Base Bid = Mid_Price - (Spread / 2)
     Base Ask = Mid_Price + (Spread / 2)
4. Применяем трендовый сдвиг (trend_offset от Trend Detector):
     BULLISH → сдвигаем цены ВВЕРХ (не продаём дёшево при росте)
     BEARISH → сдвигаем цены ВНИЗ (не покупаем дорого при падении)
5. Применяем инвентарный сдвиг (skew_offset от Risk Manager):
   - Если много YES → сдвигаем цены ВНИЗ (стимулируем продажу YES)
   - Если много NO  → сдвигаем цены ВВЕРХ (стимулируем покупку YES)

Итоговая формула:
     My Bid = Mid_Price - (Spread / 2) + trend_offset + skew_offset
     My Ask = Mid_Price + (Spread / 2) + trend_offset + skew_offset

Важно: Polymarket цены ограничены диапазоном [0.01, 0.99]
"""

import logging
from typing import Optional

from .config import BotConfig
from .models import (
    OrderBook,
    QuotePrices,
    RiskAssessment,
    SpreadAdjustment,
    TrendInfo,
)


logger = logging.getLogger(__name__)


class StrategyEngine:
    """
    Стратегический движок маркет-мейкера.

    Рассчитывает котировки (bid/ask) на основе:
    - Mid-price из стакана
    - Спреда (фиксированного или динамического)
    - Трендового сдвига (от Trend Detector)
    - Инвентарного сдвига (от Risk Manager)
    """

    def __init__(self, config: BotConfig) -> None:
        self._config = config

    def calculate_quotes(
        self,
        order_book: OrderBook,
        risk: RiskAssessment,
        spread_adjustment: Optional[SpreadAdjustment] = None,
    ) -> Optional[QuotePrices]:
        """
        Главная функция: рассчитать цены для размещения ордеров.

        Args:
            order_book: Снимок стакана ордеров
            risk: Оценка рисков от Risk Manager
            spread_adjustment: Динамический спред (если None — используем фиксированный)

        Returns:
            QuotePrices с рассчитанными ценами или None, если стакан невалиден
        """
        # ── Шаг 1: Проверяем стакан ──────────────────────────────
        if not order_book.is_valid:
            return None

        mid_price = order_book.mid_price
        if mid_price is None:
            return None

        # ── Шаг 2: Определяем спред ──────────────────────────────
        if spread_adjustment is not None:
            # Динамический спред от DynamicSpreadCalculator
            spread = spread_adjustment.spread_cents / 100.0  # центы → доллары
        else:
            # Фиксированный спред из конфигурации
            spread = self._get_effective_spread(order_book)

        # ── Шаг 3: Рассчитываем базовые цены (без сдвигов) ──────
        half_spread = spread / 2.0
        base_bid = mid_price - half_spread
        base_ask = mid_price + half_spread

        # ── Шаг 4: Применяем трендовый сдвиг ─────────────────────
        # trend_offset уже рассчитан в TrendInfo (в центах → в долларах)
        if spread_adjustment is not None:
            trend_offset = spread_adjustment.trend_offset_cents / 100.0
        else:
            trend_offset = 0.0

        # ── Шаг 5: Применяем инвентарный сдвиг ───────────────────
        # skew_offset уже рассчитан в RiskAssessment (в центах → в долларах)
        skew_offset = risk.skew_offset_cents / 100.0  # центы → доллары

        # ── Итоговые цены ────────────────────────────────────────
        my_bid = base_bid + trend_offset + skew_offset
        my_ask = base_ask + trend_offset + skew_offset

        # ── Шаг 6: Корректируем размеры ордеров ─────────────────
        base_size = self._config.order.order_size_usd
        bid_size = base_size * risk.bid_size_modifier
        ask_size = base_size * risk.ask_size_modifier

        # Минимальный размер ордера
        min_size = self._config.order.min_order_size_usd
        if bid_size < min_size:
            bid_size = 0.0  # Не размещаем слишком маленький ордер
        if ask_size < min_size:
            ask_size = 0.0

        # ── Шаг 7: Ограничиваем цены в диапазон [0.01, 0.99] ────
        my_bid = self._clamp_price(my_bid)
        my_ask = self._clamp_price(my_ask)

        # ── Шаг 8: Финальная проверка — bid < ask ────────────────
        if my_bid >= my_ask:
            # Спред схлопнулся — не размещаем ордера
            return None

        # ── Шаг 9: Проверяем, что наши цены не пересекаются ──────
        # с лучшими ценами в стакане (иначе мы сразу исполнимся)
        if order_book.best_ask is not None and my_bid >= order_book.best_ask.price:
            # Наш bid перехлёстывает рыночный ask — уменьшаем bid
            my_bid = order_book.best_ask.price - 0.01
            my_bid = self._clamp_price(my_bid)

        if order_book.best_bid is not None and my_ask <= order_book.best_bid.price:
            # Наш ask перехлёстывает рыночный bid — увеличиваем ask
            my_ask = order_book.best_bid.price + 0.01
            my_ask = self._clamp_price(my_ask)

        # Повторная проверка после корректировки
        if my_bid >= my_ask:
            return None

        return QuotePrices(
            my_bid=round(my_bid, 2),
            my_ask=round(my_ask, 2),
            bid_size=round(bid_size, 2),
            ask_size=round(ask_size, 2),
            mid_price=round(mid_price, 2),
            spread_applied=round(spread, 2),
            skew_offset=round(skew_offset, 4),
        )

    def _get_effective_spread(self, order_book: OrderBook) -> float:
        """
        Определить эффективный спред (для режима фиксированного спреда).

        Маркет-мейкер ВСЕГДА использует свой целевой спред.
        Быть внутри рыночного спреда — это и есть работа ММ:
        мы улучшаем лучшую цену покупки и продажи.

        Если рыночный спреж УЖЕ нашего (редкий случай) —
        расширяемся чуть шире, чтобы не столкнуться с лучшими ценами.
        """
        target_spread = self._config.spread.spread_cents / 100.0  # центы → доллары
        min_spread = self._config.spread.min_spread_cents / 100.0
        max_spread = self._config.spread.max_spread_cents / 100.0

        market_spread = order_book.market_spread
        if market_spread is not None and market_spread < target_spread:
            # Рыночный спреж УЖЕ нашего — расширяемся чуть шире
            # чтобы наши ордера не оказались внутри чужого спреда
            # и не были исполнены немедленно (taker, а не maker)
            target_spread = market_spread + 0.01  # +1 цент к рыночному

        # Ограничиваем
        target_spread = max(min_spread, min(target_spread, max_spread))

        return target_spread

    @staticmethod
    def _clamp_price(price: float) -> float:
        """
        Ограничить цену в допустимый диапазон Polymarket.
        Цены на Polymarket: от $0.01 до $0.99
        (0.00 и 1.00 не допускаются — это гарантированные исходы)
        """
        return max(0.01, min(0.99, price))
