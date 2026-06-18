#!/bin/bash
# Auto-restart wrapper for trade collection.
# Sandbox kills processes after ~3 min, so we restart automatically.
# Each run picks up where it left off (INSERT OR IGNORE in DB).

cd /home/z/my-project

MAX_RESTARTS=30
RESTART=0

while [ $RESTART -lt $MAX_RESTARTS ]; do
  RESTART=$((RESTART + 1))
  echo "=== Restart $RESTART/$MAX_RESTARTS ==="

  # Run collection with timeout (2 min to stay under sandbox limit)
  timeout 110 python3 -u scripts/collect_data.py --days 30 --skip-markets 2>&1 | tail -5

  # Check progress
  T=$(python3 -c "import sqlite3; c=sqlite3.connect('prisma/historical.db'); print(c.execute('SELECT COUNT(*) FROM historical_trades').fetchone()[0])" 2>/dev/null)
  MT=$(python3 -c "import sqlite3; c=sqlite3.connect('prisma/historical.db'); print(c.execute('SELECT COUNT(DISTINCT condition_id) FROM historical_trades').fetchone()[0])" 2>/dev/null)
  echo "  Trades: $T, Markets with trades: $MT"

  # Stop if we have enough
  if [ "$MT" -ge 500 ]; then
    echo "✅ Reached 500+ markets with trades"
    break
  fi

  # Check if there are more markets to process
  REMAINING=$(python3 -c "
import sqlite3
c = sqlite3.connect('prisma/historical.db')
total = c.execute('SELECT COUNT(*) FROM historical_markets WHERE outcome != \"Unknown\"').fetchone()[0]
with_trades = c.execute('SELECT COUNT(DISTINCT condition_id) FROM historical_trades').fetchone()[0]
print(total - with_trades)
" 2>/dev/null)

  if [ "$REMAINING" -le 0 ]; then
    echo "✅ All markets have trades"
    break
  fi

  echo "  Remaining: $REMAINING markets, restarting..."
  sleep 2
done

echo ""
echo "=== Final state ==="
python3 -c "
import sqlite3
c = sqlite3.connect('prisma/historical.db')
t = c.execute('SELECT COUNT(*) FROM historical_trades').fetchone()[0]
mt = c.execute('SELECT COUNT(DISTINCT condition_id) FROM historical_trades').fetchone()[0]
total = c.execute('SELECT COUNT(*) FROM historical_markets').fetchone()[0]
print(f'Markets: {total}, with trades: {mt}, total trades: {t}')
"
