"""
Data Collector — "Глаза" маркет-мейкера
========================================

Задача: Получать и парсить Order Book (стакан ордеров).

Логика:
1. Запросить стакан через py-clob-client.
2. Преобразовать сырой ответ в нашу модель OrderBook.
3. Извлечь Best Bid и Best Ask.
4. Рассчитать Mid-Price = (Best Bid + Best Ask) / 2.

Примечание: Код подключения к API уже существует.
Этот модль принимает СЫРЫЕ данные от клиента и парсит их.
"""

import logging
from typing import Any, Optional

from .config import BotConfig
from .models import OrderBook, PriceLevel

logger = logging.getLogger(__name__)


class DataCollector:
    """
    Сборщик данных о рынке.

    Получает сырые данные от py-clob-client и
    преобразует их в удобную модель OrderBook.
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

    def get_order_book(self, token_id: str) -> Optional[OrderBook]:
        """
        Получить и распарсить стакан ордеров.

        Args:
            token_id: ID токена (YES или NO)

        Returns:
            OrderBook или None, если не удалось получить
        """
        if self._client is None:
            logger.warning("CLOB client не настроен — возвращаю None")
            return None

        try:
            raw_book = self._client.get_order_book(token_id)
            return self._parse_order_book(raw_book, token_id)
        except Exception as e:
            logger.error("Ошибка при получении стакана: %s", e)
            return None

    def _parse_order_book(
        self, raw_book: dict[str, Any], token_id: str
    ) -> Optional[OrderBook]:
        """
        Преобразовать сырой ответ API в модель OrderBook.

        Формат ответа py-clob-client:
        {
            "bids": [
                {"price": "0.45", "size": "100"},
                ...
            ],
            "asks": [
                {"price": "0.55", "size": "200"},
                ...
            ]
        }

        Args:
            raw_book: Сырой словарь от API
            token_id: ID токена

        Returns:
            OrderBook или None, если данные невалидны
        """
        try:
            # Парсим bids (сортируем по убыванию цены)
            raw_bids = raw_book.get("bids", [])
            bids = sorted(
                [
                    PriceLevel(
                        price=float(b["price"]),
                        size=float(b["size"]),
                    )
                    for b in raw_bids
                    if float(b.get("price", 0)) > 0
                ],
                key=lambda x: x.price,
                reverse=True,  # Лучший bid — самый высокий
            )

            # Парсим asks (сортируем по возрастанию цены)
            raw_asks = raw_book.get("asks", [])
            asks = sorted(
                [
                    PriceLevel(
                        price=float(a["price"]),
                        size=float(a["size"]),
                    )
                    for a in raw_asks
                    if float(a.get("price", 0)) > 0
                ],
                key=lambda x: x.price,
                reverse=False,  # Лучший ask — самый низкий
            )

            order_book = OrderBook(
                bids=tuple(bids),
                asks=tuple(asks),
                token_id=token_id,
            )

            self._log_book_summary(order_book)
            return order_book

        except (KeyError, ValueError, TypeError) as e:
            logger.error("Ошибка парсинга стакана: %s", e)
            return None

    def check_liquidity(self, order_book: OrderBook) -> bool:
        """
        Проверить, достаточно ли ликвидности в стакане для торговли.

        Мы не хотим торговать на рынках с пустым стаканом —
        это может быть признаком неактивного рынка или ошибки.

        Args:
            order_book: Стакан ордеров

        Returns:
            True, если ликвидности достаточно
        """
        min_liq = self._config.min_book_liquidity_usd
        total_liq = (
            order_book.total_bid_liquidity_usd
            + order_book.total_ask_liquidity_usd
        )

        if total_liq < min_liq:
            logger.warning(
                "Недостаточная ликвидность: $%.2f < $%.2f",
                total_liq, min_liq,
            )
            return False

        return True

    @staticmethod
    def _log_book_summary(book: OrderBook) -> None:
        """Логировать сводку по стакану."""
        if book.is_valid and book.best_bid and book.best_ask:
            logger.info(
                "OrderBook: best_bid=%.2f (%.0f), best_ask=%.2f (%.0f), "
                "mid=%.2f, spread=%.2f",
                book.best_bid.price,
                book.best_bid.size,
                book.best_ask.price,
                book.best_ask.size,
                book.mid_price,
                book.market_spread,
            )
        else:
            logger.warning("OrderBook: пустой стакан (нет bid или ask)")
