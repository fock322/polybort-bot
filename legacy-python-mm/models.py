"""
Модели данных
=============
Структуры данных, которые используют все модули бота.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class Side(str, Enum):
    """Сторона ордера."""
    BUY = "BUY"
    SELL = "SELL"


class TokenSide(str, Enum):
    """Сторона токена на Polymarket."""
    YES = "YES"
    NO = "NO"


class MarketRegime(str, Enum):
    """
    Рыночный режим — результат работы Trend Detector.
    
    BULLISH  — цена растёт, бычий тренд
    BEARISH  — цена падает, медвежий тренд
    NEUTRAL  — боковик, нет явного направления
    UNKNOWN  — недостаточно данных для определения
    """
    BULLISH = "BULLISH"
    BEARISH = "BEARISH"
    NEUTRAL = "NEUTRAL"
    UNKNOWN = "UNKNOWN"


@dataclass(frozen=True)
class PriceLevel:
    """Уровень цены в стакане (ордербуке)."""
    price: float       # Цена (0.01 — 0.99)
    size: float        # Размер в количестве токенов

    @property
    def cost_usd(self) -> float:
        """Стоимость уровня в долларах."""
        return self.price * self.size


@dataclass(frozen=True)
class OrderBook:
    """
    Снимок стакана ордеров.

    Polymarket использует модель CDA (Central Limit Order Book):
    - bids: ордера на покупку (отсортированы по убыванию цены)
    - asks: ордера на продажу (отсортированы по возрастанию цены)
    """
    bids: tuple[PriceLevel, ...]  # Лучший bid — первый элемент
    asks: tuple[PriceLevel, ...]  # Лучший ask — первый элемент
    token_id: str

    @property
    def best_bid(self) -> Optional[PriceLevel]:
        """Лучший bid (самая высокая цена покупки)."""
        return self.bids[0] if self.bids else None

    @property
    def best_ask(self) -> Optional[PriceLevel]:
        """Лучший ask (самая низкая цена продажи)."""
        return self.asks[0] if self.asks else None

    @property
    def mid_price(self) -> Optional[float]:
        """
        Средняя цена = (Best Bid + Best Ask) / 2.
        Основная точка отсчёта для Strategy Engine.
        """
        if self.best_bid is None or self.best_ask is None:
            return None
        return (self.best_bid.price + self.best_ask.price) / 2.0

    @property
    def market_spread(self) -> Optional[float]:
        """Текущий рыночный спред (разница между best ask и best bid)."""
        if self.best_bid is None or self.best_ask is None:
            return None
        return self.best_ask.price - self.best_bid.price

    @property
    def is_valid(self) -> bool:
        """Проверка, что стакан имеет достаточную ликвидность для торговли."""
        return self.best_bid is not None and self.best_ask is not None

    @property
    def total_bid_liquidity_usd(self) -> float:
        """Общая ликвидность на стороне покупки (в USD)."""
        return sum(level.cost_usd for level in self.bids)

    @property
    def total_ask_liquidity_usd(self) -> float:
        """Общая ликвидность на стороне продажи (в USD)."""
        return sum(level.cost_usd for level in self.asks)


@dataclass(frozen=True)
class Inventory:
    """
    Текущий инвентарь (позиция) бота.

    На Polymarket каждый рынок имеет два токена: YES и NO.
    Позиция может быть выражена в количестве каждого токена.
    """
    yes_tokens: float = 0.0   # Количество YES токенов
    no_tokens: float = 0.0    # Количество NO токенов
    cash_usd: float = 0.0     # Свободный кэш в USD

    @property
    def net_position_usd(self) -> float:
        """
        Нетто-позиция в долларах.
        Положительная = перекос в YES (много YES токенов).
        Отрицательная = перекос в NO (много NO токенов).
        """
        return self.yes_tokens - self.no_tokens

    @property
    def total_exposure_usd(self) -> float:
        """
        Общая экспозиция в долларах.
        Сумма всех токенов (и YES, и NO).
        """
        return self.yes_tokens + self.no_tokens

    @property
    def is_long_yes(self) -> bool:
        """Бот держит больше YES, чем NO."""
        return self.net_position_usd > 0

    @property
    def is_long_no(self) -> bool:
        """Бот держит больше NO, чем YES."""
        return self.net_position_usd < 0

    @property
    def is_flat(self) -> bool:
        """Позиция сбалансирована."""
        return abs(self.net_position_usd) < 0.01


@dataclass(frozen=True)
class QuotePrices:
    """
    Рассчитанные цены для размещения ордеров.
    Это результат работы Strategy Engine.
    """
    my_bid: float        # Цена, по которой бот КУПИТ YES
    my_ask: float        # Цена, по которой бот ПРОДАСТ YES
    bid_size: float      # Размер ордера на покупку (USD)
    ask_size: float      # Размер ордера на продажу (USD)
    mid_price: float     # Mid-price, от которого отталкивались
    spread_applied: float  # Спред, который был применён
    skew_offset: float   # Сдвиг цены из-за инвентарного перекоса

    @property
    def effective_spread(self) -> float:
        """Фактический спред между нашими ордерами."""
        return self.my_ask - self.my_bid


@dataclass(frozen=True)
class Order:
    """Ордер на бирже."""
    order_id: str
    side: Side
    price: float
    size: float
    token_id: str


@dataclass
class RiskAssessment:
    """
    Результат оценки рисков от Risk Manager.
    """
    allowed: bool                   # Разрешена ли торговля
    reason: str = ""                # Причина запрета (если allowed=False)
    position_skew_usd: float = 0.0  # Текущий перекос позиции
    skew_offset_cents: float = 0.0  # Рекомендуемый сдвиг цены (в центах)
    should_reduce: bool = False     # Нужно ли уменьшить позицию
    bid_size_modifier: float = 1.0  # Модификатор размера bid ордера (0.0-1.0)
    ask_size_modifier: float = 1.0  # Модификатор размера ask ордера (0.0-1.0)


@dataclass(frozen=True)
class TrendInfo:
    """
    Результат анализа тренда от Trend Detector.
    
    Определяет текущий рыночный режим и предоставляет
    данные для динамической настройки спреда.
    """
    regime: MarketRegime = MarketRegime.UNKNOWN
    # Сила тренда: 0.0 — нет тренда, 1.0 — максимальная сила
    strength: float = 0.0
    # Волатильность: нормированное стандартное отклонение изменений цены
    # 0.0 — цена стоит, 1.0 — экстремальная волатильность
    volatility: float = 0.0
    # Моментум: скорость изменения цены (долларов за период)
    # Положительный → цена растёт, отрицательный → падает
    momentum: float = 0.0
    # Короткая EMA (быстрая скользящая средняя)
    short_ema: float = 0.0
    # Длинная EMA (медленная скользящая средняя)
    long_ema: float = 0.0
    # Сдвиг цены из-за тренда (в центах)
    # BULLISH → положительный (сдвигаем цены вверх, не продаём дёшево)
    # BEARISH → отрицательный (сдвигаем цены вниз, не покупаем дорого)
    trend_offset_cents: float = 0.0
    # Количество наблюдений в истории
    samples: int = 0

    @property
    def is_trending(self) -> bool:
        """Есть ли явный тренд (не NEUTRAL и не UNKNOWN)."""
        return self.regime in (MarketRegime.BULLISH, MarketRegime.BEARISH)

    @property
    def is_volatile(self) -> bool:
        """Высокая ли волатильность (> 0.3)."""
        return self.volatility > 0.3

    @property
    def has_enough_data(self) -> bool:
        """Достаточно ли данных для анализа."""
        return self.regime != MarketRegime.UNKNOWN


@dataclass(frozen=True)
class SpreadAdjustment:
    """
    Результат расчёта динамического спреда.
    
    Определяет, насколько нужно расширить/сузить базовый спред
    на основе рыночных условий.
    """
    # Итоговый спред в центах (уже с учётом всех факторов)
    spread_cents: float = 2.0
    # Множитель от волатильности (1.0 = без изменения)
    volatility_multiplier: float = 1.0
    # Множитель от тренда (1.0 = без изменения)
    trend_multiplier: float = 1.0
    # Множитель от ликвидности (1.0 = без изменения)
    liquidity_multiplier: float = 1.0
    # Сдвиг цены из-за тренда (в центах)
    trend_offset_cents: float = 0.0
    # Причина корректировки (для логирования)
    reason: str = ""

    @property
    def total_multiplier(self) -> float:
        """Итоговый множитель спреда."""
        return self.volatility_multiplier * self.trend_multiplier * self.liquidity_multiplier
