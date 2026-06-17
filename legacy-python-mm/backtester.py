"""
Backtester — Движок бэктестинга (v2.0)
========================================

"Проигрывает" исторические данные через Strategy Engine и Risk Manager,
симулируя работу бота на прошлых данных.

v2.0 Улучшения:
- Правильный учёт средней цены входа (FIFO / weighted average)
- Интеграция Trend Detector + Dynamic Spread
- Более точная модель исполнения
- Детальная статистика по трендам и спредам

Алгоритм:
1. Для каждой точки исторических данных:
   a. Создать виртуальный OrderBook
   b. Определить тренд (Trend Detector)
   c. Рассчитать динамический спред (Dynamic Spread)
   d. Оценить риски (Risk Manager)
   e. Рассчитать котировки (Strategy Engine)
   f. Проверить: исполнился бы наш ордер?
   g. Обновить виртуальную позицию и PnL

Симуляция исполнения:
- Наш Bid исполняется, если следующий mid-price ≤ наш Bid
  (рынок упал до нашей цены покупки)
- Наш Ask исполняется, если следующий mid-price ≥ наш Ask
  (рынок вырос до нашей цены продажи)

Это консервативная модель — в реальности исполнение зависит
от глубины стакана и конкуренции.
"""

import logging
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

from .config import BotConfig, SpreadConfig, InventoryConfig, OrderConfig
from .historical_data import HistoricalData, PricePoint
from .models import Inventory, OrderBook, PriceLevel, RiskAssessment, SpreadAdjustment, TrendInfo, MarketRegime
from .risk_manager import RiskManager
from .strategy_engine import StrategyEngine
from .trend_detector import TrendDetector
from .dynamic_spread import DynamicSpreadCalculator

logger = logging.getLogger(__name__)


@dataclass
class FillEvent:
    """Событие исполнения ордера."""
    timestamp: int
    side: str          # "BUY" или "SELL"
    price: float
    size: float        # В токенах
    value_usd: float   # В долларах
    mid_price_at_fill: float
    pnl_on_fill: float = 0.0  # Реализованный PnL от этой сделки


@dataclass
class BacktestSnapshot:
    """Снимок состояния бота на одном шаге бэктеста."""
    timestamp: int
    mid_price: float
    my_bid: Optional[float]
    my_ask: Optional[float]
    bid_size: float
    ask_size: float
    yes_tokens: float
    no_tokens: float
    cash: float
    unrealized_pnl: float
    realized_pnl: float
    total_pnl: float
    # Новые поля v2.0
    trend_regime: str = "UNKNOWN"
    trend_strength: float = 0.0
    dynamic_spread_cents: float = 0.0
    fill: Optional[FillEvent] = None


@dataclass
class PositionLot:
    """Один лот (покупка) YES токенов — для FIFO учёта."""
    price: float       # Цена покупки за 1 токен
    size: float        # Количество токенов
    timestamp: int     # Когда куплены


@dataclass
class BacktestResult:
    """Полный результат бэктеста."""
    market_name: str
    config_spread_cents: float
    config_max_position: float
    config_skew_threshold: float

    # Временные рамки
    total_hours: float
    total_points: int

    # Торговля
    total_fills: int
    buy_fills: int
    sell_fills: int
    total_volume_usd: float

    # PnL
    final_realized_pnl: float
    final_unrealized_pnl: float
    final_total_pnl: float
    max_pnl: float
    min_pnl: float

    # Позиция
    max_position_reached: float
    avg_position: float

    # Метрики
    sharpe_ratio: float          # Доходность / риск
    max_drawdown: float          # Максимальная просадка
    win_rate: float              # % прибыльных сделок
    avg_trade_pnl: float         # Средний PnL на сделку
    spread_captured_cents: float # Средний захваченный спред (в центах)

    # v2.0: Статистика по трендам
    trend_stats: dict = field(default_factory=dict)

    # Детали (для графиков)
    snapshots: list[BacktestSnapshot] = field(default_factory=list)
    fills: list[FillEvent] = field(default_factory=list)


class Backtester:
    """
    Движок бэктестинга v2.0.

    Проигрывает исторические данные через торговую логику
    и собирает статистику о результатах.

    Включает:
    - FIFO учёт средней цены входа
    - TrendDetector для распознавания трендов
    - DynamicSpreadCalculator для адаптивного спреда
    """

    def __init__(self, config: BotConfig) -> None:
        self._config = config
        self._strategy = StrategyEngine(config)
        self._risk = RiskManager(config)
        self._trend = TrendDetector(config)
        self._dyn_spread = DynamicSpreadCalculator(config)

    def run(self, data: HistoricalData) -> BacktestResult:
        """
        Запустить бэктест на исторических данных.

        Args:
            data: Исторические данные рынка

        Returns:
            BacktestResult с полной статистикой
        """
        # Начальное состояние
        inventory = Inventory(yes_tokens=0.0, no_tokens=0.0, cash_usd=100.0)
        snapshots: list[BacktestSnapshot] = []
        fills: list[FillEvent] = []

        # FIFO позиции (лоты покупки YES токенов)
        position_lots: deque[PositionLot] = deque()

        realized_pnl = 0.0
        max_pnl = 0.0
        min_pnl = 0.0
        max_position = 0.0
        total_position = 0.0

        # Предыдущие котировки (для проверки исполнения)
        prev_my_bid: Optional[float] = None
        prev_my_ask: Optional[float] = None
        prev_bid_size: float = 0.0
        prev_ask_size: float = 0.0

        # Тренд статистика
        trend_counts: dict[str, int] = {
            "BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0, "UNKNOWN": 0,
        }
        trend_pnl: dict[str, list[float]] = {
            "BULLISH": [], "BEARISH": [], "NEUTRAL": [], "UNKNOWN": [],
        }

        points = data.points

        for i, point in enumerate(points):
            # ── Шаг 1: Проверяем исполнение предыдущих ордеров ──
            fill = self._check_fill(
                point=point,
                prev_bid=prev_my_bid,
                prev_ask=prev_my_ask,
                prev_bid_size=prev_bid_size,
                prev_ask_size=prev_ask_size,
                inventory=inventory,
                position_lots=position_lots,
            )

            if fill is not None:
                fills.append(fill)
                # Обновляем инвентарь
                inventory, position_lots, realized_pnl = self._apply_fill(
                    fill, inventory, realized_pnl, position_lots,
                )

            # ── Шаг 2: Создаём виртуальный стакан ──────────────
            book = OrderBook(
                bids=(PriceLevel(price=point.best_bid, size=100),),
                asks=(PriceLevel(price=point.best_ask, size=100),),
                token_id=data.token_id,
            )

            # ── Шаг 3: Определяем тренд ─────────────────────────
            trend_info = self._trend.update_with_price(point.mid_price)

            # ── Шаг 4: Рассчитываем динамический спред ──────────
            spread_adj = self._dyn_spread.calculate(book, trend_info)

            # ── Шаг 5: Оценка рисков ────────────────────────────
            risk = self._risk.assess(inventory)

            # ── Шаг 6: Рассчитываем котировки ──────────────────
            quotes = self._strategy.calculate_quotes(book, risk, spread_adj)

            if quotes is not None:
                prev_my_bid = quotes.my_bid
                prev_my_ask = quotes.my_ask
                prev_bid_size = quotes.bid_size
                prev_ask_size = quotes.ask_size
            else:
                prev_my_bid = None
                prev_my_ask = None
                prev_bid_size = 0.0
                prev_ask_size = 0.0

            # ── Шаг 7: Считаем PnL ────────────────────────────
            avg_entry = self._calculate_avg_entry(position_lots)
            unrealized_pnl = self._calculate_unrealized_pnl(
                inventory, point.mid_price, avg_entry,
            )
            total_pnl = realized_pnl + unrealized_pnl

            max_pnl = max(max_pnl, total_pnl)
            min_pnl = min(min_pnl, total_pnl)
            position = inventory.total_exposure_usd
            max_position = max(max_position, position)
            total_position += position

            # Статистика по трендам
            regime_key = trend_info.regime.value
            trend_counts[regime_key] = trend_counts.get(regime_key, 0) + 1
            if regime_key not in trend_pnl:
                trend_pnl[regime_key] = []
            trend_pnl[regime_key].append(total_pnl)

            # ── Шаг 8: Сохраняем снимок ────────────────────────
            snapshots.append(BacktestSnapshot(
                timestamp=point.timestamp,
                mid_price=point.mid_price,
                my_bid=prev_my_bid,
                my_ask=prev_my_ask,
                bid_size=prev_bid_size,
                ask_size=prev_ask_size,
                yes_tokens=inventory.yes_tokens,
                no_tokens=inventory.no_tokens,
                cash=inventory.cash_usd,
                unrealized_pnl=round(unrealized_pnl, 4),
                realized_pnl=round(realized_pnl, 4),
                total_pnl=round(total_pnl, 4),
                trend_regime=trend_info.regime.value,
                trend_strength=trend_info.strength,
                dynamic_spread_cents=spread_adj.spread_cents,
                fill=fill,
            ))

        # ── Собираем результат ─────────────────────────────────
        # Итоговая тренд-статистика
        trend_stats = {}
        for regime, counts in trend_counts.items():
            pnls = trend_pnl.get(regime, [])
            trend_stats[regime] = {
                "count": counts,
                "pct": round(counts / len(points) * 100, 1) if points else 0,
                "avg_pnl": round(sum(pnls) / len(pnls), 4) if pnls else 0,
                "total_pnl": round(pnls[-1] - pnls[0], 4) if len(pnls) > 1 else 0,
            }

        return self._compile_result(
            data=data,
            snapshots=snapshots,
            fills=fills,
            realized_pnl=realized_pnl,
            max_pnl=max_pnl,
            min_pnl=min_pnl,
            max_position=max_position,
            total_position=total_position,
            final_inventory=inventory,
            final_unrealized=self._calculate_unrealized_pnl(
                inventory,
                points[-1].mid_price if points else 0.5,
                self._calculate_avg_entry(position_lots),
            ),
            trend_stats=trend_stats,
        )

    def _check_fill(
        self,
        point: PricePoint,
        prev_bid: Optional[float],
        prev_ask: Optional[float],
        prev_bid_size: float,
        prev_ask_size: float,
        inventory: Inventory,
        position_lots: deque,
    ) -> Optional[FillEvent]:
        """
        Проверить, исполнился ли наш ордер на этом шаге.

        Логика:
        - Bid исполняется: рынок упал и mid_price ≤ наш bid
        - Ask исполняется: рынок вырос и mid_price ≥ наш ask
        """
        # Проверяем Ask (продажа YES) — рынок вырос до нашей цены
        if prev_ask is not None and prev_ask_size > 0:
            ask_tokens = prev_ask_size / prev_ask  # Токены для продажи
            if point.mid_price >= prev_ask and inventory.yes_tokens >= ask_tokens:
                # Исполнился Ask — мы продали YES
                # Считаем PnL: FIFO
                pnl = self._calculate_sell_pnl(
                    position_lots, ask_tokens, prev_ask,
                )
                return FillEvent(
                    timestamp=point.timestamp,
                    side="SELL",
                    price=prev_ask,
                    size=ask_tokens,
                    value_usd=prev_ask * ask_tokens,
                    mid_price_at_fill=point.mid_price,
                    pnl_on_fill=pnl,
                )

        # Проверяем Bid (покупка YES) — рынок упал до нашей цены
        if prev_bid is not None and prev_bid_size > 0:
            if point.mid_price <= prev_bid:
                # Исполнился Bid — мы купили YES
                buy_tokens = prev_bid_size / prev_bid  # токены = USD / цена
                return FillEvent(
                    timestamp=point.timestamp,
                    side="BUY",
                    price=prev_bid,
                    size=buy_tokens,
                    value_usd=prev_bid_size,
                    mid_price_at_fill=point.mid_price,
                    pnl_on_fill=0.0,  # Покупка не даёт реализованный PnL
                )

        return None

    @staticmethod
    def _apply_fill(
        fill: FillEvent,
        inventory: Inventory,
        realized_pnl: float,
        position_lots: deque,
    ) -> tuple[Inventory, deque, float]:
        """
        Применить исполнение ордера к инвентарю (FIFO).

        Returns:
            (new_inventory, new_position_lots, new_realized_pnl)
        """
        if fill.side == "BUY":
            # Купили YES токены → добавляем лот
            new_lot = PositionLot(
                price=fill.price,
                size=fill.size,
                timestamp=fill.timestamp,
            )
            position_lots.append(new_lot)

            new_yes = inventory.yes_tokens + fill.size
            new_cash = inventory.cash_usd - fill.value_usd

            return (
                Inventory(
                    yes_tokens=round(new_yes, 4),
                    no_tokens=inventory.no_tokens,
                    cash_usd=round(new_cash, 4),
                ),
                position_lots,
                realized_pnl,
            )

        elif fill.side == "SELL":
            # Продали YES токены → FIFO списание лотов
            remaining = fill.size
            total_pnl = 0.0

            while remaining > 0.0001 and position_lots:
                lot = position_lots[0]
                if lot.size <= remaining:
                    # Весь лот продаётся
                    total_pnl += lot.size * (fill.price - lot.price)
                    remaining -= lot.size
                    position_lots.popleft()
                else:
                    # Частичная продажа лота
                    total_pnl += remaining * (fill.price - lot.price)
                    # Уменьшаем размер лота
                    new_lot = PositionLot(
                        price=lot.price,
                        size=lot.size - remaining,
                        timestamp=lot.timestamp,
                    )
                    position_lots[0] = new_lot
                    remaining = 0

            new_yes = inventory.yes_tokens - fill.size
            new_cash = inventory.cash_usd + fill.value_usd

            return (
                Inventory(
                    yes_tokens=round(new_yes, 4),
                    no_tokens=inventory.no_tokens,
                    cash_usd=round(new_cash, 4),
                ),
                position_lots,
                realized_pnl + total_pnl,
            )

        return inventory, position_lots, realized_pnl

    @staticmethod
    def _calculate_sell_pnl(
        position_lots: deque,
        sell_size: float,
        sell_price: float,
    ) -> float:
        """Рассчитать PnL от продажи (FIFO), не изменяя лоты."""
        remaining = sell_size
        total_pnl = 0.0

        for lot in position_lots:
            if remaining <= 0.0001:
                break
            sold_from_lot = min(lot.size, remaining)
            total_pnl += sold_from_lot * (sell_price - lot.price)
            remaining -= sold_from_lot

        return round(total_pnl, 4)

    @staticmethod
    def _calculate_avg_entry(position_lots: deque) -> float:
        """
        Рассчитать среднюю цену входа (weighted average) из FIFO лотов.
        """
        if not position_lots:
            return 0.0

        total_cost = 0.0
        total_size = 0.0
        for lot in position_lots:
            total_cost += lot.price * lot.size
            total_size += lot.size

        if total_size < 0.0001:
            return 0.0

        return total_cost / total_size

    @staticmethod
    def _calculate_unrealized_pnl(
        inventory: Inventory,
        mid_price: float,
        avg_entry_price: float,
    ) -> float:
        """
        Рассчитать нереализованный PnL.

        unrealized_pnl = yes_tokens * (mid_price - avg_entry_price)
        """
        if avg_entry_price <= 0:
            return 0.0
        return inventory.yes_tokens * (mid_price - avg_entry_price)

    def _compile_result(
        self,
        data: HistoricalData,
        snapshots: list[BacktestSnapshot],
        fills: list[FillEvent],
        realized_pnl: float,
        max_pnl: float,
        min_pnl: float,
        max_position: float,
        total_position: float,
        final_inventory: Inventory,
        final_unrealized: float,
        trend_stats: dict,
    ) -> BacktestResult:
        """Собрать финальный результат бэктеста."""

        total_fills = len(fills)
        buy_fills = sum(1 for f in fills if f.side == "BUY")
        sell_fills = sum(1 for f in fills if f.side == "SELL")
        total_volume = sum(f.value_usd for f in fills)

        # Win rate: % продаж с положительным PnL
        sell_fills_list = [f for f in fills if f.side == "SELL"]
        profitable_sells = sum(1 for f in sell_fills_list if f.pnl_on_fill > 0)
        win_rate = (profitable_sells / len(sell_fills_list) * 100) if sell_fills_list else 0

        # Max drawdown
        pnl_curve = [s.total_pnl for s in snapshots]
        max_dd = self._calculate_max_drawdown(pnl_curve)

        # Sharpe ratio (упрощённый)
        sharpe = self._calculate_sharpe(pnl_curve)

        # Средний захваченный спред: средний PnL продажи
        avg_spread = 0.0
        if sell_fills_list:
            avg_spread = sum(f.pnl_on_fill for f in sell_fills_list) / len(sell_fills_list) * 100  # в центах

        avg_trade_pnl = realized_pnl / total_fills if total_fills > 0 else 0

        return BacktestResult(
            market_name=data.market_name,
            config_spread_cents=self._config.spread.spread_cents,
            config_max_position=self._config.inventory.max_position_usd,
            config_skew_threshold=self._config.inventory.skew_threshold_usd,
            total_hours=data.duration_hours,
            total_points=len(snapshots),
            total_fills=total_fills,
            buy_fills=buy_fills,
            sell_fills=sell_fills,
            total_volume_usd=round(total_volume, 2),
            final_realized_pnl=round(realized_pnl, 2),
            final_unrealized_pnl=round(final_unrealized, 2),
            final_total_pnl=round(realized_pnl + final_unrealized, 2),
            max_pnl=round(max_pnl, 2),
            min_pnl=round(min_pnl, 2),
            max_position_reached=round(max_position, 2),
            avg_position=round(total_position / len(snapshots), 2) if snapshots else 0,
            sharpe_ratio=round(sharpe, 3),
            max_drawdown=round(max_dd, 2),
            win_rate=round(win_rate, 1),
            avg_trade_pnl=round(avg_trade_pnl, 4),
            spread_captured_cents=round(avg_spread, 2),
            trend_stats=trend_stats,
            snapshots=snapshots,
            fills=fills,
        )

    @staticmethod
    def _calculate_max_drawdown(pnl_curve: list[float]) -> float:
        """Рассчитать максимальную просадку."""
        if not pnl_curve:
            return 0.0

        peak = pnl_curve[0]
        max_dd = 0.0

        for pnl in pnl_curve:
            if pnl > peak:
                peak = pnl
            dd = peak - pnl
            if dd > max_dd:
                max_dd = dd

        return max_dd

    @staticmethod
    def _calculate_sharpe(pnl_curve: list[float]) -> float:
        """Рассчитать упрощённый Sharpe Ratio."""
        if len(pnl_curve) < 2:
            return 0.0

        # Почасовые приращения PnL
        returns = [
            pnl_curve[i] - pnl_curve[i - 1]
            for i in range(1, len(pnl_curve))
        ]

        if not returns:
            return 0.0

        avg_return = sum(returns) / len(returns)

        # Стандартное отклонение
        variance = sum((r - avg_return) ** 2 for r in returns) / len(returns)
        std_dev = variance ** 0.5

        if std_dev < 0.0001:
            return 0.0

        # Annualized Sharpe (предполагаем 8760 часов в году)
        return (avg_return / std_dev) * (8760 ** 0.5)
