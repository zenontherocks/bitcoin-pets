# Bitcoin Pets — Project Architecture

## Overview

A Bitcoin-only pet marketplace. Listings are imported from pbtmarketplace.com (a breeder marketplace), marked up, and resold — there are no user accounts; buyers check out anonymously with contact/shipping info collected per order. The stack is entirely Cloudflare-native with no build step and no frontend framework.

---

## Platform & Infrastructure

| Layer    | Technology                      |
|----------|----------------------------------|
| Runtime  | Cloudflare Workers               |
| Database | Cloudflare D1 (SQLite)           |
| Hosting  | Cloudflare Workers Static Assets |
| Config   | `wrangler.toml`                  |

Worker bindings (from `wrangler.toml`):
- `env.DB` — D1 database
- `env.ASSETS` — static file serving (implicit; `assets = { directory = "./public" }`)

No R2 or other storage binding exists. Pet photos are hotlinked directly from pbtmarketplace.com's S3 bucket (`pet_pictures.url`), never copied or proxied.

Secrets (set via `wrangler secret put`, read as `env.*`): `BTC_XPUB` (HD wallet extended pubkey for deriving payment addresses), `ADMIN_TOKEN` (gates `/api/admin/*`), `PBT_EMAIL`/`PBT_PASSWORD` (scraper login), `BREVO_API_KEY`/`BREVO_SENDER_EMAIL`/`BREVO_SENDER_NAME` (transactional email).

---

## Folder Structure

```
/
├── public/                # Static frontend (served by env.ASSETS)
│   ├── index.html         # Landing page
│   ├── browse.html        # Pet listings grid (infinite scroll)
│   ├── pet.html            # Single listing detail + checkout/invoice flow
│   ├── contact.html       # Live chat (Nostr NIP-17 DMs) + phone contact
│   ├── how-it-works.html
│   ├── about.html
│   ├── privacy.html
│   ├── terms.html
│   ├── wallet.html        # Standalone client-side BIP32/BIP84 HD wallet generator (admin/ops tool)
│   ├── sellerblacklist.html  # Admin: block PBT sellers (token-gated)
│   ├── sold.html           # Admin: paid-order list (token-gated)
│   ├── waybill.html        # Admin: printable shipping waybill per order (token-gated)
│   ├── navbar.js           # Shared nav — injected as IIFE, no module system
│   ├── shared.js           # Shared helpers (escHtml, formatBtc/Usd, ageFromDob, etc.)
│   └── chat-widget.js      # Nostr live-chat widget, loaded only on /contact
├── src/
│   └── worker.js           # Entire backend: routing, PBT scraping, Bitcoin address derivation, payments
├── schema.sql               # D1 schema (source of truth for the database)
└── wrangler.toml             # Workers config: bindings, cron triggers
```

---

## Design Pattern

### Backend (`src/worker.js`)

- **Single-file backend.** All request handling lives in `worker.js`. There is no module bundler and no imports (besides `@noble/secp256k1`/`@noble/hashes`, used for the from-scratch BIP32/bech32 address derivation).
- **Manual router.** `handleApi()` matches URL patterns with `===` and `RegExp.match()`. New routes go here — no routing library.
- **Handler functions are top-level async functions.** Each route has one dedicated function (e.g. `handleCreateOrder`, `handleGetPet`).
- **No authentication/sessions for public routes.** There is no login system. The only auth mechanism is `checkAdminToken(request, env, url)`, which every `/api/admin/*` handler calls first, comparing a `?token=` query param against `env.ADMIN_TOKEN` (fails closed if the secret isn't configured).
- **All API responses use the `json(data, status)` helper.** Never construct `new Response(JSON.stringify(...))` inline.
- **All D1 queries are parameterized** via `.bind()` — never string-concatenate untrusted input into SQL.
- **Cron job** (`scheduled` export, per `wrangler.toml`'s `crons`) has two schedules: `*/5 * * * *` runs `expireOrders()` then `confirmPayments()` (expire stale invoices, poll mempool.space for on-chain payment); `*/30 * * * *` runs `syncPbtListings()` (re-scrape pbtmarketplace.com, upsert listings, backfill missing fields/photos).

### Frontend (`public/`)

- **Vanilla HTML + CSS + JS only.** No React, Vue, Svelte, or any frontend framework. No npm, no bundler.
- **One HTML file per page.** Logic specific to a page lives in a `<script>` tag at the bottom of that page's HTML file.
- **Styles are per-page `<style>` blocks.** No external stylesheet. CSS custom properties (variables) define the color palette and are declared in `:root` on each page that needs them, with a `:root[data-theme="dark"]` override for dark mode.
- **`navbar.js` and `shared.js` are the shared files.** `navbar.js` is an IIFE that injects the `<nav>` element, currency toggle, and theme toggle. `shared.js` holds small cross-page helpers (HTML-escaping, currency/date formatting). Every page includes both via `<script src="...">`.
- **Admin pages** (`sellerblacklist.html`, `sold.html`, `waybill.html`) follow one pattern: a password-type input for the admin token (pre-filled from `?token=` in the URL), fetching from a `checkAdminToken`-gated `/api/admin/...` route. These are excluded from search indexing via `X-Robots-Tag: noindex, nofollow` (set in `worker.js`'s `fetch()` handler) and a matching `<meta name="robots">` tag.

### Data & Payments

- **Prices are always USD in the database** (`pets.price_usd`, the PBT buy-now price). At order time, `applyMarkup()` converts to BTC at the live mempool.space rate (cached with a short TTL in the `settings` table) plus a flat markup (`MARKUP_USD` + `MARKUP_SATS`).
- **Bitcoin payment addresses are derived server-side from `BTC_XPUB`** using a from-scratch BIP32/BIP84 implementation in `worker.js` (base58/bech32 codecs, `ckdPub` child-key derivation) — no external Bitcoin library at runtime. `claimNextAddress()` atomically increments a `next_address_index` counter in `settings` so concurrent orders never reuse an address.
- **Orders expire 2 hours after creation.** `expireOrders()` (5-minute cron) reverts the pet to `available` for expired, unpaid orders.
- **Pet status lifecycle:** `available` → `pending` (order created, atomically claimed to prevent a double-sale race) → `sold` (payment confirmed on-chain by `confirmPayments()`) or back to `available` (order expired). A pet can also become `ended` (delisted from PBT, or its seller blacklisted) — the PBT sync only ever revives an `ended` pet back to `available`, never overwriting `sold`/`pending`.
- **Live chat** (`/contact`) uses Nostr NIP-17 gift-wrapped DMs to the site owner's npub over public relays — no backend involved, no account required; a throwaway keypair is generated client-side and persisted in `localStorage`.

---

## Golden Rules

1. **No frontend framework, no bundler.** Keep the frontend as plain HTML/CSS/JS files.
2. **No CSS framework** (no Tailwind, Bootstrap, etc.). Use `<style>` blocks with CSS custom properties.
3. **All API responses go through `json()`.** Don't construct JSON responses manually outside that helper.
4. **Every `/api/admin/*` handler calls `checkAdminToken(request, env, url)` first** and returns 401 immediately if it fails.
5. **All D1 queries are parameterized with `.bind()`.** Never interpolate untrusted values directly into SQL strings.
6. **Schema changes go in `schema.sql` first.** It is the canonical definition of the database; every statement must be `IF NOT EXISTS`/`INSERT OR IGNORE`-safe to re-run, then applied with `wrangler d1 execute` (not automated in CI — the deploy workflow only runs `wrangler deploy` for the Worker script).
7. **New API routes follow the existing pattern**: add a branch in `handleApi()`, write a dedicated `handle*` function, keep it flat.
8. **`handleApi()` is routing only.** No business logic lives inside it — just pattern matching and dispatch calls. Keep it that way.
9. **The `scheduled` cron has one helper per pass** (`expireOrders`, `confirmPayments`, `syncPbtListings`). `scheduled()` just dispatches based on `event.cron`.
10. **Never let the PBT sync overwrite a `sold`/`pending` pet back to `available`** just because the listing is still visible on PBT's own site — only revive from `ended`.
11. **Bitcoin amounts/addresses are always computed server-side**, never accepted from the client, in `handleCreateOrder`.
