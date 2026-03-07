-- Migration: Add 'ended' to pets status enum
-- Run with: wrangler d1 execute bitcoin-pets --file=migrations/001_add_ended_status.sql

PRAGMA foreign_keys=OFF;

CREATE TABLE pets_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  species TEXT NOT NULL,
  breed TEXT,
  date_of_birth TEXT,
  weight_lbs REAL,
  gender TEXT CHECK(gender IN ('male', 'female', 'unknown')),
  color TEXT,
  description TEXT,
  health_info TEXT,
  vaccinations TEXT,
  registry_name TEXT,
  registry_number TEXT,
  microchip_id TEXT,
  price_btc REAL,
  price_usd REAL,
  price_currency TEXT NOT NULL DEFAULT 'btc'
    CHECK(price_currency IN ('btc', 'usd')),
  bitcoin_address TEXT,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK(status IN ('available', 'pending', 'sold', 'ended')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO pets_new SELECT * FROM pets;
DROP TABLE pets;
ALTER TABLE pets_new RENAME TO pets;

PRAGMA foreign_keys=ON;
