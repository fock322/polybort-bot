"""
Historical Data — Исторические данные для бэктестинга
=====================================================

Два источника данных:
1. Polymarket API (/prices-history) — реальные данные с биржи
2. Синтетические данные — симуляция политического рынка

Формат данных (одна точка):
{
    "timestamp": 1630454400,  # Unix timestamp
    "best_bid": 0.48,
    "best_ask": 0.52,
    "mid_price": 0.50,
    "volume": 150.0           # Объём торгов (опционально)
}
"""

import json
import logging
import math
import random
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PricePoint:
    """Одна точка исторических данных."""
    timestamp: int       # Unix timestamp
    best_bid: float
    best_ask: float
    mid_price: float
    volume: float = 0.0

    @property
    def spread(self) -> float:
        return self.best_ask - self.best_bid


@dataclass
class HistoricalData:
    """Набор исторических данных для бэктестинга."""
    market_name: str
    token_id: str
    interval: str = "1h"      # "1m", "5m", "1h", "1d"
    points: list[PricePoint] = field(default_factory=list)

    @property
    def start_time(self) -> Optional[int]:
        return self.points[0].timestamp if self.points else None

    @property
    def end_time(self) -> Optional[int]:
        return self.points[-1].timestamp if self.points else None

    @property
    def duration_hours(self) -> float:
        if not self.points:
            return 0.0
        return (self.end_time - self.start_time) / 3600

    def to_dict_list(self) -> list[dict]:
        """Сериализовать в список словарей."""
        return [
            {
                "timestamp": p.timestamp,
                "best_bid": p.best_bid,
                "best_ask": p.best_ask,
                "mid_price": p.mid_price,
                "volume": p.volume,
            }
            for p in self.points
        ]


# ═══════════════════════════════════════════════════════════════
# Источник 1: Polymarket API
# ═══════════════════════════════════════════════════════════════

def fetch_from_polymarket(
    clob_client: Any,
    token_id: str,
    interval: str = "1h",
    fidelity: int = 120,
) -> Optional[HistoricalData]:
    """
    Получить исторические данные с Polymarket CLOB API.

    Endpoint: GET /prices-history
    Query params:
        token_id: ID токена
        interval: "1m", "5m", "1h", "1d"
        fidelity: количество точек данных

    Args:
        clob_client: Экземпляр py-clob-client
        token_id: Token ID
        interval: Интервал между точками
        fidelity: Количество точек

    Returns:
        HistoricalData или None при ошибке
    """
    if clob_client is None:
        logger.warning("CLOB client не настроен")
        return None

    try:
        response = clob_client.get_prices_history(
            token_id=token_id,
            interval=interval,
            fidelity=fidelity,
        )

        if not response or "history" not in response:
            logger.warning("Пустой ответ от /prices-history")
            return None

        points = []
        for item in response["history"]:
            ts = item.get("t", 0)
            price = float(item.get("p", 0))

            if ts > 0 and price > 0:
                # API даёт только mid-price
                # Симулируем bid/ask вокруг него
                spread = random.uniform(0.01, 0.03)
                points.append(PricePoint(
                    timestamp=ts,
                    best_bid=price - spread / 2,
                    best_ask=price + spread / 2,
                    mid_price=price,
                    volume=0,
                ))

        if not points:
            return None

        return HistoricalData(
            market_name="Polymarket (live)",
            token_id=token_id,
            interval=interval,
            points=points,
        )

    except Exception as e:
        logger.error("Ошибка при получении исторических данных: %s", e)
        return None


# ═══════════════════════════════════════════════════════════════
# Источник 2: Синтетические данные
# ═══════════════════════════════════════════════════════════════

def generate_political_market(
    name: str = "Will X win the 2024 election?",
    start_price: float = 0.50,
    hours: int = 720,          # 30 дней по умолчанию
    interval_minutes: int = 60, # 1 точка в час
    volatility: float = 0.003,  # Низкая волатильность (полит. рынок)
    trend: float = 0.0001,      # Слабый тренд вверх
    seed: Optional[int] = 42,
) -> HistoricalData:
    """
    Сгенерировать синтетические данные для политического рынка.

    Характеристики политического рынка:
    - Низкая волатильность (в отличие от крипты)
    - Редкие новостные шоки (скачки цены)
    - Цена "прилипает" к 0.50 (неопределённость)
    - Mean-reversion к начальной цене

    Args:
        name: Название рынка
        start_price: Начальная цена (0.01 — 0.99)
        hours: Количество часов для симуляции
        interval_minutes: Интервал между точками
        volatility: Волатильность (стандартное отклонение)
        trend: Тренд за один интервал
        seed: Seed для воспроизводимости

    Returns:
        HistoricalData с синтетическими данными
    """
    if seed is not None:
        random.seed(seed)

    points: list[PricePoint] = []
    price = start_price
    base_ts = 1700000000  # условный старт

    total_points = (hours * 60) // interval_minutes

    for i in range(total_points):
        ts = base_ts + i * interval_minutes * 60

        # ── Случайное блуждание с mean-reversion ────────────
        # Mean-reversion: цена стремится вернуться к start_price
        reversion_strength = 0.01
        reversion = (start_price - price) * reversion_strength

        # Случайный шум
        noise = random.gauss(0, volatility)

        # Новостной шок (редкое событие — раз в ~50 интервалов)
        shock = 0
        if random.random() < 0.02:  # 2% шанс шока
            shock = random.gauss(0, volatility * 10)

        # Обновляем цену
        price = price + trend + reversion + noise + shock

        # Ограничиваем цену
        price = max(0.05, min(0.95, price))

        # Спред — коррелирует с волатильностью
        base_spread = 0.02
        spread_noise = random.uniform(-0.005, 0.005)
        spread = max(0.01, base_spread + spread_noise + abs(shock) * 2)

        # Bid / Ask
        best_bid = max(0.01, price - spread / 2)
        best_ask = min(0.99, price + spread / 2)

        # Объём — случайный, с пиками во время шоков
        base_volume = random.uniform(50, 200)
        volume = base_volume + abs(shock) * 5000

        points.append(PricePoint(
            timestamp=ts,
            best_bid=round(best_bid, 4),
            best_ask=round(best_ask, 4),
            mid_price=round((best_bid + best_ask) / 2, 4),
            volume=round(volume, 2),
        ))

    return HistoricalData(
        market_name=name,
        token_id="synthetic",
        interval=f"{interval_minutes}m",
        points=points,
    )


def generate_multiple_scenarios() -> list[HistoricalData]:
    """
    Сгенерировать несколько сценариев для тестирования робастности.

    Сценарии:
    1. Спокойный рынок (низкая волатильность, цена ~0.50)
    2. Тренд вверх (кандидат набирает силу)
    3. Тренд вниз (кандидат теряет позиции)
    4. Волатильный рынок (частые новостные шоки)
    5. Долгосрочный (6 месяцев)
    """
    return [
        generate_political_market(
            name="Спокойный рынок (Will X win?)",
            start_price=0.50,
            hours=720,          # 30 дней
            volatility=0.002,
            trend=0.0,
            seed=42,
        ),
        generate_political_market(
            name="Тренд вверх (X набирает силу)",
            start_price=0.40,
            hours=720,
            volatility=0.003,
            trend=0.0003,       # Рост на ~0.22 за 30 дней
            seed=100,
        ),
        generate_political_market(
            name="Тренд вниз (X теряет позиции)",
            start_price=0.60,
            hours=720,
            volatility=0.003,
            trend=-0.0003,
            seed=200,
        ),
        generate_political_market(
            name="Волатильный рынок (частые шоки)",
            start_price=0.50,
            hours=720,
            volatility=0.005,
            trend=0.0,
            seed=300,
        ),
        generate_political_market(
            name="Долгосрочный (6 месяцев)",
            start_price=0.50,
            hours=4320,          # 180 дней
            volatility=0.002,
            trend=0.00005,
            seed=400,
        ),
    ]
