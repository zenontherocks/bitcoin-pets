#!/usr/bin/env node
/**
 * Derive P2WPKH (native SegWit / bech32) addresses from a zpub or xpub.
 *
 * Usage:
 *   node scripts/derive-addresses.js <zpub|xpub> <start_index> <count>
 *
 * Outputs SQL INSERT statements to stdout. Pipe into wrangler to seed the DB:
 *   node scripts/derive-addresses.js zpub6q... 0 100 | \
 *     wrangler d1 execute bitcoin-pets --file=-
 *
 * Dependencies (install locally before running):
 *   npm install bitcoinjs-lib tiny-secp256k1 bip32 bs58check
 *
 * The derivation path used is m/0/<index>  (external chain, no hardened steps)
 * because the zpub/xpub is already the account-level key.  This matches the
 * standard BIP84 receive-address derivation used by most wallets.
 */

'use strict';

const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { BIP32Factory } = require('bip32');
const bs58check = require('bs58check').default;

const bip32 = BIP32Factory(ecc);

// zpub version bytes (BIP84 mainnet public) → xpub version bytes
const ZPUB_VERSION = 0x04b24746;
const XPUB_VERSION = 0x0488b21e;

function zpubToXpub(zpub) {
  const data = bs58check.decode(zpub);
  const buf = Buffer.from(data);
  buf.writeUInt32BE(XPUB_VERSION, 0);
  return bs58check.encode(buf);
}

function main() {
  const [,, pubkey, startArg, countArg] = process.argv;

  if (!pubkey || !startArg || !countArg) {
    console.error('Usage: node derive-addresses.js <zpub|xpub> <start_index> <count>');
    process.exit(1);
  }

  const start = parseInt(startArg, 10);
  const count = parseInt(countArg, 10);

  if (isNaN(start) || start < 0) {
    console.error('start_index must be a non-negative integer');
    process.exit(1);
  }
  if (isNaN(count) || count < 1) {
    console.error('count must be a positive integer');
    process.exit(1);
  }

  let xpub = pubkey;
  if (pubkey.startsWith('zpub')) {
    xpub = zpubToXpub(pubkey);
  }

  let node;
  try {
    node = bip32.fromBase58(xpub);
  } catch (e) {
    console.error('Invalid key:', e.message);
    process.exit(1);
  }

  // external chain: m/0/<index>
  const chain = node.derive(0);

  const rows = [];
  for (let i = start; i < start + count; i++) {
    const child = chain.derive(i);
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: Buffer.from(child.publicKey),
      network: bitcoin.networks.bitcoin,
    });
    rows.push(`('${address}', ${i})`);
  }

  console.log('INSERT INTO platform_addresses (address, derivation_index) VALUES');
  for (let i = 0; i < rows.length; i++) {
    const comma = i < rows.length - 1 ? ',' : ';';
    console.log('  ' + rows[i] + comma);
  }
}

main();
