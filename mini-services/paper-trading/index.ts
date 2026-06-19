#!/usr/bin/env bun
/**
 * Paper Trading Mini-Service
 * ==========================
 * Standalone Bun HTTP server for running the MM bot in paper mode.
 * Independent of Next.js — no hot reload crashes.
 *
 * Port: 3002
 * Auto-restart: bun --hot (restarts on file changes)
 *
 * API:
 *   GET  /              — bot status (running, balance, positions, trades, PnL)
 *   POST /start         — start paper trading
 *   POST /stop          — stop bot
 *   POST /reset         — reset state
 *   GET  /markets       — active markets
 *   GET  /positions     — open positions
 *   GET  /health        — service health check
 *
 * Usage:
 *   bun --hot mini-services/paper-trading/index.ts
 */

import { startEngine, stopEngine, resetEngine, getStatus, getMarkets, getPositions } from "../../src/lib/mm-engine";
import { getBtcPrice } from "../../src/lib/btc-feed";

const PORT = 3002;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // GET / — full bot status
      if (path === "/" && method === "GET") {
        const btc = await getBtcPrice();
        const status = getStatus(btc);
        const markets = getMarkets(btc);
        const positions = getPositions();
        return Response.json({
          ...status,
          markets: markets.slice(0, 5),
          positions: positions.slice(0, 10),
        }, { headers: corsHeaders });
      }

      // POST /start
      if (path === "/start" && method === "POST") {
        startEngine();
        const btc = await getBtcPrice();
        const status = getStatus(btc);
        console.log(`[Bot] Started — balance=$${status.balance} btc=$${btc.price?.toFixed(2)}`);
        return Response.json({ success: true, message: "Paper trading started", status }, { headers: corsHeaders });
      }

      // POST /stop
      if (path === "/stop" && method === "POST") {
        stopEngine();
        console.log("[Bot] Stopped");
        return Response.json({ success: true, message: "Bot stopped" }, { headers: corsHeaders });
      }

      // POST /reset
      if (path === "/reset" && method === "POST") {
        resetEngine();
        console.log("[Bot] Reset");
        return Response.json({ success: true, message: "Bot reset" }, { headers: corsHeaders });
      }

      // GET /markets
      if (path === "/markets" && method === "GET") {
        const btc = await getBtcPrice();
        const markets = getMarkets(btc);
        return Response.json({ markets }, { headers: corsHeaders });
      }

      // GET /positions
      if (path === "/positions" && method === "GET") {
        const positions = getPositions();
        return Response.json({ positions }, { headers: corsHeaders });
      }

      // GET /health
      if (path === "/health" && method === "GET") {
        return Response.json({
          status: "ok",
          service: "paper-trading",
          port: PORT,
          uptime: process.uptime(),
        }, { headers: corsHeaders });
      }

      return Response.json({ error: "Not found", path }, { status: 404, headers: corsHeaders });
    } catch (e: any) {
      console.error("[Service] Error:", e.message);
      return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
    }
  },
});

console.log(`═══════════════════════════════════════════════════════════════`);
console.log(`  Paper Trading Mini-Service — Port ${PORT}`);
console.log(`  bun --hot (auto-restart on file changes)`);
console.log(`═══════════════════════════════════════════════════════════════`);
console.log(`  GET  /          — bot status`);
console.log(`  POST /start     — start trading`);
console.log(`  POST /stop      — stop trading`);
console.log(`  POST /reset     — reset state`);
console.log(`  GET  /health    — health check`);
console.log(`═══════════════════════════════════════════════════════════════`);

// Auto-start bot after 2 seconds (lets server fully initialize)
setTimeout(async () => {
  try {
    console.log("[Auto-start] Starting paper trading engine...");
    startEngine();
    const btc = await getBtcPrice();
    const status = getStatus(btc);
    console.log(`[Auto-start] ✅ Running — balance=$${status.balance} btc=$${btc.price?.toFixed(2) || "?"}`);
  } catch (e: any) {
    console.error("[Auto-start] Failed:", e.message);
  }
}, 2000);
