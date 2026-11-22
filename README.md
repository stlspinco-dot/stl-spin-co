# STL Spin Co — public website + bookings (standalone code)

A standalone, deployable version of the STL Spin Co website and bookings
system — real code that can live on a real public website outside Muse.

**What it is:** a premium black-and-gold 360 video booth site for weddings
and brand/corporate events in St. Louis, with a booking form that actually
saves, a guest **My bookings** login, and a separate plain bookings page
for Miles to Accept / Decline requests.

**What it is not:** a Muse artifact. There is no Muse link, no Muse
database, and no Muse background task in this project. Everything here
runs on a normal Node server with a normal SQLite database.

## How it works

- **Public site** (`/`) — hero with a Gateway Arch motif, how it works,
  what's included, packages **Essential / Signature / Luxe** (quote-based,
  no prices listed), FAQ, gallery, booking form, My bookings.
- **Booking form** — name, email, phone, event type, date, start time,
  venue/location, package, guests, message. The date is checked live.
  - **One booking per day:** if the date already has an Under Review or
    Booked booking, the new request is stored as **Declined** (auto-decline)
    and the guest is told straight away. Otherwise it lands as
    **Under Review**.
  - Every submission sends an alert email to Miles at
    `stlspinco@gmail.com` (or logs it — see Email below).
- **My bookings** (`/#my-bookings`) — the guest enters the email they
  booked with and sees **only their own bookings** and their status
  (Under Review / Booked — Confirmed / Declined), with date, time,
  location, email, and phone. Works on a later visit, because bookings
  are saved server-side.
  > Trade-off Miles approved: this login is just the email address — no
  > password. Anyone who knows the email can look those bookings up.
  > Do not use it for anything sensitive without adding a code step.
- **Owner bookings** (`/owner`) — separate, for Miles only. A plain,
  boring list: name, event type, date, time, **Location:** venue/city,
  **Email:**, **Phone:**, status. Under Review bookings get **Accept**
  and **Decline** buttons.
  - **Accept** marks it Booked — Confirmed and sends the customer a
    confirmation email from `stlspinco@gmail.com`.
  - **Decline** marks it Declined and frees the date again.
  - The owner page is protected by a password Miles sets
    (`OWNER_PASSWORD` env var — see below). There is no default password.

## Files

```
stl-spin-co-public/
├── server.js                 # Express server + all API routes
├── lib/email.js              # Email helper (SMTP, or logs to outbox.log)
├── migrations/001_init.sql   # bookings table (SQLite; also works for D1)
├── public/
│   ├── index.html            # Public site + booking form + My bookings
│   ├── styles.css            # Black & gold styling
│   ├── app.js                # Booking form + My bookings (guest side)
│   ├── owner.html            # Owner bookings page (Miles only)
│   └── owner.js              # Owner login + Accept / Decline
├── docs/cloudflare.md        # Cloudflare Pages + Workers + D1 deployment notes
├── test-local.sh             # Automated local smoke test (see below)
├── .env.example              # Every env var, with placeholders only
├── .gitignore
├── package.json
└── README.md                 # This file
```

API endpoints (all under the same server):

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/bookings/check-date?date=YYYY-MM-DD` | Is that date taken? |
| `POST` | `/api/bookings` | Submit a booking (one-per-day rule applied) |
| `GET` | `/api/bookings/mine?email=…` | Guest My bookings, by email only |
| `POST` | `/api/owner/login` | Owner login → bearer token (12h) |
| `GET` | `/api/owner/bookings` | Owner list (token required) |
| `POST` | `/api/owner/bookings/:id/accept` | Accept → Booked + confirmation email |
| `POST` | `/api/owner/bookings/:id/decline` | Decline → date freed |

## Run it locally

Requires **Node.js 22.5+** (uses `node:sqlite`, no native build step).

```bash
cd stl-spin-co-public
npm install
cp .env.example .env
# Edit .env: set OWNER_PASSWORD and OWNER_SESSION_SECRET (see below)
npm start
# Public site:   http://localhost:3000/
# Owner bookings: http://localhost:3000/owner
```

For local development only, you can skip the password requirement with:

```bash
ALLOW_NO_OWNER_PASSWORD=1 npm start
```

Do **not** use that in production — the owner page would be unprotected.

### Test it locally

```bash
bash test-local.sh
```

That script starts the server on a temporary database, submits a booking,
submits a second booking for the same date (expects auto-decline), checks
My bookings by email, logs in as owner, and accepts the first booking.
It prints PASS/FAIL for each step and cleans up after itself.

## Environment variables

Copy `.env.example` to `.env` and fill it in. **Never commit a real
`.env`, and never paste real passwords into chat or a ticket.**

| Variable | Required? | What it is |
|---|---|---|
| `OWNER_PASSWORD` | Yes (production) | Password for `/owner`. Miles chooses it. No default. |
| `OWNER_SESSION_SECRET` | Yes (production) | Random secret for owner sessions. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `FROM_EMAIL` | No | From-address for mail. Default `stlspinco@gmail.com`. |
| `OWNER_EMAIL` | No | Where new-booking alerts go. Default `stlspinco@gmail.com`. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | No | SMTP settings. Leave blank locally — mail is logged to `data/outbox.log` and bookings still save. |
| `PORT` | No | Default `3000`. |
| `SQLITE_PATH` | No | Database file. Default `data/stlspinco.db`. |

## Email

- **Without SMTP configured:** nothing breaks. Emails are appended to
  `data/outbox.log` and the booking records `not_configured`. This is
  how local testing works.
- **To keep sending literally from `stlspinco@gmail.com`:** use Gmail
  SMTP (`smtp.gmail.com`, port 587) with 2-Step Verification turned on
  and a **16-character Gmail App Password** as `SMTP_PASS` — not the
  normal Gmail password (that no longer works for SMTP). The App Password
  is revoked if the Google password changes, so this is fragile.
- **On a hosted email service** (e.g. Resend): the service will usually
  reject Gmail as a from-address and require a verified domain, so
  `FROM_EMAIL` would become something like `bookings@stlspinco.com`.
  That needs a domain Miles owns. See `docs/cloudflare.md`.

## Deploying it

### Simplest honest path: a Node host

This project is a plain Node/Express app with a SQLite file. The
straightforward way to put it on the public internet is any Node host
(Render, Railway, Fly.io, a VPS, etc.):

1. Push this folder to a Git repo.
2. Create a Node web service from it (`npm install && npm start`).
3. Set the env vars above in the host's dashboard (never in code).
4. Point a domain at it, or use the host's free address to start.

**SQLite warning:** on most free hosts the filesystem is ephemeral —
the database file can be wiped on redeploy/restart. For a real
production site, swap the SQLite file for a hosted database (Turso,
Neon, Supabase Postgres, etc.) and port the queries in `server.js`
(the SQL is plain and the schema is in `migrations/001_init.sql`).
Do not treat the free-tier SQLite file as permanent storage.

### Cloudflare (the earlier research recommendation)

See [`docs/cloudflare.md`](docs/cloudflare.md) for the full notes.

Short version: **Cloudflare Pages + Workers + D1 ($0 to start, ~$11/year
if Miles buys a domain) is the cheapest option that keeps the automatic
flow**, and the Workers port is now built — see `worker/` (tested
23/23 checks with `node test-worker.mjs`). It is not deployed yet:
deploying still needs Miles's Cloudflare account, a D1 database id, and
the owner-password / session secrets (see `worker/README.md`).

- `public/` → served as the Worker's static assets (free, SSL, custom domain).
- `server.js` API → the Worker in `worker/src/index.js`, with the same
  endpoints, using the D1 binding instead of `node:sqlite`. The schema in
  `migrations/001_init.sql` works for D1 (it is SQLite).
- Email via Resend (free tier) or Gmail SMTP as above.

Do not pay for Vercel Pro ($20/month) or similar unless Miles prefers
the standard Node hosting path — the free Cloudflare route covers
this volume (a few bookings a week) comfortably.

## What still needs Miles

- [ ] **A Cloudflare account** (free, email only, no card) — or a
  Node host account if he prefers that path.
- [ ] **A domain decision** — confirm the name he wants (do **not**
  assume `stlspinco.com` is his; it has not been verified), buy it
  (~$11/year via Cloudflare Registrar) or use the host's free address
  to start.
- [ ] **Email decision** — (a) create a Gmail App Password himself
  in Google Account → Security, or (b) accept mail from a domain
  address once a domain exists.
- [ ] **An owner password** he chooses for the new `/owner` page.
- [ ] **Real event photos** when he has them — the gallery currently
  uses clearly labelled inspiration/sample placeholders and must not
  be presented as past STL Spin Co events.
- [ ] **A payment method** only if he picks a paid plan (none is
  needed for the free Cloudflare route).

## What was tested (and what was not)

Tested locally with `test-local.sh` (see "Test it locally" above):
booking submission, one-per-day auto-decline on a second booking for
the same date, My bookings lookup by email (own bookings only), owner
login, owner Accept, and the date check. Emails were **not** live-sent
during testing (no SMTP configured) — they were recorded in
`data/outbox.log` as `not_configured`, which is the designed fallback.

**Not tested / not done:** any real deployment, any real email
delivery, a domain purchase, or a hosted-database migration. Nothing was
published, deployed, or sent from this project. The Cloudflare Worker
port itself (`worker/`) was tested locally with `node test-worker.mjs`
(23/23 checks passed); wrangler deploy was not run — that needs Miles's
Cloudflare account.
## Deployment (live)

- Live site: https://stl-spin-co.stlspinco.workers.dev/
- Deploys automatically from this repo: Cloudflare Workers Builds is connected to `main` (root directory `worker`, deploy command `npx wrangler deploy`). Pushes to `main` deploy the Worker, with the D1 database `stl-spin-co` bound as `DB`.
