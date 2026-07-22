// ── BIP32 / BIP84 address derivation ─────────────────────────────────────────
// Derives native SegWit (P2WPKH / bech32 bc1q…) addresses from a zpub.
// Only public-key operations are needed: HMAC-SHA512 (WebCrypto) + secp256k1
// point arithmetic (@noble/secp256k1 — pure JS, runs in Workers).
//
// Derivation path: m/0/<index>  (external chain; zpub is already account-level)

import { Point } from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';

const B58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const d = B58_CHARS.indexOf(c);
    if (d < 0) throw new Error('Invalid base58 char: ' + c);
    n = n * 58n + BigInt(d);
  }
  const hex = n.toString(16).padStart(50, '0');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  // prepend leading-zero bytes encoded as '1's
  let leading = 0;
  for (const c of s) { if (c === '1') leading++; else break; }
  const out = new Uint8Array(leading + bytes.length);
  out.set(bytes, leading);
  return out;
}

function b58checkDecode(s) {
  const bytes = b58decode(s);
  // last 4 bytes = checksum; rest = payload
  return bytes.slice(0, -4);
}

// Convert zpub → raw xpub bytes (swap BIP84 version 0x04b24746 → BIP32 0x0488b21e)
function zpubToXpubBytes(zpub) {
  const buf = b58checkDecode(zpub);
  const view = new DataView(buf.buffer, buf.byteOffset);
  view.setUint32(0, 0x0488b21e, false);
  return buf;
}

// Parse a 78-byte BIP32 serialised public key into { depth, childNumber, chainCode, publicKey }
function parseBip32(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return {
    depth:       bytes[4],
    childNumber: view.getUint32(9, false),
    chainCode:   bytes.slice(13, 45),
    publicKey:   bytes.slice(45, 78),
  };
}

// Derive a non-hardened child public key (CKDpub)
function ckdPub(parentKey, index) {
  const data = new Uint8Array(37);
  data.set(parentKey.publicKey, 0);
  new DataView(data.buffer).setUint32(33, index, false);
  const I = hmac(sha512, parentKey.chainCode, data);
  const IL = I.slice(0, 32);
  const IR = I.slice(32);
  // child pubkey = point_add(parent, G * IL)
  let ilBig = 0n;
  for (const b of IL) ilBig = (ilBig << 8n) | BigInt(b);
  const childPoint = Point.fromBytes(parentKey.publicKey).add(Point.BASE.multiply(ilBig));
  return { publicKey: childPoint.toBytes(true), chainCode: IR };
}

// Hash160 = RIPEMD160(SHA256(bytes))
function hash160(bytes) {
  return ripemd160(sha256(bytes));
}

// Encode a P2WPKH (bech32 bc1q…) address from a 20-byte pubKeyHash
function p2wpkhAddress(pubKeyHash) {
  // witness version 0 + 20-byte program → bech32
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const hrp = 'bc';

  function polymod(values) {
    let chk = 1n;
    const GEN = [0x3b6a57b2n, 0x26508e6dn, 0x1ea119fan, 0x3d4233ddn, 0x2a1462b3n];
    for (const v of values) {
      const b = chk >> 25n;
      chk = ((chk & 0x1ffffffn) << 5n) ^ BigInt(v);
      for (let i = 0; i < 5; i++) if ((b >> BigInt(i)) & 1n) chk ^= GEN[i];
    }
    return chk;
  }

  function hrpExpand(hrp) {
    const r = [];
    for (const c of hrp) r.push(c.charCodeAt(0) >> 5);
    r.push(0);
    for (const c of hrp) r.push(c.charCodeAt(0) & 31);
    return r;
  }

  function convertbits(data, frombits, tobits, pad) {
    let acc = 0, bits = 0;
    const ret = [];
    const maxv = (1 << tobits) - 1;
    for (const v of data) {
      acc = (acc << frombits) | v;
      bits += frombits;
      while (bits >= tobits) { bits -= tobits; ret.push((acc >> bits) & maxv); }
    }
    if (pad && bits) ret.push((acc << (tobits - bits)) & maxv);
    return ret;
  }

  const witprog = convertbits(pubKeyHash, 8, 5, true);
  const data = [0, ...witprog]; // witness version 0
  const checksumInput = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(checksumInput) ^ 1n;
  const checksum = [];
  for (let i = 5; i >= 0; i--) checksum.push(Number((mod >> BigInt(i * 5)) & 31n));
  return hrp + '1' + [...data, ...checksum].map(d => CHARSET[d]).join('');
}

// Derive the P2WPKH address at path m/0/<index> from a zpub string
function deriveAddress(zpub, index) {
  const accountBytes = zpubToXpubBytes(zpub);
  const account = parseBip32(accountBytes);
  const chain   = ckdPub(account, 0);      // external chain
  const child   = ckdPub(chain, index);    // receive address at index
  return p2wpkhAddress(hash160(child.publicKey));
}

// Atomically claim the next derivation index, increment it in DB, return derived address.
// BTC_XPUB must be set as a Worker secret (wrangler secret put BTC_XPUB).
async function claimNextAddress(env) {
  if (!env.BTC_XPUB) throw new Error('BTC_XPUB secret not configured');
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key='next_address_index'"
  ).first();
  const index = parseInt(row?.value ?? '0', 10);
  await env.DB.prepare(
    "UPDATE settings SET value=? WHERE key='next_address_index'"
  ).bind(String(index + 1)).run();
  return { address: deriveAddress(env.BTC_XPUB, index), index };
}

// ── Entrypoints ───────────────────────────────────────────────────────────────
// The default export provides two entrypoints consumed by the Cloudflare runtime:
//   • fetch     — handles every HTTP request
//   • scheduled — two cron triggers (see wrangler.toml):
//       */5  * * * *  — expire orders + confirm on-chain payments
//       */30 * * * *  — sync listings from pbtmarketplace.com

export default {

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }
    const response = await env.ASSETS.fetch(request);
    // Add noindex header to admin pages
    if (url.pathname === '/sellerblacklist' || url.pathname === '/sellerblacklist.html') {
      const headers = new Headers(response.headers);
      headers.set('X-Robots-Tag', 'noindex, nofollow');
      return new Response(response.body, { status: response.status, headers });
    }
    if (response.status === 404) {
      const tryUrl = new URL(url.toString());
      if (!tryUrl.pathname.includes('.')) {
        tryUrl.pathname = tryUrl.pathname.replace(/\/$/, '') + '.html';
        const htmlResponse = await env.ASSETS.fetch(new Request(tryUrl.toString()));
        if (htmlResponse.status !== 404) return htmlResponse;
      }
      url.pathname = '/index.html';
      return env.ASSETS.fetch(new Request(url.toString()));
    }
    return response;
  },

  async scheduled(event, env, ctx) {
    if (event.cron === '*/5 * * * *') {
      await expireOrders(env);
      await confirmPayments(env);
    } else if (event.cron === '*/30 * * * *') {
      await syncPbtListings(env);
    }
  }
};

// ── Router ────────────────────────────────────────────────────────────────────

async function handleApi(request, env, url) {
  // Prices
  if (url.pathname === '/api/btc-price' && request.method === 'GET') {
    return handleBtcPrice();
  }

  // Pets
  if (url.pathname === '/api/pets' && request.method === 'GET') {
    return handleListPets(request, env, url);
  }
  const petMatch = url.pathname.match(/^\/api\/pets\/([a-zA-Z0-9-]+)$/);
  if (petMatch && request.method === 'GET') {
    return handleGetPet(request, env, petMatch[1]);
  }
  const petOrderMatch = url.pathname.match(/^\/api\/pets\/([a-zA-Z0-9-]+)\/order$/);
  if (petOrderMatch && request.method === 'POST') {
    return handleCreateOrder(request, env, petOrderMatch[1]);
  }

  // Orders
  const orderMatch = url.pathname.match(/^\/api\/orders\/([a-zA-Z0-9-]+)$/);
  if (orderMatch && request.method === 'GET') {
    return handleGetOrder(request, env, orderMatch[1]);
  }

  // Admin
  if (url.pathname === '/api/admin/address-index' && request.method === 'GET') {
    return handleAddressIndex(request, env);
  }
  if (url.pathname === '/api/admin/seller-blacklist') {
    if (request.method === 'GET')  return handleBlacklistGet(request, env, url);
    if (request.method === 'POST') return handleBlacklistAdd(request, env, url);
  }
  const blMatch = url.pathname.match(/^\/api\/admin\/seller-blacklist\/([^/]+)$/);
  if (blMatch && request.method === 'DELETE') {
    return handleBlacklistRemove(request, env, url, blMatch[1]);
  }
  if (url.pathname === '/api/admin/pbt-debug' && request.method === 'GET') {
    return handlePbtDebug(request, env, url);
  }
  return json({ error: 'Not found' }, 404);
}

// ── Pet handlers ──────────────────────────────────────────────────────────────

const MARKUP_SATS = 1_000_000; // 1M sats added per listing to cover shipping/expenses
const MARKUP_USD = 400; // flat USD added per listing on top of the sats markup

async function fetchBtcUsd() {
  const res = await fetch('https://mempool.space/api/v1/prices');
  if (!res.ok) throw new Error('price fetch failed');
  const { USD } = await res.json();
  if (!USD || USD <= 0) throw new Error('bad price');
  return USD;
}

function applyMarkup(price_usd, btcUsd) {
  return price_usd + MARKUP_USD + (MARKUP_SATS / 1e8) * btcUsd;
}

async function handleListPets(request, env, url) {
  const species = url.searchParams.get('species') || '';
  const page    = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit   = 24;
  const offset  = (page - 1) * limit;

  const speciesFilter = species ? 'AND p.species = ?' : '';
  const binds = species
    ? [species, limit + 1, offset]
    : [limit + 1, offset];

  const rows = await env.DB.prepare(`
    SELECT p.id, p.name, p.species, p.breed, p.gender, p.price_usd, p.created_at,
           p.date_of_birth, p.weight_lbs,
           pp.url AS photo_url
    FROM pets p
    LEFT JOIN pet_pictures pp ON pp.pet_id = p.id AND pp.is_primary = 1
    WHERE p.status = 'available' ${speciesFilter}
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...binds).all();

  let btcUsd = 0;
  try { btcUsd = await fetchBtcUsd(); } catch { /* show base price if fetch fails */ }
  const pets = (rows.results || []).map(p => ({ ...p, price_usd: btcUsd ? applyMarkup(p.price_usd, btcUsd) : p.price_usd }));
  const hasMore = pets.length > limit;
  return json({ pets: hasMore ? pets.slice(0, limit) : pets, hasMore, page });
}

async function handleGetPet(request, env, id) {
  const pet = await env.DB.prepare(
    'SELECT * FROM pets WHERE id = ?'
  ).bind(id).first();

  if (!pet) return json({ error: 'Not found' }, 404);

  const [pics, activeOrder] = await Promise.all([
    env.DB.prepare(
      'SELECT url, is_primary FROM pet_pictures WHERE pet_id = ? ORDER BY is_primary DESC'
    ).bind(id).all(),
    pet.status === 'pending'
      ? env.DB.prepare(
          "SELECT expires_at FROM orders WHERE pet_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1"
        ).bind(id).first()
      : Promise.resolve(null),
  ]);

  let btcUsd = 0;
  try { btcUsd = await fetchBtcUsd(); } catch { /* show base price if fetch fails */ }
  const displayPet = btcUsd ? { ...pet, price_usd: applyMarkup(pet.price_usd, btcUsd) } : pet;
  return json({ pet: displayPet, photos: pics.results || [], order_expires_at: activeOrder?.expires_at ?? null });
}

// ── Orders & Payments ─────────────────────────────────────────────────────────

// Creates a 30-minute Bitcoin invoice for a listing. Derives a fresh BIP32
// address from BTC_XPUB at the next unused index, then flips the pet to 'pending'.
async function handleCreateOrder(request, env, petId) {
  const pet = await env.DB.prepare(
    'SELECT id, name, status, price_usd FROM pets WHERE id = ?'
  ).bind(petId).first();

  if (!pet) return json({ error: 'Listing not found' }, 404);
  if (pet.status !== 'available') return json({ error: 'This listing is no longer available' }, 409);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { buyer_name, buyer_email, buyer_phone, buyer_address1, buyer_address2,
          buyer_city, buyer_state, buyer_zip, buyer_country } = body;

  if (!buyer_name || !buyer_email || !buyer_phone || !buyer_address1 ||
      !buyer_city || !buyer_state || !buyer_zip) {
    return json({ error: 'Name, email, phone, and shipping address are required' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyer_email)) {
    return json({ error: 'Invalid email address' }, 400);
  }

  // Compute BTC amount: convert (base USD + $400 markup) to sats, then add 1M sats markup
  let amountBtc;
  try {
    const USD = await fetchBtcUsd();
    const baseSats = Math.round(((pet.price_usd + MARKUP_USD) / USD) * 1e8);
    amountBtc = (baseSats + MARKUP_SATS) / 1e8;
  } catch {
    return json({ error: 'Could not fetch current BTC price. Please try again.' }, 502);
  }

  // Derive the next fresh address from the xpub HD wallet
  let derived;
  try {
    derived = await claimNextAddress(env);
  } catch (e) {
    return json({ error: 'Payment system not configured. Please contact support.' }, 503);
  }

  const orderId   = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  await env.DB.prepare(`
    INSERT INTO orders (id, pet_id, pay_address, amount_btc, expires_at,
      buyer_name, buyer_email, buyer_phone, buyer_address1, buyer_address2,
      buyer_city, buyer_state, buyer_zip, buyer_country)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    orderId, petId, derived.address, amountBtc, expiresAt,
    buyer_name.trim(), buyer_email.trim().toLowerCase(), buyer_phone.trim(),
    buyer_address1.trim(), buyer_address2 ? buyer_address2.trim() : null,
    buyer_city.trim(), buyer_state.trim(), buyer_zip.trim(),
    buyer_country || 'US'
  ).run();

  await env.DB.prepare(
    "UPDATE pets SET status='pending', updated_at=datetime('now') WHERE id=?"
  ).bind(petId).run();

  return json({
    order: { id: orderId, pay_address: derived.address, amount_btc: amountBtc, expires_at: expiresAt, pet_name: pet.name }
  }, 201);
}

async function handleGetOrder(request, env, orderId) {
  const order = await env.DB.prepare(
    'SELECT id, pet_id, pay_address, amount_btc, status, expires_at, paid_at, tx_id FROM orders WHERE id=?'
  ).bind(orderId).first();
  if (!order) return json({ error: 'Order not found' }, 404);
  return json({ order });
}

// ── Price ─────────────────────────────────────────────────────────────────────

async function handleBtcPrice() {
  try {
    const usd = await fetchBtcUsd();
    return json({ usd });
  } catch {
    return json({ error: 'Could not fetch BTC price' }, 502);
  }
}

// ── Admin ─────────────────────────────────────────────────────────────────────


async function handleAddressIndex(request, env) {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key='next_address_index'"
  ).first();
  return json({ next_address_index: parseInt(row?.value ?? '0', 10) });
}

// ── Admin: seller blacklist ───────────────────────────────────────────────────

function checkAdminToken(request, env, url) {
  const token = env.ADMIN_TOKEN;
  if (!token) return true; // no secret configured — allow
  return url.searchParams.get('token') === token;
}

async function handleBlacklistGet(request, env, url) {
  if (!checkAdminToken(request, env, url)) return json({ error: 'Unauthorized' }, 401);
  const rows = await env.DB.prepare(
    'SELECT username, added_at FROM seller_blacklist ORDER BY added_at DESC'
  ).all();
  return json({ sellers: rows.results || [] });
}

async function handleBlacklistAdd(request, env, url) {
  if (!checkAdminToken(request, env, url)) return json({ error: 'Unauthorized' }, 401);
  const body = await request.json().catch(() => ({}));
  const username = (body.username || '').trim().toLowerCase();
  if (!username) return json({ error: 'username required' }, 400);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO seller_blacklist (username) VALUES (?)"
  ).bind(username).run();
  // Mark any existing available listings from this seller as ended
  await env.DB.prepare(
    "UPDATE pets SET status='ended', updated_at=datetime('now') WHERE pbt_seller=? AND status='available'"
  ).bind(username).run();
  return json({ ok: true, username });
}

async function handleBlacklistRemove(request, env, url, username) {
  if (!checkAdminToken(request, env, url)) return json({ error: 'Unauthorized' }, 401);
  const u = decodeURIComponent(username).toLowerCase();
  await env.DB.prepare('DELETE FROM seller_blacklist WHERE username=?').bind(u).run();
  return json({ ok: true, username: u });
}

// TEMPORARY debug route — re-fetches one PBT listing's raw detail HTML and
// returns snippets around "sex" so we can see the real markup. Remove once
// the sex-field extraction bug is diagnosed.
async function handlePbtDebug(request, env, url) {
  if (!checkAdminToken(request, env, url)) return json({ error: 'Unauthorized' }, 401);
  const pbtId = url.searchParams.get('pbt_id');
  if (!pbtId) return json({ error: 'pbt_id required' }, 400);

  const pet = await env.DB.prepare('SELECT pbt_url FROM pets WHERE pbt_id = ?').bind(pbtId).first();
  if (!pet?.pbt_url) return json({ error: 'Unknown pbt_id' }, 404);

  const cookie = await pbtLogin(env);
  if (!cookie) return json({ error: 'PBT login failed' }, 502);

  const r = await fetch(pet.pbt_url, { headers: { Cookie: cookie } });
  if (!r.ok) return json({ error: `Fetch failed: ${r.status}` }, 502);
  const html = await r.text();

  const snippets = [];
  const re = /sex/gi;
  let m;
  while ((m = re.exec(html)) !== null && snippets.length < 10) {
    snippets.push(html.slice(Math.max(0, m.index - 250), m.index + 100));
  }
  return json({ pbt_url: pet.pbt_url, html_length: html.length, snippets });
}

// ── Cron: order expiry ────────────────────────────────────────────────────────

async function expireOrders(env) {
  const now = new Date().toISOString();
  const expired = await env.DB.prepare(
    "SELECT id, pet_id FROM orders WHERE status='pending' AND expires_at <= ?"
  ).bind(now).all();
  for (const o of (expired.results || [])) {
    await env.DB.prepare("UPDATE orders SET status='expired' WHERE id=?").bind(o.id).run();
    await env.DB.prepare(
      "UPDATE pets SET status='available', updated_at=datetime('now') WHERE id=? AND status='pending'"
    ).bind(o.pet_id).run();
  }
}

// ── Email (Resend) ────────────────────────────────────────────────────────────

async function sendEmail(env, { to, subject, html }) {
  if (!env.BREVO_API_KEY) return;
  const senderEmail = env.BREVO_SENDER_EMAIL || 'orders@bitcoin-pets.com';
  const senderName  = env.BREVO_SENDER_NAME  || 'Bitcoin Pets';
  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
    });
  } catch { /* email is best-effort; never block order processing */ }
}

async function sendOrderPaidEmails(env, orderId, txId) {
  const order = await env.DB.prepare(
    `SELECT o.*, p.name AS pet_name, p.breed, p.species, p.price_usd
     FROM orders o JOIN pets p ON p.id = o.pet_id
     WHERE o.id = ?`
  ).bind(orderId).first();
  if (!order) return;

  const amountBtc = order.amount_btc.toFixed(8);
  const addressLine = [order.buyer_address1, order.buyer_address2].filter(Boolean).join(', ');
  const txLink = `https://mempool.space/tx/${txId}`;

  const buyerHtml = `
    <h2>Your Bitcoin Pets order is confirmed</h2>
    <p>Thanks for your order, ${escapeHtml(order.buyer_name)}! Your payment has been confirmed on the Bitcoin blockchain.</p>
    <h3>Order Summary</h3>
    <ul>
      <li><strong>Pet:</strong> ${escapeHtml(order.pet_name)} (${escapeHtml(order.breed || order.species)})</li>
      <li><strong>Price:</strong> $${order.price_usd.toFixed(2)} USD (${amountBtc} BTC)</li>
      <li><strong>Transaction:</strong> <a href="${txLink}">${txId}</a></li>
    </ul>
    <h3>Shipping To</h3>
    <p>${escapeHtml(order.buyer_name)}<br>
       ${escapeHtml(addressLine)}<br>
       ${escapeHtml(order.buyer_city)}, ${escapeHtml(order.buyer_state)} ${escapeHtml(order.buyer_zip)}<br>
       ${escapeHtml(order.buyer_country)}</p>
    <p>We'll be in touch with delivery updates. Thanks for choosing Bitcoin Pets!</p>
  `;

  const adminHtml = `
    <h2>New paid order</h2>
    <h3>Pet</h3>
    <ul>
      <li><strong>Name:</strong> ${escapeHtml(order.pet_name)}</li>
      <li><strong>Breed/Species:</strong> ${escapeHtml(order.breed || order.species)}</li>
      <li><strong>Price:</strong> $${order.price_usd.toFixed(2)} USD (${amountBtc} BTC)</li>
      <li><strong>Pet ID:</strong> ${escapeHtml(order.pet_id)}</li>
    </ul>
    <h3>Buyer</h3>
    <ul>
      <li><strong>Name:</strong> ${escapeHtml(order.buyer_name)}</li>
      <li><strong>Email:</strong> ${escapeHtml(order.buyer_email)}</li>
      <li><strong>Phone:</strong> ${escapeHtml(order.buyer_phone)}</li>
      <li><strong>Address:</strong> ${escapeHtml(addressLine)}, ${escapeHtml(order.buyer_city)}, ${escapeHtml(order.buyer_state)} ${escapeHtml(order.buyer_zip)}, ${escapeHtml(order.buyer_country)}</li>
    </ul>
    <h3>Payment</h3>
    <ul>
      <li><strong>Order ID:</strong> ${escapeHtml(order.id)}</li>
      <li><strong>Pay Address:</strong> ${escapeHtml(order.pay_address)}</li>
      <li><strong>Transaction:</strong> <a href="${txLink}">${txId}</a></li>
    </ul>
  `;

  await sendEmail(env, {
    to: order.buyer_email,
    subject: `Your Bitcoin Pets order is confirmed — ${order.pet_name}`,
    html: buyerHtml,
  });
  await sendEmail(env, {
    to: 'zenontherocks@gmail.com',
    subject: `New paid order — ${order.pet_name} ($${order.price_usd.toFixed(2)})`,
    html: adminHtml,
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ── Cron: payment confirmation ────────────────────────────────────────────────

async function confirmPayments(env) {
  const now = new Date().toISOString();
  const pending = await env.DB.prepare(
    "SELECT id, pet_id, pay_address, amount_btc FROM orders WHERE status='pending' AND expires_at > ?"
  ).bind(now).all();
  for (const order of (pending.results || [])) {
    try {
      const res = await fetch(
        `https://mempool.space/api/address/${order.pay_address}/txs/chain`
      );
      if (!res.ok) continue;
      const txs = await res.json();
      const targetSats = Math.floor(order.amount_btc * 1e8);
      for (const tx of txs) {
        if (!tx.status?.confirmed) continue;
        const received = (tx.vout || [])
          .filter(o => o.scriptpubkey_address === order.pay_address)
          .reduce((s, o) => s + o.value, 0);
        if (received >= targetSats) {
          await env.DB.prepare(
            "UPDATE orders SET status='paid', tx_id=?, paid_at=datetime('now') WHERE id=?"
          ).bind(tx.txid, order.id).run();
          await env.DB.prepare(
            "UPDATE pets SET status='sold', updated_at=datetime('now') WHERE id=?"
          ).bind(order.pet_id).run();
          await sendOrderPaidEmails(env, order.id, tx.txid);
          break;
        }
      }
    } catch { /* skip on network error — retry next cron run */ }
  }
}

// ── Cron: PBT listing sync ────────────────────────────────────────────────────

async function syncPbtListings(env) {
  if (!env.PBT_EMAIL || !env.PBT_PASSWORD) return; // secrets not configured

  const cookie = await pbtLogin(env);
  if (!cookie) return;

  // Collect all listing IDs from browse pages
  const seen = new Set();
  const listings = [];
  let page = 1;
  while (true) {
    const pageListings = await pbtScrapeBrowse(cookie, page);
    if (pageListings.length === 0) break;
    for (const l of pageListings) {
      if (!seen.has(l.id)) { seen.add(l.id); listings.push(l); }
    }
    // Stop when we hit an empty page (past the last page) or a safety cap
    if (page >= 100) break;
    page++;
  }

  // Load seller blacklist
  const blRows = await env.DB.prepare('SELECT username FROM seller_blacklist').all();
  const blacklist = new Set((blRows.results || []).map(r => r.username));

  // Mark listings no longer on PBT as ended (unless already sold/pending)
  // Also end any available listings from blacklisted sellers
  const pbtIds = listings.map(l => l.id);
  const availableRows = await env.DB.prepare(
    "SELECT pbt_id, pbt_seller FROM pets WHERE status = 'available'"
  ).all();
  for (const row of (availableRows.results || [])) {
    const offPbt = pbtIds.length > 0 && !pbtIds.includes(row.pbt_id);
    const blacklisted = row.pbt_seller && blacklist.has(row.pbt_seller);
    if (offPbt || blacklisted) {
      await env.DB.prepare(
        "UPDATE pets SET status='ended', updated_at=datetime('now') WHERE pbt_id=?"
      ).bind(row.pbt_id).run();
    }
  }

  // Find listings needing a backfill detail scrape: missing photos, breed, gender, or seller
  const backfillRows = await env.DB.prepare(`
    SELECT p.pbt_id FROM pets p
    LEFT JOIN pet_pictures pp ON pp.pet_id = p.id
    WHERE p.status = 'available'
    GROUP BY p.id
    HAVING COUNT(pp.id) = 0 OR p.gender = 'unknown' OR p.breed IS NULL OR p.pbt_seller IS NULL
  `).all();
  const backfillIds = new Set((backfillRows.results || []).map(r => r.pbt_id));

  const allRows = await env.DB.prepare('SELECT pbt_id FROM pets').all();
  const existingIds = new Set((allRows.results || []).map(r => r.pbt_id));

  for (const { id, slug, price_usd } of listings) {
    if (existingIds.has(id)) {
      // Already in DB — update price from browse page if we got one
      if (price_usd && price_usd > 0) {
        try {
          await env.DB.prepare(
            "UPDATE pets SET price_usd=?, status='available', updated_at=datetime('now') WHERE pbt_id=?"
          ).bind(price_usd, id).run();
        } catch { /* ignore */ }
      }
      // Re-fetch detail page to backfill missing fields/photos
      if (backfillIds.has(id)) {
        try {
          const detail = await pbtScrapeDetail(cookie, id, slug);
          if (detail) {
            // Skip if seller is now blacklisted
            if (detail.pbt_seller && blacklist.has(detail.pbt_seller)) {
              await env.DB.prepare(
                "UPDATE pets SET status='ended', updated_at=datetime('now') WHERE pbt_id=?"
              ).bind(id).run();
              continue;
            }
            const petRow = await env.DB.prepare('SELECT id FROM pets WHERE pbt_id=?').bind(id).first();
            if (petRow) {
              // Fill in blanks only — don't overwrite existing values
              await env.DB.prepare(`
                UPDATE pets SET
                  breed      = CASE WHEN breed IS NULL AND ? IS NOT NULL THEN ? ELSE breed END,
                  gender     = CASE WHEN gender = 'unknown' AND ? != 'unknown' THEN ? ELSE gender END,
                  pbt_seller = COALESCE(pbt_seller, ?),
                  updated_at = datetime('now')
                WHERE id = ?
              `).bind(
                detail.breed, detail.breed,
                detail.gender, detail.gender,
                detail.pbt_seller,
                petRow.id
              ).run();
              // Only insert photos if this pet currently has none
              const photoCount = await env.DB.prepare(
                'SELECT COUNT(*) AS n FROM pet_pictures WHERE pet_id=?'
              ).bind(petRow.id).first();
              if ((photoCount?.n ?? 0) === 0 && detail.images?.length) {
                for (let i = 0; i < detail.images.length; i++) {
                  await env.DB.prepare(
                    'INSERT OR IGNORE INTO pet_pictures (id, pet_id, url, is_primary) VALUES (?, ?, ?, ?)'
                  ).bind(crypto.randomUUID(), petRow.id, detail.images[i], i === 0 ? 1 : 0).run();
                }
              }
            }
          }
        } catch { /* ignore */ }
      }
      continue;
    }
    try {
      const detail = await pbtScrapeDetail(cookie, id, slug);
      if (!detail) continue;
      if (detail.pbt_seller && blacklist.has(detail.pbt_seller)) continue;
      await syncPbtListings_upsert(env, detail);
    } catch { /* skip individual failures — will retry next sync */ }
  }
}

async function pbtLogin(env) {
  // No CSRF token; form fields are `username` and `password` (not Email/Password)
  const body = new URLSearchParams({
    username: env.PBT_EMAIL,
    password: env.PBT_PASSWORD,
    returnUrl: '',
    rememberMe: 'false',
  });

  try {
    const r = await fetch('https://pbtmarketplace.com/Account/LogOn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
    });
    const raw = r.headers.get('set-cookie') || '';
    const m = raw.match(/\.AspNet\.ApplicationCookie=([^;]+)/);
    return m ? `.AspNet.ApplicationCookie=${m[1]}` : null;
  } catch { return null; }
}

async function pbtScrapeBrowse(cookie, page) {
  try {
    const url = page > 1
      ? `https://pbtmarketplace.com/Browse?page=${page}`
      : 'https://pbtmarketplace.com/Browse';
    const r = await fetch(url, { headers: { Cookie: cookie } });
    if (!r.ok) return [];
    const html = await r.text();
    const seen = new Set();
    const listings = [];
    const re = /href="\/Listing\/Details\/(\d+)\/([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      // Extract price from card HTML; price lives in <span class="NumberPart">700.00</span>
      const cardHtml = html.slice(m.index, m.index + 1200);
      const priceM = cardHtml.match(/class="NumberPart">([\d,]+(?:\.\d{1,2})?)</);
      const price_usd = priceM ? parseFloat(priceM[1].replace(/,/g, '')) : null;
      listings.push({ id: m[1], slug: m[2], price_usd: price_usd && price_usd > 0 ? price_usd : null });
    }
    return listings;
  } catch { return []; }
}

async function pbtScrapeDetail(cookie, pbtId, slug) {
  const r = await fetch(
    `https://pbtmarketplace.com/Listing/Details/${pbtId}/${slug}`,
    { headers: { Cookie: cookie } }
  );
  if (!r.ok) return null;
  const html = await r.text();

  // Helper: extract text content from first element with a given class.
  // Tolerant of extra classes on the element and nested markup (icons, links)
  // inside the value, since not every field is a bare text node.
  function extract(cls) {
    const openMatch = html.match(new RegExp(`<(\\w+)[^>]*\\bclass="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, 'i'));
    if (!openMatch) return null;
    const tag = openMatch[1];
    const rest = html.slice(openMatch.index + openMatch[0].length);
    const closeMatch = rest.match(new RegExp(`<\\/${tag}>`, 'i'));
    const inner = closeMatch ? rest.slice(0, closeMatch.index) : rest.slice(0, 300);
    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return text || null;
  }

  // Price: use buy-now price from data-price attribute (the fixed sale price)
  const priceMatch = html.match(/data-price="([\d.]+)"/);
  if (!priceMatch) return null; // can't list without a price
  const price_usd = parseFloat(priceMatch[1]);
  if (!price_usd || price_usd <= 0) return null;

  const ageStr    = extract('listing-details-age');
  const breedRaw  = extract('listing-details-breed');
  const breed     = breedRaw && !breedRaw.includes('Unlisted') ? breedRaw : null;
  const registry  = extract('listing-details-registry');
  const weightStr = extract('listing-details-weight');
  const color     = extract('listing-details-color');

  // Gender: from class content, fall back to slug
  const sexRaw = extract('listing-details-sex');
  let gender = 'unknown';
  if (sexRaw) {
    if (/female/i.test(sexRaw)) gender = 'female';
    else if (/male/i.test(sexRaw)) gender = 'male';
  } else if (/-female/i.test(slug)) { gender = 'female'; }
  else if (/-male/i.test(slug)) { gender = 'male'; }

  // Species: feline category or cat-breed keywords → cat, else dog
  const isFeline = /feline|kitten|siamese|persian|maine.?coon|ragdoll|bengal/i.test(html);
  const species = isFeline ? 'cat' : 'dog';

  // Name: humanize the slug (strip trailing -female/-male, capitalize words)
  const nameParts = slug
    .replace(/-female$|-male$/i, '')
    .split('-')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1));
  const name = nameParts.join(' ') || slug;

  // Date of birth: compute from "9 Weeks 4 Days" age string
  const date_of_birth = pbtAgeToDateOfBirth(ageStr);

  // Weight in lbs from "2 lbs 9 oz"
  const weight_lbs = pbtWeightToLbs(weightStr);

  // Images: get fullsize S3 URLs; first is primary
  const images = [];
  const imgRe = /<img\s[^>]*src="(https:\/\/pbt-upload-production\.s3[^"]+_fullsize\.jpg)"[^>]*>/g;
  let im;
  while ((im = imgRe.exec(html)) !== null) {
    images.push(im[1]);
  }

  // Vaccinations: collect vaccine name + administered date pairs
  const vaccines = [];
  const vaccineRe = /class="vaccine-name">([^<]+)<[\s\S]*?class="vaccine-administered-date">([^<]+)</g;
  let vm;
  while ((vm = vaccineRe.exec(html)) !== null) {
    vaccines.push(`${vm[1].trim()} (${vm[2].trim()})`);
  }
  const vaccinations = vaccines.length > 0 ? vaccines.join('\n') : null;

  // Seller: extract username from /Member/Profile/{username} link
  const sellerM = html.match(/href="\/Member\/Profile\/([^"/?]+)"/i);
  const pbt_seller = sellerM ? sellerM[1].toLowerCase() : null;

  return {
    pbt_id: pbtId,
    pbt_url: `https://pbtmarketplace.com/Listing/Details/${pbtId}/${slug}`,
    name, species, breed, gender, color,
    date_of_birth, weight_lbs,
    registry_name: registry || null,
    price_usd,
    vaccinations,
    images,
    pbt_seller,
  };
}

async function syncPbtListings_upsert(env, listing) {
  const existing = await env.DB.prepare(
    'SELECT id FROM pets WHERE pbt_id = ?'
  ).bind(listing.pbt_id).first();

  if (existing) {
    // Update price and status only (other fields rarely change)
    await env.DB.prepare(
      "UPDATE pets SET price_usd=?, status='available', updated_at=datetime('now') WHERE pbt_id=?"
    ).bind(listing.price_usd, listing.pbt_id).run();
    return;
  }

  // New listing: insert pet + pictures
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO pets (id, pbt_id, pbt_url, name, species, breed, date_of_birth, weight_lbs,
      gender, color, vaccinations, registry_name, price_usd, pbt_seller)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, listing.pbt_id, listing.pbt_url, listing.name, listing.species,
    listing.breed, listing.date_of_birth, listing.weight_lbs,
    listing.gender, listing.color, listing.vaccinations,
    listing.registry_name, listing.price_usd, listing.pbt_seller || null
  ).run();

  for (let i = 0; i < listing.images.length; i++) {
    await env.DB.prepare(
      'INSERT INTO pet_pictures (id, pet_id, url, is_primary) VALUES (?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), id, listing.images[i], i === 0 ? 1 : 0).run();
  }
}

// ── PBT parsing helpers ───────────────────────────────────────────────────────

function pbtAgeToDateOfBirth(ageStr) {
  if (!ageStr) return null;
  let days = 0;
  const yr  = ageStr.match(/(\d+)\s*year/i);
  const mo  = ageStr.match(/(\d+)\s*month/i);
  const wk  = ageStr.match(/(\d+)\s*week/i);
  const dy  = ageStr.match(/(\d+)\s*day/i);
  if (yr) days += parseInt(yr[1]) * 365;
  if (mo) days += parseInt(mo[1]) * 30;
  if (wk) days += parseInt(wk[1]) * 7;
  if (dy) days += parseInt(dy[1]);
  if (days === 0) return null;
  return new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
}

function pbtWeightToLbs(weightStr) {
  if (!weightStr) return null;
  const lbsM = weightStr.match(/(\d+)\s*lbs?/i);
  const ozM  = weightStr.match(/(\d+)\s*oz/i);
  let lbs = lbsM ? parseFloat(lbsM[1]) : 0;
  if (ozM) lbs += parseFloat(ozM[1]) / 16;
  return lbs > 0 ? Math.round(lbs * 100) / 100 : null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
