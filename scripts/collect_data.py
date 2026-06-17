#!/usr/bin/env python3
"""
Historical Data Collector for Polymarket BTC 15-min Up/Down Markets
===================================================================
Strategy: Enumerate 15-min slot timestamps and check each via Gamma API.
This avoids the pagination issue (tag_id returns mixed asset types).

Slug format:
  - Recent/active: "btc-updown-15m-{unix_ts}"
  - Older/closed:  "btc-up-or-down-15m-{unix_ts}"

Collects:
  1. Closed BTC 15-min markets from Gamma API (slug enumeration)
  2. Individual trades from Data API for each market
  3. BTC 1-min klines from Binance for corresponding time windows

Usage:
  python collect_data.py --days 7
  python collect_data.py --from 2025-10-16 --to 2026-06-16
  python collect_data.py --stats
"""

import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import requests

# ─── Configuration ──────────────────────────────────────────────
DB_PATH = os.path.join(os.path.dirname(__file__), "..", "prisma", "historical.db")
GAMMA_API = "https://gamma-api.polymarket.com"
DATA_API = "https://data-api.polymarket.com"
BINANCE_API = "https://api.binance.com"

# Rate limiting
GAMMA_DELAY = 0.12
DATA_API_DELAY = 0.06
BINANCE_DELAY = 0.04

# Both known slug patterns for BTC 15M markets
SLUG_PATTERNS = [
    "btc-updown-15m-{ts}",
    "btc-up-or-down-15m-{ts}",
]


def create_db(conn: sqlite3.Connection) -> None:
    """Create the SQLite schema for historical data."""
    c = conn.cursor()
    c.executescript("""
        CREATE TABLE IF NOT EXISTS historical_markets (
            condition_id    TEXT PRIMARY KEY,
            market_id       TEXT,
            slug            TEXT,
            question        TEXT,
            start_date      TEXT,
            end_date        TEXT,
            closed_time     TEXT,
            up_token_id     TEXT,
            down_token_id   TEXT,
            outcome_prices  TEXT,
            outcome         TEXT,
            volume          REAL DEFAULT 0,
            liquidity       REAL DEFAULT 0,
            last_trade_price_up REAL DEFAULT 0,
            fee_type        TEXT,
            taker_base_fee  INTEGER DEFAULT 0,
            maker_base_fee  INTEGER DEFAULT 0,
            neg_risk        INTEGER DEFAULT 0,
            automatically_resolved INTEGER DEFAULT 0,
            slot_ts         INTEGER DEFAULT 0,
            collected_at    TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS historical_trades (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            condition_id    TEXT NOT NULL,
            trade_id        TEXT,
            side            TEXT,
            outcome         TEXT,
            outcome_index   INTEGER,
            asset           TEXT,
            size            REAL,
            price           REAL,
            timestamp       REAL,
            proxy_wallet    TEXT,
            transaction_hash TEXT,
            UNIQUE(condition_id, trade_id, timestamp, side, size, price)
        );

        CREATE TABLE IF NOT EXISTS btc_klines (
            open_time       INTEGER PRIMARY KEY,
            open_time_iso   TEXT,
            open_price      REAL,
            high_price      REAL,
            low_price       REAL,
            close_price     REAL,
            volume          REAL,
            close_time      INTEGER,
            num_trades      INTEGER,
            collected_at    TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS collection_log (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at      TEXT,
            finished_at     TEXT,
            markets_found   INTEGER DEFAULT 0,
            markets_new     INTEGER DEFAULT 0,
            trades_found    INTEGER DEFAULT 0,
            trades_new      INTEGER DEFAULT 0,
            klines_new      INTEGER DEFAULT 0,
            errors          INTEGER DEFAULT 0,
            status          TEXT DEFAULT 'running'
        );

        CREATE INDEX IF NOT EXISTS idx_hm_slug ON historical_markets(slug);
        CREATE INDEX IF NOT EXISTS idx_hm_end_date ON historical_markets(end_date);
        CREATE INDEX IF NOT EXISTS idx_hm_outcome ON historical_markets(outcome);
        CREATE INDEX IF NOT EXISTS idx_hm_slot_ts ON historical_markets(slot_ts);
        CREATE INDEX IF NOT EXISTS idx_ht_condition_id ON historical_trades(condition_id);
        CREATE INDEX IF NOT EXISTS idx_ht_timestamp ON historical_trades(timestamp);
        CREATE INDEX IF NOT EXISTS idx_ht_outcome ON historical_trades(outcome);
        CREATE INDEX IF NOT EXISTS idx_btc_open_time ON btc_klines(open_time);
    """)
    conn.commit()
    print("[DB] Schema created/verified")


# ─── Gamma API: Fetch Market by Slug ───────────────────────────
def fetch_market_by_slug(slug: str) -> Optional[dict]:
    """Try to fetch a market from Gamma API by slug. Returns parsed market dict or None."""
    for pattern in SLUG_PATTERNS:
        # pattern is like "btc-updown-15m-{ts}" but we already have the full slug
        pass

    # Try both /events and /markets endpoints
    for endpoint in ["/events", "/markets"]:
        try:
            url = f"{GAMMA_API}{endpoint}"
            resp = requests.get(url, params={"slug": slug}, timeout=10)
            if resp.status_code != 200:
                continue
            data = resp.json()
            if not data:
                continue

            if endpoint == "/events":
                # Events return list of event objects with nested markets
                if isinstance(data, list) and len(data) > 0:
                    ev = data[0]
                    markets = ev.get("markets", [])
                    if markets:
                        m = markets[0]
                        m["_event"] = {
                            "slug": ev.get("slug", ""),
                            "title": ev.get("title", ""),
                            "closed": ev.get("closed", False),
                        }
                        return parse_market_data(m, slug)
            else:
                # /markets returns list of market objects
                if isinstance(data, list) and len(data) > 0:
                    return parse_market_data(data[0], slug)
        except Exception:
            continue

    return None


def parse_market_data(m: dict, slug: str) -> Optional[dict]:
    """Parse a Gamma API market object into our schema."""
    condition_id = m.get("conditionId", "")
    if not condition_id:
        return None

    # Parse token IDs
    token_ids = []
    raw_tokens = m.get("clobTokenIds", "[]")
    if isinstance(raw_tokens, str):
        try:
            token_ids = json.loads(raw_tokens)
        except json.JSONDecodeError:
            token_ids = []
    elif isinstance(raw_tokens, list):
        token_ids = raw_tokens

    if len(token_ids) < 2:
        return None

    # Parse outcome prices (settlement)
    outcome_prices = []
    raw_prices = m.get("outcomePrices", "[]")
    if isinstance(raw_prices, str):
        try:
            outcome_prices = json.loads(raw_prices)
        except json.JSONDecodeError:
            outcome_prices = []
    elif isinstance(raw_prices, list):
        outcome_prices = [str(p) for p in raw_prices]

    # Determine outcome
    outcome = "Unknown"
    if len(outcome_prices) >= 2:
        try:
            p0 = float(outcome_prices[0])
            p1 = float(outcome_prices[1])
            if p0 > 0.5:
                outcome = "Up"
            elif p1 > 0.5:
                outcome = "Down"
        except (ValueError, TypeError):
            pass

    # Extract slot timestamp from slug
    slot_ts = 0
    try:
        parts = slug.rsplit("-", 1)
        slot_ts = int(parts[-1]) if parts[-1].isdigit() else 0
    except (ValueError, IndexError):
        pass

    return {
        "condition_id": condition_id,
        "market_id": str(m.get("id", "")),
        "slug": slug,
        "question": m.get("question", ""),
        "start_date": m.get("startDate", ""),
        "end_date": m.get("endDate", ""),
        "closed_time": m.get("closedTime", ""),
        "up_token_id": token_ids[0],
        "down_token_id": token_ids[1],
        "outcome_prices": json.dumps(outcome_prices),
        "outcome": outcome,
        "volume": float(m.get("volume", 0) or 0),
        "liquidity": float(m.get("liquidity", 0) or 0),
        "last_trade_price_up": float(m.get("lastTradePrice", 0) or 0),
        "fee_type": m.get("feeType", "") or "",
        "taker_base_fee": int(m.get("takerBaseFee", 0) or 0),
        "maker_base_fee": int(m.get("makerBaseFee", 0) or 0),
        "neg_risk": 1 if (m.get("neg_risk") in [True, "true"] or m.get("negRisk") in [True, "true"]) else 0,
        "automatically_resolved": 1 if m.get("automaticallyResolved") else 0,
        "slot_ts": slot_ts,
    }


def insert_markets(conn: sqlite3.Connection, markets: list[dict]) -> int:
    """Insert markets into DB, return count of new inserts."""
    c = conn.cursor()
    new_count = 0
    for m in markets:
        try:
            c.execute("""
                INSERT OR IGNORE INTO historical_markets
                (condition_id, market_id, slug, question, start_date, end_date,
                 closed_time, up_token_id, down_token_id, outcome_prices, outcome,
                 volume, liquidity, last_trade_price_up, fee_type, taker_base_fee,
                 maker_base_fee, neg_risk, automatically_resolved, slot_ts)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                m["condition_id"], m["market_id"], m["slug"], m["question"],
                m["start_date"], m["end_date"], m["closed_time"],
                m["up_token_id"], m["down_token_id"], m["outcome_prices"], m["outcome"],
                m["volume"], m["liquidity"], m["last_trade_price_up"],
                m["fee_type"], m["taker_base_fee"], m["maker_base_fee"],
                m["neg_risk"], m["automatically_resolved"], m["slot_ts"],
            ))
            if c.rowcount > 0:
                new_count += 1
        except Exception as e:
            print(f"[DB] Error inserting market {m['condition_id'][:16]}: {e}")
    conn.commit()
    return new_count


# ─── Enumerate Slots and Fetch Markets ─────────────────────────
def fetch_markets_by_slots(start_ts: int, end_ts: int, conn: sqlite3.Connection = None) -> list[dict]:
    """
    Enumerate all 15-min slots between start_ts and end_ts,
    try both slug patterns, and collect all found markets.

    If conn is provided, saves markets to DB incrementally (every 100 slots)
    so progress isn't lost if the process is interrupted.
    """
    all_markets: list[dict] = []
    total_slots = (end_ts - start_ts) // 900 + 1
    checked = 0
    found = 0
    saved = 0

    current_ts = start_ts
    while current_ts <= end_ts:
        checked += 1
        for pattern in SLUG_PATTERNS:
            slug = pattern.format(ts=current_ts)
            market = fetch_market_by_slug(slug)
            if market:
                all_markets.append(market)
                found += 1
                break  # Found with this pattern, no need to try the other
            time.sleep(GAMMA_DELAY)

        # Progress reporting + incremental save every 100 slots
        if checked % 100 == 0:
            dt = datetime.fromtimestamp(current_ts, tz=timezone.utc)
            pct = checked / total_slots * 100
            print(f"  [{checked}/{total_slots}] {dt.strftime('%Y-%m-%d %H:%M')} UTC — "
                  f"found {found} markets ({pct:.1f}%)", flush=True)

            # Incremental save: write accumulated markets to DB so progress
            # isn't lost if the process is killed mid-run.
            if conn is not None and all_markets[saved:]:
                new = insert_markets(conn, all_markets[saved:])
                saved = len(all_markets)
                conn.commit()
                if new > 0:
                    print(f"  [DB] Incremental save: +{new} markets (total saved: {saved})", flush=True)

        current_ts += 900  # 15 minutes

    # Final save of any remaining markets
    if conn is not None and all_markets[saved:]:
        insert_markets(conn, all_markets[saved:])
        conn.commit()

    print(f"[Gamma] Checked {checked} slots, found {found} BTC 15M markets")
    return all_markets


# ─── Data API: Fetch Trades ────────────────────────────────────
def fetch_trades_for_market(conn: sqlite3.Connection, condition_id: str, slug: str = "") -> tuple[int, int]:
    """Fetch all trades for a given market. Returns (total_found, new_inserted)."""
    total_found = 0
    new_inserted = 0
    offset = 0
    limit = 1000

    while True:
        try:
            resp = requests.get(f"{DATA_API}/trades", params={
                "market": condition_id,
                "limit": limit,
                "offset": offset,
                "takerOnly": "false",
            }, timeout=30)
            resp.raise_for_status()
            trades = resp.json()
        except Exception as e:
            if offset == 0:
                print(f"[DataAPI] Error for {slug[:40]}: {e}")
            break

        if not trades or not isinstance(trades, list):
            break

        total_found += len(trades)

        c = conn.cursor()
        for t in trades:
            try:
                trade_id = str(t.get("id", "")) or f"{t.get('transactionHash', '')}-{t.get('timestamp', '')}"
                c.execute("""
                    INSERT OR IGNORE INTO historical_trades
                    (condition_id, trade_id, side, outcome, outcome_index, asset,
                     size, price, timestamp, proxy_wallet, transaction_hash)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    condition_id,
                    trade_id,
                    t.get("side", ""),
                    t.get("outcome", ""),
                    int(t.get("outcomeIndex", 0) or 0),
                    t.get("asset", ""),
                    float(t.get("size", 0) or 0),
                    float(t.get("price", 0) or 0),
                    float(t.get("timestamp", 0) or 0),
                    t.get("proxyWallet", ""),
                    t.get("transactionHash", ""),
                ))
                if c.rowcount > 0:
                    new_inserted += 1
            except Exception:
                pass

        conn.commit()

        if len(trades) < limit:
            break

        offset += limit
        time.sleep(DATA_API_DELAY)

    return total_found, new_inserted


# ─── Binance: Fetch BTC Klines ─────────────────────────────────
def fetch_btc_klines(conn: sqlite3.Connection, start_ms: int, end_ms: int) -> int:
    """Fetch BTC 1-min klines from Binance. Returns new klines count."""
    new_count = 0
    current_start = start_ms

    while current_start < end_ms:
        try:
            resp = requests.get(f"{BINANCE_API}/api/v3/klines", params={
                "symbol": "BTCUSDT",
                "interval": "1m",
                "startTime": current_start,
                "endTime": end_ms,
                "limit": 1000,
            }, timeout=30)
            resp.raise_for_status()
            klines = resp.json()
        except Exception as e:
            print(f"[Binance] Error: {e}")
            break

        if not klines or not isinstance(klines, list):
            break

        c = conn.cursor()
        for k in klines:
            try:
                open_time = int(k[0])
                open_time_iso = datetime.fromtimestamp(
                    open_time / 1000, tz=timezone.utc
                ).isoformat()
                c.execute("""
                    INSERT OR IGNORE INTO btc_klines
                    (open_time, open_time_iso, open_price, high_price, low_price,
                     close_price, volume, close_time, num_trades)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    open_time, open_time_iso,
                    float(k[1]), float(k[2]), float(k[3]), float(k[4]),
                    float(k[5]), int(float(k[6])), int(float(k[8])),
                ))
                if c.rowcount > 0:
                    new_count += 1
            except Exception:
                pass

        conn.commit()

        last_close_time = int(klines[-1][6]) if klines else end_ms
        current_start = last_close_time + 1

        if len(klines) < 1000:
            break

        time.sleep(BINANCE_DELAY)

    return new_count


def fetch_klines_for_all_markets(conn: sqlite3.Connection) -> int:
    """Fetch BTC klines for the date range covered by our markets."""
    c = conn.cursor()
    c.execute("""
        SELECT MIN(end_date), MAX(start_date) FROM historical_markets
        WHERE outcome != 'Unknown'
    """)
    row = c.fetchone()
    if not row or not row[0]:
        print("[Binance] No markets with dates to fetch klines for")
        return 0

    start_dt = datetime.fromisoformat(row[0].replace("Z", "+00:00"))
    end_dt = datetime.fromisoformat(row[1].replace("Z", "+00:00"))

    # Add padding
    start_ms = int((start_dt - timedelta(hours=1)).timestamp() * 1000)
    end_ms = int((end_dt + timedelta(hours=1)).timestamp() * 1000)

    print(f"[Binance] Fetching BTC 1m klines from "
          f"{start_dt.strftime('%Y-%m-%d %H:%M')} to {end_dt.strftime('%Y-%m-%d %H:%M')} UTC")

    new_count = fetch_btc_klines(conn, start_ms, end_ms)
    print(f"[Binance] Inserted {new_count} new klines")
    return new_count


# ─── Statistics ─────────────────────────────────────────────────
def show_stats(conn: sqlite3.Connection) -> None:
    """Print database statistics."""
    c = conn.cursor()

    print("\n" + "=" * 60)
    print("  HISTORICAL DATABASE STATISTICS")
    print("=" * 60)

    # Markets
    c.execute("SELECT COUNT(*) FROM historical_markets")
    total_markets = c.fetchone()[0]
    c.execute("SELECT outcome, COUNT(*) FROM historical_markets GROUP BY outcome")
    by_outcome = c.fetchall()
    c.execute("SELECT MIN(end_date), MAX(end_date) FROM historical_markets WHERE end_date != ''")
    date_range = c.fetchone()
    c.execute("SELECT AVG(volume), MAX(volume), SUM(volume) FROM historical_markets")
    vol_stats = c.fetchone()

    print(f"\n  Markets: {total_markets}")
    for outcome, cnt in by_outcome:
        print(f"    {outcome}: {cnt}")
    if date_range and date_range[0]:
        print(f"    Date range: {date_range[0][:10]} to {date_range[1][:10]}")
    if vol_stats and vol_stats[0]:
        print(f"    Avg volume: ${vol_stats[0]:,.0f}  |  Max: ${vol_stats[1]:,.0f}  |  Total: ${vol_stats[2]:,.0f}")

    # Trades
    c.execute("SELECT COUNT(*) FROM historical_trades")
    total_trades = c.fetchone()[0]
    c.execute("SELECT COUNT(DISTINCT condition_id) FROM historical_trades")
    markets_with_trades = c.fetchone()[0]
    c.execute("SELECT outcome, COUNT(*), SUM(size), AVG(price) FROM historical_trades GROUP BY outcome")
    trade_by_outcome = c.fetchall()

    print(f"\n  Trades: {total_trades:,} across {markets_with_trades} markets")
    for outcome, cnt, total_size, avg_price in trade_by_outcome:
        ts_str = f"{total_size:,.1f}" if total_size else "0"
        ap_str = f"{avg_price:.3f}" if avg_price else "0"
        print(f"    {outcome}: {cnt:,} trades, total_size={ts_str}, avg_price={ap_str}")

    # Klines
    c.execute("SELECT COUNT(*), MIN(open_time), MAX(open_time) FROM btc_klines")
    kline_stats = c.fetchone()
    print(f"\n  BTC Klines: {kline_stats[0]:,}")
    if kline_stats and kline_stats[1]:
        k_start = datetime.fromtimestamp(kline_stats[1] / 1000, tz=timezone.utc)
        k_end = datetime.fromtimestamp(kline_stats[2] / 1000, tz=timezone.utc)
        print(f"    Range: {k_start.strftime('%Y-%m-%d %H:%M')} to {k_end.strftime('%Y-%m-%d %H:%M')} UTC")

    # Coverage
    c.execute("""
        SELECT COUNT(*) FROM historical_markets hm
        WHERE hm.outcome != 'Unknown'
        AND NOT EXISTS (SELECT 1 FROM historical_trades ht WHERE ht.condition_id = hm.condition_id)
    """)
    missing_trades = c.fetchone()[0]
    print(f"\n  Markets missing trades: {missing_trades}")

    # Win rate stats
    c.execute("SELECT outcome, COUNT(*), AVG(volume) FROM historical_markets WHERE outcome != 'Unknown' GROUP BY outcome")
    win_stats = c.fetchall()
    total_resolved = sum(r[1] for r in win_stats)
    if total_resolved > 0:
        print(f"\n  Outcome distribution ({total_resolved} resolved):")
        for outcome, cnt, avg_vol in win_stats:
            pct = cnt / total_resolved * 100
            print(f"    {outcome}: {cnt} ({pct:.1f}%), avg_vol=${avg_vol:,.0f}")

    print("=" * 60)


# ─── Main Collection Flow ──────────────────────────────────────
def run_collection(days_back: int = 7, from_date: Optional[str] = None,
                   to_date: Optional[str] = None,
                   skip_klines: bool = False, skip_trades: bool = False) -> None:
    """Main collection pipeline."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    create_db(conn)

    # Calculate time range
    if from_date:
        start_dt = datetime.fromisoformat(from_date + "T00:00:00+00:00")
    else:
        start_dt = datetime.now(timezone.utc) - timedelta(days=days_back)

    if to_date:
        end_dt = datetime.fromisoformat(to_date + "T23:59:59+00:00")
    else:
        end_dt = datetime.now(timezone.utc)

    start_ts = int(start_dt.timestamp() // 900) * 900  # Align to 15-min slot
    end_ts = int(end_dt.timestamp() // 900) * 900

    print(f"\n  Collection period: {start_dt.strftime('%Y-%m-%d %H:%M')} to {end_dt.strftime('%Y-%m-%d %H:%M')} UTC")
    print(f"  Total 15-min slots: {(end_ts - start_ts) // 900}")

    # Start log
    c = conn.cursor()
    c.execute("INSERT INTO collection_log (started_at, status) VALUES (?, 'running')",
              (datetime.now(timezone.utc).isoformat(),))
    conn.commit()
    log_id = c.lastrowid

    markets_found = 0
    markets_new = 0
    trades_found = 0
    trades_new = 0
    klines_new = 0
    errors = 0

    try:
        # Step 1: Enumerate slots and fetch markets
        print("\n" + "-" * 60)
        print("  STEP 1: Enumerating 15-min slots for BTC markets")
        print("-" * 60)
        markets = fetch_markets_by_slots(start_ts, end_ts, conn)
        markets_found = len(markets)

        if markets:
            markets_new = insert_markets(conn, markets)
            print(f"\n[DB] Inserted {markets_new} new markets (total found: {markets_found})")

        # Step 2: Fetch trades
        if not skip_trades:
            print("\n" + "-" * 60)
            print("  STEP 2: Fetching trades from Data API")
            print("-" * 60)

            c.execute("""
                SELECT condition_id, slug FROM historical_markets hm
                WHERE hm.outcome != 'Unknown'
                AND NOT EXISTS (
                    SELECT 1 FROM historical_trades ht
                    WHERE ht.condition_id = hm.condition_id
                )
                ORDER BY hm.end_date DESC
            """)
            markets_needing_trades = c.fetchall()
            print(f"[DataAPI] {len(markets_needing_trades)} markets need trades")

            for i, (cond_id, slug) in enumerate(markets_needing_trades):
                try:
                    found, new = fetch_trades_for_market(conn, cond_id, slug)
                    trades_found += found
                    trades_new += new
                    if (i + 1) % 50 == 0 or found > 0:
                        print(f"  [{i+1}/{len(markets_needing_trades)}] "
                              f"{slug[:40]}... found={found}, new={new}")
                except Exception as e:
                    errors += 1
                    print(f"  [{i+1}] Error: {e}")
                time.sleep(DATA_API_DELAY)

            print(f"\n[DataAPI] Total: {trades_found:,} found, {trades_new:,} new")

        # Step 3: Fetch BTC klines
        if not skip_klines:
            print("\n" + "-" * 60)
            print("  STEP 3: Fetching BTC 1-min klines from Binance")
            print("-" * 60)
            klines_new = fetch_klines_for_all_markets(conn)

        # Final stats
        c.execute("""
            UPDATE collection_log SET
                finished_at = ?, markets_found = ?, markets_new = ?,
                trades_found = ?, trades_new = ?, klines_new = ?,
                errors = ?, status = 'completed'
            WHERE id = ?
        """, (
            datetime.now(timezone.utc).isoformat(),
            markets_found, markets_new, trades_found, trades_new,
            klines_new, errors, log_id,
        ))
        conn.commit()
        show_stats(conn)

    except KeyboardInterrupt:
        print("\n\n[INTERRUPTED] Saving progress...")
        c.execute("""
            UPDATE collection_log SET
                finished_at = ?, markets_found = ?, markets_new = ?,
                trades_found = ?, trades_new = ?, klines_new = ?,
                errors = ?, status = 'interrupted'
            WHERE id = ?
        """, (
            datetime.now(timezone.utc).isoformat(),
            markets_found, markets_new, trades_found, trades_new,
            klines_new, errors, log_id,
        ))
        conn.commit()
        show_stats(conn)
    except Exception as e:
        print(f"\n[FATAL] {e}")
        c.execute("""
            UPDATE collection_log SET
                finished_at = ?, errors = ?, status = 'error'
            WHERE id = ?
        """, (datetime.now(timezone.utc).isoformat(), errors + 1, log_id))
        conn.commit()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Collect historical data for BTC 15-min markets")
    parser.add_argument("--days", type=int, default=7, help="Days back to collect (default: 7)")
    parser.add_argument("--from", dest="from_date", type=str, help="Start date (YYYY-MM-DD)")
    parser.add_argument("--to", dest="to_date", type=str, help="End date (YYYY-MM-DD)")
    parser.add_argument("--stats", action="store_true", help="Show DB statistics only")
    parser.add_argument("--skip-klines", action="store_true", help="Skip Binance kline collection")
    parser.add_argument("--skip-trades", action="store_true", help="Skip Data API trade collection")
    args = parser.parse_args()

    if args.stats:
        if not os.path.exists(DB_PATH):
            print("Database not found. Run collection first.")
            sys.exit(1)
        conn = sqlite3.connect(DB_PATH)
        show_stats(conn)
        conn.close()
    else:
        run_collection(
            days_back=args.days,
            from_date=args.from_date,
            to_date=args.to_date,
            skip_klines=args.skip_klines,
            skip_trades=args.skip_trades,
        )
