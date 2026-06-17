"""
Конфигурация бота-маркет-мейкера
=================================
Все настраиваемые параметры в одном месте.
"""

from dataclasses import dataclass, field
from typing import Optional


@dataclass(frozen=True)
class SpreadConfig:
    """Параметры спреда."""
    # Фиксированный спред в центах (разница между Ask и Bid)
    spread_cents: float = 2.0  # 2 цента = $0.02

    # Минимальный спред (защита от нулевого/отрицательного)
    min_spread_cents: float = 1.0  # 1 цент

    # Максимальный спред (защита от слишком широкого)
    max_spread_cents: float = 10.0  # 10 центов


@dataclass(frozen=True)
class InventoryConfig:
    """Параметры управления инвентарём."""
    # Максимальная позиция в долларах (не держать активов больше чем на $X)
    max_position_usd: float = 100.0

    # Порог для начала сдвига цен (инвентарный перекос)
    # Если позиция > skew_threshold_usd — начинаем сдвигать цены
    skew_threshold_usd: float = 30.0

    # Коэффициент сдвига цены на каждый доллар превышения порога
    # (в центах сдвига на $1 превышения)
    skew_per_dollar_cents: float = 0.1

    # Максимальный сдвиг цены (в центах) — ограничение сверху
    max_skew_cents: float = 5.0


@dataclass(frozen=True)
class OrderConfig:
    """Параметры ордеров."""
    # Размер каждого ордера (в долларах)
    order_size_usd: float = 10.0

    # Минимальный размер ордера
    min_order_size_usd: float = 5.0


@dataclass(frozen=True)
class TrendConfig:
    """
    Параметры детектора трендов.
    
    Алгоритм: две EMA (короткая и длинная).
    Если короткая EMA > длинной — бычий тренд (BULLISH).
    Если короткая EMA < длинной — медвежий тренд (BEARISH).
    Если EMA близки — нейтральный рынок (NEUTRAL).
    """
    # Включить детектор трендов
    enabled: bool = True

    # Размер окна истории (количество mid-price наблюдений)
    # Чем больше окно, тем стабильнее сигналы, но медленнее реакция
    window_size: int = 20

    # Период быстрой EMA (короткая скользящая средняя)
    # Реагирует быстрее на изменения цены
    short_ema_period: int = 5

    # Период медленной EMA (длинная скользящая средняя)
    # Более плавная, показывает общий тренд
    long_ema_period: int = 15

    # Порог для определения NEUTRAL (в долларах)
    # Если |short_ema - long_ema| < threshold → NEUTRAL
    ema_threshold: float = 0.005  # 0.5 цента

    # Максимальный сдвиг цены из-за тренда (в центах)
    # BULLISH → сдвигаем цены ВВЕРХ (не продаём дёшево)
    # BEARISH → сдвигаем цены ВНИЗ (не покупаем дорого)
    max_trend_offset_cents: float = 2.0

    # Коэффициент сдвига цены на единицу силы тренда (в центах)
    # trend_offset = strength * trend_price_factor_cents
    trend_price_factor_cents: float = 2.0


@dataclass(frozen=True)
class DynamicSpreadConfig:
    """
    Параметры динамического спреда.
    
    Вместо фиксированного спреда, бот адаптирует его
    на основе рыночных условий:
    - Волатильность: высокая волатильность → шире спред
    - Тренд: сильный тренд → шире спред (риск adverse selection)
    - Ликвидность: тонкий стакан → шире спред
    
    Формула:
        dynamic_spread = base_spread * vol_mult * trend_mult * liq_mult
    """
    # Включить динамический спред (иначе — фиксированный из SpreadConfig)
    enabled: bool = True

    # Множитель спреда от волатильности
    # vol_mult = 1.0 + (volatility * volatility_factor)
    # При volatility=0.5 и factor=2.0 → vol_mult = 2.0 (спред удваивается)
    volatility_factor: float = 2.0

    # Множитель спреда от тренда
    # trend_mult = 1.0 + (trend_strength * trend_factor)
    # При strength=0.8 и factor=1.0 → trend_mult = 1.8
    trend_factor: float = 1.0

    # Порог ликвидности (в USD) — ниже этого расширяем спред
    liquidity_threshold_usd: float = 100.0

    # Множитель спреда при низкой ликвидности
    # Если total_liquidity < threshold → liq_mult = low_liquidity_multiplier
    low_liquidity_multiplier: float = 1.5

    # Порог высокой ликвидности — выше этого можно сузить спред
    high_liquidity_threshold_usd: float = 500.0

    # Множитель спреда при высокой ликвидности
    high_liquidity_multiplier: float = 0.8


@dataclass(frozen=True)
class ObserverConfig:
    """Параметры наблюдателя (Polymarket Observer)."""
    # Включить режим наблюдения (только чтение, без ордеров)
    enabled: bool = True

    # Минимальная ликвидность рынка для наблюдения (USD)
    min_market_liquidity_usd: float = 100.0

    # Максимальное количество рынков для отслеживания
    max_markets: int = 20

    # Интервал обновления цен (секунды)
    price_update_interval_sec: float = 30.0

    # Задержка между API-запросами (чтобы не спамить)
    api_delay_sec: float = 0.5

    # Автоматически находить политические рынки
    auto_discover_markets: bool = True


@dataclass(frozen=True)
class PnLTrackerConfig:
    """Параметры трекера PnL."""
    # Включить трекинг PnL
    enabled: bool = True

    # Интервал записи точек в историю PnL (секунды)
    history_interval_sec: float = 60.0

    # Максимум точек в истории (1440 = 24ч при 1 точке/мин)
    max_history_points: int = 1440

    # Обновлять цены позиций автоматически из Observer
    auto_update_prices: bool = True

    # Начальный баланс для расчёта доходности
    initial_balance_usd: float = 500.0


@dataclass(frozen=True)
class BotConfig:
    """Главная конфигурация бота."""
    spread: SpreadConfig = field(default_factory=SpreadConfig)
    inventory: InventoryConfig = field(default_factory=InventoryConfig)
    order: OrderConfig = field(default_factory=OrderConfig)
    trend: TrendConfig = field(default_factory=TrendConfig)
    dynamic_spread: DynamicSpreadConfig = field(default_factory=DynamicSpreadConfig)
    observer: ObserverConfig = field(default_factory=ObserverConfig)
    pnl_tracker: PnLTrackerConfig = field(default_factory=PnLTrackerConfig)

    # Интервал цикла бота в секундах
    loop_interval_sec: float = 7.0  # между 5 и 10 секунд

    # Token ID рынка (условный: YES для политического рынка)
    # Будет установлен при запуске
    token_id_yes: Optional[str] = None
    token_id_no: Optional[str] = None

    # Минимальная ликвидность в стакане для торговли
    min_book_liquidity_usd: float = 50.0
