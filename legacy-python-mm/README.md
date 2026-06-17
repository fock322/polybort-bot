# Polymarket Market Maker Bot 🤖

Бот-маркет-мейкер для Polymarket. Обеспечивает ликвидность на политических рынках, зарабатывает на спреде.

## Структура проекта

```
polymarket_mm/
├── 📦 Бот (Python)
│   ├── config.py             ← Все настройки
│   ├── models.py             ← Структуры данных
│   ├── strategy_engine.py    ← 🧠 Мозг — расчёт цен со спредом
│   ├── risk_manager.py       ← 💰 Казначей — контроль позиции
│   ├── data_collector.py     ← 👁 Глаза — парсинг стакана
│   ├── execution_module.py   ← ✋ Руки — управление ордерами
│   ├── bot.py                ← 🔄 Оркестратор — главный цикл
│   ├── run.py                ← 🚀 Запуск бота
│   └── tests.py              ← ✅ Тесты (8/8 пройдены)
│
└── 📊 Dashboard (Next.js)
    ├── page.tsx              ← Главный экран
    ├── api/bot/              ← API для данных бота
    │   ├── status/           ← Статус бота
    │   ├── trades/           ← История сделок
    │   ├── positions/        ← Текущие позиции
    │   ├── markets/          ← Рынки
    │   └── seed/             ← Демо-данные
    └── prisma/schema.prisma  ← Схема БД
```

## Быстрый старт

### Бот (Python)
```bash
# Тесты
python -m polymarket_mm.tests

# Dry-run (без биржи)
python -m polymarket_mm.run

# Реальная торговля
export POLY_PRIVATE_KEY=0x...
export POLY_TOKEN_ID_YES=...
python -m polymarket_mm.run
```

### Dashboard (Next.js)
```bash
# Установить зависимости
bun install

# Заполнить демо-данными
curl -X POST http://localhost:3000/api/bot/seed

# Открыть http://localhost:3000
```

## Версии

| Версия | Описание |
|--------|----------|
| v1.0.0 | 🚀 Каркас бота (4 модуля, тесты) |
| v1.1.0 | 📊 Dashboard с позициями, сделками, PnL |
