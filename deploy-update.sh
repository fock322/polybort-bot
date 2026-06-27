#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# DEPLOY SCRIPT — VPS (151.245.140.23)
# Run on VPS: cd ~/polybort-bot-live && bash deploy-update.sh
#
# What this does:
# 1. Pulls latest code from GitHub (BTC trend filter + live-5m service + submit fix)
# 2. Creates .env symlink for live-momentum-5m (so it reads CLOB creds)
# 3. Installs deps for live-momentum-5m
# 4. Stops old live-momentum (15m, port 3006)
# 5. Starts live-momentum-5m (5m markets, port 3008, REAL money)
# 6. Restarts paper-momentum-5m (3007) with new BTC trend filter
# ═══════════════════════════════════════════════════════════════
set -e

PROJECT_DIR="$HOME/polybort-bot-live"
cd "$PROJECT_DIR" || { echo "❌ Project dir not found: $PROJECT_DIR"; exit 1; }

echo "═══════════════════════════════════════════════════════════════"
echo "  🚀 VPS DEPLOY — BTC trend filter + live-5m + submit fix"
echo "═══════════════════════════════════════════════════════════════"
echo

# ── 1. Pull latest code ──
echo "📦 [1/6] Pulling latest code from GitHub..."
git fetch origin main
git reset --hard origin/main
echo "✅ Code updated"
echo

# ── 2. Create .env symlinks for services that need CLOB creds ──
echo "🔐 [2/6] Creating .env symlinks..."
# The .env should already exist at project root with CLOB_PRIVATE_KEY + CLOB_FUNDER_ADDRESS
if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo "⚠️  .env not found at $PROJECT_DIR/.env"
  echo "   Creating from template — you MUST add real CLOB keys!"
  cat > "$PROJECT_DIR/.env" << 'ENVTPL'
DATABASE_URL=file:/home/z/my-project/db/custom.db
CLOB_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
CLOB_FUNDER_ADDRESS=0x68C7e024b9F5127B0b14753B7C0EB26112532F6c
LIVE_STARTING_BALANCE=42
ENVTPL
  echo "❌ Edit .env and add real CLOB_PRIVATE_KEY before continuing!"
  exit 1
fi

# Symlink .env into each service dir (bun loads .env from cwd)
for svc in live-momentum live-momentum-5m paper-trading-momentum paper-trading-momentum-5m; do
  if [ -d "$PROJECT_DIR/mini-services/$svc" ]; then
    ln -sf "$PROJECT_DIR/.env" "$PROJECT_DIR/mini-services/$svc/.env"
    echo "  ✓ $svc/.env → symlink"
  fi
done
echo "✅ .env symlinks created"
echo

# ── 3. Install deps for live-momentum-5m ──
echo "📚 [3/6] Installing dependencies for live-momentum-5m..."
cd "$PROJECT_DIR/mini-services/live-momentum-5m"
bun install 2>&1 | tail -3
echo "✅ Deps installed"
echo

# ── 4. Stop old live-momentum (15m, port 3006) ──
echo "🛑 [4/6] Stopping old live-momentum (15m, port 3006)..."
# Find and kill the process on port 3006
PID_3006=$(lsof -ti :3006 2>/dev/null || true)
if [ -n "$PID_3006" ]; then
  kill "$PID_3006" 2>/dev/null || true
  sleep 2
  kill -9 "$PID_3006" 2>/dev/null || true
  echo "  ✓ Stopped PID $PID_3006 (port 3006)"
else
  echo "  ℹ️  Port 3006 not in use"
fi
echo

# ── 5. Start live-momentum-5m (5m markets, port 3008, REAL money) ──
echo "🔴 [5/6] Starting live-momentum-5m (port 3008, REAL MONEY)..."
cd "$PROJECT_DIR/mini-services/live-momentum-5m"
# Kill any existing process on 3008
PID_3008=$(lsof -ti :3008 2>/dev/null || true)
if [ -n "$PID_3008" ]; then
  kill -9 "$PID_3008" 2>/dev/null || true
fi
# Start in background with nohup
nohup bun run dev >> /tmp/live-momentum-5m.log 2>&1 &
sleep 4
# Verify it started
if curl -s --max-time 3 http://localhost:3008/health | grep -q "ok"; then
  echo "  ✅ live-momentum-5m started on port 3008"
  curl -s http://localhost:3008/health | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'     liveMode={d.get(\"liveMode\")}  hasClobKey={d.get(\"hasClobKey\")}  marketInterval={d.get(\"marketInterval\")}')
" 2>/dev/null || true
else
  echo "  ❌ Failed to start live-momentum-5m — check /tmp/live-momentum-5m.log"
fi
echo

# ── 6. Restart paper-momentum-5m (3007) to pick up BTC trend filter ──
echo "📄 [6/6] Restarting paper-momentum-5m (port 3007) for BTC trend filter..."
PID_3007=$(lsof -ti :3007 2>/dev/null || true)
if [ -n "$PID_3007" ]; then
  kill "$PID_3007" 2>/dev/null || true
  sleep 2
fi
cd "$PROJECT_DIR/mini-services/paper-trading-momentum-5m"
nohup bun run dev >> /tmp/paper-momentum-5m.log 2>&1 &
sleep 4
if curl -s --max-time 3 http://localhost:3007/health | grep -q "ok"; then
  echo "  ✅ paper-momentum-5m restarted on port 3007"
else
  echo "  ⚠️  paper-momentum-5m may need manual restart"
fi
echo

# ── Summary ──
echo "═══════════════════════════════════════════════════════════════"
echo "  ✅ DEPLOY COMPLETE"
echo "═══════════════════════════════════════════════════════════════"
echo
echo "Dashboard URLs (direct VPS access):"
echo "  🔴 LIVE 5m:    http://151.245.140.23:3008/dashboard"
echo "  📄 Paper 5m:   http://151.245.140.23:3007/dashboard"
echo "  ⚠️  LIVE 15m:   STOPPED (was port 3006)"
echo
echo "Logs:"
echo "  live-5m:  tail -f /tmp/live-momentum-5m.log"
echo "  paper-5m: tail -f /tmp/paper-momentum-5m.log"
echo
echo "To restart live-5m:"
echo "  cd ~/polybort-bot-live/mini-services/live-momentum-5m && bun run dev"
echo
