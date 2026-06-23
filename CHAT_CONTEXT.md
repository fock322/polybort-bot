# Chat Context — Polymarket MM Bot v6

> Полный контекст разработки. Последнее обновление: 2026-06-23

---

## ТЕКУЩАЯ АРХИТЕКТУРА (3 стратегии параллельно)

### 3 Mini-сервиса на VPS (151.245.140.23)

| Порт | Стратегия | Файл | TP | SL | Position |
|------|-----------|------|-----|-----|----------|
| 3002 | Contrarian | smart-entry.ts | 15% maker | 5% ATR | $5 |
| 3003 | Momentum | momentum-entry.ts | 8% trailing maker | 10% token drop | $5 |
| 3004 | Smart Money v3 | smart-money-entry.ts | НЕТ (hold to settlement) | 10% token drop | $10 |

### Ключевые файлы

```
src/lib/
  btc-feed.ts         — Multi-asset price feeds (BTC, ETH, SOL independently)
  mm-engine.ts        — Главный движок (3100+ строк)
  smart-entry.ts      — Contrarian стратегия
  momentum-entry.ts   — Momentum стратегия
  smart-money-entry.ts — Smart Money v3 стратегия

mini-services/
  paper-trading/           — Порт 3002 (contrarian)
  paper-trading-momentum/  — Порт 3003 (momentum)
  paper-trading-smart-money/ — Порт 3004 (smart-money)
```

---

## STRATEGY DETAILS

### Contrarian (порт 3002)
- **Логика:** Fade trend (BTC 5m > 0.3% → BUY DOWN, ожидать reversion)
- **TP:** 15% via maker ASK (0 fee)
- **SL:** 5% ATR-based dynamic
- **Tau окно:** 3-14min
- **L2:** bid pressure > 55%, depth > $50
- **Volatility:** |1m| < 5%
- **BTC 5m range:** [0.3%, 6%]
- **Position:** $5, single entry (no accumulation)

### Momentum (порт 3003)
- **Логика:** Follow trend (BTC 5m > 0.3% → BUY UP)
- **TP:** 8% trailing (drop 8% from peak) via maker ASK (0 fee)
- **SL:** 10% token mid drop from entry (taker exit)
- **Tau окно:** 1-14.5min (full market)
- **L2:** bid pressure > 55%, depth > $50 (HARD filter)
- **Volatility:** |1m| < 5%
- **BTC 5m range:** [0.3%, 6%]
- **Position:** $5, partial fills (up to 3 entries, scaling in)

### Smart Money v3 (порт 3004)
- **Логика:** Follow trend, hold to settlement for max profit
- **TP:** НЕТ — держать до settlement ($1.00 = up to +100% profit!)
- **SL:** 10% token mid drop from entry (taker exit)
- **Tau окно:** 2-14min
- **L2:** bid pressure > 50%, depth > $30 (HARD filter)
- **Volatility:** |1m| < 5%
- **BTC 5m range:** [0.2%, 8%]
- **Position:** $10, single entry
- **BTC 1m MUST confirm 5m** (hard filter, не optional)

---

## MULTI-ASSET PRICE FEEDS (2026-06-23)

Каждый рынок использует свой price feed:
- BTC markets → Binance BTCUSDT (price, 1m, 5m, ATR, EMA)
- ETH markets → Binance ETHUSDT (независимые данные)
- SOL markets → Binance SOLUSDT (независимые данные)

Функции:
- `getAssetPrice("BTC"|"ETH"|"SOL")` — independent cache per asset
- `slugToAsset(slug)` — mapping: "btc-*" → BTC, "eth-*" → ETH, "sol-*" → SOL

---

## SETTLEMENT & SL (универсально для всех активов)

### Settlement
- `upMid > 0.50` → UP wins (работает для BTC, ETH, SOL)
- `upMid <= 0.50` → DOWN wins
- Token mid price как proxy (не зависит от BTC price)

### Stop Loss
- **Momentum + Smart Money:** 10% token mid drop from entry
- **Contrarian:** 5% ATR-based dynamic

---

## MAKER TP EXIT (0 fee)

Все TP exits используют maker ASK (0 fee):
- `takerTakeProfit()` — sells via ASK at best_ask - 1 tick
- `tpTriggers` array — trailing TP и smart-money TP идут через maker
- `stopLossTriggers` — SL идут через taker (closePositionById)
- Fee savings: $0.36 per TP exit on $10 position

---

## TUNABLE PARAMETERS (для регулировки)

### Contrarian (smart-entry.ts)
```
tau window: 3-14
volatility: |1m| < 0.05 (5%)
UP mid: 0.20-0.80
BTC 5m: [0.003, 0.06] (0.3% - 6%)
L2 depth: > $50
L2 bid pressure: > 0.55
MIN_CONFIDENCE: 40
MIN_GAP: 20
TP: 15% (SMART_TP_PCT = 0.15)
SL: 5% ATR (SMART_SL_PCT = 0.05)
```

### Momentum (momentum-entry.ts)
```
tau window: 1-14.5
volatility: |1m| < 0.05 (5%)
UP mid: 0.10-0.92
BTC 5m: [0.003, 0.06] (0.3% - 6%)
L2 depth: > $50
L2 bid pressure: > 0.55
MIN_CONFIDENCE: 40
MIN_GAP: 20
TP: 8% trailing (TRAILING_TP_DROP_PCT = 0.08)
SL: 10% token drop (SL_DROP_PCT = 0.10)
MAX_PARTIAL_ENTRIES: 3
```

### Smart Money v3 (smart-money-entry.ts)
```
tau window: 2-14
volatility: |1m| < 0.05 (5%)
UP mid: 0.15-0.85
BTC 5m: [0.002, 0.08] (0.2% - 8%)
L2 depth: > $30
L2 bid pressure: > 0.50
MIN_CONFIDENCE: 40
MIN_GAP: 15
TP: NONE (hold to settlement)
SL: 10% token drop (SL_DROP_PCT = 0.10)
Position size: $10
```

---

## VPS СЕРВЕР
- IP: 151.245.140.23
- Login: root
- Password: GdW0%mC_26
- Dashboard: http://151.245.140.23:3002/dashboard (contrarian)
- Dashboard: http://151.245.140.23:3003/dashboard (momentum)
- Dashboard: http://151.245.140.23:3004/dashboard (smart-money)
- Открытые порты: 3002, 3003, 3004 (UFW)

### Запуск ботов:
```bash
pkill -9 -f paper-trading
cd ~/polybort-bot && git fetch origin && git reset --hard origin/main
setsid bash -c 'nohup /root/.bun/bin/bun mini-services/paper-trading/index.ts > bot-contrarian.log 2>&1 < /dev/null &'
setsid bash -c 'nohup /root/.bun/bin/bun mini-services/paper-trading-momentum/index.ts > bot-momentum.log 2>&1 < /dev/null &'
setsid bash -c 'nohup /root/.bun/bin/bun mini-services/paper-trading-smart-money/index.ts > bot-smart-money.log 2>&1 < /dev/null &'
```

## GITHUB
- Repo: https://github.com/fock322/polybort-bot
- Backup tag: backup-momentum-strategy (старая momentum стратегия)
- Восстановление: `git checkout backup-momentum-strategy`

## ВАЖНЫЕ ПРАВИЛА
1. Take-profit через maker ASK (0 fee) — НЕ taker
2. Gas fees $0.015 за ордер
3. Multi-asset price feeds — каждый актив независим
4. Settlement через token mid price (не BTC price)
5. SL через token mid price (не BTC price)
6. 3 стратегии работают параллельно для сравнения
7. Smart Money v3 — нет TP, держать до settlement
