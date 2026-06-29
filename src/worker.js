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
  if (url.pathname === '/api/admin/address-pool' && request.method === 'GET') {
    return handleAddressPool(request, env);
  }

  return json({ error: 'Not found' }, 404);
}

// ── Pet handlers ──────────────────────────────────────────────────────────────

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
           pp.url AS photo_url
    FROM pets p
    LEFT JOIN pet_pictures pp ON pp.pet_id = p.id AND pp.is_primary = 1
    WHERE p.status = 'available' ${speciesFilter}
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...binds).all();

  const pets = rows.results || [];
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

  return json({ pet, photos: pics.results || [], order_expires_at: activeOrder?.expires_at ?? null });
}

// ── Orders & Payments ─────────────────────────────────────────────────────────

// Creates a 30-minute Bitcoin invoice for a listing. Collects buyer contact info,
// assigns a platform address from the pre-loaded pool, and flips the pet to 'pending'.
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

  // Compute BTC amount from USD price at current market rate
  let amountBtc;
  try {
    const priceRes = await fetch('https://mempool.space/api/v1/prices');
    if (!priceRes.ok) throw new Error('price fetch failed');
    const { USD } = await priceRes.json();
    if (!USD || USD <= 0) throw new Error('bad price');
    amountBtc = Math.round((pet.price_usd / USD) * 1e8) / 1e8;
  } catch {
    return json({ error: 'Could not fetch current BTC price. Please try again.' }, 502);
  }

  // Claim the next unassigned address from the platform pool
  const addrRow = await env.DB.prepare(
    'SELECT id, address FROM platform_addresses WHERE assigned_order_id IS NULL ORDER BY id LIMIT 1'
  ).first();
  if (!addrRow) {
    return json({ error: 'No payment addresses available. Please contact support.' }, 503);
  }

  const orderId  = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  await env.DB.prepare(`
    INSERT INTO orders (id, pet_id, pay_address, amount_btc, expires_at,
      buyer_name, buyer_email, buyer_phone, buyer_address1, buyer_address2,
      buyer_city, buyer_state, buyer_zip, buyer_country)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    orderId, petId, addrRow.address, amountBtc, expiresAt,
    buyer_name.trim(), buyer_email.trim().toLowerCase(), buyer_phone.trim(),
    buyer_address1.trim(), buyer_address2 ? buyer_address2.trim() : null,
    buyer_city.trim(), buyer_state.trim(), buyer_zip.trim(),
    buyer_country || 'US'
  ).run();

  await env.DB.prepare(
    "UPDATE platform_addresses SET assigned_order_id=?, assigned_at=datetime('now') WHERE id=?"
  ).bind(orderId, addrRow.id).run();

  await env.DB.prepare(
    "UPDATE pets SET status='pending', updated_at=datetime('now') WHERE id=?"
  ).bind(petId).run();

  return json({
    order: { id: orderId, pay_address: addrRow.address, amount_btc: amountBtc, expires_at: expiresAt, pet_name: pet.name }
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
    const res = await fetch('https://mempool.space/api/v1/prices');
    if (!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    return json({ usd: data.USD });
  } catch {
    return json({ error: 'Could not fetch BTC price' }, 502);
  }
}

// ── Admin ─────────────────────────────────────────────────────────────────────

async function handleAddressPool(request, env) {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS unassigned FROM platform_addresses WHERE assigned_order_id IS NULL'
  ).first();
  return json({ unassigned: row?.unassigned ?? 0 });
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
    // PBT browse page shows ~20 listings; stop after 50 pages to avoid runaway
    if (pageListings.length < 10 || page >= 50) break;
    page++;
  }

  // Mark listings no longer on PBT as ended (unless already sold/pending)
  const pbtIds = listings.map(l => l.id);
  if (pbtIds.length > 0) {
    const existing = await env.DB.prepare(
      "SELECT pbt_id FROM pets WHERE status = 'available'"
    ).all();
    for (const row of (existing.results || [])) {
      if (!pbtIds.includes(row.pbt_id)) {
        await env.DB.prepare(
          "UPDATE pets SET status='ended', updated_at=datetime('now') WHERE pbt_id=?"
        ).bind(row.pbt_id).run();
      }
    }
  }

  // Upsert each listing
  for (const { id, slug } of listings) {
    try {
      const detail = await pbtScrapeDetail(cookie, id, slug);
      if (!detail) continue;
      await syncPbtListings_upsert(env, detail);
    } catch { /* skip individual failures — will retry next sync */ }
  }
}

async function pbtLogin(env) {
  // Step 1: GET login page to capture antiforgery token and session cookie
  let loginHtml, sessionCookie;
  try {
    const r = await fetch('https://pbtmarketplace.com/Account/LogOn');
    loginHtml = await r.text();
    const raw = r.headers.get('set-cookie') || '';
    const m = raw.match(/ASP\.NET_SessionId=([^;]+)/i);
    sessionCookie = m ? `ASP.NET_SessionId=${m[1]}` : '';
  } catch { return null; }

  const tokenMatch = loginHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  const token = tokenMatch ? tokenMatch[1] : '';

  // Step 2: POST credentials
  const body = new URLSearchParams({
    Email: env.PBT_EMAIL,
    Password: env.PBT_PASSWORD,
    __RequestVerificationToken: token,
    RememberMe: 'false',
  });

  try {
    const r = await fetch('https://pbtmarketplace.com/Account/LogOn', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': sessionCookie,
      },
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
    const listings = [];
    const re = /href="\/Listing\/Details\/(\d+)\/([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      listings.push({ id: m[1], slug: m[2] });
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

  // Helper: extract text content from first element with a given class
  function extract(cls) {
    const m = html.match(new RegExp(`class="${cls}"[^>]*>\\s*([^<]+)\\s*<`, 'i'));
    return m ? m[1].trim() : null;
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

  return {
    pbt_id: pbtId,
    pbt_url: `https://pbtmarketplace.com/Listing/Details/${pbtId}/${slug}`,
    name, species, breed, gender, color,
    date_of_birth, weight_lbs,
    registry_name: registry || null,
    price_usd,
    vaccinations,
    images,
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
      gender, color, vaccinations, registry_name, price_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, listing.pbt_id, listing.pbt_url, listing.name, listing.species,
    listing.breed, listing.date_of_birth, listing.weight_lbs,
    listing.gender, listing.color, listing.vaccinations,
    listing.registry_name, listing.price_usd
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
