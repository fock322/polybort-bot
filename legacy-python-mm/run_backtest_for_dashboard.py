#!/usr/bin/env python3
"""
Run Backtests for Dashboard — Запуск бэктестов для дашборда
============================================================

Запуск: python -m polymarket_mm.run_backtest_for_dashboard

Спреды: 3, 4, 5 центов (по запросу пользователя)
Вывод: JSON-файл с детальными результатами для дашборда:
  - PnL по каждому сценарию и спреду
  - Список сделок (fills) с ценами, сторонами, PnL
  - Позиции по каждому сценарию
  - Кривая PnL (снимки)
"""

import json
import logging
import sys
import os
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from polymarket_mm.config import BotConfig, SpreadConfig, InventoryConfig, OrderConfig
from polymarket_mm.backtester import Backtester
from polymarket_mm.historical_data import generate_political_market, generate_multiple_scenarios

logging.basicConfig(level=logging.WARNING)

# ── Конфигурация ────────────────────────────────────────────────

SPREADS = [3.0, 4.0, 5.0]  # Только 3, 4, 5 центов

SCENARIOS_CONFIG = [
    {
        "name": "Спокойный рынок (Will X win?)",
        "start_price": 0.50,
        "hours": 720,
        "volatility": 0.002,
        "trend": 0.0,
        "seed": 42,
    },
    {
        "name": "Тренд вверх (X набирает силу)",
        "start_price": 0.40,
        "hours": 720,
        "volatility": 0.003,
        "trend": 0.0003,
        "seed": 100,
    },
    {
        "name": "Тренд вниз (X теряет позиции)",
        "start_price": 0.60,
        "hours": 720,
        "volatility": 0.003,
        "trend": -0.0003,
        "seed": 200,
    },
    {
        "name": "Волатильный рынок (частые шоки)",
        "start_price": 0.50,
        "hours": 720,
        "volatility": 0.005,
        "trend": 0.0,
        "seed": 300,
    },
    {
        "name": "Долгосрочный (6 месяцев)",
        "start_price": 0.50,
        "hours": 4320,
        "volatility": 0.002,
        "trend": 0.00005,
        "seed": 400,
    },
]


def run_backtests() -> dict:
    """
    Запустить все бэктесты и собрать детальные результаты.
    
    Returns:
        dict с полной информацией для дашборда
    """
    all_results = []  # Сводные результаты (как раньше)
    detailed_fills = []  # Детальные сделки
    detailed_positions = []  # Детальные позиции по сценариям
    pnl_curves = {}  # Кривые PnL по сценариям
    
    print(f"╔══════════════════════════════════════════════════════╗")
    print(f"║  Backtesting: спреды 3c, 4c, 5c                    ║")
    print(f"║  Сценариев: {len(SCENARIOS_CONFIG)} | Спредов: {len(SPREADS)} = {len(SCENARIOS_CONFIG) * len(SPREADS)} тестов  ║")
    print(f"╚══════════════════════════════════════════════════════╝\n")

    for sc_idx, sc_cfg in enumerate(SCENARIOS_CONFIG):
        print(f"  📊 [{sc_idx+1}/{len(SCENARIOS_CONFIG)}] {sc_cfg['name']}")
        
        # Генерируем данные один раз на сценарий
        data = generate_political_market(
            name=sc_cfg["name"],
            start_price=sc_cfg["start_price"],
            hours=sc_cfg["hours"],
            volatility=sc_cfg["volatility"],
            trend=sc_cfg["trend"],
            seed=sc_cfg["seed"],
        )
        
        for spread_cents in SPREADS:
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
            result = bt.run(data)
            
            # ── Сводный результат (как раньше) ──
            result_dict = {
                "market": result.market_name,
                "spread_cents": spread_cents,
                "total_pnl": result.final_total_pnl,
                "realized_pnl": result.final_realized_pnl,
                "unrealized_pnl": result.final_unrealized_pnl,
                "fills": result.total_fills,
                "buy_fills": result.buy_fills,
                "sell_fills": result.sell_fills,
                "volume": result.total_volume_usd,
                "win_rate": result.win_rate,
                "max_drawdown": result.max_drawdown,
                "sharpe": result.sharpe_ratio,
                "max_position": result.max_position_reached,
                "avg_position": result.avg_position,
                "spread_captured": result.spread_captured_cents,
                "avg_trade_pnl": result.avg_trade_pnl,
                "total_hours": result.total_hours,
                "total_points": result.total_points,
                "trend_stats": result.trend_stats,
            }
            all_results.append(result_dict)
            
            # ── Детальные сделки (fills) ──
            key = f"{sc_cfg['name']}__{spread_cents:.0f}c"
            for fill in result.fills:
                fill_dict = {
                    "scenario": sc_cfg["name"],
                    "spread_cents": spread_cents,
                    "timestamp": fill.timestamp,
                    "side": fill.side,
                    "price": fill.price,
                    "size": round(fill.size, 4),
                    "value_usd": round(fill.value_usd, 2),
                    "mid_price_at_fill": fill.mid_price_at_fill,
                    "pnl_on_fill": round(fill.pnl_on_fill, 4),
                }
                detailed_fills.append(fill_dict)
            
            # ── Позиция в конце бэктеста ──
            last_snapshot = result.snapshots[-1] if result.snapshots else None
            pos_dict = {
                "scenario": sc_cfg["name"],
                "spread_cents": spread_cents,
                "yes_tokens": last_snapshot.yes_tokens if last_snapshot else 0,
                "no_tokens": last_snapshot.no_tokens if last_snapshot else 0,
                "cash": last_snapshot.cash if last_snapshot else 100.0,
                "unrealized_pnl": last_snapshot.unrealized_pnl if last_snapshot else 0,
                "realized_pnl": last_snapshot.realized_pnl if last_snapshot else 0,
                "total_pnl": last_snapshot.total_pnl if last_snapshot else 0,
                "trend_regime": last_snapshot.trend_regime if last_snapshot else "UNKNOWN",
                "mid_price": last_snapshot.mid_price if last_snapshot else 0,
                "dynamic_spread_cents": last_snapshot.dynamic_spread_cents if last_snapshot else 0,
            }
            detailed_positions.append(pos_dict)
            
            # ── Кривая PnL (выбираем каждый N-й снепшот для компактности) ──
            step = max(1, len(result.snapshots) // 100)  # ~100 точек
            curve_points = []
            for i, snap in enumerate(result.snapshots):
                if i % step == 0 or i == len(result.snapshots) - 1:
                    curve_points.append({
                        "t": snap.timestamp,
                        "mid": snap.mid_price,
                        "bid": snap.my_bid,
                        "ask": snap.my_ask,
                        "yes_tokens": snap.yes_tokens,
                        "cash": snap.cash,
                        "unrealized_pnl": snap.unrealized_pnl,
                        "realized_pnl": snap.realized_pnl,
                        "total_pnl": snap.total_pnl,
                        "regime": snap.trend_regime,
                        "spread": snap.dynamic_spread_cents,
                        "fill_side": snap.fill.side if snap.fill else None,
                        "fill_price": snap.fill.price if snap.fill else None,
                    })
            pnl_curves[key] = curve_points
            
            # Краткий вывод
            pnl_str = f"${result.final_total_pnl:+.2f}"
            print(f"    Спред {spread_cents:.0f}c → PnL: {pnl_str:>8} | "
                  f"Сделок: {result.total_fills:>3} (B:{result.buy_fills} S:{result.sell_fills}) | "
                  f"WR: {result.win_rate:.0f}% | DD: ${result.max_drawdown:.2f} | "
                  f"Sharpe: {result.sharpe_ratio:.2f}")
    
    # ── Анализ по спредам ──
    spread_analysis = []
    for s in SPREADS:
        pnls = [r["total_pnl"] for r in all_results if r["spread_cents"] == s]
        if pnls:
            spread_analysis.append({
                "spread": s,
                "avg_pnl": round(sum(pnls) / len(pnls), 2),
                "profitable": sum(1 for p in pnls if p > 0),
                "total": len(pnls),
                "pct": round(sum(1 for p in pnls if p > 0) / len(pnls) * 100),
            })
    
    # ── Лучший результат ──
    best = max(all_results, key=lambda r: r["total_pnl"])
    
    profitable = sum(1 for r in all_results if r["total_pnl"] > 0)
    total = len(all_results)
    
    # Вердикт
    if profitable > total * 0.6:
        verdict = f"✅ Стратегия прибыльна в {profitable}/{total} тестов — можно переходить к Paper Trading"
    elif profitable > total * 0.3:
        verdict = f"⚠️ Стратегия прибыльна в {profitable}/{total} тестов — нужна доработка параметров"
    else:
        verdict = f"❌ Стратегия убыточна ({profitable}/{total} прибыльных) — необходима переработка логики"
    
    # Собираем итоговый JSON
    output = {
        "version": "3.0",
        "generated_at": datetime.utcnow().isoformat(),
        "spreads": SPREADS,
        "scenarios": [sc["name"] for sc in SCENARIOS_CONFIG],
        "summary": {
            "profitable": profitable,
            "total": total,
            "verdict": verdict,
            "best_result": {
                "scenario": best["market"],
                "spread": best["spread_cents"],
                "pnl": best["total_pnl"],
                "sharpe": best["sharpe"],
            },
            "spread_analysis": spread_analysis,
        },
        "results": all_results,
        "fills": detailed_fills,
        "positions": detailed_positions,
        "pnl_curves": pnl_curves,
    }
    
    return output


def main() -> None:
    output = run_backtests()
    
    # Сохраняем JSON
    output_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "backtest_results.json"
    )
    
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    
    print(f"\n  💾 Результаты сохранены: {output_path}")
    print(f"  📊 Сделок: {len(output['fills'])} | Позиций: {len(output['positions'])} | Кривых: {len(output['pnl_curves'])}")
    print(f"\n  {output['summary']['verdict']}")


if __name__ == "__main__":
    main()
