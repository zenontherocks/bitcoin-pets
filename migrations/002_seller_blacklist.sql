-- Migration: Add pbt_seller column to pets, add seller_blacklist table
-- Run with: wrangler d1 execute bitcoin-pets --remote --file=migrations/002_seller_blacklist.sql

ALTER TABLE pets ADD COLUMN pbt_seller TEXT;

CREATE TABLE IF NOT EXISTS seller_blacklist (
  username TEXT PRIMARY KEY,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);
