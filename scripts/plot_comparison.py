#!/usr/bin/env python3
"""Compare v2 vs v4 backtest results"""

import json
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
from datetime import datetime

# Font setup
fm.fontManager.addfont('/usr/share/fonts/truetype/chinese/SarasaMonoSC-LightItalic.ttf')
fm.fontManager.addfont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
plt.rcParams['font.sans-serif'] = ['Sarasa Mono SC', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

# v2 result
with open('/home/z/my-project/download/backtest_result.json') as f:
    v2 = json.load(f)
# v4 result
with open('/home/z/my-project/download/backtest_v4_result.json') as f:
    v4 = json.load(f)

fig, axes = plt.subplots(2, 2, figsize=(16, 10), constrained_layout=True)
fig.suptitle('Backtest Strategy Comparison: v2 (original) vs v4 (smart hedge)', fontsize=14, fontweight='bold')

# ─── 1. Equity Curves ───
ax1 = axes[0, 0]
v2_eq = [e['equity'] for e in v2['result']['equityCurve']]
v4_eq = [e['equity'] for e in v4['result']['equityCurve']]
v2_ts = [datetime.fromtimestamp(e['ts'] / 1000) for e in v2['result']['equityCurve']]
v4_ts = [datetime.fromtimestamp(e['ts'] / 1000) for e in v4['result']['equityCurve']]
ax1.plot(v2_ts, v2_eq, color='#F44336', linewidth=1.5, label=f"v2 (PnL ${v2['result']['totalPnl']:.0f}, Sharpe {v2['result']['sharpeRatio']:.0f})", alpha=0.8)
ax1.plot(v4_ts, v4_eq, color='#2196F3', linewidth=1.5, label=f"v4 (PnL ${v4['result']['totalPnl']:.0f}, Sharpe {v4['result']['sharpeRatio']:.0f})", alpha=0.8)
ax1.axhline(y=1000, color='gray', linestyle='--', alpha=0.5, label='Start $1000')
ax1.set_title('Equity Curves — v2 vs v4', fontweight='bold')
ax1.set_ylabel('Balance ($)')
ax1.legend(loc='upper left')
ax1.grid(True, alpha=0.3)

# ─── 2. PnL per trade comparison ───
ax2 = axes[0, 1]
v2_pnls = [t['pnl'] for t in v2['result']['trades'] if t['pnl'] != 0]
v4_pnls = [t['pnl'] for t in v4['result']['trades'] if t['pnl'] != 0]
ax2.hist(v2_pnls, bins=40, alpha=0.6, color='#F44336', label=f'v2 ({len(v2_pnls)} trades)', edgecolor='black', linewidth=0.3)
ax2.hist(v4_pnls, bins=40, alpha=0.6, color='#2196F3', label=f'v4 ({len(v4_pnls)} trades)', edgecolor='black', linewidth=0.3)
ax2.axvline(x=0, color='black', linewidth=1)
ax2.set_title('PnL Distribution per Trade', fontweight='bold')
ax2.set_xlabel('PnL ($)')
ax2.set_ylabel('Count')
ax2.legend()
ax2.grid(True, alpha=0.3)
ax2.set_xlim(-25, 15)

# ─── 3. Metrics bar chart ───
ax3 = axes[1, 0]
metrics = ['Total PnL ($)', 'Sharpe Ratio', 'Max Drawdown (%)', 'Win Rate (%)']
v2_vals = [v2['result']['totalPnl'], v2['result']['sharpeRatio'], v2['result']['maxDrawdown']*100, v2['result']['winRate']*100]
v4_vals = [v4['result']['totalPnl'], v4['result']['sharpeRatio'], v4['result']['maxDrawdown']*100, v4['result']['winRate']*100]
x = range(len(metrics))
width = 0.35
ax3.bar([i - width/2 for i in x], v2_vals, width, color='#F44336', alpha=0.7, label='v2')
ax3.bar([i + width/2 for i in x], v4_vals, width, color='#2196F3', alpha=0.7, label='v4')
ax3.set_xticks(list(x))
ax3.set_xticklabels(metrics, fontsize=9)
ax3.set_title('Key Metrics Comparison', fontweight='bold')
ax3.legend()
ax3.grid(True, alpha=0.3, axis='y')

# Add value labels
for i, (v2v, v4v) in enumerate(zip(v2_vals, v4_vals)):
    ax3.text(i - width/2, v2v + 1, f'{v2v:.1f}', ha='center', fontsize=8)
    ax3.text(i + width/2, v4v + 1, f'{v4v:.1f}', ha='center', fontsize=8)

# ─── 4. Summary table ───
ax4 = axes[1, 1]
ax4.axis('off')

# Compute additional stats
v2_settle = [t for t in v2['result']['trades'] if t['side'].startswith('SETTLE')]
v4_settle = [t for t in v4['result']['trades'] if t['side'].startswith('SETTLE')]
v2_settle_pnl = sum(t['pnl'] for t in v2_settle)
v4_settle_pnl = sum(t['pnl'] for t in v4_settle)

stats = f"""
╔══════════════════════════════════════════════╗
║       STRATEGY COMPARISON (7-day backtest)   ║
╠══════════════════════════════════════════════╣
║  Metric                 v2          v4       ║
║  ─────────────────────────────────────────── ║
║  Total PnL              ${v2['result']['totalPnl']:>7.0f}      ${v4['result']['totalPnl']:>6.0f}    ║
║  Sharpe Ratio           {v2['result']['sharpeRatio']:>7.1f}      {v4['result']['sharpeRatio']:>6.1f}    ║
║  Max Drawdown           {v2['result']['maxDrawdown']*100:>6.1f}%      {v4['result']['maxDrawdown']*100:>5.1f}%    ║
║  Total Trades           {v2['result']['totalTrades']:>7d}      {v4['result']['totalTrades']:>6d}    ║
║  Win Rate               {v2['result']['winRate']*100:>6.1f}%      {v4['result']['winRate']*100:>5.1f}%    ║
║  Settlement Losses      {sum(1 for t in v2_settle if t['pnl']<0):>7d}      {sum(1 for t in v4_settle if t['pnl']<0):>6d}    ║
║  Settle PnL             ${v2_settle_pnl:>7.0f}      ${v4_settle_pnl:>6.0f}    ║
║  Fees Paid              ${v2['result']['totalFees']:>7.0f}      ${v4['result']['totalFees']:>6.0f}    ║
║  ─────────────────────────────────────────── ║
║  WINNER (Sharpe)                  →   v4     ║
║  WINNER (Risk/MaxDD)              →   v4     ║
║  WINNER (Absolute PnL)            →   v2     ║
╚══════════════════════════════════════════════╝
"""
ax4.text(0.05, 0.95, stats, transform=ax4.transAxes,
         fontsize=10, verticalalignment='top', fontfamily='monospace',
         bbox=dict(boxstyle='round', facecolor='#E3F2FD', alpha=0.8))

out = '/home/z/my-project/download/backtest_v2_vs_v4.png'
plt.savefig(out, dpi=150, bbox_inches='tight')
print(f"Comparison chart saved to {out}")
