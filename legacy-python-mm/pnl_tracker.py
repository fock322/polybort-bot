"""
PnL Tracker — "Трекер прибыли"
================================

Отслеживает прибыль и убытки (PnL) в реальном времени.

Рассчитывает:
1. Нереализованный PnL — прибыль/убыток по открытым позициям
   на основе текущих рыночных цен
2. Реализованный PnL — прибыль/убыток от закрытых сделок
3. Общий PnL = Unrealized + Realized
4. PnL за период — дневной, недельный, месячный
5. Max Drawdown — максимальная просадка

Формулы:
- Unrealized PnL = (current_mid - avg_entry_price) × position_size
- Realized PnL = Σ (exit_price - entry_price) × size для закрытых сделок
- Total PnL = Unrealized + Realized
- Drawdown = (peak_pnl - current_pnl) / peak_pnl

Использование:
    tracker = PnLTracker(observer)
    tracker.add_position("token_yes", entry_price=0.45, size=50, side="YES")
    tracker.update_prices()  # Обновить из API
    summary = tracker.get_summary()
    history = tracker.get_pnl_history(hours=24)
"""

import logging
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Optional

from .observer import PolymarketObserver, MarketSnapshot

logger = logging.getLogger(__name__)


# ─── Модели данных PnL ────────────────────────────────────────────


@dataclass
class PositionEntry:
    """Запись об открытой позиции."""
    token_id: str              # Token ID (YES или NO)
    market_question: str = ""  # Название рынка
    side: str = "YES"          # YES или NO
    entry_price: float = 0.0   # Средняя цена входа
    size: float = 0.0          # Количество токенов
    entry_time: float = 0.0    # Время открытия (unix timestamp)
    current_mid: float = 0.0   # Текущая средняя цена
    last_update: float = 0.0   # Время последнего обновления

    @property
    def unrealized_pnl(self) -> float:
        """Нереализованный PnL."""
        if self.current_mid <= 0 or self.entry_price <= 0:
            return 0.0
        return (self.current_mid - self.entry_price) * self.size

    @property
    def unrealized_pnl_pct(self) -> float:
        """Нереализованный PnL в процентах."""
        if self.entry_price <= 0:
            return 0.0
        return ((self.current_mid / self.entry_price) - 1.0) * 100

    @property
    def cost_basis(self) -> float:
        """Стоимость позиции при открытии."""
        return self.entry_price * self.size

    @property
    def market_value(self) -> float:
        """Текущая рыночная стоимость."""
        return self.current_mid * self.size


@dataclass
class RealizedTrade:
    """Запись о закрытой сделке (реализованный PnL)."""
    token_id: str
    market_question: str = ""
    side: str = "YES"
    entry_price: float = 0.0
    exit_price: float = 0.0
    size: float = 0.0
    pnl: float = 0.0           # Реализованный PnL
    timestamp: float = 0.0     # Время закрытия


@dataclass
class PnLPoint:
    """Точка на графике PnL (для истории)."""
    timestamp: float            # Unix timestamp
    total_pnl: float            # Общий PnL на момент времени
    unrealized_pnl: float       # Нереализованный PnL
    realized_pnl: float         # Реализованный PnL
    drawdown: float             # Просадка от пика
    position_value: float       # Стоимость позиций


@dataclass
class PnLSummary:
    """Сводка по PnL."""
    total_pnl: float = 0.0              # Общий PnL
    unrealized_pnl: float = 0.0         # Нереализованный PnL
    realized_pnl: float = 0.0           # Реализованный PnL
    total_position_value: float = 0.0   # Стоимость всех позиций
    total_cost_basis: float = 0.0       # Общая стоимость входа
    position_count: int = 0             # Количество открытых позиций
    trade_count: int = 0                # Количество закрытых сделок
    max_drawdown: float = 0.0           # Максимальная просадка ($)
    max_drawdown_pct: float = 0.0       # Максимальная просадка (%)
    peak_pnl: float = 0.0              # Пик PnL
    current_drawdown: float = 0.0       # Текущая просадка от пика
    win_rate: float = 0.0               # Процент прибыльных сделок
    avg_trade_pnl: float = 0.0          # Средний PnL на сделку
    pnl_24h: float = 0.0               # PnL за последние 24ч
    pnl_7d: float = 0.0                # PnL за 7 дней

    @property
    def is_profitable(self) -> bool:
        """Общий PnL положительный."""
        return self.total_pnl > 0

    @property
    def return_pct(self) -> float:
        """Доходность в % от cost basis."""
        if self.total_cost_basis <= 0:
            return 0.0
        return (self.total_pnl / self.total_cost_basis) * 100


class PnLTracker:
    """
    Трекер прибыли/убытков.
    
    Отслеживает PnL в реальном времени:
    - Обновляет цены позиций из Observer
    - Считает нереализованный и реализованный PnL
    - Хранит историю PnL для графиков
    - Считает максимальную просадку
    """

    def __init__(
        self,
        observer: Optional[PolymarketObserver] = None,
        history_interval_sec: float = 60.0,
        max_history_points: int = 1440,  # 24ч при 1 точке/мин
    ) -> None:
        """
        Args:
            observer: Экземпляр PolymarketObserver для обновления цен
            history_interval_sec: Интервал записи точек PnL (секунды)
            max_history_points: Максимум точек в истории
        """
        self._observer = observer
        self._history_interval = history_interval_sec
        self._max_history = max_history_points

        # Открытые позиции: token_id → PositionEntry
        self._positions: dict[str, PositionEntry] = {}
        
        # Закрытые сделки
        self._realized_trades: list[RealizedTrade] = []
        
        # История PnL (для графиков)
        self._pnl_history: list[PnLPoint] = []
        
        # Трекинг пика и просадки
        self._peak_pnl: float = 0.0
        self._max_drawdown: float = 0.0
        
        # Время последней записи в историю
        self._last_history_time: float = 0.0
        
        # PnL на момент 24ч и 7д назад (для периодов)
        self._pnl_24h_ago: float = 0.0
        self._pnl_7d_ago: float = 0.0
        
        # Счётчики
        self._update_count: int = 0

        logger.info(
            "PnLTracker инициализирован (observer=%s, interval=%.0fs)",
            "подключён" if observer else "нет",
            history_interval_sec,
        )

    # ── Управление позициями ───────────────────────────────────────

    def add_position(
        self,
        token_id: str,
        entry_price: float,
        size: float,
        side: str = "YES",
        market_question: str = "",
    ) -> None:
        """
        Добавить открытую позицию.
        
        Если позиция с таким token_id уже есть — обновляет
        среднюю цену входа и размер (усреднение).
        
        Args:
            token_id: Token ID
            entry_price: Цена входа
            size: Количество токенов
            side: YES или NO
            market_question: Название рынка
        """
        if token_id in self._positions:
            # Усреднение позиции
            existing = self._positions[token_id]
            total_cost = existing.cost_basis + (entry_price * size)
            total_size = existing.size + size
            avg_price = total_cost / total_size if total_size > 0 else 0.0
            
            existing.entry_price = avg_price
            existing.size = total_size
            existing.last_update = time.time()
            
            logger.info(
                "Позиция обновлена: %s avg_price=%.3f size=%.1f",
                token_id[:12] + "...", avg_price, total_size,
            )
        else:
            self._positions[token_id] = PositionEntry(
                token_id=token_id,
                market_question=market_question,
                side=side,
                entry_price=entry_price,
                size=size,
                entry_time=time.time(),
                last_update=time.time(),
            )
            
            logger.info(
                "Позиция добавлена: %s price=%.3f size=%.1f side=%s",
                token_id[:12] + "...", entry_price, size, side,
            )

    def close_position(
        self,
        token_id: str,
        exit_price: float,
        size: Optional[float] = None,
    ) -> Optional[RealizedTrade]:
        """
        Закрыть позицию (частично или полностью).
        
        Args:
            token_id: Token ID
            exit_price: Цена выхода
            size: Количество для закрытия (None = вся позиция)
            
        Returns:
            RealizedTrade или None
        """
        if token_id not in self._positions:
            logger.warning("Позиция %s не найдена", token_id[:12] + "...")
            return None
        
        pos = self._positions[token_id]
        close_size = size if size is not None else pos.size
        close_size = min(close_size, pos.size)
        
        pnl = (exit_price - pos.entry_price) * close_size
        
        trade = RealizedTrade(
            token_id=token_id,
            market_question=pos.market_question,
            side=pos.side,
            entry_price=pos.entry_price,
            exit_price=exit_price,
            size=close_size,
            pnl=pnl,
            timestamp=time.time(),
        )
        
        self._realized_trades.append(trade)
        
        # Обновляем или удаляем позицию
        if close_size >= pos.size:
            del self._positions[token_id]
        else:
            pos.size -= close_size
            pos.last_update = time.time()
        
        logger.info(
            "Позиция закрыта: %s pnl=%+.2f size=%.1f @ %.3f",
            token_id[:12] + "...", pnl, close_size, exit_price,
        )
        return trade

    # ── Обновление цен ─────────────────────────────────────────────

    def update_prices(self) -> int:
        """
        Обновить цены всех открытых позиций из Observer.
        
        Returns:
            Количество обновлённых позиций
        """
        if self._observer is None:
            logger.warning("Observer не подключён — цены не обновлены")
            return 0
        
        updated = 0
        for token_id, pos in self._positions.items():
            try:
                mid = self._observer.fetch_mid_price(token_id)
                if mid is not None and mid > 0:
                    pos.current_mid = mid
                    pos.last_update = time.time()
                    updated += 1
            except Exception as e:
                logger.debug("Не удалось обновить цену %s: %s", token_id[:12], e)
        
        self._update_count += 1
        
        # Записать точку в историю
        self._maybe_record_history()
        
        logger.debug("Цены обновлены: %d/%d позиций", updated, len(self._positions))
        return updated

    def update_prices_from_snapshots(
        self, snapshots: dict[str, MarketSnapshot]
    ) -> int:
        """
        Обновить цены из готовых снимков.
        
        Быстрее чем update_prices(), т.к. не делает API запросы.
        
        Args:
            snapshots: dict[token_id, MarketSnapshot]
            
        Returns:
            Количество обновлённых позиций
        """
        updated = 0
        for token_id, pos in self._positions.items():
            snap = snapshots.get(token_id)
            if snap:
                pos.current_mid = snap.mid_price
                pos.last_update = time.time()
                updated += 1
        
        self._update_count += 1
        self._maybe_record_history()
        
        return updated

    def set_price(self, token_id: str, mid_price: float) -> None:
        """
        Установить цену позиции вручную (для тестирования).
        
        Args:
            token_id: Token ID
            mid_price: Средняя цена
        """
        if token_id in self._positions:
            self._positions[token_id].current_mid = mid_price
            self._positions[token_id].last_update = time.time()

    # ── Расчёт PnL ─────────────────────────────────────────────────

    def get_summary(self) -> PnLSummary:
        """
        Получить полную сводку по PnL.
        
        Returns:
            PnLSummary с актуальными данными
        """
        unrealized = sum(p.unrealized_pnl for p in self._positions.values())
        realized = sum(t.pnl for t in self._realized_trades)
        total = unrealized + realized
        
        position_value = sum(p.market_value for p in self._positions.values())
        cost_basis = sum(p.cost_basis for p in self._positions.values())
        
        # Трекинг пика и просадки
        if total > self._peak_pnl:
            self._peak_pnl = total
        
        current_dd = self._peak_pnl - total
        if current_dd > self._max_drawdown:
            self._max_drawdown = current_dd
        
        max_dd_pct = (
            (self._max_drawdown / self._peak_pnl * 100)
            if self._peak_pnl > 0 else 0.0
        )
        
        # Win rate
        wins = sum(1 for t in self._realized_trades if t.pnl > 0)
        total_trades = len(self._realized_trades)
        win_rate = (wins / total_trades * 100) if total_trades > 0 else 0.0
        
        # Средний PnL на сделку
        avg_pnl = (realized / total_trades) if total_trades > 0 else 0.0
        
        # PnL за периоды
        pnl_24h = total - self._pnl_24h_ago
        pnl_7d = total - self._pnl_7d_ago
        
        return PnLSummary(
            total_pnl=total,
            unrealized_pnl=unrealized,
            realized_pnl=realized,
            total_position_value=position_value,
            total_cost_basis=cost_basis,
            position_count=len(self._positions),
            trade_count=total_trades,
            max_drawdown=self._max_drawdown,
            max_drawdown_pct=max_dd_pct,
            peak_pnl=self._peak_pnl,
            current_drawdown=current_dd,
            win_rate=win_rate,
            avg_trade_pnl=avg_pnl,
            pnl_24h=pnl_24h,
            pnl_7d=pnl_7d,
        )

    def get_position_pnl(self, token_id: str) -> Optional[dict[str, Any]]:
        """
        Получить PnL по конкретной позиции.
        
        Args:
            token_id: Token ID
            
        Returns:
            dict с данными PnL или None
        """
        pos = self._positions.get(token_id)
        if pos is None:
            return None
        
        return {
            "token_id": token_id,
            "market_question": pos.market_question,
            "side": pos.side,
            "entry_price": pos.entry_price,
            "current_mid": pos.current_mid,
            "size": pos.size,
            "cost_basis": pos.cost_basis,
            "market_value": pos.market_value,
            "unrealized_pnl": pos.unrealized_pnl,
            "unrealized_pnl_pct": pos.unrealized_pnl_pct,
        }

    # ── История PnL ────────────────────────────────────────────────

    def get_pnl_history(self, hours: float = 24.0) -> list[PnLPoint]:
        """
        Получить историю PnL за указанный период.
        
        Args:
            hours: Количество часов
            
        Returns:
            Список PnLPoint
        """
        cutoff = time.time() - (hours * 3600)
        return [p for p in self._pnl_history if p.timestamp >= cutoff]

    def _maybe_record_history(self) -> None:
        """Записать точку в историю PnL (если прошло достаточно времени)."""
        now = time.time()
        if now - self._last_history_time < self._history_interval:
            return
        
        summary = self.get_summary()
        
        point = PnLPoint(
            timestamp=now,
            total_pnl=summary.total_pnl,
            unrealized_pnl=summary.unrealized_pnl,
            realized_pnl=summary.realized_pnl,
            drawdown=summary.current_drawdown,
            position_value=summary.total_position_value,
        )
        
        self._pnl_history.append(point)
        self._last_history_time = now
        
        # Ограничение размера истории
        if len(self._pnl_history) > self._max_history:
            self._pnl_history = self._pnl_history[-self._max_history:]

    # ── Данные для дашборда ────────────────────────────────────────

    def get_dashboard_data(self) -> dict[str, Any]:
        """
        Получить данные для дашборда (серриализация).
        
        Returns:
            dict со всеми данными PnL
        """
        summary = self.get_summary()
        
        # Позиции
        positions_data = []
        for tid, pos in self._positions.items():
            positions_data.append({
                "tokenId": tid,
                "marketQuestion": pos.market_question,
                "side": pos.side,
                "entryPrice": round(pos.entry_price, 4),
                "currentMid": round(pos.current_mid, 4),
                "size": round(pos.size, 2),
                "costBasis": round(pos.cost_basis, 2),
                "marketValue": round(pos.market_value, 2),
                "unrealizedPnl": round(pos.unrealized_pnl, 4),
                "unrealizedPnlPct": round(pos.unrealized_pnl_pct, 2),
            })
        
        # Последние сделки
        recent_trades = sorted(
            self._realized_trades, key=lambda t: t.timestamp, reverse=True
        )[:20]
        
        trades_data = []
        for t in recent_trades:
            trades_data.append({
                "tokenId": t.token_id,
                "marketQuestion": t.market_question,
                "side": t.side,
                "entryPrice": round(t.entry_price, 4),
                "exitPrice": round(t.exit_price, 4),
                "size": round(t.size, 2),
                "pnl": round(t.pnl, 4),
                "timestamp": t.timestamp,
            })
        
        # История PnL (последние 24ч)
        history = self.get_pnl_history(hours=24)
        history_data = []
        for p in history:
            history_data.append({
                "timestamp": p.timestamp,
                "totalPnl": round(p.total_pnl, 4),
                "unrealizedPnl": round(p.unrealized_pnl, 4),
                "realizedPnl": round(p.realized_pnl, 4),
                "drawdown": round(p.drawdown, 4),
                "positionValue": round(p.position_value, 2),
            })
        
        return {
            "summary": {
                "totalPnl": round(summary.total_pnl, 4),
                "unrealizedPnl": round(summary.unrealized_pnl, 4),
                "realizedPnl": round(summary.realized_pnl, 4),
                "positionValue": round(summary.total_position_value, 2),
                "costBasis": round(summary.total_cost_basis, 2),
                "positionCount": summary.position_count,
                "tradeCount": summary.trade_count,
                "maxDrawdown": round(summary.max_drawdown, 4),
                "maxDrawdownPct": round(summary.max_drawdown_pct, 2),
                "peakPnl": round(summary.peak_pnl, 4),
                "currentDrawdown": round(summary.current_drawdown, 4),
                "winRate": round(summary.win_rate, 2),
                "avgTradePnl": round(summary.avg_trade_pnl, 4),
                "pnl24h": round(summary.pnl_24h, 4),
                "pnl7d": round(summary.pnl_7d, 4),
                "isProfitable": summary.is_profitable,
                "returnPct": round(summary.return_pct, 2),
            },
            "positions": positions_data,
            "recentTrades": trades_data,
            "pnlHistory": history_data,
        }

    # ── Статистика ──────────────────────────────────────────────────

    @property
    def stats(self) -> dict[str, Any]:
        """Статистика трекера."""
        return {
            "position_count": len(self._positions),
            "trade_count": len(self._realized_trades),
            "history_points": len(self._pnl_history),
            "update_count": self._update_count,
            "peak_pnl": round(self._peak_pnl, 4),
            "max_drawdown": round(self._max_drawdown, 4),
        }
