#!/usr/bin/env node
/**
 * Derive P2WPKH (native SegWit / bech32) addresses from an xpub.
 *
 * Usage:
 *   node scripts/derive-addresses.js <xpub> <start_index> <count>
 *
 * Outputs SQL INSERT statements to stdout. Pipe into wrangler to seed the DB:
 *   node scripts/derive-addresses.js xpub6C... 0 100 | \
 *     wrangler d1 execute bitcoin-pets --file=-
 *
 * Dependencies (install locally before running):
 *   npm install bitcoinjs-lib @bitcoinerlab/secp256k1 tiny-secp256k1
 *
 * The derivation path used is m/0/<index>  (external chain, no hardened steps)
 * because xpub is already the account-level key.  This matches the standard
 * BIP84 receive-address derivation used by most wallets.
 */

'use strict';

const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { BIP32Factory } = require('bip32');

const bip32 = BIP32Factory(ecc);

function main() {
  const [,, xpub, startArg, countArg] = process.argv;

  if (!xpub || !startArg || !countArg) {
    console.error('Usage: node derive-addresses.js <xpub> <start_index> <count>');
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

  let node;
  try {
    node = bip32.fromBase58(xpub);
  } catch (e) {
    console.error('Invalid xpub:', e.message);
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
