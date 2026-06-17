// ─── Backtest API Route ───────────────────────────────────────
// GET  /api/backtest?type=results   — Get last backtest results
// GET  /api/backtest?type=data      — Get historical data summary
// POST /api/backtest                 — Run backtest with config

import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import {
  runBacktest,
  DEFAULT_BACKTEST_CONFIG,
  type BacktestConfig,
  type BacktestResult,
  type HistoricalMarket,
  type HistoricalTrade,
  type BtcKline,
} from "@/lib/backtest-v2";

// Cache last result in memory
let lastResult: BacktestResult | null = null;

function getDb(): Database.Database {
  const dbPath = path.join(process.cwd(), "prisma", "historical.db");
  return new Database(dbPath, { readonly: true });
}

function loadMarkets(db: Database.Database, daysBack?: number): HistoricalMarket[] {
  let query: string;
  if (daysBack) {
    query = `
      SELECT condition_id, slug, question, start_date, end_date,
             up_token_id, down_token_id, outcome, outcome_prices,
             volume, liquidity, taker_base_fee, maker_base_fee, neg_risk, slot_ts
      FROM historical_markets
      WHERE outcome != 'Unknown'
        AND end_date >= datetime('now', '-${daysBack} days')
      ORDER BY end_date ASC
    `;
  } else {
    query = `
      SELECT condition_id, slug, question, start_date, end_date,
             up_token_id, down_token_id, outcome, outcome_prices,
             volume, liquidity, taker_base_fee, maker_base_fee, neg_risk, slot_ts
      FROM historical_markets
      WHERE outcome != 'Unknown'
      ORDER BY end_date ASC
    `;
  }

  const rows = db.prepare(query).all() as Array<Record<string, unknown>>;
  return rows.map((r) => {
    let outcomePrices = [0.5, 0.5];
    try {
      const parsed = JSON.parse(r.outcome_prices as string);
      if (Array.isArray(parsed)) outcomePrices = parsed.map(Number);
    } catch { /* defaults */ }

    return {
      conditionId: r.condition_id as string,
      slug: r.slug as string,
      question: r.question as string,
      startDate: r.start_date as string,
      endDate: r.end_date as string,
      upTokenId: r.up_token_id as string,
      downTokenId: r.down_token_id as string,
      outcome: r.outcome as "Up" | "Down",
      outcomePrices,
      volume: r.volume as number,
      liquidity: r.liquidity as number,
      takerBaseFee: r.taker_base_fee as number,
      makerBaseFee: r.maker_base_fee as number,
      negRisk: Boolean(r.neg_risk),
      slotTs: r.slot_ts as number,
    };
  });
}

function loadTrades(db: Database.Database): Map<string, HistoricalTrade[]> {
  const rows = db.prepare(`
    SELECT condition_id, side, outcome, outcome_index, size, price, timestamp
    FROM historical_trades
    ORDER BY timestamp ASC
  `).all() as Array<Record<string, unknown>>;

  const map = new Map<string, HistoricalTrade[]>();
  for (const r of rows) {
    const condId = r.condition_id as string;
    if (!map.has(condId)) map.set(condId, []);
    map.get(condId)!.push({
      conditionId: condId,
      side: r.side as "BUY" | "SELL",
      outcome: r.outcome as "Up" | "Down",
      outcomeIndex: r.outcome_index as number,
      size: r.size as number,
      price: r.price as number,
      timestamp: r.timestamp as number,
    });
  }
  return map;
}

function loadKlines(db: Database.Database): BtcKline[] {
  const rows = db.prepare(`
    SELECT open_time, open_price, high_price, low_price, close_price, volume, num_trades
    FROM btc_klines
    ORDER BY open_time ASC
  `).all() as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    openTime: r.open_time as number,
    open: r.open_price as number,
    high: r.high_price as number,
    low: r.low_price as number,
    close: r.close_price as number,
    volume: r.volume as number,
    numTrades: r.num_trades as number,
  }));
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const type = url.searchParams.get("type") || "results";

  if (type === "results") {
    if (!lastResult) {
      return NextResponse.json({ error: "No backtest results yet. Run a backtest first." }, { status: 404 });
    }
    return NextResponse.json(lastResult);
  }

  if (type === "data") {
    try {
      const db = getDb();
      const markets = loadMarkets(db);
      const trades = loadTrades(db);
      const klines = loadKlines(db);
      db.close();

      return NextResponse.json({
        markets: markets.length,
        trades: [...trades.values()].reduce((s, t) => s + t.length, 0),
        klines: klines.length,
        dateRange: markets.length > 0 ? {
          start: markets[0].startDate,
          end: markets[markets.length - 1].endDate,
        } : null,
        outcomeDistribution: {
          up: markets.filter(m => m.outcome === "Up").length,
          down: markets.filter(m => m.outcome === "Down").length,
        },
      });
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Unknown type" }, { status: 400 });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const config: BacktestConfig = {
      ...DEFAULT_BACKTEST_CONFIG,
      ...(body.config || {}),
    };
    const daysBack = body.daysBack || undefined;

    const db = getDb();
    const markets = loadMarkets(db, daysBack);
    const trades = loadTrades(db);
    const klines = loadKlines(db);
    db.close();

    if (markets.length === 0) {
      return NextResponse.json({ error: "No historical data available. Run data collection first." }, { status: 400 });
    }

    console.log(`[Backtest] Running with ${markets.length} markets, ${[...trades.values()].reduce((s, t) => s + t.length, 0)} trades, ${klines.length} klines`);

    const result = runBacktest(markets, trades, klines, config);
    lastResult = result;

    console.log(`[Backtest] Complete: PnL=$${result.totalPnl.toFixed(2)}, trades=${result.totalTrades}, winRate=${(result.winRate * 100).toFixed(1)}%, sharpe=${result.sharpeRatio.toFixed(2)}`);

    return NextResponse.json(result);
  } catch (e) {
    console.error("[Backtest] Error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
