"""
Trend Detector — "Радар" маркет-мейкера
=========================================

Задача: Определять текущий рыночный тренд и его силу.

Алгоритм:
1. Собираем историю mid-price (скользящее окно)
2. Рассчитываем две EMA (экспоненциальные скользящие средние):
   - Короткая EMA (быстрая) — реагирует на недавние изменения
   - Длинная EMA (медленная) — показывает общий тренд
3. Определяем режим:
   - BULLISH: короткая EMA > длинной (цена растёт)
   - BEARISH: короткая EMA < длинной (цена падает)
   - NEUTRAL: EMA близки друг к другу (боковик)
   - UNKNOWN: недостаточно данных
4. Рассчитываем силу тренда и волатильность
5. Определяем сдвиг цены (trend_offset) для защиты от adverse selection

Защита от adverse selection:
━━━━━━━━━━━━━━━━━━━━━━━━━━━
Если рынок растёт (BULLISH), мы НЕ хотим продавать дёшево —
поэтому сдвигаем цены ВВЕРХ. Аналогично при BEARISH — вниз.
Это уменьшает вероятность, что нас "проехут" информированные трейдеры.
"""

import logging
import math
from collections import deque
from typing import Optional

from .config import BotConfig, TrendConfig
from .models import MarketRegime, OrderBook, TrendInfo

logger = logging.getLogger(__name__)


class TrendDetector:
    """
    Детектор трендов на основе EMA-кроссовера.
    
    Отслеживает изменения mid-price и определяет:
    - Рыночный режим (BULLISH / BEARISH / NEUTRAL / UNKNOWN)
    - Силу тренда (0.0 — 1.0)
    - Волатильность (нормированное стандартное отклонение)
    - Моментум (скорость изменения цены)
    - Рекомендуемый сдвиг цены (trend_offset)
    """

    def __init__(self, config: BotConfig) -> None:
        self._config = config
        self._trend_cfg = config.trend

        # История mid-price (скользящее окно)
        self._price_history: deque[float] = deque(
            maxlen=self._trend_cfg.window_size
        )

        # EMA значения (инициализируются при первом наблюдении)
        self._short_ema: Optional[float] = None
        self._long_ema: Optional[float] = None

        # Количество обработанных наблюдений
        self._sample_count: int = 0

        # EMA множители (сглаживающие коэффициенты)
        # α = 2 / (period + 1) — стандартная формула EMA
        self._short_alpha = 2.0 / (self._trend_cfg.short_ema_period + 1)
        self._long_alpha = 2.0 / (self._trend_cfg.long_ema_period + 1)

        logger.info(
            "TrendDetector инициализирован: "
            "window=%d, short_ema=%d, long_ema=%d, threshold=%.3f",
            self._trend_cfg.window_size,
            self._trend_cfg.short_ema_period,
            self._trend_cfg.long_ema_period,
            self._trend_cfg.ema_threshold,
        )

    def update(self, order_book: OrderBook) -> TrendInfo:
        """
        Обновить детектор новыми данными из стакана.
        
        Извлекает mid-price, обновляет EMA и рассчитывает тренд.
        
        Args:
            order_book: Текущий снимок стакана ордеров
            
        Returns:
            TrendInfo с актуальной информацией о тренде
        """
        if not self._trend_cfg.enabled:
            return TrendInfo()  # Детектор выключен — возвращаем пустой результат

        mid_price = order_book.mid_price
        if mid_price is None:
            return TrendInfo(samples=self._sample_count)

        # Добавляем в историю
        self._price_history.append(mid_price)
        self._sample_count += 1

        # Обновляем EMA
        self._update_ema(mid_price)

        # Рассчитываем тренд
        return self._analyze()

    def update_with_price(self, mid_price: float) -> TrendInfo:
        """
        Обновить детектор напрямую ценой (для тестирования и бэктеста).
        
        Args:
            mid_price: Mid-price для добавления в историю
            
        Returns:
            TrendInfo с актуальной информацией о тренде
        """
        if not self._trend_cfg.enabled:
            return TrendInfo()

        self._price_history.append(mid_price)
        self._sample_count += 1

        self._update_ema(mid_price)
        return self._analyze()

    def _update_ema(self, price: float) -> None:
        """
        Обновить значения EMA новой ценой.
        
        Формула EMA:
            EMA_today = α * price + (1 - α) * EMA_yesterday
        
        Где α = 2 / (period + 1)
        
        При первом наблюдении EMA = price.
        """
        if self._short_ema is None:
            # Первое наблюдение: EMA = цена
            self._short_ema = price
            self._long_ema = price
        else:
            # EMA обновление: взвешенная сумма
            self._short_ema = (
                self._short_alpha * price
                + (1 - self._short_alpha) * self._short_ema
            )
            self._long_ema = (
                self._long_alpha * price
                + (1 - self._long_alpha) * self._long_ema
            )

    def _analyze(self) -> TrendInfo:
        """
        Проанализировать текущее состояние и определить тренд.
        
        Алгоритм:
        1. Определить режим по EMA-кроссоверу
        2. Рассчитать силу тренда
        3. Рассчитать волатильность
        4. Рассчитать моментум
        5. Рассчитать trend_offset
        """
        # Недостаточно данных — нужен хотя бы long_ema_period наблюдений
        min_samples = self._trend_cfg.long_ema_period
        if self._sample_count < min_samples or self._short_ema is None or self._long_ema is None:
            return TrendInfo(
                regime=MarketRegime.UNKNOWN,
                short_ema=self._short_ema or 0.0,
                long_ema=self._long_ema or 0.0,
                samples=self._sample_count,
            )

        # ── Шаг 1: Определяем режим ────────────────────────────
        regime = self._determine_regime()

        # ── Шаг 2: Рассчитываем силу тренда ────────────────────
        strength = self._calculate_strength()

        # ── Шаг 3: Рассчитываем волатильность ──────────────────
        volatility = self._calculate_volatility()

        # ── Шаг 4: Рассчитываем моментум ───────────────────────
        momentum = self._calculate_momentum()

        # ── Шаг 5: Рассчитываем trend_offset ───────────────────
        trend_offset = self._calculate_trend_offset(regime, strength)

        info = TrendInfo(
            regime=regime,
            strength=round(strength, 4),
            volatility=round(volatility, 4),
            momentum=round(momentum, 4),
            short_ema=round(self._short_ema, 4),
            long_ema=round(self._long_ema, 4),
            trend_offset_cents=round(trend_offset, 2),
            samples=self._sample_count,
        )

        self._log_trend(info)
        return info

    def _determine_regime(self) -> MarketRegime:
        """
        Определить рыночный режим по EMA-кроссоверу.
        
        Логика:
        - short_ema > long_ema + threshold → BULLISH
        - short_ema < long_ema - threshold → BEARISH
        - Иначе → NEUTRAL
        """
        assert self._short_ema is not None and self._long_ema is not None

        diff = self._short_ema - self._long_ema
        threshold = self._trend_cfg.ema_threshold

        if diff > threshold:
            return MarketRegime.BULLISH
        elif diff < -threshold:
            return MarketRegime.BEARISH
        else:
            return MarketRegime.NEUTRAL

    def _calculate_strength(self) -> float:
        """
        Рассчитать силу тренда.
        
        Сила = нормированная разница между короткой и длинной EMA.
        Чем больше расхождение, тем сильнее тренд.
        
        Нормализация: делим на цену, чтобы получить относительную величину.
        Ограничиваем до [0.0, 1.0].
        """
        if self._short_ema is None or self._long_ema is None:
            return 0.0

        if self._long_ema == 0:
            return 0.0

        # Относительное расхождение EMA
        relative_diff = abs(self._short_ema - self._long_ema) / self._long_ema

        # Нормализуем: типичное расхождение для Polymarket — 0.01-0.10
        # Считаем, что расхождение > 5% = максимальная сила
        strength = min(relative_diff / 0.05, 1.0)

        return strength

    def _calculate_volatility(self) -> float:
        """
        Рассчитать волатильность.
        
        Волатильность = стандартное отклонение изменений цены,
        нормированное на среднюю цену.
        
        Используем изменения цены (returns), а не абсолютные значения,
        чтобы получить стационарный ряд.
        """
        if len(self._price_history) < 3:
            return 0.0

        prices = list(self._price_history)

        # Рассчитываем изменения цены (returns)
        returns = []
        for i in range(1, len(prices)):
            if prices[i - 1] > 0:
                ret = (prices[i] - prices[i - 1]) / prices[i - 1]
                returns.append(ret)

        if not returns:
            return 0.0

        # Стандартное отклонение returns
        mean_return = sum(returns) / len(returns)
        variance = sum((r - mean_return) ** 2 for r in returns) / len(returns)
        std_dev = math.sqrt(variance)

        # Нормализуем: для Polymarket типичная волатильность 0.01-0.05 за цикл
        # Считаем, что std > 0.05 = экстремальная волатильность = 1.0
        volatility = min(std_dev / 0.05, 1.0)

        return volatility

    def _calculate_momentum(self) -> float:
        """
        Рассчитать моментум (скорость изменения цены).
        
        Простой momentum = цена_текущая - цена_N_назад,
        где N = long_ema_period.
        
        Положительный → цена растёт, отрицательный → падает.
        """
        if len(self._price_history) < 2:
            return 0.0

        prices = list(self._price_history)
        n = min(self._trend_cfg.long_ema_period, len(prices) - 1)

        momentum = prices[-1] - prices[-n - 1]
        return momentum

    def _calculate_trend_offset(
        self, regime: MarketRegime, strength: float
    ) -> float:
        """
        Рассчитать сдвиг цены из-за тренда (в центах).
        
        Логика:
        - BULLISH: сдвигаем цены ВВЕРХ (не продаём дёшево)
          offset = +strength * factor
        - BEARISH: сдвигаем цены ВНИЗ (не покупаем дорого)
          offset = -strength * factor
        - NEUTRAL/UNKNOWN: без сдвига
        
        Ограничение: |offset| ≤ max_trend_offset_cents
        """
        if regime == MarketRegime.BULLISH:
            offset = strength * self._trend_cfg.trend_price_factor_cents
        elif regime == MarketRegime.BEARISH:
            offset = -strength * self._trend_cfg.trend_price_factor_cents
        else:
            offset = 0.0

        # Ограничиваем максимальный сдвиг
        max_offset = self._trend_cfg.max_trend_offset_cents
        offset = max(-max_offset, min(offset, max_offset))

        return offset

    @staticmethod
    def _log_trend(info: TrendInfo) -> None:
        """Логировать результаты анализа тренда."""
        regime_icon = {
            MarketRegime.BULLISH: "📈",
            MarketRegime.BEARISH: "📉",
            MarketRegime.NEUTRAL: "↔️",
            MarketRegime.UNKNOWN: "❓",
        }.get(info.regime, "❓")

        logger.info(
            "Trend: %s %s | strength=%.2f | vol=%.2f | "
            "momentum=%.4f | offset=%.2fc | EMA: short=%.4f long=%.4f",
            regime_icon,
            info.regime.value,
            info.strength,
            info.volatility,
            info.momentum,
            info.trend_offset_cents,
            info.short_ema,
            info.long_ema,
        )

    @property
    def sample_count(self) -> int:
        """Количество обработанных наблюдений."""
        return self._sample_count

    def reset(self) -> None:
        """Сбросить состояние детектора (для тестирования)."""
        self._price_history.clear()
        self._short_ema = None
        self._long_ema = None
        self._sample_count = 0
