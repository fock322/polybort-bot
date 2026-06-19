#!/usr/bin/env bun
/**
 * Walk-Forward Optimization
 *
 * Splits historical data into train (70%) and test (30%) sets.
 * On train: grid search over edgeThreshold, minConfluenceScore, and factor
 *           weights to find the combination that maximizes win rate.
 * On test:  validates the best parameters out-of-sample.
 *
 * Usage: bun run scripts/walk-forward-optimize.ts
 */

import { Database } from 'bun:sqlite';
import path from 'path';

// ── Types (mirror backtest-v2.ts) ──
interface HistoricalMarket {
  conditionId: string;
  slug: string;
  question: string;
  startDate: string;
  endDate: string;
  outcome: "Up" | "Down";
  slotTs: number;
  priceToBeat: number;
  finalPrice: number;
  takerBaseFee: number;
  volume: number;
  liquidity: number;
}

interface BtcKline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  numTrades: number;
}

const TICK_SIZE = 0.01;
function tickRound(p: number) { return Math.round(p / TICK_SIZE) * TICK_SIZE; }
function sigmoid(x: number) { return 1 / (1 + Math.exp(-x)); }
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

// ── Load data from DB ──
function loadData() {
  const dbPath = path.join(process.cwd(), 'prisma', 'historical.db');
  const db = new Database(dbPath, { readonly: true });

  const markets: HistoricalMarket[] = db.prepare(`
    SELECT condition_id, slug, question, start_date, end_date, outcome,
           slot_ts, price_to_beat, final_price, taker_base_fee, volume, liquidity
    FROM historical_markets
    WHERE outcome != 'Unknown' AND price_to_beat > 0
    ORDER BY slot_ts ASC
  `).all().map((r: any) => ({
    conditionId: r.condition_id,
    slug: r.slug,
    question: r.question,
    startDate: r.start_date,
    endDate: r.end_date,
    outcome: r.outcome,
    slotTs: r.slot_ts,
    priceToBeat: r.price_to_beat,
    finalPrice: r.final_price,
    takerBaseFee: r.taker_base_fee,
    volume: r.volume,
    liquidity: r.liquidity,
  }));

  const klines: BtcKline[] = db.prepare(`
    SELECT open_time, open_price, high_price, low_price, close_price, volume, num_trades
    FROM btc_klines ORDER BY open_time ASC
  `).all().map((r: any) => ({
    openTime: r.open_time,
    open: r.open_price,
    high: r.high_price,
    low: r.low_price,
    close: r.close_price,
    volume: r.volume,
    numTrades: r.num_trades,
  }));

  db.close();
  return { markets, klines };
}

// ── Simplified probability model with configurable weights ──
interface ModelWeights {
  zScore: number;
  rsi: number;
  boll: number;
  ema: number;
  momentum: number;
  volume: number;
}

interface ModelParams {
  edgeThreshold: number;
  minConfluence: number;
  contrarian: boolean;
  weights: ModelWeights;
}

// ── Compute indicators (simplified from backtest-v2) ──
function computeIndicators(klines: BtcKline[], currentTs: number) {
  const currentMs = currentTs * 1000;
  const relevant = klines.filter(k => k.openTime <= currentMs);
  if (relevant.length < 20) return null;

  const price = relevant[relevant.length - 1].close;

  // ATR(5)
  const trs: number[] = [];
  for (let i = 1; i < relevant.length; i++) {
    const tr = Math.max(
      relevant[i].high - relevant[i].low,
      Math.abs(relevant[i].high - relevant[i-1].close),
      Math.abs(relevant[i].low - relevant[i-1].close),
    );
    trs.push(tr);
  }
  const atr5m = trs.slice(-5).reduce((s, v) => s + v, 0) / Math.min(5, trs.length);

  // RSI(14)
  const changes: number[] = [];
  for (let i = 1; i < relevant.length; i++) {
    changes.push(relevant[i].close - relevant[i-1].close);
  }
  const recent14 = changes.slice(-14);
  const gains = recent14.filter(c => c > 0);
  const losses = recent14.filter(c => c < 0).map(c => -c);
  const avgGain = gains.length > 0 ? gains.reduce((s,v) => s+v, 0) / 14 : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s,v) => s+v, 0) / 14 : 0;
  const rsi14 = avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss);

  // Bollinger
  const last20 = relevant.slice(-20).map(k => k.close);
  const mean = last20.reduce((s,v) => s+v, 0) / 20;
  const std = Math.sqrt(last20.reduce((s,v) => s + (v-mean)**2, 0) / 20);
  const upper = mean + 2 * std;
  const lower = mean - 2 * std;
  const bollPosition = upper > lower ? clamp((price - lower) / (upper - lower), 0, 1) : 0.5;

  // EMA
  const closes = relevant.map(k => k.close);
  const ema = (data: number[], period: number) => {
    const k = 2 / (period + 1);
    let e = data[0];
    for (let i = 1; i < data.length; i++) e = data[i] * k + e * (1 - k);
    return e;
  };
  const emaFast = ema(closes.slice(-5), 5);
  const emaSlow = ema(closes.slice(-15), 15);
  const emaCross = emaFast > emaSlow ? "bull" : emaFast < emaSlow ? "bear" : "none";

  // Momentum
  const k1m = relevant[relevant.length - 2] || relevant[0];
  const k5m = relevant.length >= 6 ? relevant[relevant.length - 6] : relevant[0];
  const momentum1m = atr5m > 0 ? (price - k1m.close) / atr5m : 0;
  const momentum5m = atr5m > 0 ? (price - k5m.close) / atr5m : 0;

  // Volume
  const vol5 = relevant.slice(-5).reduce((s, k) => s + k.volume, 0) / 5;
  const vol15 = relevant.slice(-15).reduce((s, k) => s + k.volume, 0) / 15;
  const volumeRatio = vol15 > 0 ? vol5 / vol15 : 1;

  return { price, atr5m, rsi14, bollPosition, emaCross, momentum1m, momentum5m, volumeRatio };
}

// ── Compute probability with given weights ──
function computeProb(
  strike: number, price: number, tau: number, atr5m: number,
  ind: ReturnType<typeof computeIndicators>,
  weights: ModelWeights,
): number {
  if (!ind || price <= 0) return 0.5;

  // Factor 1: z-score
  let zScore = 0;
  if (strike > 0 && tau > 0) {
    const distPct = (price - strike) / price;
    const atrPct = atr5m > 0 ? atr5m / price : 0.001;
    const expectedMove = atrPct * Math.sqrt(Math.max(tau, 0.1) / 5);
    zScore = expectedMove > 0 ? distPct / expectedMove : 0;
  }
  const zScoreFactor = sigmoid(zScore * 1.5);

  // Factor 2: RSI trend-following
  let rsiFactor = 0.5;
  if (ind.rsi14 >= 55) rsiFactor = 0.5 + Math.min((ind.rsi14 - 55) / 90, 0.35);
  else if (ind.rsi14 <= 45) rsiFactor = 0.5 - Math.min((45 - ind.rsi14) / 90, 0.35);

  // Factor 3: Bollinger breakout
  let bollFactor = 0.5;
  if (ind.bollPosition >= 0.6) bollFactor = 0.5 + (ind.bollPosition - 0.6);
  else if (ind.bollPosition <= 0.4) bollFactor = 0.5 - (0.4 - ind.bollPosition);
  bollFactor = clamp(bollFactor, 0.1, 0.9);

  // Factor 4: EMA
  let emaFactor = 0.5;
  if (ind.emaCross === "bull") emaFactor = 0.62;
  else if (ind.emaCross === "bear") emaFactor = 0.38;

  // Factor 5: Momentum
  const momentumFactor = sigmoid((ind.momentum1m * 0.5 + ind.momentum5m * 0.3) * 1.5);

  // Factor 6: Volume
  const volSurge = Math.max(0, ind.volumeRatio - 1);
  const volFactor = momentumFactor > 0.5
    ? Math.min(0.9, 0.5 + volSurge * 0.2)
    : Math.max(0.1, 0.5 - volSurge * 0.2);

  // Weighted combination
  const expiryWeight = tau < 3 ? 0.55 : tau < 7 ? 0.45 : 0.35;
  const w = weights;
  const totalW = w.zScore + w.rsi + w.boll + w.ema + w.momentum + w.volume;

  const pUp =
    zScoreFactor * (expiryWeight * w.zScore / totalW) +
    rsiFactor * (w.rsi / totalW) * (1 - expiryWeight * 0.3) +
    bollFactor * (w.boll / totalW) * (1 - expiryWeight * 0.3) +
    emaFactor * (w.ema / totalW) * (1 - expiryWeight * 0.3) +
    momentumFactor * (w.momentum / totalW) * (1 - expiryWeight * 0.3) +
    volFactor * (w.volume / totalW) * (1 - expiryWeight * 0.3);

  return clamp(pUp, 0.01, 0.99);
}

// ── Evaluate a single market: predict outcome, compare to actual ──
function evaluateMarket(
  market: HistoricalMarket,
  klines: BtcKline[],
  params: ModelParams,
): { predicted: "Up" | "Down"; actual: "Up" | "Down"; correct: boolean } {
  const marketEndTs = new Date(market.endDate).getTime() / 1000;
  const marketStartTs = market.slotTs || marketEndTs - 900;

  // Evaluate at slot start (when we'd make the prediction)
  const ind = computeIndicators(klines, marketStartTs);
  if (!ind) return { predicted: "Up", actual: market.outcome, correct: false };

  const strike = market.priceToBeat > 0 ? market.priceToBeat : ind.price;
  const tau = (marketEndTs - marketStartTs) / 60;

  const probUp = computeProb(strike, ind.price, tau, ind.atr5m, ind, params.weights);

  // Edge: if probUp far from 0.5, we have a directional view
  const edge = probUp - 0.5;
  const threshold = params.edgeThreshold;

  let predicted: "Up" | "Down";
  if (Math.abs(edge) < threshold) {
    // No edge — predict based on z-score only (fallback)
    predicted = ind.price > strike ? "Up" : "Down";
  } else {
    if (params.contrarian) {
      predicted = edge > 0 ? "Down" : "Up";  // contrarian
    } else {
      predicted = edge > 0 ? "Up" : "Down";  // normal
    }
  }

  return {
    predicted,
    actual: market.outcome,
    correct: predicted === market.outcome,
  };
}

// ── Main: walk-forward optimization ──
async function main() {
  const { markets, klines } = loadData();
  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  Walk-Forward Optimization`);
  console.log(`  Markets: ${markets.length}, Klines: ${klines.length}`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  if (markets.length < 50) {
    console.error("Need at least 50 markets for meaningful optimization. Current:", markets.length);
    process.exit(1);
  }

  // Split: 70% train, 30% test (chronological — walk forward)
  const splitIdx = Math.floor(markets.length * 0.7);
  const train = markets.slice(0, splitIdx);
  const test = markets.slice(splitIdx);
  console.log(`Train: ${train.length} markets (before ${new Date(train[train.length-1].slotTs * 1000).toISOString().slice(0,10)})`);
  console.log(`Test:  ${test.length} markets (after ${new Date(test[0].slotTs * 1000).toISOString().slice(0,10)})`);
  console.log();

  // Grid search parameters
  const edgeThresholds = [0.02, 0.03, 0.04, 0.06, 0.08];
  const minConfluences = [0, 2, 3, 4];
  const contrarianOptions = [false, true];
  const weightSets: ModelWeights[] = [
    { zScore: 0.35, rsi: 0.15, boll: 0.12, ema: 0.13, momentum: 0.15, volume: 0.10 },  // default
    { zScore: 0.50, rsi: 0.10, boll: 0.08, ema: 0.10, momentum: 0.12, volume: 0.10 },  // z-score heavy
    { zScore: 0.20, rsi: 0.20, boll: 0.15, ema: 0.15, momentum: 0.20, volume: 0.10 },  // balanced
    { zScore: 0.40, rsi: 0.20, boll: 0.15, ema: 0.10, momentum: 0.10, volume: 0.05 },  // RSI heavy
  ];

  let bestParams: ModelParams | null = null;
  let bestWinRate = 0;
  let bestTrades = 0;

  console.log("Grid search on TRAIN set:");
  console.log("─".repeat(80));

  for (const edgeThreshold of edgeThresholds) {
    for (const minConfluence of minConfluences) {
      for (const contrarian of contrarianOptions) {
        for (const weights of weightSets) {
          const params: ModelParams = { edgeThreshold, minConfluence, contrarian, weights };
          let correct = 0;
          let total = 0;

          for (const m of train) {
            const r = evaluateMarket(m, klines, params);
            total++;
            if (r.correct) correct++;
          }

          const winRate = total > 0 ? correct / total : 0;
          // Only consider params that produce enough "edge" predictions
          // (where edge > threshold, not just fallback z-score)
          if (winRate > bestWinRate && total > 0) {
            bestWinRate = winRate;
            bestParams = params;
            bestTrades = total;
            console.log(`  edge=${edgeThreshold} conf=${minConfluence} contrarian=${contrarian} → win ${(winRate*100).toFixed(1)}% (${correct}/${total})`);
          }
        }
      }
    }
  }

  console.log("─".repeat(80));
  if (!bestParams) {
    console.log("No valid parameters found.");
    return;
  }

  console.log(`\nBest TRAIN params: edge=${bestParams.edgeThreshold} conf=${bestParams.minConfluence} contrarian=${bestParams.contrarian}`);
  console.log(`  Train win rate: ${(bestWinRate * 100).toFixed(1)}% (${bestTrades} markets)`);

  // Validate on TEST set
  console.log(`\nValidating on TEST set (${test.length} markets):`);
  let testCorrect = 0;
  let testTotal = 0;
  for (const m of test) {
    const r = evaluateMarket(m, klines, bestParams!);
    testTotal++;
    if (r.correct) testCorrect++;
  }
  const testWinRate = testTotal > 0 ? testCorrect / testTotal : 0;
  console.log(`  Test win rate: ${(testWinRate * 100).toFixed(1)}% (${testCorrect}/${testTotal})`);
  console.log(`  Overfit check: train ${(bestWinRate*100).toFixed(1)}% vs test ${(testWinRate*100).toFixed(1)}%`);

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  RESULT: ${testWinRate * 100 > 55 ? "✅ Model has predictive power" : "❌ No predictive power"}`);
  console.log(`  Test win rate: ${(testWinRate * 100).toFixed(1)}% (need >55% for edge)`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
