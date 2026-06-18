import { NextResponse } from 'next/server';
import { startEngine, getStatus } from '@/lib/mm-engine';
import { getBtcPrice } from '@/lib/btc-feed';

export async function POST() {
  try {
    startEngine();
    const btc = await getBtcPrice();
    const status = getStatus(btc);
    return NextResponse.json({ success: true, message: 'Bot started (paper trading)', status });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
