import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

/**
 * GET /api/bot/historical
 *   ?market=btc-150k-2026     → single market with candles
 *   ?summary=1                → only market summaries (no candles)
 *   ?limit=200                → cap candles returned (default 2000)
 *
 * Returns historical price candles collected from Polymarket for backtesting.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const marketId = searchParams.get('market');
  const summaryOnly = searchParams.get('summary') === '1';
  const limit = Math.min(parseInt(searchParams.get('limit') || '2000', 10), 10000);

  try {
    // Summary only: list all markets with stats
    if (summaryOnly || !marketId) {
      const markets = await db.historicalMarket.findMany({
        orderBy: { points: 'desc' },
        select: {
          id: true,
          question: true,
          slug: true,
          conditionId: true,
          yesTokenId: true,
          noTokenId: true,
          endDate: true,
          intervalMin: true,
          rangeStart: true,
          rangeEnd: true,
          points: true,
          yesMin: true,
          yesMax: true,
          yesLast: true,
          avgSpread: true,
          collectedAt: true,
        },
      });
      return NextResponse.json({
        count: markets.length,
        markets,
      });
    }

    // Single market with candles
    const market = await db.historicalMarket.findUnique({
      where: { id: marketId },
      include: {
        candles: {
          orderBy: { ts: 'asc' },
          take: limit,
        },
      },
    });

    if (!market) {
      return NextResponse.json(
        { error: `Market "${marketId}" not found` },
        { status: 404 },
      );
    }

    return NextResponse.json({
      market: {
        id: market.id,
        question: market.question,
        slug: market.slug,
        conditionId: market.conditionId,
        yesTokenId: market.yesTokenId,
        noTokenId: market.noTokenId,
        endDate: market.endDate,
        intervalMin: market.intervalMin,
        rangeStart: market.rangeStart,
        rangeEnd: market.rangeEnd,
        points: market.points,
        yesMin: market.yesMin,
        yesMax: market.yesMax,
        yesLast: market.yesLast,
        avgSpread: market.avgSpread,
        collectedAt: market.collectedAt,
      },
      candles: market.candles.map(c => ({
        t: c.unix,
        ts: c.ts,
        yes: c.yesPrice,
        no: c.noPrice,
        spread: c.spread,
      })),
      candleCount: market.candles.length,
    });
  } catch (e: any) {
    console.error('historical API error:', e);
    return NextResponse.json(
      { error: 'Internal server error', detail: e.message },
      { status: 500 },
    );
  }
}
