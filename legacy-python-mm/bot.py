"""
Market Maker Bot — Главный оркестратор
========================================

Алгоритм работы (Цикл):
1. Получить Order Book                     (Data Collector)
2. Обновить детектор трендов               (Trend Detector)
3. Рассчитать динамический спред           (Dynamic Spread)
4. Проверить инвентарь                     (Risk Manager)
5. Рассчитать свои цены                    (Strategy Engine)
6. Отменить старые ордера                  (Execution Module)
7. Разместить новые ордера                 (Execution Module)
8. Обновить PnL трекер                     (PnL Tracker)
9. Подождать 5-10 секунд
10. Повторить

v1.4: + Observer (режим наблюдения) + PnL Tracker

Использование:
    bot = MarketMakerBot(config)
    bot.run()  # Запуск бесконечного цикла
"""

import logging
import time
from typing import Any, Optional

from .config import BotConfig
from .data_collector import DataCollector
from .dynamic_spread import DynamicSpreadCalculator
from .execution_module import ExecutionModule
from .models import Inventory, RiskAssessment, SpreadAdjustment, TrendInfo
from .observer import PolymarketObserver
from .pnl_tracker import PnLTracker
from .risk_manager import RiskManager
from .strategy_engine import StrategyEngine
from .trend_detector import TrendDetector

logger = logging.getLogger(__name__)


class MarketMakerBot:
    """
    Маркет-мейкер бот для Polymarket.

    Обеспечивает ликвидность на политических рынках,
    зарабатывая на спреде между покупкой и продажей.
    
    v1.4: + Observer (подключение к Polymarket в режиме наблюдения)
          + PnL Tracker (трекинг прибыли/убытков в реальном времени)
    """

    def __init__(
        self,
        config: BotConfig,
        clob_client: Any = None,
    ) -> None:
        """
        Args:
            config: Конфигурация бота
            clob_client: Экземпляр py-clob-client (ClobClient)
                         Если None — бот работает в режиме dry-run
        """
        self._config = config
        self._client = clob_client

        # Инициализация модулей
        self._data_collector = DataCollector(config, clob_client)
        self._strategy_engine = StrategyEngine(config)
        self._risk_manager = RiskManager(config)
        self._execution = ExecutionModule(config, clob_client)
        self._trend_detector = TrendDetector(config)
        self._dynamic_spread = DynamicSpreadCalculator(config)

        # Observer — подключение к Polymarket в режиме наблюдения
        self._observer = PolymarketObserver(clob_client)
        
        # PnL Tracker — трекинг прибыли
        self._pnl_tracker = PnLTracker(
            observer=self._observer if config.pnl_tracker.auto_update_prices else None,
            history_interval_sec=config.pnl_tracker.history_interval_sec,
            max_history_points=config.pnl_tracker.max_history_points,
        )

        # Состояние
        self._running = False
        self._cycle_count = 0
        self._inventory = Inventory()  # Текущий инвентарь
        self._last_trend_info = TrendInfo()  # Последний анализ тренда
        self._last_spread_adj = SpreadAdjustment()  # Последний спред
        self._observed_markets: list = []  # Рынки от Observer

        logger.info(
            "MarketMakerBot v1.4 инициализирован: "
            "spread=%.1fc, max_pos=$%.0f, interval=%.1fs, "
            "trend=%s, dynamic_spread=%s, observer=%s, pnl_tracker=%s",
            config.spread.spread_cents,
            config.inventory.max_position_usd,
            config.loop_interval_sec,
            "ON" if config.trend.enabled else "OFF",
            "ON" if config.dynamic_spread.enabled else "OFF",
            "ON" if config.observer.enabled else "OFF",
            "ON" if config.pnl_tracker.enabled else "OFF",
        )

    def run(self) -> None:
        """
        Запустить бесконечный цикл бота.

        Для остановки: bot.stop() из другого потока
        или Ctrl+C в терминале.
        """
        self._running = True
        logger.info("🚀 Market Maker Bot запущен")

        # Если observer включён — сначала получаем список рынков
        if self._config.observer.enabled:
            self._discover_markets()

        try:
            while self._running:
                self._run_cycle()
                self._wait()
        except KeyboardInterrupt:
            logger.info("Получен сигнал остановки (Ctrl+C)")
        finally:
            self._shutdown()

    def stop(self) -> None:
        """Остановить бота (безопасно)."""
        self._running = False
        logger.info("⏹ Остановка бота...")

    def _discover_markets(self) -> None:
        """Обнаружить политические рынки через Observer."""
        logger.info("🔍 Поиск политических рынков Polymarket...")
        
        try:
            markets = self._observer.fetch_political_markets(
                limit=self._config.observer.max_markets,
                min_liquidity=self._config.observer.min_market_liquidity_usd,
            )
            self._observed_markets = markets
            
            if markets:
                logger.info(
                    "📋 Найдено %d рынков: %s",
                    len(markets),
                    ", ".join(m.question[:40] + "..." for m in markets[:5]),
                )
                
                # Если token_id_yes не задан — берём первый рынок
                if not self._config.token_id_yes and markets:
                    first = markets[0]
                    logger.info(
                        "🎯 Авто-выбор рынка: %s (YES=%s)",
                        first.question[:50],
                        first.token_id_yes[:16] + "...",
                    )
            else:
                logger.warning("Политические рынки не найдены")
                
        except Exception as e:
            logger.error("Ошибка при поиске рынков: %s", e)

    def _run_cycle(self) -> None:
        """
        Один цикл работы бота.

        Шаги:
        1. Получить Order Book
        2. Проверить ликвидность
        3. Обновить детектор трендов
        4. Рассчитать динамический спред
        5. Обновить инвентарь
        6. Оценить риски
        7. Рассчитать котировки
        8. Исполнить (отменить + разместить)
        9. Обновить PnL трекер
        """
        self._cycle_count += 1
        cycle_id = self._cycle_count

        logger.info("━━━ Цикл #%d ━━━━━━━━━━━━━━━━━━━", cycle_id)

        # ── Шаг 1: Получить Order Book ───────────────────────────
        token_id = self._config.token_id_yes
        if token_id is None:
            logger.warning("token_id_yes не задан — режим наблюдения")
            # В режиме наблюдения обновляем цены через Observer
            if self._config.observer.enabled:
                self._observer_cycle()
            return

        order_book = self._data_collector.get_order_book(token_id)
        if order_book is None:
            logger.warning("Не удалось получить стакан — пробуем Observer")
            if self._config.observer.enabled:
                order_book = self._observer.fetch_order_book(token_id)
            if order_book is None:
                logger.warning("Не удалось получить стакан — пропуск цикла")
                return

        # ── Шаг 2: Проверить ликвидность ─────────────────────────
        if not self._data_collector.check_liquidity(order_book):
            logger.warning("Недостаточная ликвидность — пропуск цикла")
            return

        # ── Шаг 3: Обновить детектор трендов ─────────────────────
        trend_info = self._trend_detector.update(order_book)
        self._last_trend_info = trend_info

        # ── Шаг 4: Рассчитать динамический спред ─────────────────
        spread_adj = self._dynamic_spread.calculate(order_book, trend_info)
        self._last_spread_adj = spread_adj

        # ── Шаг 5: Обновить инвентарь ────────────────────────────
        self._update_inventory()

        # ── Шаг 6: Оценить риски ─────────────────────────────────
        risk = self._risk_manager.assess(self._inventory)
        if not risk.allowed:
            logger.warning(
                "Торговля запрещена: %s — пропуск цикла", risk.reason
            )
            self._execution.cancel_all_orders()
            return

        # ── Шаг 7: Рассчитать котировки ──────────────────────────
        spread_arg = (
            spread_adj if self._config.dynamic_spread.enabled else None
        )
        quotes = self._strategy_engine.calculate_quotes(
            order_book, risk, spread_arg
        )
        if quotes is None:
            logger.warning("Не удалось рассчитать котировки — пропуск цикла")
            return

        logger.info(
            "📊 Котировки: bid=$%.2f x$%.2f | ask=$%.2f x$%.2f | "
            "mid=$%.2f spread=%.2fc skew=%.2fc trend_offset=%.2fc [%s]",
            quotes.my_bid, quotes.bid_size,
            quotes.my_ask, quotes.ask_size,
            quotes.mid_price,
            quotes.spread_applied * 100,
            quotes.skew_offset * 100,
            spread_adj.trend_offset_cents if self._config.dynamic_spread.enabled else 0.0,
            trend_info.regime.value,
        )

        # ── Шаг 8: Исполнить ─────────────────────────────────────
        self._execution.cancel_and_place(quotes, token_id)

        # ── Шаг 9: Обновить PnL трекер ───────────────────────────
        if self._config.pnl_tracker.enabled:
            self._update_pnl_tracker(order_book)

        logger.info(
            "✅ Цикл #%d завершён | активных ордеров: %d",
            cycle_id, self._execution.active_orders_count,
        )

    def _observer_cycle(self) -> None:
        """Цикл работы в режиме наблюдения (без торговли)."""
        # Обновляем снимки для наблюдаемых рынков
        if self._observed_markets:
            token_ids = [
                m.token_id_yes for m in self._observed_markets[:10]
                if m.token_id_yes
            ]
            snapshots = self._observer.take_snapshots(
                token_ids, delay=self._config.observer.api_delay_sec
            )
            
            # Обновляем PnL трекер
            if self._config.pnl_tracker.enabled:
                self._pnl_tracker.update_prices_from_snapshots(snapshots)
            
            # Логируем краткую сводку
            for tid, snap in list(snapshots.items())[:5]:
                market = self._observer.find_market_by_token(tid)
                question = market.question[:35] if market else tid[:16]
                logger.info(
                    "👁 %s: mid=%.3f spread=%.1fc depth=$%.0f/$%.0f",
                    question + "...",
                    snap.mid_price,
                    snap.spread_cents,
                    snap.bid_depth_usd,
                    snap.ask_depth_usd,
                )
            
            # Логируем PnL
            if self._config.pnl_tracker.enabled:
                summary = self._pnl_tracker.get_summary()
                if summary.position_count > 0:
                    logger.info(
                        "💰 PnL: total=%+.4f unrealized=%+.4f realized=%+.4f positions=%d",
                        summary.total_pnl,
                        summary.unrealized_pnl,
                        summary.realized_pnl,
                        summary.position_count,
                    )

    def _update_pnl_tracker(self, order_book: Any = None) -> None:
        """Обновить PnL трекер."""
        # Обновляем цены из Observer
        if self._config.pnl_tracker.auto_update_prices and self._observer:
            self._pnl_tracker.update_prices()
        
        summary = self._pnl_tracker.get_summary()
        logger.debug(
            "PnL: total=%+.4f unrealized=%+.4f realized=%+.4f",
            summary.total_pnl,
            summary.unrealized_pnl,
            summary.realized_pnl,
        )

    def _update_inventory(self) -> None:
        """
        Обновить информацию о текущем инвентаре.

        Запрашивает баланс через API и обновляет
        внутреннюю модель Inventory.
        """
        raw = self._execution.get_inventory_from_client()
        if raw is not None:
            self._inventory = Inventory(
                yes_tokens=raw.get("yes", 0.0),
                no_tokens=raw.get("no", 0.0),
                cash_usd=raw.get("cash", 0.0),
            )
            logger.debug(
                "Инвентарь обновлён: YES=%.2f, NO=%.2f, Cash=$%.2f",
                self._inventory.yes_tokens,
                self._inventory.no_tokens,
                self._inventory.cash_usd,
            )
        # Если raw is None — используем предыдущее значение инвентаря

    def _wait(self) -> None:
        """Подождать перед следующим циклом."""
        interval = self._config.loop_interval_sec
        logger.debug("Ожидание %.1f сек...", interval)

        # Проверяем _running каждую секунду для быстрой остановки
        elapsed = 0.0
        while elapsed < interval and self._running:
            time.sleep(1.0)
            elapsed += 1.0

    def _shutdown(self) -> None:
        """Корректное завершение работы."""
        logger.info("Завершение работы: отмена всех ордеров...")
        self._execution.cancel_all_orders()
        
        # Финальная сводка PnL
        if self._config.pnl_tracker.enabled:
            summary = self._pnl_tracker.get_summary()
            logger.info(
                "📊 Финальный PnL: total=%+.4f "
                "(unrealized=%+.4f, realized=%+.4f) | "
                "max_drawdown=%.4f | win_rate=%.1f%%",
                summary.total_pnl,
                summary.unrealized_pnl,
                summary.realized_pnl,
                summary.max_drawdown,
                summary.win_rate,
            )
        
        logger.info(
            "Бот остановлен. Всего циклов: %d", self._cycle_count
        )

    # ── Ручное управление для тестирования ───────────────────────

    def set_inventory(
        self,
        yes_tokens: float = 0.0,
        no_tokens: float = 0.0,
        cash_usd: float = 0.0,
    ) -> None:
        """
        Ручная установка инвентаря (для тестирования).
        """
        self._inventory = Inventory(
            yes_tokens=yes_tokens,
            no_tokens=no_tokens,
            cash_usd=cash_usd,
        )
        logger.info(
            "Инвентарь установлен: YES=%.2f, NO=%.2f, Cash=$%.2f",
            yes_tokens, no_tokens, cash_usd,
        )

    @property
    def inventory(self) -> Inventory:
        """Текущий инвентарь."""
        return self._inventory

    @property
    def cycle_count(self) -> int:
        """Количество выполненных циклов."""
        return self._cycle_count

    @property
    def trend_info(self) -> TrendInfo:
        """Последняя информация о тренде."""
        return self._last_trend_info

    @property
    def spread_adjustment(self) -> SpreadAdjustment:
        """Последняя корректировка спреда."""
        return self._last_spread_adj

    @property
    def trend_detector(self) -> TrendDetector:
        """Доступ к детектору трендов (для тестирования)."""
        return self._trend_detector

    @property
    def dynamic_spread(self) -> DynamicSpreadCalculator:
        """Доступ к калькулятору динамического спреда."""
        return self._dynamic_spread

    @property
    def observer(self) -> PolymarketObserver:
        """Доступ к наблюдателю."""
        return self._observer

    @property
    def pnl_tracker(self) -> PnLTracker:
        """Доступ к трекеру PnL."""
        return self._pnl_tracker

    @property
    def observed_markets(self) -> list:
        """Список наблюдаемых рынков."""
        return self._observed_markets
