#!/usr/bin/env bun
/**
 * Load collected historical JSON files from data/historical/*.json into the SQLite
 * database via Prisma. This makes the data queryable from the Next.js API.
 *
 * Usage:
 *   bun run scripts/load-history-to-db.ts              # load all
 *   bun run scripts/load-history-to-db.ts --market=btc-150k-2026
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DATA_DIR = join(import.meta.dir, '..', 'data', 'historical');

interface Candle {
  t: number;
  ts: string;
  yesPrice: number;
  noPrice: number;
  spread: number;
}
interface MarketData {
  marketId: string;
  question: string;
  slug: string;
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  endDate: string;
  interval: string;
  collectedAt: string;
  rangeStart: string;
  rangeEnd: string;
  points: number;
  candles: Candle[];
}

function parseArgs() {
  const m = process.argv.slice(2).find(a => a.startsWith('--market='))?.replace('--market=', '');
  return { marketFilter: m || null };
}

async function loadOne(filePath: string) {
  const raw = readFileSync(filePath, 'utf-8');
  const data: MarketData = JSON.parse(raw);
  console.log(`📦  Loading ${data.marketId} (${data.points} candles)...`);

  // Upsert market
  const prices = data.candles.map(c => c.yesPrice);
  const spreads = data.candles.map(c => c.spread);
  await prisma.historicalMarket.upsert({
    where: { slug: data.slug },
    create: {
      id: data.marketId,
      question: data.question,
      slug: data.slug,
      conditionId: data.conditionId,
      yesTokenId: data.yesTokenId,
      noTokenId: data.noTokenId,
      endDate: new Date(data.endDate),
      intervalMin: parseInt(data.interval, 10) || 15,
      rangeStart: new Date(data.rangeStart),
      rangeEnd: new Date(data.rangeEnd),
      points: data.points,
      yesMin: prices.length ? Math.min(...prices) : 0,
      yesMax: prices.length ? Math.max(...prices) : 0,
      yesLast: prices.length ? prices[prices.length - 1] : 0,
      avgSpread: spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : 0,
      collectedAt: new Date(data.collectedAt),
    },
    update: {
      question: data.question,
      conditionId: data.conditionId,
      yesTokenId: data.yesTokenId,
      noTokenId: data.noTokenId,
      endDate: new Date(data.endDate),
      rangeStart: new Date(data.rangeStart),
      rangeEnd: new Date(data.rangeEnd),
      points: data.points,
      yesMin: prices.length ? Math.min(...prices) : 0,
      yesMax: prices.length ? Math.max(...prices) : 0,
      yesLast: prices.length ? prices[prices.length - 1] : 0,
      avgSpread: spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : 0,
      collectedAt: new Date(data.collectedAt),
    },
  });

  // Bulk insert candles (delete old first to keep idempotent)
  await prisma.historicalCandle.deleteMany({ where: { marketId: data.marketId } });

  // SQLite has parameter limits; insert in batches of 500
  const BATCH = 500;
  for (let i = 0; i < data.candles.length; i += BATCH) {
    const batch = data.candles.slice(i, i + BATCH);
    await prisma.historicalCandle.createMany({
      data: batch.map(c => ({
        marketId: data.marketId,
        ts: new Date(c.ts),
        unix: c.t,
        yesPrice: c.yesPrice,
        noPrice: c.noPrice,
        spread: c.spread,
      })),
    });
    process.stdout.write(`\r    inserted ${Math.min(i + BATCH, data.candles.length)}/${data.points}   `);
  }
  console.log('');
  console.log(`    ✅ ${data.marketId} done`);
}

async function main() {
  const { marketFilter } = parseArgs();
  const files = readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .filter(f => !marketFilter || f.includes(marketFilter))
    .map(f => join(DATA_DIR, f));

  console.log(`Found ${files.length} market JSON file(s) to load`);
  for (const f of files) {
    await loadOne(f);
  }
  console.log('\n✨ All markets loaded into database');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
