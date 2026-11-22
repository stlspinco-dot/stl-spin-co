# STL Spin Co — Cloudflare Worker port (free hosting)

This is the part that was missing. The Node/Express code in the parent
folder does **not** run on Cloudflare Workers as-is, so saying "put it
live on free Cloudflare" did not mean anything until this port existed.
This `worker/` folder is that port: the same site, the same API, the
same one-booking-per-day rule, running on Cloudflare's free tier.

## What it is

- **Worker** (`src/index.js`) — the whole API from `server.js`, rewritten
  for Workers + D1: health, live date check, booking submit, My bookings
  by email, owner login, owner list, Accept, Decline.
- **Static site** — served from `../public/` via the Worker's assets
  binding, so the public site and the API live on one address.
- **Database** — Cloudflare D1 (SQLite). Same schema as
  `../migrations/001_init.sql`.
- **Email** — via the Resend HTTP API when `RESEND_API_KEY` is set.
  Workers cannot use Gmail SMTP, and Resend needs a verified domain, so
  on this path mail comes from a domain address such as
  `bookings@stlspinco.com`, **not** from `stlspinco@gmail.com`. With no
  API key, bookings still save and mail records `not_configured`, exactly
  like the Node version without SMTP.
- **Owner login** — stateless HMAC-signed token (12h), signed with
  `OWNER_SESSION_SECRET`. A Worker has no shared memory between
  requests, so the Node version's in-memory token map would not work.

## What it costs

$0 to start on Cloudflare's free tier (Workers 100k requests/day,
D1 5 GB). No card needed. A custom domain is ~$11/year if Miles buys
one later; until then the site lives at
`https://stl-spin-co.<his-subdomain>.workers.dev`.

## Deploy (needs Miles)

Nothing here is deployed yet. Deploying needs a Cloudflare account in
Miles's name — no account, password or API key lives in this repo.

```bash
cd stl-spin-co-public/worker
npx wrangler login                                  # Miles's Cloudflare account
npx wrangler d1 create stl-spin-co                 # note the database_id
# paste that id into wrangler.toml, then:
npx wrangler d1 execute stl-spin-co --file ../migrations/001_init.sql
npx wrangler secret put OWNER_PASSWORD              # Miles chooses it
npx wrangler secret put OWNER_SESSION_SECRET        # random string
npx wrangler secret put RESEND_API_KEY              # optional, for real email
npx wrangler deploy
```

Then open the `workers.dev` address it prints and submit a test booking.
If it lands in `/owner` as Under Review, the live site works end to end.

## Test locally (no Cloudflare account needed)

```bash
cd worker
node test-worker.mjs
```

That runs the Worker code in Node against an in-memory SQLite database
with a mock D1 binding — same checks as `test-local.sh` does for the
Node server: booking lands Under Review, second booking for the same
date auto-declines, My bookings shows only the right guest's bookings,
owner login rejects a wrong password, Accept flips it to Booked.

## What still needs Miles (unchanged)

- A Cloudflare account (free, email only, no card)
- A domain decision — use the free `workers.dev` address to start, or
  buy `stlspinco.com` (~$11/year) later. Do **not** assume that domain
  is his; it has not been verified.
- An email decision — Resend + a verified domain address, or accept
  that alerts/confirmations are logged, not sent, until then
- An owner password he chooses for `/owner`
- Real event photos when he has them
