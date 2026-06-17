"""
Execution Module — "Руки" маркет-мейкера
=========================================

Задача: Управлять ордерами на бирже.

Логика:
1. Перед размещением НОВЫХ ордеров — отменить СТАРЫЕ.
   Это критически важно: без отмены ордера накапливаются,
   и бот может иметь десятки висящих ордеров.
2. Размещать ЛИМИТНЫЕ ордера (Limit Orders), а не рыночные.
   Market Maker НИКОГДА не использует рыночные ордера.

Порядок действий:
  a) Запомнить ID всех своих ордеров на этом рынке.
  b) Отменить ВСЕ свои ордера.
  c) Разместить новые Bid и Ask.
  d) Запомнить ID новых ордеров.

Примечание: Код подключения к API уже существует.
Этот модль использует py-clob-client для отправки ордеров.
"""

import logging
from typing import Any, Optional

from .config import BotConfig
from .models import Order, QuotePrices, Side

logger = logging.getLogger(__name__)


class ExecutionModule:
    """
    Модуль исполнения ордеров.

    Управляет жизненным циклом ордеров:
    отмена старых → размещение новых → отслеживание ID.
    """

    def __init__(self, config: BotConfig, clob_client: Any = None) -> None:
        """
        Args:
            config: Конфигурация бота
            clob_client: Экземпляр py-clob-client (ClobClient)
                         Если None — будет работать в режиме mock
        """
        self._config = config
        self._client = clob_client

        # Храним ID текущих активных ордеров для отмены
        self._active_order_ids: list[str] = []

    @property
    def active_orders_count(self) -> int:
        """Количество активных ордеров."""
        return len(self._active_order_ids)

    def cancel_and_place(
        self,
        quotes: QuotePrices,
        token_id: str,
    ) -> Optional[tuple[Optional[Order], Optional[Order]]]:
        """
        Главная функция: отменить старые ордера и разместить новые.

        Порядок:
        1. Отменить ВСЕ текущие ордера
        2. Разместить Bid (покупка)
        3. Разместить Ask (продажа)
        4. Запомнить ID новых ордеров

        Args:
            quotes: Рассчитанные цены от Strategy Engine
            token_id: ID токена YES

        Returns:
            (bid_order, ask_order) или None при ошибке
        """
        # ── Шаг 1: Отменяем старые ордера ────────────────────────
        self._cancel_all_orders()

        # ── Шаг 2: Размещаем новые ───────────────────────────────
        new_order_ids: list[str] = []
        bid_order: Optional[Order] = None
        ask_order: Optional[Order] = None

        # Размещаем Bid (покупка YES)
        if quotes.bid_size > 0:
            bid_order = self._place_limit_order(
                side=Side.BUY,
                price=quotes.my_bid,
                size=quotes.bid_size,
                token_id=token_id,
            )
            if bid_order is not None:
                new_order_ids.append(bid_order.order_id)
                logger.info(
                    "✅ Bid размещён: BUY @ $%.2f x $%.2f",
                    quotes.my_bid, quotes.bid_size,
                )

        # Размещаем Ask (продажа YES)
        if quotes.ask_size > 0:
            ask_order = self._place_limit_order(
                side=Side.SELL,
                price=quotes.my_ask,
                size=quotes.ask_size,
                token_id=token_id,
            )
            if ask_order is not None:
                new_order_ids.append(ask_order.order_id)
                logger.info(
                    "✅ Ask размещён: SELL @ $%.2f x $%.2f",
                    quotes.my_ask, quotes.ask_size,
                )

        # Обновляем список активных ордеров
        self._active_order_ids = new_order_ids

        if bid_order is None and ask_order is None:
            logger.warning("Не удалось разместить ни одного ордера")
            return None

        return bid_order, ask_order

    def _cancel_all_orders(self) -> int:
        """
        Отменить ВСЕ текущие ордера бота.

        Важно: отменяем СНАЧАЛА, размещаем ПОТОМ.
        Иначе возможен race condition — новые ордера
        будут отменены вместе со старыми.

        Returns:
            Количество отменённых ордеров
        """
        if not self._active_order_ids:
            logger.debug("Нет активных ордеров для отмены")
            return 0

        if self._client is None:
            logger.warning("CLOB client не настроен — пропуск отмены")
            self._active_order_ids = []
            return 0

        cancelled = 0
        for order_id in self._active_order_ids:
            try:
                self._client.cancel(order_id)
                cancelled += 1
                logger.debug("Отменён ордер: %s", order_id)
            except Exception as e:
                # Ордер мог уже исполниться или быть отменён — не критично
                logger.warning(
                    "Не удалось отменить ордер %s: %s", order_id, e
                )

        logger.info("Отменено ордеров: %d / %d", cancelled, len(self._active_order_ids))

        # Очищаем список
        self._active_order_ids = []
        return cancelled

    def _place_limit_order(
        self,
        side: Side,
        price: float,
        size: float,
        token_id: str,
    ) -> Optional[Order]:
        """
        Разместить лимитный ордер.

        Лимитный ордер = ордер по указанной цене.
        В отличие от рыночного, он НЕ исполняется немедленно,
        а встаёт в стакан и ждёт контрагента.

        Args:
            side: BUY или SELL
            price: Цена ордера (0.01 — 0.99)
            size: Размер ордера в USD
            token_id: ID токена

        Returns:
            Order или None при ошибке
        """
        if self._client is None:
            logger.warning(
                "CLOB client не настроен — ордер не размещён (%s @ $%.2f)",
                side.value, price,
            )
            return None

        try:
            # py-clob-client: создание и отправка лимитного ордера
            #
            # Пример использования (реальный API py-clob-client):
            #
            #   from py_clob_client.clob_types import OrderArgs, OrderType
            #
            #   order_args = OrderArgs(
            #       price=price,
            #       size=size,
            #       side=side.value,
            #       token_id=token_id,
            #   )
            #   signed_order = self._client.create_order(order_args)
            #   result = self._client.post_order(signed_order, OrderType.GTC)
            #
            # Для прототипа используем упрощённый интерфейс:
            result = self._client.create_and_post_order(
                side=side.value,
                price=price,
                size=size,
                token_id=token_id,
            )

            order_id = result.get("orderID", result.get("id", "unknown"))

            return Order(
                order_id=order_id,
                side=side,
                price=price,
                size=size,
                token_id=token_id,
            )

        except Exception as e:
            logger.error(
                "Ошибка размещения ордера (%s @ $%.2f): %s",
                side.value, price, e,
            )
            return None

    def get_inventory_from_client(self) -> Optional[dict[str, float]]:
        """
        Получить текущий инвентарь (баланс токенов) через API.

        Returns:
            Словарь {"yes": float, "no": float, "cash": float}
            или None при ошибке
        """
        if self._client is None:
            return None

        try:
            # py-clob-client: получение балансов
            # Реальный вызов зависит от версии библиотеки
            balances = self._client.get_balances()
            return balances
        except Exception as e:
            logger.error("Ошибка получения инвентаря: %s", e)
            return None
