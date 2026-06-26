#!/usr/bin/env bun
/**
 * Paper Trading Mini-Service — HOLD-TP strategy
 * Standalone Bun HTTP server — independent of Next.js
 * Port: 3005
 *
 * Strategy: TP 8% maker, dynamic SL by tau (85%/60%/30%/taker<2min), no emergency 25%.
 * Position $5, max 1 одновременно (capital lock mitigation).
 * State is isolated from other services via separate process.
 */

import { startEngine, stopEngine, resetEngine, getStatus, getMarkets, getPositions, getTrades, getAnalytics, getTradeAnalysis, setStrategy } from "../../src/lib/mm-engine";
import { getBtcPrice } from "../../src/lib/btc-feed";
import { initCoinbaseWs, getWsStatus } from "../../src/lib/coinbase-ws";

// Set strategy to HOLD-TP before any engine operations
setStrategy("hold-tp");

const PORT = 3005;

// ── Start Coinbase WebSocket on boot (real-time BTC/ETH/SOL price + flow) ──
// Each asset gets its OWN independent data stream (BTC-USD, ETH-USD, SOL-USD).
initCoinbaseWs();
console.log(`[paper-trading-hold-tp:${PORT}] Coinbase WebSocket initialized (BTC-USD, ETH-USD, SOL-USD)`);

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

    if (method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    try {
      if (path === "/" && method === "GET") {
        const btc = await getBtcPrice();
        const status = getStatus(btc);
        const markets = await getMarkets(btc);
        const positions = getPositions();
        return Response.json({ ...status, markets: markets.slice(0, 5), positions: positions.slice(0, 10) }, { headers: corsHeaders });
      }

      if (path === "/dashboard" && method === "GET") {
        return new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders } });
      }

      if (path === "/start" && method === "POST") {
        startEngine();
        const btc = await getBtcPrice();
        const status = getStatus(btc);
        return Response.json({ success: true, message: "Hold-TP bot started", status }, { headers: corsHeaders });
      }

      if (path === "/stop" && method === "POST") {
        stopEngine();
        return Response.json({ success: true, message: "Bot stopped" }, { headers: corsHeaders });
      }

      if (path === "/reset" && method === "POST") {
        resetEngine();
        setStrategy("hold-tp");  // re-set after reset
        return Response.json({ success: true, message: "Bot reset" }, { headers: corsHeaders });
      }

      if (path === "/markets" && method === "GET") {
        const btc = await getBtcPrice();
        return Response.json({ markets: await getMarkets(btc) }, { headers: corsHeaders });
      }

      if (path === "/positions" && method === "GET") {
        return Response.json({ positions: getPositions() }, { headers: corsHeaders });
      }

      if (path === "/trades" && method === "GET") {
        return Response.json({ trades: getTrades(20) }, { headers: corsHeaders });
      }

      if (path === "/analytics" && method === "GET") {
        return Response.json(getAnalytics(), { headers: corsHeaders });
      }

      if (path === "/trade-analysis" && method === "GET") {
        return Response.json(getTradeAnalysis(), { headers: corsHeaders });
      }

      if (path === "/health" && method === "GET") {
        return Response.json({ status: "ok", service: "paper-trading-hold-tp", port: PORT, strategy: "hold-tp", uptime: process.uptime() }, { headers: corsHeaders });
      }

      if (path === "/debug-state" && method === "GET") {
        const g = globalThis as any;
        return Response.json({
          __mm_cash: g.__mm_cash,
          __mm_realizedPnl: g.__mm_realizedPnl,
          __mm_running: g.__mm_running,
          __mm_trades_length: g.__mm_trades?.length,
          __mm_totalWins: g.__mm_totalWins,
          __mm_totalLosses: g.__mm_totalLosses,
          __mm_totalWinAmount: g.__mm_totalWinAmount,
          __mm_totalLossAmount: g.__mm_totalLossAmount,
          __mm_positions_size: g.__mm_positions?.size,
        }, { headers: corsHeaders });
      }

      if (path === "/ws-status" && method === "GET") {
        return Response.json(getWsStatus(), { headers: corsHeaders });
      }

      return Response.json({ error: "Not found", path }, { status: 404, headers: corsHeaders });
    } catch (e: any) {
      console.error("[HoldTP Service] Error:", e.message);
      return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
    }
  },
});

console.log(`═══════════════════════════════════════════════════════════════`);
console.log(`  Paper Trading Mini-Service — HOLD-TP strategy — Port ${PORT}`);
console.log(`  Dashboard: http://localhost:${PORT}/dashboard`);
console.log(`  Strategy: trend-following + trailing TP (no ceiling)`);
console.log(`═══════════════════════════════════════════════════════════════`);

// Auto-start engine on launch
startEngine();

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Polymarket MM Bot — HOLD-TP</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f1117; color: #e4e4e7; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 20px; min-height: 100vh; }
  .container { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 24px; margin-bottom: 5px; }
  .subtitle { color: #f59e0b; font-size: 14px; margin-bottom: 20px; }
  .status-bar { display: flex; align-items: center; gap: 10px; padding: 12px; background: #1a1d27; border-radius: 8px; margin-bottom: 20px; border: 1px solid #2a2d37; }
  .status-dot { width: 12px; height: 12px; border-radius: 50%; }
  .status-dot.running { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
  .status-dot.stopped { background: #ef4444; }
  .status-text { font-weight: 600; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; margin-bottom: 20px; }
  .card { background: #1a1d27; border-radius: 12px; padding: 20px; border: 1px solid #2a2d37; }
  .card-label { font-size: 12px; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
  .card-value { font-size: 28px; font-weight: 700; }
  .card-value.green { color: #22c55e; }
  .card-value.red { color: #ef4444; }
  .card-value.neutral { color: #e4e4e7; }
  .card-sub { font-size: 12px; color: #71717a; margin-top: 4px; }
  .section { background: #1a1d27; border-radius: 12px; padding: 20px; margin-bottom: 15px; border: 1px solid #2a2d37; }
  .section-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; color: #f59e0b; }
  .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #2a2d37; font-size: 14px; }
  .row:last-child { border-bottom: none; }
  .row-label { color: #71717a; }
  .row-value { font-weight: 600; }
  .empty { color: #52525b; font-style: italic; text-align: center; padding: 20px; }
  .refresh-info { text-align: center; color: #52525b; font-size: 12px; margin-top: 15px; }
  .controls { display: flex; gap: 10px; justify-content: center; margin-bottom: 20px; }
  .btn { padding: 10px 24px; border-radius: 8px; border: none; font-size: 14px; font-weight: 600; cursor: pointer; }
  .btn-start { background: #22c55e; color: #0f1117; }
  .btn-stop { background: #ef4444; color: #0f1117; }
  .btn-reset { background: #3f3f46; color: #e4e4e7; }
  .pnl-positive { color: #22c55e; }
  .pnl-negative { color: #ef4444; }
  .strategy-badge { display: inline-block; background: #f59e0b; color: #0f1117; padding: 4px 12px; border-radius: 4px; font-size: 12px; font-weight: 700; margin-left: 10px; }
  @media (max-width:600px) { .cards { grid-template-columns:1fr; } }
</style>
</head>
<body>
<div class="container">
  <h1>🚀 Polymarket MM Bot — HOLD-TP <span class="strategy-badge">HOLD TO TAKE-PROFIT</span></h1>
  <p class="subtitle">TP 8% maker • Динамический SL по tau (85/60/30%) • Держим до TP или settlement</p>
  <div class="status-bar"><div class="status-dot" id="statusDot"></div><span class="status-text" id="statusText">Загрузка...</span></div>
  <div class="controls">
    <button class="btn btn-start" onclick="sendCommand('start')">▶ Старт</button>
    <button class="btn btn-stop" onclick="sendCommand('stop')">⏸ Стоп</button>
    <button class="btn btn-reset" onclick="sendCommand('reset')">🔄 Сброс</button>
  </div>
  <div class="cards">
    <div class="card"><div class="card-label">💰 Баланс</div><div class="card-value neutral" id="balance">—</div><div class="card-sub" id="cashSub">—</div></div>
    <div class="card"><div class="card-label">📈 PnL</div><div class="card-value" id="pnl">—</div><div class="card-sub" id="pnlSub">—</div></div>
    <div class="card"><div class="card-label">📊 Сделки</div><div class="card-value neutral" id="trades">—</div><div class="card-sub" id="quotesSub">—</div></div>
    <div class="card"><div class="card-label">₿ BTC цена</div><div class="card-value neutral" id="btc">—</div><div class="card-sub" id="uptimeSub">—</div></div>
  </div>
  <div class="section"><div class="section-title">📋 Открытые позиции</div><div id="positions"><div class="empty">Нет позиций</div></div></div>
  <div class="section"><div class="section-title">🏪 Активные рынки</div><div id="markets"><div class="empty">Нет рынков</div></div></div>
  <div class="section"><div class="section-title">📜 История сделок</div><div id="tradesList"><div class="empty">Нет сделок</div></div></div>
  <div class="section"><div class="section-title">📊 Аналитика</div><div id="analytics"><div class="empty">Загрузка...</div></div></div>
  <div class="refresh-info">Авто-обновление каждые 5 секунд • Hold-TP strategy • Port 3005</div>
</div>
<script>
const API=window.location.origin;
// FIX: detect if we're behind gateway (XTransformPort in query) and use it for all fetches.
// This makes the dashboard work both when accessed directly (localhost:3003) and through gateway.
const urlParams=new URLSearchParams(window.location.search);
const XT_PORT=urlParams.get('XTransformPort');
const API_BASE=XT_PORT?API+'?XTransformPort='+XT_PORT:API;
// helper: build URL with XTransformPort for any path
function api(path){return XT_PORT?API+path+'?XTransformPort='+XT_PORT:API+path;}
async function fetchStatus(){try{const r=await fetch(api('/'));const d=await r.json();updateUI(d);}catch(e){document.getElementById('statusText').textContent='❌ Нет связи';document.getElementById('statusDot').className='status-dot stopped';}}
function updateUI(d){
  const running=d.running;
  document.getElementById('statusDot').className='status-dot '+(running?'running':'stopped');
  document.getElementById('statusText').textContent=running?'🟢 Hold-TP бот работает':'🔴 Бот остановлен';
  document.getElementById('balance').textContent='$'+(d.balance||0).toFixed(2);
  const posVal=d.positionsValue||0;
  document.getElementById('cashSub').innerHTML='Наличные: <strong>$'+(d.cashBalance||0).toFixed(2)+'</strong> | В позициях: <strong style="color:'+(posVal>0?'#22c55e':'#71717a')+'">$'+posVal.toFixed(2)+'</strong>';
  const pnl=d.totalPnl||0;
  const pnlEl=document.getElementById('pnl');
  pnlEl.textContent=(pnl>=0?'+':'')+'$'+pnl.toFixed(2);
  pnlEl.className='card-value '+(pnl>=0?'green':'red');
  document.getElementById('pnlSub').textContent='Реализ: $'+(d.realizedPnl||0).toFixed(2)+' | Нереализ: $'+(d.unrealizedPnl||0).toFixed(2);
  document.getElementById('trades').textContent=d.tradeCount||0;
  document.getElementById('quotesSub').textContent='Котировки: '+(d.quoteCount||0)+' | Позиции: '+(d.positionCount||0);
  document.getElementById('btc').textContent='$'+(d.btcPrice||0).toLocaleString('en-US',{maximumFractionDigits:0});
  const up=(d.uptime||0)/1000;const h=Math.floor(up/3600);const m=Math.floor((up%3600)/60);
  document.getElementById('uptimeSub').textContent='Время работы: '+h+'ч '+m+'м';
  const posEl=document.getElementById('positions');
  if(d.positions&&d.positions.length>0){posEl.innerHTML=d.positions.map(p=>{
    const u=p.unrealizedPnl||0;const c=u>=0?'pnl-positive':'pnl-negative';
    const bid=(p.currentBid||0).toFixed(2);const ask=(p.currentAsk||0).toFixed(2);
    const mid=(p.currentMid||0).toFixed(2);
    const peak=p.peakValue||0;
    return '<div class="row" style="flex-direction:column;align-items:stretch;padding:10px 0;">'+
      '<div style="display:flex;justify-content:space-between;">'+
        '<span class="row-label">'+p.side+' • qty='+p.quantity+' • вход $'+(p.entryPrice||0).toFixed(2)+'</span>'+
        '<span class="row-value '+c+'">'+(u>=0?'+':'')+'$'+u.toFixed(2)+'</span>'+
      '</div>'+
      '<small style="color:#52525b;margin-top:4px;display:block;">bid $'+bid+' ask $'+ask+' mid $'+mid+' | peak=$'+peak.toFixed(2)+' | trailing TP active</small>'+
    '</div>';
  }).join('');}else{posEl.innerHTML='<div class="empty">Нет позиций</div>';}
  const mktEl=document.getElementById('markets');
  if(d.markets&&d.markets.length>0){mktEl.innerHTML=d.markets.map(m=>{
    const q=(m.question||'?').substring(0,50);
    const v=(m.volume||0).toLocaleString('en-US',{maximumFractionDigits:0});
    const b=(m.realUpBestBid||0).toFixed(2);const a=(m.realUpBestAsk||0).toFixed(2);
    const exp=m.expiresAt||0;const now=Date.now();const ml=Math.max(0,(exp-now)/60000);
    const mn=Math.floor(ml);const sc=Math.floor((ml-mn)*60);const ts=mn<1?sc+'s':mn+'m '+sc+'s';
    const tc=ml<3?'#ef4444':ml<5?'#f59e0b':'#71717a';
    const s=m.smartSignal||{};
    let sigHtml='';
    if(s.should){
      const sc2=s.confidence>=80?'#22c55e':s.confidence>=60?'#f59e0b':'#ef4444';
      sigHtml='<div style="margin-top:4px;font-size:12px;color:'+sc2+';">🎯 HOLD-TP ENTER '+s.side+' (conf='+s.confidence+'/100)</div>';
    }else{
      sigHtml='<div style="margin-top:4px;font-size:12px;color:#71717a;">⏸ '+((s.reason||'').substring(0,80))+'</div>';
    }
    return '<div class="row" style="flex-direction:column;align-items:stretch;padding:10px 0;">'+
      '<div style="display:flex;justify-content:space-between;">'+
        '<span class="row-label">'+q+'<br><small style="color:'+tc+'">⏱ '+ts+' • bid '+b+' • ask '+a+'</small></span>'+
        '<span class="row-value">Vol $'+v+'</span>'+
      '</div>'+sigHtml+
    '</div>';
  }).join('');}else{mktEl.innerHTML='<div class="empty">Нет рынков</div>';}
}
async function fetchTrades(){try{const r=await fetch(api('/trades'));const d=await r.json();const t=d.trades||[];const el=document.getElementById('tradesList');if(t.length===0){el.innerHTML='<div class="empty">Нет сделок</div>';return;}el.innerHTML=t.slice(0,15).map(t=>{const s=t.side||'?';const p=(t.price||0).toFixed(2);const q=t.quantity||0;const rs=t.reason||'?';const pnl=t.pnl||0;const ps=pnl!==0?(pnl>0?'+':'')+'$'+pnl.toFixed(4):'—';const pc=pnl>0?'pnl-positive':pnl<0?'pnl-negative':'';const ts=new Date(t.executedAt||0).toLocaleTimeString('ru-RU');const ctx=t.context||{};const slug=ctx.marketSlug||'?';const entry=ctx.entryPrice?(ctx.entryPrice).toFixed(3):'?';const hold=ctx.holdTimeMs?(ctx.holdTimeMs/1000).toFixed(0)+'s':'?';const vol=ctx.marketVolume?'$'+ctx.marketVolume.toFixed(0):'?';const a1m=ctx.btcChange1m?(ctx.btcChange1m*100).toFixed(2)+'%':'?';const a5m=ctx.btcChange5m?(ctx.btcChange5m*100).toFixed(2)+'%':'?';const pnlSym=pnl>0?'🟢':pnl<0?'🔴':'⚪';return '<div class="row" style="flex-direction:column;align-items:stretch;padding:10px 0;">'+'<div style="display:flex;justify-content:space-between;">'+'<span class="row-label">'+pnlSym+' '+ts+' • '+s+' '+q+'@$'+p+' <small>('+rs+')</small></span>'+'<span class="row-value '+pc+'">'+ps+'</span>'+'</div>'+'<small style="color:#71717a;margin-top:3px;display:block;">'+slug.substring(0,40)+' | entry=$'+entry+' hold='+hold+' vol='+vol+' 1m='+a1m+' 5m='+a5m+'</small>'+'</div>';}).join('');}catch(e){}}
async function fetchAnalytics(){try{const r=await fetch(api('/analytics'));const a=await r.json();const el=document.getElementById('analytics');const wr=(a.winRate*100).toFixed(1);const wc=a.winRate>=0.8?'#22c55e':a.winRate>=0.6?'#f59e0b':'#ef4444';const pf=isFinite(a.profitFactor)?a.profitFactor.toFixed(2):'∞';const pfc=a.profitFactor>=1.5?'#22c55e':a.profitFactor>=1.0?'#f59e0b':'#ef4444';const totalTrades=a.totalTrades||0;if(totalTrades===0){el.innerHTML='<div class="empty">Нет закрытых сделок для аналитики</div>';return;}el.innerHTML='<div class="row"><span class="row-label">Win Rate</span><span class="row-value" style="color:'+wc+';font-weight:600;">'+wr+'%</span></div><div class="row"><span class="row-label">Побед / Поражений</span><span class="row-value">🟢 '+a.totalWins+' / 🔴 '+a.totalLosses+'</span></div><div class="row"><span class="row-label">Сумма выигрышей</span><span class="row-value pnl-positive">+$'+(a.totalWinAmount||0).toFixed(4)+'</span></div><div class="row"><span class="row-label">Сумма проигрышей</span><span class="row-value pnl-negative">-$'+(a.totalLossAmount||0).toFixed(4)+'</span></div><div class="row"><span class="row-label">Чистая прибыль</span><span class="row-value '+(a.netProfit>=0?'pnl-positive':'pnl-negative')+'">'+(a.netProfit>=0?'+':'')+'$'+(a.netProfit||0).toFixed(4)+'</span></div><div class="row"><span class="row-label">Profit Factor</span><span class="row-value" style="color:'+pfc+';font-weight:600;">'+pf+'</span></div><div class="row"><span class="row-label">Gas + Fees</span><span class="row-value pnl-negative">-$'+((a.totalGasPaid||0)+(a.totalFeesPaid||0)).toFixed(4)+'</span></div>';}catch(e){}}
async function sendCommand(cmd){try{await fetch(api('/'+cmd),{method:'POST'});setTimeout(fetchStatus,500);}catch(e){alert('Ошибка: '+e.message);}}
// FIX: браузеры троттлят setInterval в фоновых вкладках → дашборд "зависал" со старыми данными.
// При возврате на вкладку (visibilitychange) — мгновенно обновляем все панели.
setInterval(fetchStatus,5000);setInterval(fetchTrades,10000);setInterval(fetchAnalytics,15000);
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible'){console.log('[Dashboard] Tab visible — force refresh');fetchStatus();fetchTrades();fetchAnalytics();}});
// Доп. защита: авто-reload каждые 5 мин (на случай утечки памяти / зависшего state)
setInterval(function(){if(document.visibilityState==='visible'){location.reload();}},300000);
// Первый fetch сразу при загрузке
fetchStatus();fetchTrades();fetchAnalytics();
</script>
</body>
</html>`;
