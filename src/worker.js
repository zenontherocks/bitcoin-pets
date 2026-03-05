export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }

    const response = await env.ASSETS.fetch(request);
    if (response.status === 404) {
      url.pathname = '/index.html';
      return env.ASSETS.fetch(new Request(url.toString()));
    }
    return response;
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
  if (url.pathname === '/api/pets' && request.method === 'POST') {
    return handleCreatePet(request, env);
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
          registry_number, microchip_id, price_btc } = body;

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
      registry_name, registry_number, microchip_id, price_btc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, userRow.id,
    name.trim(), species.trim(),
    breed || null, date_of_birth || null,
    weight_lbs ? Number(weight_lbs) : null,
    gender || null, color || null,
    description || null, health_info || null,
    vaccinations || null, registry_name || null,
    registry_number || null, microchip_id || null,
    Number(price_btc)
  ).run();

  return json({ success: true, id }, 201);
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

  const user = await env.DB.prepare(
    'SELECT id, password_hash FROM users WHERE email = ?1 OR username = ?1 LIMIT 1'
  ).bind(login.trim().toLowerCase()).first();

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
