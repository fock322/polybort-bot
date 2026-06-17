#!/usr/bin/env bun
/**
 * Collect BTC market historical data from Polymarket CLOB API
 *
 * Strategy:
 *  - Polymarket prices-history endpoint has a ~1500 point limit per request
 *  - For 15-min interval (fidelity=15) over 30 days = 2880 points (exceeds limit)
 *  - Solution: chunk requests into 10-day windows (960 points each), then merge
 *
 * Output:
 *  - data/historical/<slug>-15m.csv  (tabular, for backtesting)
 *  - data/historical/<slug>-15m.json (structured, for dashboard)
 *  - data/historical/_summary.json   (market metadata + collection stats)
 *
 * Usage:
 *   bun run scripts/collect-btc-history.ts              # default: 30 days, all markets
 *   bun run scripts/collect-btc-history.ts --days=60    # custom range
 *   bun run scripts/collect-btc-history.ts --market=150k  # specific market
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// ============================================================================
// CONFIGURATION
// ============================================================================

interface MarketConfig {
  id: string;          // short id for filename
  question: string;
  slug: string;
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  endDate: string;
}

// Active BTC markets on Polymarket (June 2026), sorted by volume
const BTC_MARKETS: MarketConfig[] = [
  {
    id: 'btc-150k-2026',
    question: 'Will Bitcoin reach $150,000 by December 31, 2026?',
    slug: 'will-bitcoin-reach-150000-by-december-31-2026-557-246-971',
    conditionId: '0x0a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef',
    yesTokenId: '9408196828451163378822245032645030045707991112669125056198742225498158094445',
    noTokenId:  '51483905306465811734319720696244063650497726569976526242005911027664652328096',
    endDate: '2027-01-01T05:00:00Z',
  },
  {
    id: 'btc-dip-47500-june',
    question: 'Will Bitcoin dip to $47,500 in June?',
    slug: 'will-bitcoin-dip-to-47pt5k-in-june-2026-352-889',
    conditionId: '0x1111111111111111111111111111111111111111111111111111111111111111',
    yesTokenId: '66688570202680980348054371425878724386180439159820402142886790910165609540845',
    noTokenId:  '38888545447178587736651600562005787233364986863136821825137462499182092188458',
    endDate: '2026-07-01T04:00:00Z',
  },
  {
    id: 'china-unban-btc-2027',
    question: 'Will China unban Bitcoin by 2027?',
    slug: 'will-china-unban-bitcoin-by-2027',
    conditionId: '0x2222222222222222222222222222222222222222222222222222222222222222',
    yesTokenId: '91810646921497227084241579668235102205462718984593674693010693975258849328842',
    noTokenId:  '51080463689161030375818291005097816690283354390568417705958874093502264623871',
    endDate: '2026-12-31T00:00:00Z',
  },
];

const FIDELITY_MIN = 15;          // 15-minute candles
const CHUNK_DAYS = 10;            // safe chunk size (960 pts per chunk, under 1500 limit)
const POLYMARKET_CLOB = 'https://clob.polymarket.com';
const OUTPUT_DIR = join(import.meta.dir, '..', 'data', 'historical');

// ============================================================================
// TYPES
// ============================================================================

interface PricePoint { t: number; p: number; }
interface PriceHistory { history: PricePoint[]; }

interface MarketData {
  marketId: string;
  question: string;
  slug: string;
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  endDate: string;
  interval: string;            // '15m'
  collectedAt: string;         // ISO
  rangeStart: string;          // ISO
  rangeEnd: string;            // ISO
  points: number;
  candles: Candle[];           // merged + sorted
}

interface Candle {
  t: number;            // unix seconds
  ts: string;           // ISO 8601
  yesPrice: number;     // YES token mid-price (0..1)
  noPrice: number;      // NO token mid-price (0..1)
  spread: number;       // |yes + no - 1| (deviation from no-arb)
}

// ============================================================================
// HTTP FETCH WITH RETRY
// ============================================================================

async function fetchJson(url: string, retries = 3): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'polybort-collector/1.0 (+https://github.com/fock322/polybort-bot)' },
      });
      if (res.status === 429) {
        const wait = 2000 * attempt;
        console.warn(`  ⚠️  429 rate limit, waiting ${wait}ms (attempt ${attempt}/${retries})`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      }
      return await res.json();
    } catch (e: any) {
      if (attempt === retries) throw e;
      const wait = 1000 * attempt;
      console.warn(`  ⚠️  fetch error: ${e.message}, retrying in ${wait}ms (${attempt}/${retries})`);
      await sleep(wait);
    }
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================================
// CHUNKED HISTORICAL DATA FETCHER
// ============================================================================

/**
 * Fetch price history for a single token, splitting the range into chunks
 * to avoid Polymarket's ~1500 point per-request limit.
 *
 * fidelity is in MINUTES (Polymarket API quirk), so 15 = 15-min candles.
 */
async function fetchTokenHistory(
  tokenId: string,
  startTs: number,
  endTs: number,
  fidelityMin: number,
): Promise<PricePoint[]> {
  const chunkSec = CHUNK_DAYS * 86400;
  const all: PricePoint[] = [];
  let chunkStart = startTs;

  while (chunkStart < endTs) {
    const chunkEnd = Math.min(chunkStart + chunkSec, endTs);
    const url = `${POLYMARKET_CLOB}/prices-history?market=${tokenId}&startTs=${chunkStart}&endTs=${chunkEnd}&fidelity=${fidelityMin}`;
    process.stdout.write(`    chunk ${new Date(chunkStart * 1000).toISOString().slice(0,16)} → ${new Date(chunkEnd * 1000).toISOString().slice(0,16)} ... `);
    try {
      const data: PriceHistory = await fetchJson(url);
      const pts = data.history || [];
      all.push(...pts);
      console.log(`${pts.length} pts`);
    } catch (e: any) {
      console.log(`FAIL: ${e.message}`);
      throw e;
    }
    chunkStart = chunkEnd;
    await sleep(300); // be polite
  }

  // dedupe by timestamp (chunks may overlap on boundary)
  const seen = new Map<number, number>();
  for (const pt of all) {
    if (!seen.has(pt.t)) seen.set(pt.t, pt.p);
  }
  return Array.from(seen.entries())
    .map(([t, p]) => ({ t, p }))
    .sort((a, b) => a.t - b.t);
}

// ============================================================================
// MERGE YES + NO INTO CANDLES
// ============================================================================

/**
 * Merge YES and NO price histories into unified candles.
 * Polymarket returns YES/NO prices that should sum to ~1.0 (no-arb).
 * We align by timestamp (YES is authoritative; NO is matched by nearest ts).
 */
function mergeYesNo(yesPts: PricePoint[], noPts: PricePoint[]): Candle[] {
  const noMap = new Map<number, number>();
  for (const pt of noPts) noMap.set(pt.t, pt.p);

  const candles: Candle[] = [];
  for (const y of yesPts) {
    const n = noMap.get(y.t);
    const noP = n !== undefined ? n : (1 - y.p); // fallback: derive NO from YES
    candles.push({
      t: y.t,
      ts: new Date(y.t * 1000).toISOString(),
      yesPrice: y.p,
      noPrice: noP,
      spread: Math.abs(y.p + noP - 1),
    });
  }
  return candles;
}

// ============================================================================
// COLLECT ONE MARKET
// ============================================================================

async function collectMarket(
  market: MarketConfig,
  days: number,
): Promise<MarketData> {
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - days * 86400;

  console.log(`\n📊  ${market.question}`);
  console.log(`    slug: ${market.slug}`);
  console.log(`    range: ${new Date(startTs * 1000).toISOString()} → ${new Date(endTs * 1000).toISOString()}`);
  console.log(`    interval: ${FIDELITY_MIN}min  chunks: ${Math.ceil(days / CHUNK_DAYS)} × ${CHUNK_DAYS}d`);

  console.log(`    → fetching YES token (${market.yesTokenId.slice(0,12)}...)`);
  const yesPts = await fetchTokenHistory(market.yesTokenId, startTs, endTs, FIDELITY_MIN);

  console.log(`    → fetching NO token (${market.noTokenId.slice(0,12)}...)`);
  const noPts = await fetchTokenHistory(market.noTokenId, startTs, endTs, FIDELITY_MIN);

  const candles = mergeYesNo(yesPts, noPts);
  console.log(`    ✅ merged: ${candles.length} candles (YES: ${yesPts.length}, NO: ${noPts.length})`);

  if (candles.length > 0) {
    const prices = candles.map(c => c.yesPrice);
    console.log(`    price range: min=${Math.min(...prices).toFixed(4)}  max=${Math.max(...prices).toFixed(4)}  last=${prices[prices.length-1].toFixed(4)}`);
  }

  return {
    marketId: market.id,
    question: market.question,
    slug: market.slug,
    conditionId: market.conditionId,
    yesTokenId: market.yesTokenId,
    noTokenId: market.noTokenId,
    endDate: market.endDate,
    interval: `${FIDELITY_MIN}m`,
    collectedAt: new Date().toISOString(),
    rangeStart: new Date(startTs * 1000).toISOString(),
    rangeEnd: new Date(endTs * 1000).toISOString(),
    points: candles.length,
    candles,
  };
}

// ============================================================================
// OUTPUT: CSV + JSON
// ============================================================================

function writeCsv(market: MarketData, outDir: string): string {
  const path = join(outDir, `${market.marketId}-15m.csv`);
  const header = 'timestamp,unix,year,month,day,hour,minute,weekday,yes_price,no_price,spread\n';
  const rows = market.candles.map(c => {
    const d = new Date(c.t * 1000);
    const wd = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
    return [
      c.ts,
      c.t,
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      wd,
      c.yesPrice.toFixed(6),
      c.noPrice.toFixed(6),
      c.spread.toFixed(6),
    ].join(',');
  }).join('\n');
  writeFileSync(path, header + rows + '\n', 'utf-8');
  return path;
}

function writeJson(market: MarketData, outDir: string): string {
  const path = join(outDir, `${market.marketId}-15m.json`);
  writeFileSync(path, JSON.stringify(market, null, 2), 'utf-8');
  return path;
}

function writeSummary(markets: MarketData[], outDir: string): string {
  const path = join(outDir, '_summary.json');
  const summary = {
    generatedAt: new Date().toISOString(),
    source: 'Polymarket CLOB API (prices-history)',
    interval: `${FIDELITY_MIN} minutes`,
    markets: markets.map(m => ({
      marketId: m.marketId,
      question: m.question,
      slug: m.slug,
      yesTokenId: m.yesTokenId,
      noTokenId: m.noTokenId,
      rangeStart: m.rangeStart,
      rangeEnd: m.rangeEnd,
      points: m.points,
      files: {
        csv: `${m.marketId}-15m.csv`,
        json: `${m.marketId}-15m.json`,
      },
      stats: m.points > 0 ? {
        yesMin: Math.min(...m.candles.map(c => c.yesPrice)),
        yesMax: Math.max(...m.candles.map(c => c.yesPrice)),
        yesLast: m.candles[m.candles.length - 1].yesPrice,
        avgSpread: m.candles.reduce((s, c) => s + c.spread, 0) / m.points,
      } : null,
    })),
  };
  writeFileSync(path, JSON.stringify(summary, null, 2), 'utf-8');
  return path;
}

// ============================================================================
// CLI ARG PARSER
// ============================================================================

function parseArgs(): { days: number; marketFilter: string | null } {
  const args = process.argv.slice(2);
  let days = 30;
  let marketFilter: string | null = null;
  for (const arg of args) {
    const m = arg.match(/^--days=(\d+)$/);
    if (m) days = parseInt(m[1], 10);
    const mk = arg.match(/^--market=(.+)$/);
    if (mk) marketFilter = mk[1];
  }
  return { days, marketFilter };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const { days, marketFilter } = parseArgs();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Polymarket BTC History Collector`);
  console.log(`  Range: last ${days} days  |  Interval: ${FIDELITY_MIN}min  |  Chunk: ${CHUNK_DAYS}d`);
  console.log('═══════════════════════════════════════════════════════════════');

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const markets = marketFilter
    ? BTC_MARKETS.filter(m => m.id.includes(marketFilter) || m.slug.includes(marketFilter))
    : BTC_MARKETS;

  if (markets.length === 0) {
    console.error(`No markets match filter "${marketFilter}"`);
    process.exit(1);
  }

  console.log(`\nMarkets to collect (${markets.length}):`);
  markets.forEach((m, i) => console.log(`  ${i+1}. ${m.question}`));

  const collected: MarketData[] = [];
  for (const market of markets) {
    try {
      const data = await collectMarket(market, days);
      collected.push(data);
    } catch (e: any) {
      console.error(`\n❌ Failed to collect ${market.id}: ${e.message}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Writing files...');
  console.log('═══════════════════════════════════════════════════════════════');

  for (const m of collected) {
    const csvPath = writeCsv(m, OUTPUT_DIR);
    const jsonPath = writeJson(m, OUTPUT_DIR);
    console.log(`  ✅ ${m.marketId}`);
    console.log(`     ${csvPath}  (${m.points} rows)`);
    console.log(`     ${jsonPath}`);
  }

  if (collected.length > 0) {
    const summaryPath = writeSummary(collected, OUTPUT_DIR);
    console.log(`  📋 ${summaryPath}`);
  }

  console.log('\n✨ Done. Total candles collected:');
  collected.forEach(m => console.log(`   ${m.marketId.padEnd(28)} ${String(m.points).padStart(6)} points`));
  console.log(`   ${'TOTAL'.padEnd(28)} ${String(collected.reduce((s, m) => s + m.points, 0)).padStart(6)} points`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
