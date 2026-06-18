#!/bin/bash
# Background logger: captures bot status every 5 minutes for 60 minutes
# Saves to /tmp/bot_monitor.log

LOG=/tmp/bot_monitor.log
INTERVAL=300  # 5 minutes
MAX_MINUTES=60
COUNT=0
MAX_COUNT=$((MAX_MINUTES / 5))

echo "=== Bot Monitor Started: $(date) ===" > $LOG
echo "Will capture status every 5 min for 60 min (12 snapshots)" >> $LOG
echo "" >> $LOG

while [ $COUNT -lt $MAX_COUNT ]; do
  COUNT=$((COUNT + 1))
  TIMESTAMP=$(date '+%H:%M:%S')
  STATUS=$(curl -s --max-time 10 http://localhost:3000/api/bot/status 2>/dev/null)
  
  if [ -z "$STATUS" ]; then
    echo "[$TIMESTAMP] Snapshot $COUNT/$MAX_COUNT: ERROR - no response" >> $LOG
  else
    # Extract key metrics
    echo "[$TIMESTAMP] Snapshot $COUNT/$MAX_COUNT:" >> $LOG
    echo "$STATUS" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(f'  running={d.get(\"running\")} balance=\${d.get(\"balance\",0):.2f} btc=\${d.get(\"btcPrice\",0):,.0f}')
    print(f'  positions={d.get(\"positionCount\")} quotes={d.get(\"quoteCount\")} trades={d.get(\"tradeCount\")}')
    print(f'  pnl=total:\${d.get(\"totalPnl\",0):.2f} realized:\${d.get(\"realizedPnl\",0):.2f} unreal:\${d.get(\"unrealizedPnl\",0):.2f}')
    print(f'  circuit={d.get(\"circuitBreaker\")} markets={d.get(\"activeMarkets\")}')
    if d.get('positions'):
        for p in d['positions'][:3]:
            print(f'    {p.get(\"side\",\"?\"):6s} qty={p.get(\"quantity\",0):5.1f} entry={p.get(\"entryPrice\",0):.2f} unreal=\${p.get(\"unrealizedPnl\",0):.2f}')
except Exception as e:
    print(f'  PARSE ERROR: {e}')
" >> $LOG
  fi
  echo "" >> $LOG
  
  # Sleep 5 min (but check if bot is still running every minute)
  for i in 1 2 3 4 5; do
    sleep 60
  done
done

echo "=== Monitor Complete: $(date) ===" >> $LOG
echo "=== Final summary ===" >> $LOG
curl -s --max-time 10 http://localhost:3000/api/bot/status 2>/dev/null | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'Final balance: \${d.get(\"balance\",0):.2f}')
print(f'Total trades: {d.get(\"tradeCount\")}')
print(f'Total PnL: \${d.get(\"totalPnl\",0):.2f}')
print(f'Realized: \${d.get(\"realizedPnl\",0):.2f}')
print(f'Unrealized: \${d.get(\"unrealizedPnl\",0):.2f}')
print(f'Circuit breaker: {d.get(\"circuitBreaker\")}')
" >> $LOG
