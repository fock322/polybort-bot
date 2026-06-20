#!/usr/bin/env bun
/**
 * Paper Trading Mini-Service
 * Standalone Bun HTTP server — independent of Next.js
 * Port: 3002
 */

import { startEngine, stopEngine, resetEngine, getStatus, getMarkets, getPositions, getTrades, getAnalytics } from "../../src/lib/mm-engine";
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

    if (method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    try {
      if (path === "/" && method === "GET") {
        const btc = await getBtcPrice();
        const status = getStatus(btc);
        const markets = getMarkets(btc);
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
        return Response.json({ success: true, message: "Paper trading started", status }, { headers: corsHeaders });
      }

      if (path === "/stop" && method === "POST") {
        stopEngine();
        return Response.json({ success: true, message: "Bot stopped" }, { headers: corsHeaders });
      }

      if (path === "/reset" && method === "POST") {
        resetEngine();
        return Response.json({ success: true, message: "Bot reset" }, { headers: corsHeaders });
      }

      if (path === "/markets" && method === "GET") {
        const btc = await getBtcPrice();
        return Response.json({ markets: getMarkets(btc) }, { headers: corsHeaders });
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

      if (path === "/health" && method === "GET") {
        return Response.json({ status: "ok", service: "paper-trading", port: PORT, uptime: process.uptime() }, { headers: corsHeaders });
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
console.log(`  Dashboard: http://localhost:${PORT}/dashboard`);
console.log(`═══════════════════════════════════════════════════════════════`);

setTimeout(async () => {
  try {
    startEngine();
    const btc = await getBtcPrice();
    const status = getStatus(btc);
    console.log(`[Auto-start] ✅ Running — balance=$${status.balance} btc=$${btc.price?.toFixed(2) || "?"}`);
  } catch (e: any) { console.error("[Auto-start] Failed:", e.message); }
}, 2000);

// ── Dashboard HTML ──
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Polymarket MM Bot — Paper Trading</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0f1117; color:#e4e4e7; min-height:100vh; padding:20px; }
  .container { max-width:800px; margin:0 auto; }
  h1 { text-align:center; margin-bottom:5px; font-size:24px; }
  .subtitle { text-align:center; color:#71717a; margin-bottom:25px; font-size:14px; }
  .status-bar { display:flex; align-items:center; justify-content:center; gap:12px; margin-bottom:25px; }
  .status-dot { width:12px; height:12px; border-radius:50%; }
  .status-dot.running { background:#22c55e; box-shadow:0 0 8px #22c55e; }
  .status-dot.stopped { background:#ef4444; box-shadow:0 0 8px #ef4444; }
  .status-text { font-size:16px; font-weight:600; }
  .cards { display:grid; grid-template-columns:repeat(2,1fr); gap:15px; margin-bottom:25px; }
  .card { background:#1a1d27; border-radius:12px; padding:20px; border:1px solid #2a2d37; }
  .card-label { font-size:12px; color:#71717a; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px; }
  .card-value { font-size:28px; font-weight:700; }
  .card-value.green { color:#22c55e; }
  .card-value.red { color:#ef4444; }
  .card-value.neutral { color:#e4e4e7; }
  .card-sub { font-size:12px; color:#71717a; margin-top:4px; }
  .section { background:#1a1d27; border-radius:12px; padding:20px; margin-bottom:15px; border:1px solid #2a2d37; }
  .section-title { font-size:14px; font-weight:600; margin-bottom:12px; color:#a1a1aa; }
  .row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #2a2d37; font-size:14px; }
  .row:last-child { border-bottom:none; }
  .row-label { color:#71717a; }
  .row-value { font-weight:600; }
  .empty { color:#52525b; font-style:italic; text-align:center; padding:20px; }
  .refresh-info { text-align:center; color:#52525b; font-size:12px; margin-top:15px; }
  .controls { display:flex; gap:10px; justify-content:center; margin-bottom:20px; }
  .btn { padding:10px 24px; border-radius:8px; border:none; font-size:14px; font-weight:600; cursor:pointer; }
  .btn-start { background:#22c55e; color:#0f1117; }
  .btn-stop { background:#ef4444; color:#0f1117; }
  .btn-reset { background:#3f3f46; color:#e4e4e7; }
  .pnl-positive { color:#22c55e; }
  .pnl-negative { color:#ef4444; }
  @media (max-width:600px) { .cards { grid-template-columns:1fr; } }
</style>
</head>
<body>
<div class="container">
  <h1>🤖 Polymarket MM Bot</h1>
  <p class="subtitle">Paper Trading Dashboard</p>
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
  <div class="refresh-info">Авто-обновление каждые 5 секунд</div>
</div>
<script>
const API=window.location.origin;
async function fetchStatus(){try{const r=await fetch(API+'/');const d=await r.json();updateUI(d);}catch(e){document.getElementById('statusText').textContent='❌ Нет связи';document.getElementById('statusDot').className='status-dot stopped';}}
function updateUI(d){
  const running=d.running;
  document.getElementById('statusDot').className='status-dot '+(running?'running':'stopped');
  document.getElementById('statusText').textContent=running?'🟢 Бот работает':'🔴 Бот остановлен';
  document.getElementById('balance').textContent='$'+(d.balance||0).toFixed(2);
  // BUG FIX (2026-06-20): positionsValue was missing from API → showed $0.00 always
  // Now backend returns positionsValue (sum of currentValue across open positions)
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
    const mid=(p.currentMid||0).toFixed(2);const sp=(p.spread||0).toFixed(2);
    const tp=(p.tpThreshold||0).toFixed(4);const cp=(p.closePrice||0).toFixed(2);
    const midPnl=(p.midPnlPct||0).toFixed(1);const bidPnl=(p.bidPnlPct||0).toFixed(1);
    const ready=p.tpReady?' ✅ TP READY':' ❌ TP wait';
    const expired=p.marketExpired?' ⚠️ MARKET EXPIRED':'';
    const tte=p.timeToExpiryMin?(p.timeToExpiryMin<3?' ⏰ '+p.timeToExpiryMin.toFixed(1)+'m':''):'';
    const spc=sp>=0.04?'#ef4444':sp>=0.02?'#f59e0b':'#71717a';
    return '<div class="row" style="flex-direction:column;align-items:stretch;padding:10px 0;">'+
      '<div style="display:flex;justify-content:space-between;">'+
        '<span class="row-label">'+p.side+' • qty='+p.quantity+' • вход $'+(p.entryPrice||0).toFixed(2)+expired+tte+'</span>'+
        '<span class="row-value '+c+'">'+(u>=0?'+':'')+'$'+u.toFixed(2)+'</span>'+
      '</div>'+
      '<small style="color:#52525b;margin-top:4px;display:block;">'+
        'bid $'+bid+' • ask $'+ask+' • mid $'+mid+' • spread <span style="color:'+spc+'">'+sp+'¢</span> | '+
        'TP>$'+tp+' • close@'+cp+' | midPnL '+midPnl+'% • bidPnL '+bidPnl+'%'+ready+
      '</small>'+
    '</div>';
  }).join('');}else{posEl.innerHTML='<div class="empty">Нет позиций</div>';}
  const mktEl=document.getElementById('markets');
  if(d.markets&&d.markets.length>0){mktEl.innerHTML=d.markets.map(m=>{
    const q=(m.question||'?').substring(0,50);
    const v=(m.volume||0).toLocaleString('en-US',{maximumFractionDigits:0});
    const b=(m.realUpBestBid||0).toFixed(2);
    const a=(m.realUpBestAsk||0).toFixed(2);
    const exp=m.expiresAt||0;
    const now=Date.now();
    const ml=Math.max(0,(exp-now)/60000);
    const mn=Math.floor(ml);
    const sc=Math.floor((ml-mn)*60);
    const ts=mn<1?sc+'s':mn+'m '+sc+'s';
    const tc=ml<3?'#ef4444':ml<5?'#f59e0b':'#71717a';
    // Smart entry signal display
    const s=m.smartSignal||{};
    let sigHtml='';
    if(s.should){
      const sc2=s.confidence>=80?'#22c55e':s.confidence>=70?'#f59e0b':'#ef4444';
      sigHtml='<div style="margin-top:4px;font-size:12px;color:'+sc2+';">🎯 ENTER '+s.side+' (conf='+s.confidence+'/100, UP='+s.upConfidence+' DOWN='+s.downConfidence+')</div>'+
        '<small style="color:#52525b;display:block;margin-top:2px;">pUp='+(s.pUp*100).toFixed(0)+'% btc1m='+(s.btc1m*100).toFixed(2)+'% btc5m='+(s.btc5m*100).toFixed(2)+'% upL2imb='+(s.upL2Imbalance*100).toFixed(0)+'% downL2imb='+(s.downL2Imbalance*100).toFixed(0)+'%</small>';
    }else{
      sigHtml='<div style="margin-top:4px;font-size:12px;color:#71717a;">⏸ '+((s.reason||'').substring(0,80))+'</div>';
    }
    return '<div class="row" style="flex-direction:column;align-items:stretch;padding:10px 0;">'+
      '<div style="display:flex;justify-content:space-between;">'+
        '<span class="row-label">'+q+'<br><small style="color:'+tc+'">⏱ '+ts+' • bid '+b+' • ask '+a+'</small></span>'+
        '<span class="row-value">Vol $'+v+'</span>'+
      '</div>'+
      sigHtml+
    '</div>';
  }).join('');}else{mktEl.innerHTML='<div class="empty">Нет рынков</div>';}
}
async function fetchTrades(){try{const r=await fetch(API+'/trades');const d=await r.json();const t=d.trades||[];const el=document.getElementById('tradesList');if(t.length===0){el.innerHTML='<div class="empty">Нет сделок</div>';return;}el.innerHTML=t.slice(0,15).map(t=>{const s=t.side||'?';const p=(t.price||0).toFixed(2);const q=t.quantity||0;const rs=t.reason||'?';const pnl=t.pnl||0;const ps=pnl!==0?(pnl>0?'+':'')+'$'+pnl.toFixed(4):'—';const pc=pnl>0?'pnl-positive':pnl<0?'pnl-negative':'';const ts=new Date(t.executedAt||0).toLocaleTimeString('ru-RU');return '<div class="row"><span class="row-label">'+ts+' • '+s+' '+q+'@$'+p+' <small>('+rs+')</small></span><span class="row-value '+pc+'">'+ps+'</span></div>';}).join('');}catch(e){}}
async function fetchAnalytics(){
  try{
    const r=await fetch(API+'/analytics');
    if(!r.ok){document.getElementById('analytics').innerHTML='<div class="empty">Ошибка аналитики: HTTP '+r.status+'</div>';return;}
    const a=await r.json();
    const el=document.getElementById('analytics');
    // BUG FIX (2026-06-20): removed fragile .replace() pattern that broke when winRate=0
    // Now using template literals with proper color directly
    const wr=((a.winRate||0)*100).toFixed(1);
    const wc=(a.winRate||0)>=0.8?'#22c55e':(a.winRate||0)>=0.6?'#f59e0b':'#ef4444';
    const pfRaw=a.profitFactor||0;
    const pf=isFinite(pfRaw)&&pfRaw>0?pfRaw.toFixed(2):pfRaw===0?'—':'∞';
    const pfc=pfRaw>=1.5?'#22c55e':pfRaw>=1.0?'#f59e0b':'#ef4444';
    const netProfit=a.netProfit||0;
    const npc=netProfit>=0?'pnl-positive':'pnl-negative';
    const totalTrades=a.totalTrades||0;
    if(totalTrades===0){
      el.innerHTML='<div class="empty">Нет закрытых сделок для аналитики</div>';
      return;
    }
    const rows=[
      ['Win Rate','<span style="color:'+wc+';font-weight:600;">'+wr+'%</span>'],
      ['Побед / Поражений','🟢 '+(a.totalWins||0)+' / 🔴 '+(a.totalLosses||0)],
      ['Сумма выигрышей','<span class="pnl-positive">+$'+(a.totalWinAmount||0).toFixed(4)+'</span>'],
      ['Сумма проигрышей','<span class="pnl-negative">-$'+(a.totalLossAmount||0).toFixed(4)+'</span>'],
      ['Чистая прибыль','<span class="'+npc+'">'+(netProfit>=0?'+':'')+'$'+netProfit.toFixed(4)+'</span>'],
      ['Profit Factor','<span style="color:'+pfc+';font-weight:600;">'+pf+'</span>'],
      ['Средняя прибыль','+$'+(a.avgWin||0).toFixed(4)],
      ['Средний убыток','-$'+(a.avgLoss||0).toFixed(4)],
      ['Gas + Fees','<span class="pnl-negative">-$'+((a.totalGasPaid||0)+(a.totalFeesPaid||0)).toFixed(4)+'</span>']
    ];
    el.innerHTML=rows.map(r=>'<div class="row"><span class="row-label">'+r[0]+'</span><span class="row-value">'+r[1]+'</span></div>').join('');
  }catch(e){
    document.getElementById('analytics').innerHTML='<div class="empty">Ошибка аналитики: '+(e.message||e)+'</div>';
  }
}
async function sendCommand(cmd){try{await fetch(API+'/'+cmd,{method:'POST'});setTimeout(fetchStatus,500);}catch(e){alert('Ошибка: '+e.message);}}
fetchStatus();fetchTrades();fetchAnalytics();
setInterval(fetchStatus,5000);setInterval(fetchTrades,10000);setInterval(fetchAnalytics,15000);
</script>
</body>
</html>`;
