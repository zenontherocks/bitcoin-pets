# Bitcoin Pets — Project Architecture

## Overview

A peer-to-peer pet marketplace where listings are paid for in Bitcoin. The stack is entirely Cloudflare-native with no build step and no frontend framework.

---

## Platform & Infrastructure

| Layer    | Technology                      |
|----------|---------------------------------|
| Runtime  | Cloudflare Workers              |
| Database | Cloudflare D1 (SQLite)          |
| Storage  | Cloudflare R2 (image blobs)     |
| Hosting  | Cloudflare Workers Static Assets|
| Config   | `wrangler.toml`                 |

Worker bindings (from `wrangler.toml`):
- `env.DB` — D1 database
- `env.IMAGES` — R2 bucket
- `env.ASSETS` — static file serving

---

## Folder Structure

```
/
├── public/              # Static frontend (served by env.ASSETS)
│   ├── index.html       # Landing page
│   ├── browse.html      # Pet listings grid
│   ├── pet.html         # Single listing detail + order flow
│   ├── sell.html        # Create a listing
│   ├── account.html     # User dashboard (my listings, profile)
│   ├── login.html
│   ├── register.html
│   ├── how-it-works.html
│   ├── about.html
│   ├── privacy.html
│   ├── terms.html
│   └── navbar.js        # Shared nav — injected as IIFE, no module system
├── src/
│   └── worker.js        # Entire backend: routing, handlers, auth, crypto
├── schema.sql           # D1 schema (source of truth for the database)
└── wrangler.toml        # Workers config: bindings, cron triggers
```

---

## Design Pattern

### Backend (`src/worker.js`)

- **Single-file backend.** All request handling lives in `worker.js`. There is no module bundler and no imports.
- **Manual router.** `handleApi()` matches URL patterns with `===` and `RegExp.match()`. New routes go here — no routing library.
- **Handler functions are top-level async functions.** Each route has one dedicated function (e.g. `handleCreatePet`, `handleGetOrder`).
- **Auth via `getSession(request, env)`.** Every protected handler calls this helper first. It reads the `session` cookie, validates against D1, and returns `{ user_id, username, email }` or `null`.
- **All API responses use the `json(data, status)` helper.** Never construct `new Response(JSON.stringify(...))` inline.
- **Password hashing uses PBKDF2** via `hashPassword()` / `verifyPassword()`. Do not use plain SHA-256 for new password operations.
- **Cron job** (`scheduled` export) runs every 5 minutes: expires overdue orders and polls mempool.space to confirm on-chain payments.

### Frontend (`public/`)

- **Vanilla HTML + CSS + JS only.** No React, Vue, Svelte, or any frontend framework. No npm, no bundler.
- **One HTML file per page.** Logic specific to a page lives in a `<script>` tag at the bottom of that page's HTML file.
- **Styles are per-page `<style>` blocks.** No external stylesheet. CSS custom properties (variables) define the color palette and are declared in `:root` on each page that needs them.
- **`navbar.js` is the only shared file.** It is an IIFE that injects the `<nav>` element and its styles, then calls `/api/me` to toggle auth links. All pages include it via `<script src="/navbar.js">`.
- **No inline `style="..."` attributes** on elements (except dynamically set ones in JS where a class isn't practical).

### Data & Payments

- **Prices have a currency anchor.** `price_currency` is either `'btc'` or `'usd'`. USD-anchored listings convert to BTC at order time using the mempool.space price feed.
- **Images are stored in R2** and always referenced through the `/api/images/:key` Worker endpoint — never via direct R2 URLs.
- **Image keys are sanitized** with `/[^a-zA-Z0-9.\-_]/g` before use in DB or R2 lookups.
- **Orders expire after 30 minutes.** The cron job reverts the pet status to `'available'` for expired orders.
- **Pet status lifecycle:** `available` → `pending` (order created) → `sold` (payment confirmed on-chain) or back to `available` (order expired).

---

## Golden Rules

1. **No frontend framework, no bundler.** Keep the frontend as plain HTML/CSS/JS files.
2. **No CSS framework** (no Tailwind, Bootstrap, etc.). Use `<style>` blocks with CSS custom properties.
3. **No inline styles** on HTML elements. Define classes instead.
4. **All API responses go through `json()`.** Don't construct JSON responses manually outside that helper.
5. **All protected API handlers call `getSession()` first** and return 401 immediately if it returns `null`.
6. **Don't add direct R2 URLs to the database.** Store the `/api/images/:key` path so the Worker controls access and cache headers.
7. **Schema changes go in `schema.sql` first.** It is the canonical definition of the database; apply changes with `wrangler d1 execute`.
8. **No redundant `/api/me` calls.** The navbar already fetches it; pages that also need session data should share that result or make one additional targeted call.
9. **PBKDF2 for all password hashing** — use `hashPassword()` / `verifyPassword()`, never raw SHA-256.
10. **New API routes follow the existing pattern**: add a branch in `handleApi()`, write a dedicated `handle*` function, keep it flat.
11. **`handleApi()` is routing only.** No logic lives inside it — just pattern matching and dispatch calls. Keep it that way.
12. **If a handler exceeds ~60 lines, decompose it.** Extract private helpers named after the handler (e.g. `createPet_insertPhotos()`). Don't let a single function grow unbounded.
13. **The `scheduled` cron has one helper per pass.** The two passes (expire orders, confirm payments) each get their own top-level function (`expireOrders`, `confirmPayments`). `scheduled` just calls them.
14. **Each `// ── Section ──` block has a ~150-line soft budget.** Exceeding it is a signal to extract helpers within that section, not a hard stop.
