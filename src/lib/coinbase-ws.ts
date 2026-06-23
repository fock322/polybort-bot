// ─── Coinbase WebSocket Price Feed ─────────────────────────
// Real-time tick data from Coinbase Exchange WebSocket API.
// Provides instant price updates + buy/sell flow for BTC, ETH, SOL.
//
// IMPORTANT: Each asset (BTC, ETH, SOL) gets its OWN independent data stream.
// The WebSocket subscribes to 3 separate product_ids (BTC-USD, ETH-USD, SOL-USD)
// and routes each tick to the correct asset buffer. ETH markets use ETH flow,
// SOL markets use SOL flow, BTC markets use BTC flow — never mixed.
//
// Benefits over REST polling (every 3s):
// - Sub-100ms latency (vs 3000ms)
// - Real buy/sell flow (taker aggression, not just close prices)
// - No rate limit (1 connection vs 120 requests/min)
// - Accurate momentum: count of buy vs sell volume in real-time
//
// WebSocket: wss://ws-feed.exchange.coinbase.com
// Channels: "ticker" (price + side per trade), "level2" (best bid/ask)

export interface WsTick {
  price: number;
  size: number;
  side: "buy" | "sell";     // TAKER side (buy = taker bought = bullish)
  time: number;               // epoch ms
}

export interface WsAssetData {
  price: number;
  bestBid: number;
  bestAsk: number;
  // Rolling 60-second buy/sell flow (TAKER aggression)
  buyVolume: number;          // total taker-buy USD volume in last 60s
  sellVolume: number;         // total taker-sell USD volume in last 60s
  tickCount: number;          // total ticks in last 60s
  buyTickCount: number;       // taker-buy ticks in last 60s
  sellTickCount: number;      // taker-sell ticks in last 60s
  lastUpdate: number;
  connected: boolean;
}

export interface WsStatus {
  connected: boolean;
  assets: Record<string, {
    price: number;
    bestBid: number;
    bestAsk: number;
    tickCount: number;
    buyTickCount: number;
    sellTickCount: number;
    buyVolume: number;
    sellVolume: number;
    flowRatio: number;          // -1..+1 (tick-based)
    volumeFlowRatio: number;    // -1..+1 (USD-weighted)
    lastUpdate: number;
    connected: boolean;
  }>;
}

// ─── State ─────────────────────────────────────────────────
const assetData: Map<string, WsAssetData> = new Map();
const tickBuffer: Map<string, WsTick[]> = new Map();  // rolling 60s buffer
let ws: WebSocket | null = null;
let wsConnected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let lastMessageAt = 0;

const SUPPORTED_ASSETS = ["BTC", "ETH", "SOL"];
const COINBASE_WS_URL = "wss://ws-feed.exchange.coinbase.com";
const BUFFER_WINDOW_MS = 60_000;  // 60 seconds rolling window
const CLEANUP_INTERVAL_MS = 5_000;  // cleanup old ticks every 5s
const STALE_THRESHOLD_MS = 15_000;  // if no msg for 15s, consider reconnecting

function defaultAssetData(): WsAssetData {
  return {
    price: 0, bestBid: 0, bestAsk: 0,
    buyVolume: 0, sellVolume: 0,
    tickCount: 0, buyTickCount: 0, sellTickCount: 0,
    lastUpdate: 0, connected: false,
  };
}

// ─── Initialize WebSocket connection ──────────────────────
export function initCoinbaseWs(): void {
  if (ws) return;  // already initialized

  for (const asset of SUPPORTED_ASSETS) {
    assetData.set(asset, defaultAssetData());
    tickBuffer.set(asset, []);
  }

  connectWs();

  // Cleanup old ticks every 5 seconds (keeps 60s rolling window accurate)
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [asset, ticks] of tickBuffer) {
      let buyVol = 0, sellVol = 0, buyTicks = 0, sellTicks = 0;
      // Remove ticks older than 60s AND recompute rolling aggregates
      const fresh: WsTick[] = [];
      for (const t of ticks) {
        if (now - t.time > BUFFER_WINDOW_MS) continue;
        fresh.push(t);
        const usd = t.price * t.size;
        if (t.side === "buy") { buyVol += usd; buyTicks++; }
        else { sellVol += usd; sellTicks++; }
      }
      tickBuffer.set(asset, fresh);

      const data = assetData.get(asset);
      if (data) {
        data.buyVolume = buyVol;
        data.sellVolume = sellVol;
        data.buyTickCount = buyTicks;
        data.sellTickCount = sellTicks;
        data.tickCount = buyTicks + sellTicks;
      }
    }

    // Watchdog: if no messages for STALE_THRESHOLD, force reconnect
    if (wsConnected && now - lastMessageAt > STALE_THRESHOLD_MS) {
      console.warn(`[Coinbase WS] No messages for ${Math.round((now - lastMessageAt) / 1000)}s — forcing reconnect`);
      try { ws?.close(); } catch { /* ignore */ }
      // onclose will trigger reconnect
    }
  }, CLEANUP_INTERVAL_MS);
}

function connectWs(): void {
  try {
    console.log("[Coinbase WS] Connecting to", COINBASE_WS_URL);
    ws = new WebSocket(COINBASE_WS_URL);

    ws.onopen = () => {
      console.log("[Coinbase WS] ✅ Connected — subscribing to BTC-USD, ETH-USD, SOL-USD tickers + level2");
      wsConnected = true;
      lastMessageAt = Date.now();

      // Subscribe to ticker channel for all assets (price + taker side per trade)
      const subscribeMsg = {
        type: "subscribe",
        product_ids: SUPPORTED_ASSETS.map(a => `${a}-USD`),
        channels: ["ticker"],
      };
      ws?.send(JSON.stringify(subscribeMsg));

      // Also subscribe to level2 (order book) for real-time best bid/ask
      const level2Msg = {
        type: "subscribe",
        product_ids: SUPPORTED_ASSETS.map(a => `${a}-USD`),
        channels: ["level2"],
      };
      ws?.send(JSON.stringify(level2Msg));

      // Mark all assets as connected
      for (const asset of SUPPORTED_ASSETS) {
        const data = assetData.get(asset);
        if (data) data.connected = true;
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(event.data as string);
        handleMessage(msg);
      } catch {
        // Non-JSON message, ignore
      }
    };

    ws.onerror = (event: Event) => {
      console.error("[Coinbase WS] Error:", event);
      wsConnected = false;
    };

    ws.onclose = () => {
      console.warn("[Coinbase WS] Disconnected — will reconnect in 3s");
      wsConnected = false;
      for (const asset of SUPPORTED_ASSETS) {
        const data = assetData.get(asset);
        if (data) data.connected = false;
      }
      ws = null;
      // Reconnect after 3s
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => connectWs(), 3000);
    };
  } catch (e) {
    console.error("[Coinbase WS] Failed to connect:", e);
    // Retry after 5s
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connectWs(), 5000);
  }
}

// ─── Handle incoming WebSocket messages ───────────────────
// CRITICAL FIX (2026-06-23): Coinbase `ticker.side` = MAKER side, NOT taker.
//   side="sell" → maker had a resting ASK → taker BOUGHT it → BULLISH (taker buy)
//   side="buy"  → maker had a resting BID → taker SOLD into it → BEARISH (taker sell)
// Previously the code treated msg.side as taker side → flow was INVERTED.
function handleMessage(msg: any): void {
  if (!msg || !msg.type) return;

  // Ticker message: real-time trade
  if (msg.type === "ticker" && msg.product_id && msg.price) {
    const asset = msg.product_id.replace("-USD", "");
    if (!SUPPORTED_ASSETS.includes(asset)) return;

    const price = parseFloat(msg.price);
    const size = parseFloat(msg.last_size || "0");
    const makerSide = msg.side as "buy" | "sell";
    // Convert maker side → taker action (inverted)
    const takerSide: "buy" | "sell" = makerSide === "sell" ? "buy" : "sell";
    const time = msg.time ? new Date(msg.time).getTime() : Date.now();

    if (price <= 0 || isNaN(price)) return;

    // Add to rolling tick buffer
    const ticks = tickBuffer.get(asset) || [];
    ticks.push({ price, size, side: takerSide, time });
    tickBuffer.set(asset, ticks);

    // Update asset data
    const data = assetData.get(asset) || defaultAssetData();
    data.price = price;
    data.lastUpdate = time;
    data.connected = true;

    // Update rolling buy/sell flow (aggregates are recomputed in cleanup timer,
    // but we also increment here for immediate availability)
    const usdVolume = price * size;
    if (takerSide === "buy") {
      data.buyVolume += usdVolume;
      data.buyTickCount++;
    } else {
      data.sellVolume += usdVolume;
      data.sellTickCount++;
    }
    data.tickCount = data.buyTickCount + data.sellTickCount;

    // Update best bid/ask from ticker (if available)
    if (msg.best_bid) data.bestBid = parseFloat(msg.best_bid);
    if (msg.best_ask) data.bestAsk = parseFloat(msg.best_ask);

    assetData.set(asset, data);
  }

  // Level2 snapshot — initial order book
  if (msg.type === "snapshot" && msg.product_id) {
    const asset = msg.product_id.replace("-USD", "");
    if (!SUPPORTED_ASSETS.includes(asset)) return;
    const data = assetData.get(asset) || defaultAssetData();
    if (msg.bids && msg.bids.length > 0) data.bestBid = parseFloat(msg.bids[0][0]);
    if (msg.asks && msg.asks.length > 0) data.bestAsk = parseFloat(msg.asks[0][0]);
    assetData.set(asset, data);
  }

  // Level2 update — order book changes
  if (msg.type === "l2update" && msg.product_id) {
    const asset = msg.product_id.replace("-USD", "");
    if (!SUPPORTED_ASSETS.includes(asset)) return;
    const data = assetData.get(asset) || defaultAssetData();
    if (msg.changes && msg.changes.length > 0) {
      for (const change of msg.changes) {
        const side = change[0];  // "buy" (bids) or "sell" (asks)
        const price = parseFloat(change[1]);
        const size = parseFloat(change[2] || "0");
        if (side === "buy" && price > 0) {
          // Best bid update: only if size > 0 (size 0 = level removed)
          if (size > 0 && (data.bestBid === 0 || price >= data.bestBid)) data.bestBid = price;
        }
        if (side === "sell" && price > 0) {
          if (size > 0 && (data.bestAsk === 0 || price <= data.bestAsk)) data.bestAsk = price;
        }
      }
    }
    assetData.set(asset, data);
  }
}

// ─── Public API ───────────────────────────────────────────

// Get real-time asset data from WebSocket (per-asset, never mixed)
export function getWsAssetData(asset: string): WsAssetData | null {
  return assetData.get(asset.toUpperCase()) || null;
}

// Get current price (instant, no HTTP request) — asset-specific
export function getWsPrice(asset: string): number {
  const data = assetData.get(asset.toUpperCase());
  return data?.price || 0;
}

// Get best bid/ask from WebSocket order book — asset-specific
export function getWsBestBidAsk(asset: string): { bid: number; ask: number; spread: number } {
  const data = assetData.get(asset.toUpperCase());
  const bid = data?.bestBid || 0;
  const ask = data?.bestAsk || 0;
  return { bid, ask, spread: bid > 0 && ask > 0 ? ask - bid : 0 };
}

// Get buy/sell flow ratio (-1 to +1) — TICK-based, asset-specific
// +1 = 100% taker-buys (very bullish), -1 = 100% taker-sells (very bearish), 0 = balanced
export function getWsFlowRatio(asset: string): number {
  const data = assetData.get(asset.toUpperCase());
  if (!data || data.tickCount === 0) return 0;
  const buyRatio = data.buyTickCount / data.tickCount;
  return (buyRatio - 0.5) * 2;  // -1 to +1
}

// Get volume-weighted buy/sell ratio (-1 to +1) — USD-weighted, asset-specific
// More meaningful than tick ratio (big orders matter more than many small ones)
export function getWsVolumeFlowRatio(asset: string): number {
  const data = assetData.get(asset.toUpperCase());
  if (!data || (data.buyVolume + data.sellVolume) === 0) return 0;
  const buyVolRatio = data.buyVolume / (data.buyVolume + data.sellVolume);
  return (buyVolRatio - 0.5) * 2;  // -1 to +1
}

// Get 1-minute price change (from tick buffer) — asset-specific
// Returns FRACTIONAL change (e.g. 0.003 = 0.3%). Caller multiplies by 100 for %.
export function getWsChange1m(asset: string): number {
  const ticks = tickBuffer.get(asset.toUpperCase());
  if (!ticks || ticks.length < 2) return 0;
  const now = Date.now();
  // Find tick ~60s ago
  let oldTick: WsTick | null = null;
  for (const t of ticks) {
    if (now - t.time >= 55_000) {  // within 55-60s ago
      oldTick = t;
      break;
    }
  }
  if (!oldTick) {
    // Use first tick if no 60s old tick
    oldTick = ticks[0];
  }
  const currentPrice = ticks[ticks.length - 1].price;
  if (oldTick.price <= 0) return 0;
  return (currentPrice - oldTick.price) / oldTick.price;
}

// Get tick count in last 60s (for confidence weighting) — asset-specific
export function getWsTickCount(asset: string): number {
  const data = assetData.get(asset.toUpperCase());
  return data?.tickCount || 0;
}

// Is WebSocket connected?
export function isWsConnected(): boolean {
  return wsConnected;
}

// Full status report for monitoring/dashboards
export function getWsStatus(): WsStatus {
  const assets: WsStatus["assets"] = {};
  for (const asset of SUPPORTED_ASSETS) {
    const data = assetData.get(asset) || defaultAssetData();
    const totalVol = data.buyVolume + data.sellVolume;
    assets[asset] = {
      price: data.price,
      bestBid: data.bestBid,
      bestAsk: data.bestAsk,
      tickCount: data.tickCount,
      buyTickCount: data.buyTickCount,
      sellTickCount: data.sellTickCount,
      buyVolume: data.buyVolume,
      sellVolume: data.sellVolume,
      flowRatio: data.tickCount > 0 ? (data.buyTickCount / data.tickCount - 0.5) * 2 : 0,
      volumeFlowRatio: totalVol > 0 ? (data.buyVolume / totalVol - 0.5) * 2 : 0,
      lastUpdate: data.lastUpdate,
      connected: data.connected,
    };
  }
  return { connected: wsConnected, assets };
}

// Cleanup
export function closeCoinbaseWs(): void {
  if (ws) {
    ws.close();
    ws = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  wsConnected = false;
}
