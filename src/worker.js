// ── Entrypoints ───────────────────────────────────────────────────────────────
// The default export provides two entrypoints consumed by the Cloudflare runtime:
//   • fetch    — handles every HTTP request
//   • scheduled — runs on the cron trigger defined in wrangler.toml (every 5 min)

export default {

  // Routes /api/* to handleApi(); all other paths are served from static assets
  // (public/ folder) via env.ASSETS. Pretty-URL fallback: /browse → /browse.html.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }

    const response = await env.ASSETS.fetch(request);
    if (response.status === 404) {
      // Try pretty URL: /pet -> /pet.html, /browse -> /browse.html, etc.
      const tryUrl = new URL(url.toString());
      if (!tryUrl.pathname.includes('.')) {
        tryUrl.pathname = tryUrl.pathname.replace(/\/$/, '') + '.html';
        const htmlResponse = await env.ASSETS.fetch(new Request(tryUrl.toString()));
        if (htmlResponse.status !== 404) return htmlResponse;
      }
      // Final fallback: serve index.html (SPA-style catch-all)
      url.pathname = '/index.html';
      return env.ASSETS.fetch(new Request(url.toString()));
    }
    return response;
  },

  // Cron job — runs every 5 minutes (see wrangler.toml).
  // Two passes each run:
  //   1. Expire orders whose 30-minute window has elapsed → revert pet to 'available'
  //   2. Poll mempool.space for confirmed on-chain payments → mark order 'paid' + pet 'sold'
  async scheduled(event, env, ctx) {
    const now = new Date().toISOString();

    // Pass 1: expire overdue orders and revert pet status to 'available'
    const expired = await env.DB.prepare(
      "SELECT id, pet_id FROM orders WHERE status='pending' AND expires_at <= ?"
    ).bind(now).all();
    for (const o of (expired.results || [])) {
      await env.DB.prepare("UPDATE orders SET status='expired' WHERE id=?").bind(o.id).run();
      await env.DB.prepare(
        "UPDATE pets SET status='available', updated_at=datetime('now') WHERE id=? AND status='pending'"
      ).bind(o.pet_id).run();
    }

    // Pass 2: check still-pending orders against mempool.space confirmed transactions.
    // For each order, sum all vout values sent to the payment address and compare
    // against the required sats amount. First matching confirmed tx marks it paid.
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
          // Sum all outputs sent to this address in the transaction
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
            break; // first matching tx is sufficient
          }
        }
      } catch { /* skip on network error — will retry next cron run */ }
    }
  }
};

// ── Router ────────────────────────────────────────────────────────────────────
// Manual router: matches URL patterns with === or RegExp.match().
// Routes are checked top-to-bottom; the first match wins.
// All handler functions follow the pattern: handleXxx(request, env, ...params).

async function handleApi(request, env, url) {
  // Auth
  if (url.pathname === '/api/register' && request.method === 'POST') {
    return handleRegister(request, env);
  }
  if (url.pathname === '/api/login' && request.method === 'POST') {
    return handleLogin(request, env);
  }
  if (url.pathname === '/api/logout' && request.method === 'POST') {
    return handleLogout(request, env);
  }
  if (url.pathname === '/api/me' && request.method === 'GET') {
    return handleMe(request, env);
  }

  // Account
  if (url.pathname === '/api/account/pets' && request.method === 'GET') {
    return handleGetAccountPets(request, env);
  }
  if (url.pathname === '/api/account' && request.method === 'GET') {
    return handleGetAccount(request, env);
  }
  if (url.pathname === '/api/account' && request.method === 'PUT') {
    return handleUpdateAccount(request, env);
  }
  if (url.pathname === '/api/account/password' && request.method === 'PUT') {
    return handleChangePassword(request, env);
  }

  // Prices
  if (url.pathname === '/api/btc-price' && request.method === 'GET') {
    return handleBtcPrice();
  }

  // Pets — list and create
  if (url.pathname === '/api/pets' && request.method === 'GET') {
    return handleListPets(request, env, url);
  }
  if (url.pathname === '/api/pets' && request.method === 'POST') {
    return handleCreatePet(request, env);
  }

  // Pets — single item (GET/DELETE by id)
  const petMatch = url.pathname.match(/^\/api\/pets\/([a-zA-Z0-9-]+)$/);
  if (petMatch && request.method === 'GET') {
    return handleGetPet(request, env, petMatch[1]);
  }
  if (petMatch && request.method === 'DELETE') {
    return handleEndListing(request, env, petMatch[1]);
  }

  // Pets — image management and order creation
  const petImagesMatch = url.pathname.match(/^\/api\/pets\/([a-zA-Z0-9-]+)\/images$/);
  if (petImagesMatch && request.method === 'POST') {
    return handleAddPetImages(request, env, petImagesMatch[1]);
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

  // Images
  if (url.pathname === '/api/images/upload' && request.method === 'POST') {
    return handleImageUpload(request, env);
  }
  if (url.pathname.startsWith('/api/images/') && request.method === 'GET') {
    // Strip the /api/images/ prefix to get the R2 key
    return handleServeImage(env, url.pathname.slice('/api/images/'.length));
  }

  return json({ error: 'Not found' }, 404);
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

// Reads the 'session' cookie, validates it against the sessions table,
// and returns { user_id, username, email } or null if invalid/expired.
// Every protected route calls this first and returns 401 if it returns null.
async function getSession(request, env) {
  const sessionId = getCookie(request, 'session');
  if (!sessionId) return null;
  const session = await env.DB.prepare(
    "SELECT s.user_id, u.username, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > datetime('now') LIMIT 1"
  ).bind(sessionId).first();
  return session || null;
}

// ── Auth handlers ─────────────────────────────────────────────────────────────

async function handleRegister(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { username, email, password } = body;

  if (!username || !email || !password) {
    return json({ error: 'username, email, and password are required' }, 400);
  }
  if (username.length < 3 || username.length > 32) {
    return json({ error: 'Username must be 3-32 characters' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Invalid email address' }, 400);
  }
  if (password.length < 8) {
    return json({ error: 'Password must be at least 8 characters' }, 400);
  }

  const passwordHash = await hashPassword(password);
  const id = crypto.randomUUID();

  try {
    await env.DB.prepare(
      'INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)'
    ).bind(id, username.trim(), email.trim().toLowerCase(), passwordHash).run();
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return json({ error: 'Username or email is already taken' }, 409);
    }
    return json({ error: 'Registration failed. Please try again.' }, 500);
  }

  return json({ success: true }, 201);
}

// Accepts email or username as the login identifier.
// Returns a Set-Cookie header with a 30-day session token on success.
// Note: uses new Response() directly (not json()) because json() doesn't
// support extra headers and we need to set Set-Cookie here.
async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { login, password } = body;
  if (!login || !password) {
    return json({ error: 'Email/username and password are required' }, 400);
  }

  const loginVal = login.trim().toLowerCase();
  const user = await env.DB.prepare(
    'SELECT id, password_hash FROM users WHERE email = ? OR LOWER(username) = ? LIMIT 1'
  ).bind(loginVal, loginVal).first();

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return json({ error: 'Invalid email or password' }, 401);
  }

  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(sessionId, user.id, expiresAt).run();

  // Must use new Response() here (not json()) to include the Set-Cookie header
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `session=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${new Date(expiresAt).toUTCString()}`
    }
  });
}

// Deletes the session from the DB and clears the cookie by setting it expired.
// Note: uses new Response() directly for the same reason as handleLogin above.
async function handleLogout(request, env) {
  const sessionId = getCookie(request, 'session');
  if (sessionId) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
  }
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': 'session=; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    }
  });
}

// Returns the currently logged-in user's username and email.
// Returns { user: null } (not 401) so the navbar can safely call this
// without triggering error handling on unauthenticated pages.
async function handleMe(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ user: null }, 200);
  return json({ user: { username: session.username, email: session.email } });
}

// ── Account handlers ──────────────────────────────────────────────────────────

// Returns full profile data for the logged-in user (excluding password_hash).
async function handleGetAccount(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  const user = await env.DB.prepare(
    'SELECT id, username, email, phone, address_line1, address_line2, city, state, zip_code, country, bitcoin_address, created_at FROM users WHERE username = ?'
  ).bind(session.username).first();
  if (!user) return json({ error: 'Not found' }, 404);
  return json({ user });
}

// Updates mutable profile fields. email and country use COALESCE so that
// omitting them from the request body leaves the existing value in place.
async function handleUpdateAccount(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { email, phone, address_line1, address_line2, city, state, zip_code, country, bitcoin_address } = body;

  if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Invalid email address' }, 400);
  }

  try {
    await env.DB.prepare(`
      UPDATE users SET
        email = COALESCE(?, email),
        phone = ?,
        address_line1 = ?,
        address_line2 = ?,
        city = ?,
        state = ?,
        zip_code = ?,
        country = COALESCE(?, country),
        bitcoin_address = ?,
        updated_at = datetime('now')
      WHERE username = ?
    `).bind(
      email ? email.trim().toLowerCase() : null,
      phone || null, address_line1 || null, address_line2 || null,
      city || null, state || null, zip_code || null,
      country || null, bitcoin_address || null,
      session.username
    ).run();
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return json({ error: 'Email already in use' }, 409);
    throw e;
  }

  return json({ success: true });
}

// Verifies the current password with PBKDF2 then stores the new hash.
// Both verification and hashing use the shared helpers so the format
// (pbkdf2:salt:hash) stays consistent with registration and login.
async function handleChangePassword(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { current_password, new_password } = body;
  if (!current_password || !new_password) return json({ error: 'current_password and new_password are required' }, 400);
  if (new_password.length < 8) return json({ error: 'New password must be at least 8 characters' }, 400);

  const user = await env.DB.prepare('SELECT id, password_hash FROM users WHERE username = ?').bind(session.username).first();
  if (!user) return json({ error: 'Not found' }, 404);

  if (!(await verifyPassword(current_password, user.password_hash))) {
    return json({ error: 'Current password is incorrect' }, 400);
  }

  const newHash = await hashPassword(new_password);
  await env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").bind(newHash, user.id).run();
  return json({ success: true });
}

// Returns the logged-in user's own listings with their primary photo and any
// active pending-order expiry time (for the account dashboard countdown).
async function handleGetAccountPets(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const userRow = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(session.username).first();
  if (!userRow) return json({ error: 'Not found' }, 404);

  const rows = await env.DB.prepare(`
    SELECT p.id, p.name, p.species, p.breed, p.price_btc, p.status, p.created_at,
           pp.url AS photo_url,
           o.expires_at AS order_expires_at
    FROM pets p
    LEFT JOIN pet_pictures pp ON pp.pet_id = p.id AND pp.is_primary = 1
    LEFT JOIN orders o ON o.pet_id = p.id AND o.status = 'pending'
    WHERE p.user_id = ?
    ORDER BY p.created_at DESC
  `).bind(userRow.id).all();

  return json({ pets: rows.results || [] });
}

// ── Pet handlers ──────────────────────────────────────────────────────────────

// Paginated listing of available pets with optional species filter.
// Fetches limit+1 rows to cheaply determine whether a next page exists
// without running a separate COUNT query.
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
    SELECT p.id, p.name, p.species, p.breed, p.gender, p.price_btc, p.price_usd, p.price_currency, p.created_at,
           pp.url AS photo_url, u.username AS seller
    FROM pets p
    LEFT JOIN pet_pictures pp ON pp.pet_id = p.id AND pp.is_primary = 1
    JOIN users u ON u.id = p.user_id
    WHERE p.status = 'available' ${speciesFilter}
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...binds).all();

  const pets = rows.results || [];
  const hasMore = pets.length > limit;
  return json({ pets: hasMore ? pets.slice(0, limit) : pets, hasMore, page });
}

// Returns a single pet with all photos and the active order's expiry time
// (used by pet.html to show the pending countdown). The photos and pending
// order are fetched in parallel to minimize latency.
async function handleGetPet(request, env, id) {
  const pet = await env.DB.prepare(`
    SELECT p.*, u.username AS seller,
      COALESCE(p.bitcoin_address, u.bitcoin_address) AS seller_btc
    FROM pets p
    JOIN users u ON u.id = p.user_id
    WHERE p.id = ?
  `).bind(id).first();

  if (!pet) return json({ error: 'Not found' }, 404);

  const [pics, activeOrder] = await Promise.all([
    env.DB.prepare(
      'SELECT url, is_primary FROM pet_pictures WHERE pet_id = ? ORDER BY is_primary DESC'
    ).bind(id).all(),
    // Only query for an active order if the pet is currently pending
    pet.status === 'pending'
      ? env.DB.prepare(
          "SELECT expires_at FROM orders WHERE pet_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1"
        ).bind(id).first()
      : Promise.resolve(null),
  ]);

  return json({ pet, photos: pics.results || [], order_expires_at: activeOrder?.expires_at ?? null });
}

// Creates a new pet listing. Accepts up to 5 photo keys (already uploaded to R2
// via /api/images/upload) and stores them as pet_pictures rows.
// The per-listing bitcoin_address overrides the user's account-level address at order time.
async function handleCreatePet(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'You must be signed in to create a listing' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { name, species, breed, date_of_birth, weight_lbs, gender, color,
          description, health_info, vaccinations, registry_name,
          registry_number, microchip_id, price_btc, price_usd, price_currency,
          bitcoin_address, photo_keys } = body;

  if (!name || !name.trim()) return json({ error: 'Pet name is required' }, 400);
  if (!species || !species.trim()) return json({ error: 'Species is required' }, 400);
  if (price_btc == null || isNaN(Number(price_btc)) || Number(price_btc) < 0) {
    return json({ error: 'A valid price in BTC is required' }, 400);
  }
  // price_currency determines which price field is the canonical anchor:
  // 'usd' = USD amount is fixed, BTC amount is recalculated at order time;
  // 'btc' = BTC amount is fixed.
  const anchorCurrency = price_currency === 'usd' ? 'usd' : 'btc';

  // Look up user_id from username stored in session
  const userRow = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(session.username).first();
  if (!userRow) return json({ error: 'User not found' }, 500);

  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO pets (id, user_id, name, species, breed, date_of_birth, weight_lbs,
      gender, color, description, health_info, vaccinations,
      registry_name, registry_number, microchip_id, price_btc, price_usd, price_currency, bitcoin_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, userRow.id,
    name.trim(), species.trim(),
    breed || null, date_of_birth || null,
    weight_lbs ? Number(weight_lbs) : null,
    gender || null, color || null,
    description || null, health_info || null,
    vaccinations || null, registry_name || null,
    registry_number || null, microchip_id || null,
    Number(price_btc),
    (price_usd != null && !isNaN(Number(price_usd))) ? Number(price_usd) : null,
    anchorCurrency,
    bitcoin_address || null
  ).run();

  // Sanitize photo keys before storing — only alphanumeric, dot, hyphen, underscore
  if (Array.isArray(photo_keys) && photo_keys.length > 0) {
    const keys = photo_keys.slice(0, 5); // cap at 5 photos per listing
    for (let i = 0; i < keys.length; i++) {
      const key = String(keys[i]).replace(/[^a-zA-Z0-9.\-_]/g, '');
      if (!key) continue;
      await env.DB.prepare(
        'INSERT INTO pet_pictures (id, pet_id, url, is_primary) VALUES (?, ?, ?, ?)'
      ).bind(crypto.randomUUID(), id, `/api/images/${key}`, i === 0 ? 1 : 0).run();
    }
  }

  return json({ success: true, id }, 201);
}

// Marks an available listing as 'ended' (soft delete — stays in DB but hidden from browse).
// Only the listing's owner can end it, and only while it is in 'available' status.
async function handleEndListing(request, env, petId) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const userRow = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(session.username).first();
  if (!userRow) return json({ error: 'Not found' }, 404);

  const pet = await env.DB.prepare('SELECT id, status, user_id FROM pets WHERE id = ?').bind(petId).first();
  if (!pet) return json({ error: 'Listing not found' }, 404);
  if (pet.user_id !== userRow.id) return json({ error: 'Forbidden' }, 403);
  if (pet.status !== 'available') return json({ error: 'Only available listings can be ended' }, 409);

  await env.DB.prepare(
    "UPDATE pets SET status='ended', updated_at=datetime('now') WHERE id=?"
  ).bind(petId).run();

  return json({ success: true });
}

// Replaces all photos for a listing. Deletes existing pet_pictures rows and
// inserts new ones from the provided R2 keys. The first key becomes the primary photo.
// Only the listing's owner can update photos.
async function handleAddPetImages(request, env, petId) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const userRow = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(session.username).first();
  if (!userRow) return json({ error: 'Not found' }, 404);

  const pet = await env.DB.prepare('SELECT id, user_id FROM pets WHERE id = ?').bind(petId).first();
  if (!pet) return json({ error: 'Listing not found' }, 404);
  if (pet.user_id !== userRow.id) return json({ error: 'Forbidden' }, 403);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { photo_keys } = body;
  if (!Array.isArray(photo_keys) || photo_keys.length === 0) {
    return json({ error: 'No photos provided' }, 400);
  }

  await env.DB.prepare('DELETE FROM pet_pictures WHERE pet_id = ?').bind(petId).run();
  const keys = photo_keys.slice(0, 5); // cap at 5 photos
  for (let i = 0; i < keys.length; i++) {
    const key = String(keys[i]).replace(/[^a-zA-Z0-9.\-_]/g, '');
    if (!key) continue;
    await env.DB.prepare(
      'INSERT INTO pet_pictures (id, pet_id, url, is_primary) VALUES (?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), petId, `/api/images/${key}`, i === 0 ? 1 : 0).run();
  }

  return json({ success: true });
}

// ── Orders & Payments ─────────────────────────────────────────────────────────

// Creates a 30-minute payment invoice for a listing. Flips the pet status to
// 'pending' so no other buyer can start a competing order.
// For USD-anchored listings the BTC amount is computed live from mempool.space
// at order creation time; the stored price_btc is the fallback.
async function handleCreateOrder(request, env, petId) {
  // Prefer the listing's own bitcoin_address; fall back to the seller's account address
  const pet = await env.DB.prepare(`
    SELECT p.id, p.name, p.status, p.price_btc, p.price_usd, p.price_currency,
      COALESCE(p.bitcoin_address, u.bitcoin_address) AS pay_address
    FROM pets p JOIN users u ON u.id = p.user_id
    WHERE p.id = ?
  `).bind(petId).first();

  if (!pet) return json({ error: 'Listing not found' }, 404);
  if (pet.status !== 'available') return json({ error: 'This listing is no longer available' }, 409);
  const payAddress = pet.pay_address;
  if (!payAddress) {
    return json({ error: 'Seller has not set a Bitcoin address for this listing. Contact them directly.' }, 422);
  }

  // For USD-anchored listings, compute the BTC amount at current market price
  let amountBtc = pet.price_btc;
  if (pet.price_currency === 'usd' && pet.price_usd) {
    try {
      const priceRes = await fetch('https://mempool.space/api/v1/prices');
      if (priceRes.ok) {
        const priceData = await priceRes.json();
        const btcUsd = priceData.USD;
        if (btcUsd && btcUsd > 0) {
          // Round to nearest satoshi (1e8 sats per BTC)
          amountBtc = Math.round((pet.price_usd / btcUsd) * 1e8) / 1e8;
        }
      }
    } catch { /* fall back to stored price_btc if price feed is unavailable */ }
  }

  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 minutes

  await env.DB.prepare(
    "INSERT INTO orders (id, pet_id, pay_address, amount_btc, expires_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, petId, payAddress, amountBtc, expiresAt).run();

  await env.DB.prepare(
    "UPDATE pets SET status='pending', updated_at=datetime('now') WHERE id=?"
  ).bind(petId).run();

  return json({ order: { id, pay_address: payAddress, amount_btc: amountBtc, expires_at: expiresAt, pet_name: pet.name } }, 201);
}

// Returns the current state of an order. Polled by pet.html every 30 seconds
// after the invoice modal is opened to detect confirmed payments.
async function handleGetOrder(request, env, orderId) {
  const order = await env.DB.prepare(
    "SELECT id, pet_id, pay_address, amount_btc, status, expires_at, paid_at, tx_id FROM orders WHERE id=?"
  ).bind(orderId).first();
  if (!order) return json({ error: 'Order not found' }, 404);
  return json({ order });
}

// Fetches the current BTC/USD price from mempool.space.
// Used by browse.html, pet.html, and sell.html to show USD equivalents.
async function handleBtcPrice() {
  try {
    const res = await fetch('https://mempool.space/api/v1/prices');
    if (!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    return json({ usd: data.USD });
  } catch {
    return json({ error: 'Could not fetch BTC price' }, 502);
  }
}

// ── Images ────────────────────────────────────────────────────────────────────

// Accepts a single image file via multipart/form-data, validates type and size,
// stores it in the R2 bucket, and returns the key + serving URL.
// Images are always referenced via /api/images/:key (never direct R2 URLs)
// so the Worker controls caching and access.
async function handleImageUpload(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('multipart/form-data')) {
    return json({ error: 'Expected multipart/form-data' }, 400);
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: 'Invalid form data' }, 400);
  }

  const file = formData.get('image');
  if (!file || typeof file.arrayBuffer !== 'function') {
    return json({ error: 'No image provided' }, 400);
  }

  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowed.includes(file.type)) {
    return json({ error: 'Only JPEG, PNG, WebP, and GIF images are accepted' }, 400);
  }

  const maxSize = 5 * 1024 * 1024; // 5 MB
  if (file.size > maxSize) {
    return json({ error: 'Image must be under 5 MB' }, 400);
  }

  const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  const key = `${crypto.randomUUID()}.${extMap[file.type]}`;

  await env.IMAGES.put(key, file.stream(), {
    httpMetadata: { contentType: file.type }
  });

  return json({ key, url: `/api/images/${key}` }, 201);
}

// Serves an image from R2 with a 1-year immutable cache header.
// Key is sanitized before use to prevent path traversal or injection.
async function handleServeImage(env, key) {
  const safeKey = key.replace(/[^a-zA-Z0-9.\-_]/g, '');
  if (!safeKey) return new Response('Not found', { status: 404 });

  const obj = await env.IMAGES.get(safeKey);
  if (!obj) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers); // copies Content-Type from R2 metadata
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { headers });
}

// ── Crypto helpers ────────────────────────────────────────────────────────────
// PBKDF2 with 100,000 iterations and a random 16-byte salt.
// Stored format: "pbkdf2:<saltHex>:<hashHex>"
// Use these functions for ALL password operations — never raw SHA-256.

async function hashPassword(password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  const hex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2:${hex(salt.buffer)}:${hex(bits)}`;
}

// Extracts the salt from storedHash, re-derives the hash, and compares.
// Returns true if the password matches, false otherwise.
async function verifyPassword(password, storedHash) {
  const [, saltHex, hashHex] = storedHash.split(':');
  const enc = new TextEncoder();
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  const hex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex(bits) === hashHex;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

// Parses a single named cookie from the Cookie request header.
function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const match = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? match[1] : null;
}

// Standard JSON response helper. All API responses go through this function
// (except handleLogin/handleLogout which need to set Set-Cookie headers).
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
