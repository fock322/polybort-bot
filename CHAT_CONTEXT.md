# Chat Context — Polymarket MM Bot

> Этот файл содержит полный контекст разработки. Создан для предотвращения потери информации.
> Последнее обновление: 2026-06-19

---

## ТЕКУЩИЕ РЕШЁННЫЕ ПАРАМЕТРЫ СТРАТЕГИИ

### Take-profit: 8%
- `entryPrice × 1.08` для ASK (maker)
- `entryPrice × 1.08` для takerTakeProfit (немедленная продажа по bid)
- **НЕ МЕНЯТЬ на 3%** — при 3% комиссии съедают 100%+ прибыли
- Расчёт: profit $0.49 на $5 позицию, break-even win rate 93.4%

### Stop-loss: ДИНАМИЧЕСКИЙ от ATR
- `dynSlPct = clamp(ATR_5m / BTC_price × 12, 5%, 20%)`
- **ПРОБЛЕМА**: при низкой волатильности ATR → 5% слишком жёстко
- Позиции закрываются в убыток до достижения 8% take-profit
- **НУЖНО ПОМЕНЯТЬ**: минимум 15% вместо 5%

### Position size: $5
- `quoteSize: 5`
- Один проигрыш = ~$0.75 (при 15% SL)
- Break-even: 3 победы на 1 проигрыш

### Cycle interval: 1 секунда
- `cycleIntervalMs: 1000`
- `scanMarkets` интервал: 1 секунда

### Условия входа (STRICT):
1. P(UP) > 60% → BID_UP, или P(UP) < 40% → BID_DOWN
2. midPrice 0.10–0.90 (не extreme)
3. > 1 мин до экспирации
4. Volume > $1000, Liquidity > $500
5. Book валиден (bid > 0, ask > 0, bid < ask)

### Условия выхода:
1. **Take-profit 8%** → takerTakeProfit (немедленно по bid)
2. **Dynamic stop-loss** (5-20% от ATR) → closePositionById
3. **1 мин до экспирации** → closePositionById
4. **Auto-exit (3 мин до конца, в плюсе)** → closePositionsForMarket
5. **Settlement при истечении** → settleMarket (НЕМЕДЛЕННО, не 30 мин)
6. **EV-based hold-vs-sell**: держать только если P(win) > bid

---

## ИСПРАВЛЕННЫЕ БАГИ (из аудита)

### Критические (исправлены):
1. ✅ totalPnL формула: `realizedPnl + unrealizedPnl` (не `(cash-start)+unreal`)
2. ✅ dailyPnL: включает open positions value
3. ✅ EV-based hold-vs-sell (не безусловный hold)
4. ✅ Settlement: settleMarket ДО markets.delete
5. ✅ Settlement: НЕМЕДЛЕННО (не 30 мин задержки)
6. ✅ Maker rebate = 0 (Polymarket не платит per-fill)
7. ✅ Taker fee divisor: /10000 (не /14000)
8. ✅ Taker fee cap: `min(rawFee, shares × min(price, 1-price))`
9. ✅ Race condition guard: `cycleInFlight`
10. ✅ cachedBtcPrice persist в globalThis
11. ✅ Float fix: `Math.round(price × 100) / 100`
12. ✅ Strike from eventMetadata (priceToBeat)
13. ✅ Strike fallback: BTC price при первом цикле
14. ✅ Volume refresh для существующих рынков (каждую секунду)
15. ✅ Volume parsing: `volumeNum || volume || volume24hr`
16. ✅ Gas fees: $0.015 за ордер (buy + sell)
17. ✅ PnL field в trades.push
18. ✅ recordTradeAnalytics на каждом закрытии
19. ✅ takerTakeProfit восстановлена
20. ✅ Dashboard, /trades, /analytics endpoints

### Live-mode баги (ещё не исправлены):
- Bug #6: Live stop-loss не отправляет SELL ордер
- Bug #7: Live auto-exit не продаёт
- Bug #12: isTaker heuristic ненадёжен
- Bug #13: Balance sync затирает PnL
- Bug #14: SELL fill без guard на размер
- Bug #15: capByBalance не резервирует cash
- Bug #16: Toggle liveMode без CLOB init
- Bug #17: realizedPnl не сбрасывается при switch to live

---

## ТЕКУЩАЯ ПРОБЛЕМА (не исправлена)

**0% win rate — все позиции закрываются через stop-loss, ни одна через take-profit.**

Причина: Dynamic stop-loss минимум 5% слишком жёсткий.
- ATR $40, BTC $63,000 → ATR% = 0.0006 × 12 = 0.0076 → clamp to 5%
- Позиция падает на 5% → stop-loss срабатывает
- До 8% take-profit не доходит

Решение: поднять минимум stop-loss с 5% до 15%.

---

## VPS СЕРВЕР
- IP: 151.245.140.23
- Login: root
- Password: GdW0%mC_26
- Dashboard: http://151.245.140.23:3002/dashboard
- Запуск: `cd ~/polybort-bot && nohup bun mini-services/paper-trading/index.ts > bot.log 2>&1 &`
- Обновление: `pkill -f paper-trading && cd ~/polybort-bot && git pull && nohup bun mini-services/paper-trading/index.ts > bot.log 2>&1 &`
- Проверка коммита: `git log --oneline -1`

## GITHUB
- Repo: https://github.com/fock322/polybort-bot (public)
- Token: [REDACTED — see env]

## ВАЖНЫЕ ПРАВИЛА
1. **НЕ использовать `git push --force`** — теряются изменения
2. **Всегда проверять** что функции не пропали после коммита
3. **Обновлять этот файл** при каждом изменении параметров
4. Take-profit 8% — **НЕ МЕНЯТЬ** (3% съедают комиссии)
5. Gas fees $0.015 — учитывать во всех операциях
