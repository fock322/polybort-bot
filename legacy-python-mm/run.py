#!/usr/bin/env python3
"""
Запуск бота-маркет-мейкера
===========================

Пример подключения к Polymarket и запуска бота.

Перед запуском:
1. Установите зависимости: pip install py-clob-client requests
2. Настройте переменные окружения:
   - POLY_PRIVATE_KEY — приватный ключ кошелька (для торговли)
   - POLY_TOKEN_ID_YES — Token ID рынка (YES)

Режимы запуска:
- Без ключей: режим наблюдения (observer) + PnL трекинг
- С ключами: полный режим (торговля + наблюдение + PnL)

Запуск:
   python -m polymarket_mm.run
"""

import logging
import os
import sys

from .config import (
    BotConfig,
    SpreadConfig,
    InventoryConfig,
    OrderConfig,
    TrendConfig,
    DynamicSpreadConfig,
    ObserverConfig,
    PnLTrackerConfig,
)
from .bot import MarketMakerBot


def setup_logging() -> None:
    """Настроить логирование."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    # Уменьшить шум от сторонних библиотек
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("web3").setLevel(logging.WARNING)


def create_clob_client() -> object | None:
    """
    Создать и настроить py-clob-client.

    Returns:
        ClobClient или None, если библиотека не установлена / нет ключей
    """
    try:
        from py_clob_client.client import ClobClient
        from py_clob_client.clob_types import ApiCreds

        # Polymarket CLOB API (Polygon / chain_id=137)
        host = "https://clob.polymarket.com"
        chain_id = 137

        # Ключи из окружения
        private_key = os.environ.get("POLY_PRIVATE_KEY", "")
        api_key = os.environ.get("POLY_API_KEY", "")
        api_secret = os.environ.get("POLY_API_SECRET", "")
        api_passphrase = os.environ.get("POLY_API_PASSPHRASE", "")

        if not private_key:
            logging.info(
                "POLY_PRIVATE_KEY не задан — режим наблюдения (Observer only)"
            )
            return None

        # Создание клиента
        creds = ApiCreds(
            api_key=api_key,
            api_secret=api_secret,
            api_passphrase=api_passphrase,
        ) if api_key else None

        client = ClobClient(
            host=host,
            chain_id=chain_id,
            key=private_key,
            creds=creds,
        )

        # Проверка подключения
        try:
            server_time = client.get_server_time()
            logging.info("Подключение к Polymarket OK (server_time=%s)", server_time)
        except Exception as e:
            logging.error("Не удалось подключиться к Polymarket: %s", e)
            return None

        return client

    except ImportError:
        logging.info(
            "py-clob-client не установлен — режим наблюдения (REST API). "
            "Установите: pip install py-clob-client"
        )
        return None


def main() -> None:
    """Точка входа."""
    setup_logging()

    logging.info("═" * 60)
    logging.info("  Polymarket Market Maker Bot v1.4")
    logging.info("  + Observer + PnL Tracker")
    logging.info("═" * 60)

    # ── Конфигурация ─────────────────────────────────────────────
    token_id_yes = os.environ.get("POLY_TOKEN_ID_YES", "")

    # Чтение конфигурации из окружения (с дефолтами)
    trend_enabled = os.environ.get("POLY_TREND_ENABLED", "true").lower() == "true"
    dyn_spread_enabled = os.environ.get("POLY_DYNAMIC_SPREAD_ENABLED", "true").lower() == "true"
    observer_enabled = os.environ.get("POLY_OBSERVER_ENABLED", "true").lower() == "true"
    pnl_enabled = os.environ.get("POLY_PNL_TRACKER_ENABLED", "true").lower() == "true"

    config = BotConfig(
        spread=SpreadConfig(
            spread_cents=2.0,
            min_spread_cents=1.0,
            max_spread_cents=10.0,
        ),
        inventory=InventoryConfig(
            max_position_usd=100.0,
            skew_threshold_usd=30.0,
            skew_per_dollar_cents=0.1,
            max_skew_cents=5.0,
        ),
        order=OrderConfig(
            order_size_usd=10.0,
            min_order_size_usd=5.0,
        ),
        trend=TrendConfig(
            enabled=trend_enabled,
            window_size=20,
            short_ema_period=5,
            long_ema_period=15,
            ema_threshold=0.005,
            max_trend_offset_cents=2.0,
            trend_price_factor_cents=2.0,
        ),
        dynamic_spread=DynamicSpreadConfig(
            enabled=dyn_spread_enabled,
            volatility_factor=2.0,
            trend_factor=1.0,
            liquidity_threshold_usd=100.0,
            low_liquidity_multiplier=1.5,
            high_liquidity_threshold_usd=500.0,
            high_liquidity_multiplier=0.8,
        ),
        observer=ObserverConfig(
            enabled=observer_enabled,
            min_market_liquidity_usd=100.0,
            max_markets=20,
            price_update_interval_sec=30.0,
            api_delay_sec=0.5,
            auto_discover_markets=True,
        ),
        pnl_tracker=PnLTrackerConfig(
            enabled=pnl_enabled,
            history_interval_sec=60.0,
            max_history_points=1440,
            auto_update_prices=True,
            initial_balance_usd=500.0,
        ),
        loop_interval_sec=7.0,
        token_id_yes=token_id_yes if token_id_yes else None,
    )

    # ── Подключение к API ────────────────────────────────────────
    client = create_clob_client()

    # ── Запуск бота ──────────────────────────────────────────────
    bot = MarketMakerBot(config=config, clob_client=client)

    if client is None:
        mode = "НАБЛЮДЕНИЕ" if observer_enabled else "DRY-RUN"
        logging.info(
            "══════════════════════════════════════════════\n"
            "  РЕЖИМ %s\n"
            "  %s\n"
            "  Ордера НЕ отправляются на биржу.\n"
            "══════════════════════════════════════════════",
            mode,
            "Чтение данных через REST API + PnL трекинг"
            if observer_enabled
            else "Бот работает, но без подключения к Polymarket",
        )

    try:
        bot.run()
    except KeyboardInterrupt:
        bot.stop()


if __name__ == "__main__":
    main()
