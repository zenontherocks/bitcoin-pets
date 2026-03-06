export default {
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
      url.pathname = '/index.html';
      return env.ASSETS.fetch(new Request(url.toString()));
    }
    return response;
  },

  async scheduled(event, env, ctx) {
    const now = new Date().toISOString();

    // Expire overdue orders and revert pet status to available
    const expired = await env.DB.prepare(
      "SELECT id, pet_id FROM orders WHERE status='pending' AND expires_at <= ?"
    ).bind(now).all();
    for (const o of (expired.results || [])) {
      await env.DB.prepare("UPDATE orders SET status='expired' WHERE id=?").bind(o.id).run();
      await env.DB.prepare(
        "UPDATE pets SET status='available', updated_at=datetime('now') WHERE id=? AND status='pending'"
      ).bind(o.pet_id).run();
    }

    // Check pending orders against mempool.space
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
            break;
          }
        }
      } catch { /* skip on network error — will retry next cron run */ }
    }
  }
};

async function handleApi(request, env, url) {
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
  if (url.pathname === '/api/account' && request.method === 'GET') {
    return handleGetAccount(request, env);
  }
  if (url.pathname === '/api/account' && request.method === 'PUT') {
    return handleUpdateAccount(request, env);
  }
  if (url.pathname === '/api/account/password' && request.method === 'PUT') {
    return handleChangePassword(request, env);
  }
  if (url.pathname === '/api/pets' && request.method === 'GET') {
    return handleListPets(request, env, url);
  }
  const petMatch = url.pathname.match(/^\/api\/pets\/([a-zA-Z0-9-]+)$/);
  if (petMatch && request.method === 'GET') {
    return handleGetPet(request, env, petMatch[1]);
  }
  if (url.pathname === '/api/pets' && request.method === 'POST') {
    return handleCreatePet(request, env);
  }
  const petOrderMatch = url.pathname.match(/^\/api\/pets\/([a-zA-Z0-9-]+)\/order$/);
  if (petOrderMatch && request.method === 'POST') {
    return handleCreateOrder(request, env, petOrderMatch[1]);
  }
  const orderMatch = url.pathname.match(/^\/api\/orders\/([a-zA-Z0-9-]+)$/);
  if (orderMatch && request.method === 'GET') {
    return handleGetOrder(request, env, orderMatch[1]);
  }
  if (url.pathname === '/api/images/upload' && request.method === 'POST') {
    return handleImageUpload(request, env);
  }
  if (url.pathname.startsWith('/api/images/') && request.method === 'GET') {
    return handleServeImage(env, url.pathname.slice('/api/images/'.length));
  }
  return json({ error: 'Not found' }, 404);
}

async function getSession(request, env) {
  const sessionId = getCookie(request, 'session');
  if (!sessionId) return null;
  const session = await env.DB.prepare(
    "SELECT s.user_id, u.username, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > datetime('now') LIMIT 1"
  ).bind(sessionId).first();
  return session || null;
}

async function handleListPets(request, env, url) {
  const species = url.searchParams.get('species') || '';
  const page    = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit   = 24;
  const offset  = (page - 1) * limit;

  const speciesFilter = species ? 'AND p.species = ?' : '';
  const binds = species
    ? [limit + 1, offset, species]
    : [limit + 1, offset];

  const rows = await env.DB.prepare(`
    SELECT p.id, p.name, p.species, p.breed, p.gender, p.price_btc, p.created_at,
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

async function handleGetAccount(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  const user = await env.DB.prepare(
    'SELECT id, username, email, phone, address_line1, address_line2, city, state, zip_code, country, bitcoin_address, created_at FROM users WHERE username = ?'
  ).bind(session.username).first();
  if (!user) return json({ error: 'Not found' }, 404);
  return json({ user });
}

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

  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(current_password));
  const currentHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (currentHash !== user.password_hash) return json({ error: 'Current password is incorrect' }, 400);

  const newHashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(new_password));
  const newHash = Array.from(new Uint8Array(newHashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  await env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").bind(newHash, user.id).run();
  return json({ success: true });
}

async function handleGetPet(request, env, id) {
  const pet = await env.DB.prepare(`
    SELECT p.*, u.username AS seller,
      COALESCE(p.bitcoin_address, u.bitcoin_address) AS seller_btc
    FROM pets p
    JOIN users u ON u.id = p.user_id
    WHERE p.id = ?
  `).bind(id).first();

  if (!pet) return json({ error: 'Not found' }, 404);

  const pics = await env.DB.prepare(
    'SELECT url, is_primary FROM pet_pictures WHERE pet_id = ? ORDER BY is_primary DESC'
  ).bind(id).all();

  return json({ pet, photos: pics.results || [] });
}

async function handleMe(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ user: null }, 200);
  return json({ user: { username: session.username, email: session.email } });
}

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
          registry_number, microchip_id, price_btc, bitcoin_address, photo_keys } = body;

  if (!name || !name.trim()) return json({ error: 'Pet name is required' }, 400);
  if (!species || !species.trim()) return json({ error: 'Species is required' }, 400);
  if (price_btc == null || isNaN(Number(price_btc)) || Number(price_btc) < 0) {
    return json({ error: 'A valid price in BTC is required' }, 400);
  }

  // Look up user_id from username stored in session
  const userRow = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(session.username).first();
  if (!userRow) return json({ error: 'User not found' }, 500);

  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO pets (id, user_id, name, species, breed, date_of_birth, weight_lbs,
      gender, color, description, health_info, vaccinations,
      registry_name, registry_number, microchip_id, price_btc, bitcoin_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, userRow.id,
    name.trim(), species.trim(),
    breed || null, date_of_birth || null,
    weight_lbs ? Number(weight_lbs) : null,
    gender || null, color || null,
    description || null, health_info || null,
    vaccinations || null, registry_name || null,
    registry_number || null, microchip_id || null,
    Number(price_btc), bitcoin_address || null
  ).run();

  if (Array.isArray(photo_keys) && photo_keys.length > 0) {
    const keys = photo_keys.slice(0, 5);
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

async function handleCreateOrder(request, env, petId) {
  // Fetch pet with seller's bitcoin address (listing-level or account-level)
  const pet = await env.DB.prepare(`
    SELECT p.id, p.name, p.status, p.price_btc,
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

  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 minutes

  await env.DB.prepare(
    "INSERT INTO orders (id, pet_id, pay_address, amount_btc, expires_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, petId, payAddress, pet.price_btc, expiresAt).run();

  await env.DB.prepare(
    "UPDATE pets SET status='pending', updated_at=datetime('now') WHERE id=?"
  ).bind(petId).run();

  return json({ order: { id, pay_address: payAddress, amount_btc: pet.price_btc, expires_at: expiresAt, pet_name: pet.name } }, 201);
}

async function handleGetOrder(request, env, orderId) {
  const order = await env.DB.prepare(
    "SELECT id, pet_id, pay_address, amount_btc, status, expires_at, paid_at, tx_id FROM orders WHERE id=?"
  ).bind(orderId).first();
  if (!order) return json({ error: 'Order not found' }, 404);
  return json({ order });
}

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

  const maxSize = 5 * 1024 * 1024;
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

async function handleServeImage(env, key) {
  const safeKey = key.replace(/[^a-zA-Z0-9.\-_]/g, '');
  if (!safeKey) return new Response('Not found', { status: 404 });

  const obj = await env.IMAGES.get(safeKey);
  if (!obj) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { headers });
}

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
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(sessionId, user.id, expiresAt).run();

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `session=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${new Date(expiresAt).toUTCString()}`
    }
  });
}

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

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const match = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? match[1] : null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
