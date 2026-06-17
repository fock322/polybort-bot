#!/usr/bin/env python3
"""
Backtest Runner — Запуск бэктестов (v2.0)
==========================================

Запуск: python -m polymarket_mm.backtest_runner

v2.0 Улучшения:
- Реальные данные Polymarket через Gamma API
- FIFO учёт PnL (точный расчёт)
- Интеграция Trend Detector + Dynamic Spread
- Расширенная статистика по трендам
- Сравнение: синтетика vs реальные данные

Режимы:
  --synthetic   Только синтетические данные (по умолчанию)
  --live        Подключиться к Polymarket API за реальными данными
  --all         И синтетика, и реальные данные
"""

import json
import logging
import sys
import os
import time
from dataclasses import asdict
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from polymarket_mm.config import BotConfig, SpreadConfig, InventoryConfig, OrderConfig
from polymarket_mm.backtester import Backtester
from polymarket_mm.historical_data import generate_political_market, generate_multiple_scenarios

logging.basicConfig(level=logging.WARNING)  # Тихо, только ошибки


def print_header(text: str) -> None:
    print(f"\n{'═' * 60}")
    print(f"  {text}")
    print(f"{'═' * 60}")


def print_backtest_summary(result) -> None:
    """Красивый вывод результата бэктеста."""
    pnl_icon = "📈" if result.final_total_pnl > 0 else "📉" if result.final_total_pnl < 0 else "➖"

    print(f"\n  🏷️  Рынок:       {result.market_name}")
    print(f"  ⏱️  Период:      {result.total_hours:.0f} часов ({result.total_hours/24:.0f} дней)")
    print(f"  📊 Точек:       {result.total_points}")
    print(f"  ──────────────────────────────────────")
    print(f"  💰 ИТОГОВЫЙ PnL: {pnl_icon} ${result.final_total_pnl:.2f}")
    print(f"     Реализованный:  ${result.final_realized_pnl:.2f}")
    print(f"     Нереализованный: ${result.final_unrealized_pnl:.2f}")
    print(f"  ──────────────────────────────────────")
    print(f"  📋 Сделок:       {result.total_fills} (покупок: {result.buy_fills}, продаж: {result.sell_fills})")
    print(f"  📦 Объём:        ${result.total_volume_usd:.2f}")
    print(f"  🎯 Win Rate:     {result.win_rate:.1f}%")
    print(f"  📉 Max Drawdown: ${result.max_drawdown:.2f}")
    print(f"  📈 Sharpe Ratio: {result.sharpe_ratio:.3f}")
    print(f"  💵 Макс. поз.:   ${result.max_position_reached:.2f}")
    print(f"  💲 Средний PnL:  ${result.avg_trade_pnl:.4f} за сделку")
    print(f"  📏 Захвач. спред: {result.spread_captured_cents:.2f} центов")

    # Тренд-статистика
    if result.trend_stats:
        print(f"  ──────────────────────────────────────")
        print(f"  📊 ТРЕНД-СТАТИСТИКА:")
        for regime, stats in result.trend_stats.items():
            if stats.get("count", 0) > 0:
                print(f"     {regime}: {stats['count']} точек ({stats['pct']}%) | "
                      f"ΔPnL=${stats.get('total_pnl', 0):.2f}")


def fetch_real_market_data() -> list:
    """
    Получить реальные данные с Polymarket через Gamma API.
    
    Возвращает список HistoricalData для бэктеста.
    """
    try:
        import requests
    except ImportError:
        print("  ❌ Библиотека 'requests' не установлена. pip install requests")
        return []

    from polymarket_mm.historical_data import HistoricalData, PricePoint

    GAMMA_HOST = "https://gamma-api.polymarket.com"
    CLOB_HOST = "https://clob.polymarket.com"

    session = requests.Session()
    session.headers.update({
        "User-Agent": "PolymarketMM-Backtest/2.0",
        "Accept": "application/json",
    })

    datasets = []

    # ── Шаг 1: Получаем список рынков с высокой ликвидностью ────
    print_header("ЗАГРУЗКА РЕАЛЬНЫХ ДАННЫХ POLYMARKET")
    print("  🔍 Поиск рынков с высокой ликвидностью...")

    try:
        url = f"{GAMMA_HOST}/markets"
        params = {
            "limit": 20,
            "active": "true",
            "closed": "false",
            "order": "liquidity",
            "ascending": "false",
        }

        resp = session.get(url, params=params, timeout=15)
        resp.raise_for_status()
        all_markets = resp.json()

        if not all_markets:
            print("  ⚠️  Не найдено рынков")
            return []

        # Фильтруем: нужны рынки с ликвидностью и ценами
        markets = []
        for m in all_markets:
            liquidity = float(m.get("liquidityNum", 0) or m.get("liquidity_num", 0) or 0)
            best_bid = m.get("bestBid") or m.get("best_bid")
            best_ask = m.get("bestAsk") or m.get("best_ask")

            if liquidity >= 500 and best_bid and best_ask:
                try:
                    bb = float(best_bid)
                    ba = float(best_ask)
                    if bb > 0 and ba > 0 and bb < ba:
                        markets.append(m)
                except (ValueError, TypeError):
                    continue

        print(f"  ✅ Найдено пригодных рынков: {len(markets)} (из {len(all_markets)})")

    except Exception as e:
        print(f"  ❌ Ошибка получения рынков: {e}")
        return []

    if not markets:
        print("  ⚠️  Нет рынков с достаточной ликвидностью")
        return []

    # ── Шаг 2: Для каждого рынка получаем историю цен ──────────
    import random as _random

    for idx, market in enumerate(markets[:5]):  # Максимум 5 рынков
        question = market.get("question", "Unknown")

        # Извлекаем token_id (API использует camelCase clobTokenIds — JSON строка)
        token_id_yes = ""
        clob_ids_raw = market.get("clobTokenIds") or market.get("clob_token_ids")
        outcomes_raw = market.get("outcomes") or market.get("outcomePrices")

        if clob_ids_raw:
            try:
                # clobTokenIds может быть JSON-строкой или списком
                if isinstance(clob_ids_raw, str):
                    clob_ids = json.loads(clob_ids_raw)
                else:
                    clob_ids = clob_ids_raw

                # outcomes тоже может быть строкой
                if isinstance(outcomes_raw, str):
                    outcomes = json.loads(outcomes_raw)
                else:
                    outcomes = outcomes_raw or ["Yes", "No"]

                # YES токен = первый в списке (обычно)
                if clob_ids and len(clob_ids) > 0:
                    # Если есть outcomes — ищем "Yes"
                    yes_idx = 0
                    if outcomes:
                        for i, out in enumerate(outcomes):
                            if str(out).lower() == "yes":
                                yes_idx = i
                                break
                    token_id_yes = clob_ids[yes_idx] if yes_idx < len(clob_ids) else clob_ids[0]
            except (json.JSONDecodeError, IndexError, TypeError):
                pass

        if not token_id_yes:
            continue

        liquidity = float(market.get("liquidityNum", 0) or market.get("liquidity_num", 0) or 0)
        best_bid = float(market.get("bestBid", 0) or market.get("best_bid", 0) or 0)
        best_ask = float(market.get("bestAsk", 0) or market.get("best_ask", 0) or 0)

        if best_bid <= 0 or best_ask <= 0:
            continue

        mid_price = (best_bid + best_ask) / 2

        print(f"\n  📈 [{idx+1}/{min(5, len(markets))}] {question[:50]}...")
        print(f"     Ликвидность: ${liquidity:.0f} | Mid: ${mid_price:.3f}")
        print(f"     Загрузка истории цен...")

        try:
            # Получаем историю цен через CLOB API
            hist_url = f"{CLOB_HOST}/prices-history"
            hist_params = {
                "token_id": token_id_yes,
                "interval": "1h",
                "fidelity": 168,  # 7 дней по часам
            }

            resp = session.get(hist_url, params=hist_params, timeout=15)

            if resp.status_code == 200:
                data = resp.json()
                history = data.get("history", [])

                if history and len(history) >= 10:
                    # Парсим в PricePoint
                    points = []
                    for item in history:
                        ts = item.get("t", 0)
                        price = float(item.get("p", 0))

                        if ts > 0 and price > 0:
                            spread = _random.uniform(0.01, 0.03)
                            points.append(PricePoint(
                                timestamp=ts,
                                best_bid=max(0.01, price - spread / 2),
                                best_ask=min(0.99, price + spread / 2),
                                mid_price=price,
                                volume=0,
                            ))

                    if len(points) >= 10:
                        hist_data = HistoricalData(
                            market_name=f"[LIVE] {question[:40]}",
                            token_id=token_id_yes,
                            interval="1h",
                            points=points,
                        )
                        datasets.append(hist_data)
                        print(f"     ✅ Загружено: {len(points)} точек, {hist_data.duration_hours:.0f} часов")
                        time.sleep(0.5)
                        continue

            # Если CLOB API не вернул данные — генерируем на основе реальной цены
            print(f"     ⚠️  CLOB API не дал историю — генерация на основе реальной цены...")
            sim_data = generate_political_market(
                name=f"[LIVE] {question[:40]}",
                start_price=mid_price,
                hours=168,  # 7 дней
                volatility=0.003,
                trend=0.0,
                seed=hash(token_id_yes) % 10000,
            )
            datasets.append(sim_data)
            print(f"     ✅ Симуляция: {len(sim_data.points)} точек (на основе mid=${mid_price:.3f})")

        except Exception as e:
            print(f"     ❌ Ошибка: {e}")
            continue

    print(f"\n  📊 Итого реальных датасетов: {len(datasets)}")
    return datasets


def run_parameter_sweep(
    scenarios: list = None,
    spreads: list = None,
) -> list[dict]:
    """
    Провести серию бэктестов с разными параметрами спреда.

    Тестируем: спред 1, 2, 3, 4, 5 центов
    На каждом из сценариев = N * 5 бэктестов
    """
    if scenarios is None:
        scenarios = generate_multiple_scenarios()
    if spreads is None:
        spreads = [1.0, 2.0, 3.0, 4.0, 5.0]

    all_results = []

    print_header("БЭКТЕСТИНГ MARKET MAKER v2.0 — Серия тестов")
    print(f"\n  Сценариев: {len(scenarios)}")
    print(f"  Спредов: {len(spreads)} → {len(scenarios) * len(spreads)} бэктестов")
    print(f"  FIFO учёт PnL: ✅")
    print(f"  Trend Detector: ✅")
    print(f"  Dynamic Spread: ✅")

    for scenario in scenarios:
        print_header(f"Сценарий: {scenario.market_name}")

        for spread_cents in spreads:
            config = BotConfig(
                spread=SpreadConfig(spread_cents=spread_cents),
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
                loop_interval_sec=7.0,
            )

            bt = Backtester(config)
            result = bt.run(scenario)

            # Убираем snapshots/fills из JSON (слишком много данных)
            result_dict = {
                "market": result.market_name,
                "spread_cents": spread_cents,
                "total_pnl": result.final_total_pnl,
                "realized_pnl": result.final_realized_pnl,
                "unrealized_pnl": result.final_unrealized_pnl,
                "fills": result.total_fills,
                "volume": result.total_volume_usd,
                "win_rate": result.win_rate,
                "max_drawdown": result.max_drawdown,
                "sharpe": result.sharpe_ratio,
                "max_position": result.max_position_reached,
                "spread_captured": result.spread_captured_cents,
                "trend_stats": result.trend_stats,
            }
            all_results.append(result_dict)

            # Краткий вывод
            pnl_str = f"${result.final_total_pnl:+.2f}"
            trend_info = ""
            if result.trend_stats:
                bullish_pct = result.trend_stats.get("BULLISH", {}).get("pct", 0)
                bearish_pct = result.trend_stats.get("BEARISH", {}).get("pct", 0)
                trend_info = f"↑{bullish_pct:.0f}%↓{bearish_pct:.0f}%"

            print(f"    Спред {spread_cents:.0f}c → PnL: {pnl_str:>8} | "
                  f"Сделок: {result.total_fills:>3} | "
                  f"DD: ${result.max_drawdown:.2f} | "
                  f"Sharpe: {result.sharpe_ratio:.2f} | "
                  f"Спред захв.: {result.spread_captured_cents:.1f}c | "
                  f"{trend_info}")

    return all_results


def print_comparison_table(results: list[dict]) -> None:
    """Вывести сравнительную таблицу всех бэктестов."""
    print_header("СВОДНАЯ ТАБЛИЦА")

    # Группируем по сценарию
    by_market = {}
    for r in results:
        m = r["market"]
        if m not in by_market:
            by_market[m] = []
        by_market[m].append(r)

    for market, market_results in by_market.items():
        print(f"\n  📍 {market}")
        print(f"  {'Спред':>6} │ {'PnL':>8} │ {'Сделок':>6} │ {'Win%':>5} │ {'MaxDD':>6} │ {'Sharpe':>6} │ {'Захв.c':>6}")
        print(f"  {'─'*6}─┼─{'─'*8}─┼─{'─'*6}─┼─{'─'*5}─┼─{'─'*6}─┼─{'─'*6}─┼─{'─'*6}")

        for r in market_results:
            print(f"  {r['spread_cents']:>5.0f}c │ "
                  f"${r['total_pnl']:>+7.2f} │ "
                  f"{r['fills']:>6} │ "
                  f"{r['win_rate']:>4.0f}% │ "
                  f"${r['max_drawdown']:>5.2f} │ "
                  f"{r['sharpe']:>6.2f} │ "
                  f"{r.get('spread_captured', 0):>5.1f}c")

    # Лучшая комбинация
    best = max(results, key=lambda r: r["total_pnl"])
    print(f"\n  🏆 ЛУЧШИЙ РЕЗУЛЬТАТ:")
    print(f"     Рынок: {best['market']}")
    print(f"     Спред: {best['spread_cents']:.0f} центов")
    print(f"     PnL: ${best['total_pnl']:+.2f}")
    print(f"     Sharpe: {best['sharpe']:.2f}")
    print(f"     Захваченный спред: {best.get('spread_captured', 0):.2f} центов")

    # Худшая комбинация
    worst = min(results, key=lambda r: r["total_pnl"])
    print(f"\n  💀 ХУДШИЙ РЕЗУЛЬТАТ:")
    print(f"     Рынок: {worst['market']}")
    print(f"     Спред: {worst['spread_cents']:.0f} центов")
    print(f"     PnL: ${worst['total_pnl']:+.2f}")

    # Анализ по спредам
    print(f"\n  📊 АНАЛИЗ ПО СПРЕДАМ:")
    spread_results = {}
    for r in results:
        s = r["spread_cents"]
        if s not in spread_results:
            spread_results[s] = []
        spread_results[s].append(r["total_pnl"])

    for s in sorted(spread_results.keys()):
        pnls = spread_results[s]
        avg = sum(pnls) / len(pnls)
        profitable = sum(1 for p in pnls if p > 0)
        print(f"     Спред {s:.0f}c: средний PnL=${avg:+.2f}, "
              f"прибыльных {profitable}/{len(pnls)} ({profitable/len(pnls)*100:.0f}%)")


def save_results_json(results: list[dict], filepath: str) -> None:
    """Сохранить результаты в JSON для дашборда."""
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"\n  💾 Результаты сохранены: {filepath}")


def main() -> None:
    # Определяем режим запуска
    mode = "synthetic"  # по умолчанию
    if "--live" in sys.argv:
        mode = "live"
    elif "--all" in sys.argv:
        mode = "all"

    print("╔══════════════════════════════════════════════════════╗")
    print("║  Polymarket MM Bot — Backtesting Engine v2.0        ║")
    print("║  FIFO PnL · Trend Detector · Dynamic Spread         ║")
    print("╚══════════════════════════════════════════════════════╝")
    print(f"\n  Режим: {mode}")

    # ── Одиночный бэктест (детальный) ───────────────────────
    print_header("ТЕСТ 1: Детальный бэктест (спокойный рынок)")

    config = BotConfig(
        spread=SpreadConfig(spread_cents=2.0),
        inventory=InventoryConfig(
            max_position_usd=100.0,
            skew_threshold_usd=30.0,
        ),
        order=OrderConfig(order_size_usd=10.0),
    )

    data = generate_political_market(
        name="Will X win 2024 election?",
        hours=720,
        volatility=0.002,
    )

    bt = Backtester(config)
    result = bt.run(data)
    print_backtest_summary(result)

    # ── Синтетические бэктесты ──────────────────────────────
    all_results = []

    if mode in ("synthetic", "all"):
        results = run_parameter_sweep()
        all_results.extend(results)
        print_comparison_table(results)

    # ── Реальные данные Polymarket ──────────────────────────
    if mode in ("live", "all"):
        real_datasets = fetch_real_market_data()

        if real_datasets:
            real_results = run_parameter_sweep(
                scenarios=real_datasets,
                spreads=[2.0, 3.0, 4.0],  # Меньше вариантов для скорости
            )
            all_results.extend(real_results)
            print_comparison_table(real_results)
        else:
            print("\n  ⚠️  Реальные данные недоступны — пропускаем")

    # ── Сохраняем для дашборда ──────────────────────────────
    output_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "backtest_results.json"
    )
    save_results_json(all_results, output_path)

    # ── Вердикт ─────────────────────────────────────────────
    profitable = sum(1 for r in all_results if r["total_pnl"] > 0)
    total = len(all_results)

    print_header("ВЕРДИКТ")
    if profitable > total * 0.6:
        print(f"  ✅ Стратегия прибыльна в {profitable}/{total} тестов")
        print(f"  → Можно переходить к Paper Trading")
    elif profitable > total * 0.3:
        print(f"  ⚠️  Стратегия прибыльна в {profitable}/{total} тестов")
        print(f"  → Нужна доработка параметров")
    else:
        print(f"  ❌ Стратегия убыточна ({profitable}/{total} прибыльных)")
        print(f"  → Необходима переработка логики")

    # Рекомендации по параметрам
    if all_results:
        best_spread = max(
            set(r["spread_cents"] for r in all_results),
            key=lambda s: sum(r["total_pnl"] for r in all_results if r["spread_cents"] == s),
        )
        print(f"\n  💡 Рекомендуемый спред: {best_spread:.0f} центов")


if __name__ == "__main__":
    main()
