import { NextResponse } from "next/server";
import { getBtcPrice } from "@/lib/btc-feed";
import {
  runTradingCycle, getStatus, getMarkets, getPositions,
  getTrades, getQuotes, getPnl, getConfig, updateConfig,
  startEngine, stopEngine, resetEngine, isRunning,
} from "@/lib/mm-engine";

// Note: trading cycle is now driven by the daemon loop inside mm-engine,
// NOT by this API endpoint. This API only serves data.
// The daemon runs every config.cycleIntervalMs (default 10s) independently.

export async function GET(req: Request) {
  const url = new URL(req.url);
  const type = url.searchParams.get("type") || "status";

  const btc = await getBtcPrice();

  switch (type) {
    case "status":
      return NextResponse.json(getStatus(btc));
    case "markets":
      return NextResponse.json(getMarkets(btc));
    case "positions":
      return NextResponse.json(getPositions());
    case "trades": {
      const limit = parseInt(url.searchParams.get("limit") || "50");
      return NextResponse.json(getTrades(limit));
    }
    case "quotes":
      return NextResponse.json(getQuotes());
    case "pnl": {
      const limit = parseInt(url.searchParams.get("limit") || "100");
      return NextResponse.json(getPnl(limit));
    }
    case "config":
      return NextResponse.json(getConfig());
    case "btc":
      return NextResponse.json(btc);
    case "all": {
      return NextResponse.json({
        status: getStatus(btc),
        markets: getMarkets(btc),
        positions: getPositions(),
        trades: getTrades(10),
        quotes: getQuotes(),
        pnl: getPnl(50),
        btc,
      });
    }
    default:
      return NextResponse.json({ error: "Unknown type" }, { status: 400 });
  }
}

export async function POST(req: Request) {
  const body = await req.json();
  const { action, ...updates } = body;

  switch (action) {
    case "start":
      startEngine();
      return NextResponse.json({ ok: true, message: "Engine started (daemon mode)" });
    case "stop":
      stopEngine();
      return NextResponse.json({ ok: true, message: "Engine stopped" });
    case "reset":
      resetEngine();
      return NextResponse.json({ ok: true, message: "Engine reset" });
    case "config":
      updateConfig(updates);
      return NextResponse.json({ ok: true, config: getConfig() });
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}
