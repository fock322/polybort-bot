"""
Polymarket Observer — "Наблюдатель"
====================================

Подключается к Polymarket CLOB API в режиме ТОЛЬКО ЧТЕНИЕ.
Не размещает ордера — только собирает данные:

1. Список рынков (политических)
2. Order Book по выбранным рынкам
3. История сделок
4. Цены и спреды в реальном времени

Эти данные используются:
- PnL Tracker для расчёта прибыли
- Trend Detector для анализа направления
- Dashboard для отображения

Использование:
    observer = PolymarketObserver()
    markets = observer.fetch_political_markets()
    book = observer.fetch_order_book(token_id)
    price = observer.fetch_mid_price(token_id)
"""

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from .models import OrderBook

logger = logging.getLogger(__name__)


# ─── Модели данных наблюдателя ────────────────────────────────────


@dataclass
class MarketInfo:
    """Информация о рынке Polymarket."""
    condition_id: str         # Уникальный ID рынка
    question: str             # Вопрос рынка
    token_id_yes: str         # Token ID для YES
    token_id_no: str          # Token ID для NO
    slug: str = ""            # URL slug
    active: bool = True       # Активен ли рынок
    end_date: str = ""        # Дата окончания
    volume: float = 0.0       # Объём торгов (USD)
    liquidity: float = 0.0    # Ликвидность (USD)
    best_bid: float = 0.0     # Лучший bid
    best_ask: float = 0.0     # Лучший ask
    mid_price: float = 0.0    # Средняя цена

    @property
    def spread_cents(self) -> float:
        """Спред в центах."""
        return (self.best_ask - self.best_bid) * 100 if self.best_bid and self.best_ask else 0.0


@dataclass
class MarketSnapshot:
    """Снимок состояния рынка на момент времени."""
    token_id: str
    timestamp: float           # Unix timestamp
    best_bid: float
    best_ask: float
    mid_price: float
    spread_cents: float
    bid_depth_usd: float       # Глубина стакана на покупку
    ask_depth_usd: float       # Глубина стакана на продажу
    volume_24h: float = 0.0    # Объём за 24ч


@dataclass
class TradeRecord:
    """Запись о сделке на Polymarket."""
    trade_id: str
    market_question: str
    token_side: str            # YES / NO
    side: str                  # BUY / SELL
    price: float
    size: float
    timestamp: float


class PolymarketObserver:
    """
    Наблюдатель за рынками Polymarket.
    
    Работает в режиме ТОЛЬКО ЧТЕНИЕ:
    - Получает список рынков
    - Скачивает order books
    - Отслеживает цены
    - Собирает историю сделок
    
    НЕ размещает ордера и НЕ требует приватный ключ.
    """

    # Polymarket CLOB API endpoint
    CLOB_HOST = "https://clob.polymarket.com"
    GAMMA_HOST = "https://gamma-api.polymarket.com"

    def __init__(self, clob_client: Any = None) -> None:
        """
        Args:
            clob_client: Экземпляр py-clob-client (ClobClient)
                         Если None — будет использоваться REST API напрямую
        """
        self._client = clob_client
        self._session: Any = None  # requests.Session (ленивая инициализация)
        self._markets_cache: dict[str, MarketInfo] = {}
        self._last_fetch_time: float = 0.0
        self._fetch_count: int = 0

        logger.info("PolymarketObserver инициализирован (client=%s)",
                    "подключён" if clob_client else "REST-only")

    # ── Получение списка рынков ───────────────────────────────────

    def fetch_political_markets(
        self,
        limit: int = 50,
        min_liquidity: float = 100.0,
    ) -> list[MarketInfo]:
        """
        Получить список политических рынков Polymarket.
        
        Использует Gamma API для поиска по категориям.
        
        Args:
            limit: Максимум рынков
            min_liquidity: Минимальная ликвидность (USD)
            
        Returns:
            Список MarketInfo
        """
        try:
            session = self._get_session()
            
            # Gamma API — поиск политических рынков
            url = f"{self.GAMMA_HOST}/markets"
            params = {
                "limit": limit,
                "active": "true",
                "closed": "false",
                "order": "liquidity",
                "ascending": "false",
                "tag": "politics",
            }
            
            resp = session.get(url, params=params, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            
            markets = []
            for item in data:
                try:
                    # Извлекаем tokens (YES/NO)
                    tokens = item.get("tokens", [])
                    token_yes = ""
                    token_no = ""
                    for tok in tokens:
                        outcome = tok.get("outcome", "")
                        if outcome == "Yes":
                            token_yes = tok.get("token_id", "")
                        elif outcome == "No":
                            token_no = tok.get("token_id", "")
                    
                    if not token_yes:
                        continue
                    
                    liquidity = float(item.get("liquidity_num", 0) or 0)
                    volume = float(item.get("volume_num", 0) or 0)
                    
                    # Фильтр по ликвидности
                    if liquidity < min_liquidity:
                        continue
                    
                    info = MarketInfo(
                        condition_id=item.get("condition_id", ""),
                        question=item.get("question", "Unknown"),
                        token_id_yes=token_yes,
                        token_id_no=token_no,
                        slug=item.get("slug", ""),
                        active=item.get("active", True),
                        end_date=item.get("end_date_iso", ""),
                        volume=volume,
                        liquidity=liquidity,
                        best_bid=float(item.get("best_bid", 0) or 0),
                        best_ask=float(item.get("best_ask", 0) or 0),
                        mid_price=float(item.get("outcome_prices", "0").split(",")[0] or 0) if item.get("outcome_prices") else 0.0,
                    )
                    markets.append(info)
                    self._markets_cache[info.condition_id] = info
                    
                except (KeyError, ValueError, IndexError) as e:
                    logger.debug("Пропуск рынка: ошибка парсинга — %s", e)
                    continue
            
            self._fetch_count += 1
            self._last_fetch_time = time.time()
            
            logger.info(
                "Получено %d политических рынков (всего в кэше: %d)",
                len(markets), len(self._markets_cache),
            )
            return markets
            
        except Exception as e:
            logger.error("Ошибка получения рынков: %s", e)
            return []

    # ── Получение Order Book ───────────────────────────────────────

    def fetch_order_book(self, token_id: str) -> Optional[OrderBook]:
        """
        Получить стакан ордеров по token_id.
        
        Сначала пробует через py-clob-client, затем через REST API.
        
        Args:
            token_id: ID токена (YES или NO)
            
        Returns:
            OrderBook или None
        """
        # Способ 1: через py-clob-client (если доступен)
        if self._client is not None:
            try:
                raw = self._client.get_order_book(token_id)
                if raw:
                    return self._parse_clob_book(raw, token_id)
            except Exception as e:
                logger.debug("py-clob-client не смог получить стакан: %s", e)

        # Способ 2: через REST API
        try:
            session = self._get_session()
            url = f"{self.CLOB_HOST}/book"
            params = {"token_id": token_id}
            
            resp = session.get(url, params=params, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            
            return self._parse_clob_book(data, token_id)
            
        except Exception as e:
            logger.error("REST API не смог получить стакан: %s", e)
            return None

    # ── Получение mid-price ────────────────────────────────────────

    def fetch_mid_price(self, token_id: str) -> Optional[float]:
        """
        Получить текущую среднюю цену для токена.
        
        Args:
            token_id: ID токена
            
        Returns:
            Mid-price или None
        """
        book = self.fetch_order_book(token_id)
        if book and book.mid_price is not None:
            return book.mid_price
        return None

    # ── Снимок рынка ───────────────────────────────────────────────

    def take_snapshot(self, token_id: str) -> Optional[MarketSnapshot]:
        """
        Сделать снимок состояния рынка.
        
        Полезно для PnL трекера — фиксирует цены на момент времени.
        
        Args:
            token_id: ID токена
            
        Returns:
            MarketSnapshot или None
        """
        book = self.fetch_order_book(token_id)
        if book is None or not book.is_valid:
            return None
        
        if book.best_bid is None or book.best_ask is None:
            return None
        
        mid = book.mid_price
        if mid is None:
            return None
        
        snapshot = MarketSnapshot(
            token_id=token_id,
            timestamp=time.time(),
            best_bid=book.best_bid.price,
            best_ask=book.best_ask.price,
            mid_price=mid,
            spread_cents=(book.best_ask.price - book.best_bid.price) * 100,
            bid_depth_usd=book.total_bid_liquidity_usd,
            ask_depth_usd=book.total_ask_liquidity_usd,
        )
        
        logger.debug(
            "Snapshot: mid=%.3f spread=%.1fc depth=$%.0f/$%.0f",
            mid, snapshot.spread_cents,
            snapshot.bid_depth_usd, snapshot.ask_depth_usd,
        )
        return snapshot

    # ── Получение нескольких снимков ───────────────────────────────

    def take_snapshots(
        self, token_ids: list[str], delay: float = 0.5
    ) -> dict[str, MarketSnapshot]:
        """
        Сделать снимки для нескольких токенов.
        
        Args:
            token_ids: Список token_id
            delay: Задержка между запросами (секунды)
            
        Returns:
            dict[token_id, MarketSnapshot]
        """
        results: dict[str, MarketSnapshot] = {}
        
        for i, tid in enumerate(token_ids):
            snap = self.take_snapshot(tid)
            if snap:
                results[tid] = snap
            
            # Не спамим API
            if i < len(token_ids) - 1:
                time.sleep(delay)
        
        logger.info("Снимки получены для %d/%d токенов", len(results), len(token_ids))
        return results

    # ── Кэш рынков ─────────────────────────────────────────────────

    def get_cached_market(self, condition_id: str) -> Optional[MarketInfo]:
        """Получить рынок из кэша."""
        return self._markets_cache.get(condition_id)

    def find_market_by_token(self, token_id: str) -> Optional[MarketInfo]:
        """Найти рынок по token_id (YES или NO)."""
        for m in self._markets_cache.values():
            if m.token_id_yes == token_id or m.token_id_no == token_id:
                return m
        return None

    # ── Статистика ──────────────────────────────────────────────────

    @property
    def stats(self) -> dict[str, Any]:
        """Статистика наблюдателя."""
        return {
            "fetch_count": self._fetch_count,
            "last_fetch_time": self._last_fetch_time,
            "cached_markets": len(self._markets_cache),
            "has_client": self._client is not None,
        }

    # ── Внутренние методы ──────────────────────────────────────────

    def _get_session(self) -> Any:
        """Получить HTTP сессию (ленивая инициализация)."""
        if self._session is None:
            try:
                import requests
                self._session = requests.Session()
                self._session.headers.update({
                    "User-Agent": "PolymarketMM-Bot/1.4",
                    "Accept": "application/json",
                })
            except ImportError:
                raise RuntimeError(
                    "Библиотека 'requests' не установлена. "
                    "Установите: pip install requests"
                )
        return self._session

    def _parse_clob_book(
        self, raw_book: dict[str, Any], token_id: str
    ) -> Optional[OrderBook]:
        """Распарсить ответ CLOB API в OrderBook."""
        from .models import PriceLevel
        
        try:
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
                reverse=True,
            )
            
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
                reverse=False,
            )
            
            return OrderBook(
                bids=tuple(bids),
                asks=tuple(asks),
                token_id=token_id,
            )
            
        except (KeyError, ValueError, TypeError) as e:
            logger.error("Ошибка парсинга стакана: %s", e)
            return None
