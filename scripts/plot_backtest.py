#!/usr/bin/env python3
"""Plot backtest results: equity curve + PnL distribution"""

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

# Load results
with open('/home/z/my-project/download/backtest_result.json') as f:
    data = json.load(f)

result = data['result']
config = data['config']
equity = result['equityCurve']
trades = result['trades']

fig, axes = plt.subplots(2, 2, figsize=(16, 10), constrained_layout=True)
fig.suptitle(
    f"Backtest Results — Spread={config['baseSpread']}, QuoteSize={config['quoteSize']}, "
    f"StartBalance=${config['startingBalance']}",
    fontsize=14, fontweight='bold'
)

# ─── 1. Equity Curve ───
ax1 = axes[0, 0]
ts = [datetime.fromtimestamp(e['ts'] / 1000) for e in equity]
eq = [e['equity'] for e in equity]
ax1.plot(ts, eq, color='#2196F3', linewidth=1.5, label='Equity')
ax1.axhline(y=config['startingBalance'], color='gray', linestyle='--', alpha=0.5, label='Starting Balance')
ax1.fill_between(ts, config['startingBalance'], eq, where=[e >= config['startingBalance'] for e in eq],
                  alpha=0.15, color='green')
ax1.fill_between(ts, config['startingBalance'], eq, where=[e < config['startingBalance'] for e in eq],
                  alpha=0.15, color='red')
ax1.set_title('Equity Curve', fontweight='bold')
ax1.set_ylabel('Balance ($)')
ax1.legend(loc='upper left')
ax1.grid(True, alpha=0.3)

# ─── 2. PnL per trade ───
ax2 = axes[0, 1]
pnls = [t['pnl'] for t in trades if t['pnl'] != 0]
if pnls:
    colors = ['#4CAF50' if p > 0 else '#F44336' for p in pnls]
    ax2.bar(range(len(pnls)), pnls, color=colors, width=1.0, alpha=0.7)
    ax2.axhline(y=0, color='black', linewidth=0.5)
ax2.set_title(f'PnL per Trade (n={len(pnls)})', fontweight='bold')
ax2.set_ylabel('PnL ($)')
ax2.set_xlabel('Trade #')
ax2.grid(True, alpha=0.3)

# ─── 3. PnL Distribution ───
ax3 = axes[1, 0]
if pnls:
    ax3.hist(pnls, bins=50, color='#FF9800', alpha=0.7, edgecolor='black', linewidth=0.3)
    ax3.axvline(x=0, color='black', linewidth=1)
    mean_pnl = sum(pnls) / len(pnls)
    ax3.axvline(x=mean_pnl, color='blue', linewidth=1.5, linestyle='--', label=f'Mean: ${mean_pnl:.3f}')
    ax3.legend()
ax3.set_title('PnL Distribution', fontweight='bold')
ax3.set_xlabel('PnL ($)')
ax3.set_ylabel('Count')
ax3.grid(True, alpha=0.3)

# ─── 4. Summary Stats ───
ax4 = axes[1, 1]
ax4.axis('off')
stats_text = f"""
╔══════════════════════════════════╗
║     BACKTEST SUMMARY             ║
╠══════════════════════════════════╣
║  Total PnL:     ${result['totalPnl']:>10.2f}     ║
║  Final Balance: ${eq[-1]:>10.2f}     ║
║  Return:        {(result['totalPnl']/config['startingBalance']*100):>9.1f}%     ║
║  Max Drawdown:  {(result['maxDrawdown']*100):>9.1f}%     ║
║  Sharpe Ratio:  {result['sharpeRatio']:>10.2f}     ║
║  Win Rate:      {(result['winRate']*100):>9.1f}%     ║
║  Total Trades:  {result['totalTrades']:>10d}     ║
║  Maker/Taker:   {result['makerTrades']:>4d}/{result['makerTrades']:<5d}    ║
║  Fees Paid:     ${result['totalFees']:>10.2f}     ║
║  Rebates:       ${result['totalRebates']:>10.2f}     ║
║  Net Fees:      ${(result['totalFees']-result['totalRebates']):>10.2f}     ║
║  Markets:       {result['marketsTraded']:>4d}/{result['totalMarkets']:<5d}    ║
║  Avg Hold:      {result['avgHoldingMin']:>8.1f} min  ║
╚══════════════════════════════════╝
"""
ax4.text(0.05, 0.95, stats_text, transform=ax4.transAxes,
         fontsize=11, verticalalignment='top', fontfamily='monospace',
         bbox=dict(boxstyle='round', facecolor='#E3F2FD', alpha=0.8))

out = '/home/z/my-project/download/backtest_chart.png'
plt.savefig(out, dpi=150, bbox_inches='tight')
print(f"Chart saved to {out}")
