#!/usr/bin/env python3
"""
Collect Chainlink BTC prices (priceToBeat, finalPrice) for all historical markets.

Polymarket stores these in events[0].eventMetadata on the Gamma API:
  - priceToBeat: BTC price at slot START (= strike price for Up/Down resolution)
  - finalPrice:  BTC price at slot END (compared to priceToBeat for outcome)

This replaces using Binance BTC price at slot_ts as the strike, which had ~18%
mismatch with Polymarket's Chainlink resolution source.

Usage:
  python3 scripts/collect_chainlink_prices.py
"""
import argparse
import json
import os
import sqlite3
import time
import urllib.request
from typing import Optional

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "prisma", "historical.db")
GAMMA_API = "https://gamma-api.polymarket.com"
DELAY = 0.08  # 80ms between requests


def add_price_columns(conn: sqlite3.Connection) -> None:
    """Add price_to_beat and final_price columns if they don't exist."""
    c = conn.cursor()
    # Check if columns exist
    cols = [r[1] for r in c.execute("PRAGMA table_info(historical_markets)")]
    if "price_to_beat" not in cols:
        c.execute("ALTER TABLE historical_markets ADD COLUMN price_to_beat REAL DEFAULT 0")
        print("[DB] Added price_to_beat column")
    if "final_price" not in cols:
        c.execute("ALTER TABLE historical_markets ADD COLUMN final_price REAL DEFAULT 0")
        print("[DB] Added final_price column")
    conn.commit()


def fetch_market_metadata(slug: str) -> Optional[dict]:
    """Fetch market data from Gamma API, return eventMetadata if present."""
    url = f"{GAMMA_API}/markets/slug/{slug}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.load(resp)
        # events is a list with one event; eventMetadata is inside
        events = data.get("events", [])
        if not events:
            return None
        meta = events[0].get("eventMetadata", {})
        if not meta:
            return None
        return {
            "priceToBeat": meta.get("priceToBeat"),
            "finalPrice": meta.get("finalPrice"),
        }
    except Exception as e:
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="Max markets to process (0 = all)")
    parser.add_argument("--force", action="store_true", help="Re-fetch even if prices already set")
    args = parser.parse_args()

    conn = sqlite3.connect(DB_PATH)
    add_price_columns(conn)
    c = conn.cursor()

    # Find markets without Chainlink prices
    if args.force:
        query = "SELECT condition_id, slug FROM historical_markets ORDER BY slot_ts DESC"
    else:
        query = """
            SELECT condition_id, slug FROM historical_markets
            WHERE price_to_beat = 0 OR price_to_beat IS NULL
            ORDER BY slot_ts DESC
        """

    if args.limit > 0:
        query += f" LIMIT {args.limit}"

    markets = c.execute(query).fetchall()
    print(f"\n[Chainlink] {len(markets)} markets need Chainlink prices")
    if not markets:
        print("All markets already have Chainlink prices. Use --force to re-fetch.")
        return

    updated = 0
    errors = 0
    for i, (cond_id, slug) in enumerate(markets):
        meta = fetch_market_metadata(slug)
        if meta and meta["priceToBeat"] and meta["finalPrice"]:
            c.execute(
                "UPDATE historical_markets SET price_to_beat = ?, final_price = ? WHERE condition_id = ?",
                (meta["priceToBeat"], meta["finalPrice"], cond_id),
            )
            updated += 1
            if (i + 1) % 50 == 0:
                conn.commit()
                print(f"  [{i+1}/{len(markets)}] updated {updated}, errors {errors}", flush=True)
        else:
            errors += 1
        time.sleep(DELAY)

    conn.commit()
    print(f"\n[Chainlink] Done. Updated: {updated}, Errors: {errors}, Total: {len(markets)}")

    # Verify: how many markets now have prices?
    total = c.execute("SELECT COUNT(*) FROM historical_markets").fetchone()[0]
    with_prices = c.execute(
        "SELECT COUNT(*) FROM historical_markets WHERE price_to_beat > 0"
    ).fetchone()[0]
    print(f"[DB] Markets with Chainlink prices: {with_prices}/{total} ({with_prices/total*100:.1f}%)")

    # Verify outcome matches price movement
    print("\n[Verify] Outcome vs Chainlink price movement:")
    matches = 0
    mismatches = 0
    for r in c.execute(
        "SELECT outcome, price_to_beat, final_price FROM historical_markets WHERE price_to_beat > 0"
    ):
        outcome, strike, final = r
        moved_up = final >= strike
        expected_up = outcome == "Up"
        if moved_up == expected_up:
            matches += 1
        else:
            mismatches += 1
    total_checked = matches + mismatches
    if total_checked > 0:
        print(f"  Matches: {matches}, Mismatches: {mismatches}")
        print(f"  Match rate: {matches/total_checked*100:.1f}%")

    conn.close()


if __name__ == "__main__":
    main()
