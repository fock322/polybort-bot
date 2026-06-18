import { NextResponse } from 'next/server';
import { startEngine, stopEngine, resetEngine, getStatus, getMarkets, getPositions } from '@/lib/mm-engine';
import { getBtcPrice } from '@/lib/btc-feed';

/**
 * GET /api/bot/status — get current bot status (running, balance, positions, trades)
 * POST /api/bot/status with { action: "start" | "stop" | "reset" } — control the bot
 */
export async function GET() {
  try {
    const btc = await getBtcPrice();
    const status = getStatus(btc);
    const markets = getMarkets(btc);
    const positions = getPositions();
    return NextResponse.json({
      ...status,
      markets: markets.slice(0, 5),  // top 5 markets
      positions: positions.slice(0, 10),  // top 10 positions
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = body.action;

    if (action === 'start') {
      startEngine();
      const btc = await getBtcPrice();
      const status = getStatus(btc);
      return NextResponse.json({ success: true, message: 'Bot started', status });
    }

    if (action === 'stop') {
      stopEngine();
      const btc = await getBtcPrice();
      const status = getStatus(btc);
      return NextResponse.json({ success: true, message: 'Bot stopped', status });
    }

    if (action === 'reset') {
      resetEngine();
      const btc = await getBtcPrice();
      const status = getStatus(btc);
      return NextResponse.json({ success: true, message: 'Bot reset', status });
    }

    return NextResponse.json({ error: 'Unknown action. Use start, stop, or reset.' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
