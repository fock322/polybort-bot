#!/usr/bin/env python3
"""
Quick Binance klines collector — fetches 30 days of 1-min BTC klines
and stores them in prisma/historical.db.btc_klines table.

Binance allows 1000 klines per request, so 30 days = 43200 min / 1000 = 43 requests.
Takes ~30 seconds total.
"""
import sqlite3
import time
import requests
from datetime import datetime, timezone

DB_PATH = "prisma/historical.db"
BINANCE_API = "https://api.binance.com"

def fetch_klines(start_ms, end_ms, interval="1m", limit=1000):
    """Fetch klines from Binance for a time range."""
    url = f"{BINANCE_API}/api/v3/klines"
    params = {
        "symbol": "BTCUSDT",
        "interval": interval,
        "startTime": start_ms,
        "endTime": end_ms,
        "limit": limit,
    }
    resp = requests.get(url, params=params, timeout=30)
    if resp.status_code != 200:
        raise Exception(f"Binance API {resp.status_code}: {resp.text[:200]}")
    return resp.json()

def main():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    # Ensure table exists
    c.execute("""
        CREATE TABLE IF NOT EXISTS btc_klines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            open_time INTEGER UNIQUE,
            open_price REAL,
            high_price REAL,
            low_price REAL,
            close_price REAL,
            volume REAL,
            num_trades INTEGER
        )
    """)
    conn.commit()

    # 30 days back from now
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - 30 * 24 * 60 * 60 * 1000  # 30 days

    print(f"Fetching BTC klines from {datetime.fromtimestamp(start_ms/1000, tz=timezone.utc).isoformat()}")
    print(f"                  to {datetime.fromtimestamp(end_ms/1000, tz=timezone.utc).isoformat()}")
    print()

    total_inserted = 0
    current_ms = start_ms
    batch = 0

    while current_ms < end_ms:
        batch += 1
        try:
            klines = fetch_klines(current_ms, end_ms)
            if not klines:
                print(f"  [batch {batch}] no data, stopping")
                break

            rows = []
            for k in klines:
                rows.append((
                    int(k[0]),       # open_time (ms)
                    float(k[1]),     # open
                    float(k[2]),     # high
                    float(k[3]),     # low
                    float(k[4]),     # close
                    float(k[5]),     # volume
                    int(k[8]),       # num_trades
                ))

            # Insert with INSERT OR IGNORE (skip duplicates)
            c.executemany("""
                INSERT OR IGNORE INTO btc_klines
                (open_time, open_price, high_price, low_price, close_price, volume, num_trades)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, rows)
            conn.commit()

            total_inserted += c.rowcount
            last_time = datetime.fromtimestamp(klines[-1][0] / 1000, tz=timezone.utc)
            print(f"  [batch {batch}] {len(rows)} klines, +{c.rowcount} new, last={last_time.strftime('%Y-%m-%d %H:%M')} UTC", flush=True)

            # Move to next window (last kline + 1 min)
            current_ms = int(klines[-1][0]) + 60_000

            if len(klines) < 1000:
                print(f"  got < 1000 klines, done")
                break

            time.sleep(0.2)  # be polite to Binance
        except Exception as e:
            print(f"  [batch {batch}] ERROR: {e}")
            time.sleep(2)
            # try to continue from last known
            current_ms += 1000 * 60 * 1000  # skip 1000 min ahead

    # Final count
    total = c.execute("SELECT COUNT(*) FROM btc_klines").fetchone()[0]
    r = c.execute("SELECT MIN(open_time), MAX(open_time) FROM btc_klines").fetchone()
    print(f"\n✅ Done. Total klines in DB: {total}")
    if r[0]:
        print(f"   Range: {datetime.fromtimestamp(r[0]/1000, tz=timezone.utc).isoformat()}")
        print(f"      to: {datetime.fromtimestamp(r[1]/1000, tz=timezone.utc).isoformat()}")

    conn.close()

if __name__ == "__main__":
    main()
