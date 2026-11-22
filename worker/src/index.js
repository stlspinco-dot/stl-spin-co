/**
 * STL Spin Co — Cloudflare Worker port of server.js
 * --------------------------------------------------
 * Same public site, same API, same rules as the Node/Express version:
 *   - one booking per day (a second request for a taken date is stored
 *     as Declined, otherwise Under Review)
 *   - guest My bookings lookup by the email they booked with
 *   - owner /owner page: Accept / Decline, Accept sends a confirmation
 *
 * Differences from the Node version (forced by Workers):
 *   - Storage is Cloudflare D1 (SQLite) via env.DB, not node:sqlite.
 *     The schema in ../migrations/001_init.sql works as-is for D1.
 *   - Owner sessions are stateless HMAC-signed tokens (Web Crypto),
 *     not an in-memory Map — a Worker has no shared memory between
 *     requests. The token format is unchanged from the browser's point
 *     of view: an opaque string sent as `Authorization: Bearer <token>`,
 *     valid 12h. OWNER_SESSION_SECRET signs it.
 *   - Email is sent via the Resend HTTP API when RESEND_API_KEY is set.
 *     Workers cannot use Gmail SMTP. Resend needs a verified domain,
 *     so FROM_EMAIL must then be e.g. bookings@stlspinco.com — it
 *     cannot stay stlspinco@gmail.com on this path. With no API key,
 *     mail is NOT sent and the booking records `not_configured`,
 *     exactly like the Node version without SMTP.
 *   - Web push (see below) is pure Web Crypto (ECDH + HKDF + AES-GCM
 *     for RFC 8291 aes128gcm, ES256 for VAPID RFC 8292) — no Node-only
 *     crypto, no npm dependency, so it runs in Workers as-is. Keys:
 *     VAPID_PUBLIC_KEY (var, public) and VAPID_PRIVATE_KEY (secret).
 *     Subscriptions live in D1 (migrations/002_push_subscriptions.sql).
 *     With no VAPID keys set, pushes are skipped and bookings still save.
 *   - Static files (public/) are served by the Worker's assets binding
 *     (env.ASSETS); anything that is not an /api/* route falls through
 *     to it, including /owner (owner.html).
 *
 * Nothing here is deployed yet. See worker/README.md for the deploy
 * steps. No secrets live in this file — OWNER_PASSWORD,
 * OWNER_SESSION_SECRET and RESEND_API_KEY are Worker secrets.
 */

const FROM_EMAIL_DEFAULT = 'stlspinco@gmail.com';
const OWNER_EMAIL_DEFAULT = 'stlspinco@gmail.com';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const te = new TextEncoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function publicBooking(row) {
  if (!row) return null;
  return {
    id: row.id,
    ref: row.ref,
    name: row.name,
    email: row.email,
    phone: row.phone || '',
    eventType: row.event_type,
    eventDate: row.event_date,
    startTime: row.start_time || '',
    venue: row.venue || '',
    city: row.city || '',
    location: [row.venue, row.city].filter(Boolean).join(', '),
    package: row.package || '',
    guests: row.guests || '',
    message: row.message || '',
    status: row.status,
    createdAt: row.created_at,
  };
}

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}
function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}
function statusLabel(status) {
  return { under_review: 'Under Review', booked: 'Booked — Confirmed', declined: 'Declined' }[status] || status;
}

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function unb64url(s) {
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ------------------------------------------------------------ web push
// RFC 8291 (aes128gcm payload encryption) + RFC 8292 (VAPID auth).
// Pure Web Crypto, so this runs in Cloudflare Workers with no deps.
const VAPID_SUBJECT = 'mailto:stlspinco@gmail.com';
const PUSH_TTL_SECONDS = 86400; // 24h — the push service keeps it that long

function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}
async function hkdfExtract(salt, ikm) {
  // RFC 8291 §3.3: PRK = HMAC-SHA-256(auth_secret, ECDH shared secret)
  return hmacSha256(salt, ikm);
}
async function hkdfExpand(prk, info, length) {
  // RFC 5869 expand, one HMAC round is enough for 12/16-byte outputs.
  let t = new Uint8Array(0);
  let out = new Uint8Array(0);
  let counter = 1;
  while (out.length < length) {
    t = await hmacSha256(prk, concatBytes(t, info, new Uint8Array([counter])));
    out = concatBytes(out, t);
    counter += 1;
  }
  return out.slice(0, length);
}

function vapidKeys(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  let pub, priv;
  try {
    pub = unb64url(env.VAPID_PUBLIC_KEY);
    priv = unb64url(env.VAPID_PRIVATE_KEY);
  } catch {
    return null;
  }
  if (pub.length !== 65 || pub[0] !== 0x04 || priv.length !== 32) return null;
  return { pub, priv };
}

async function makeVapidJwt(env, audience) {
  const keys = vapidKeys(env);
  const x = b64url(keys.pub.slice(1, 33));
  const y = b64url(keys.pub.slice(33, 65));
  const d = b64url(keys.priv);
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x, y, d },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const header = b64url(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(
    te.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: VAPID_SUBJECT })),
  );
  const signingInput = `${header}.${payload}`;
  // Web Crypto ECDSA returns the raw R||S (64-byte) signature, which is
  // exactly what a VAPID JWT needs (NOT the DER form Node's crypto gives).
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(signingInput)));
  return `${signingInput}.${b64url(sig)}`;
}

async function encryptPushPayload(sub, plaintext) {
  const clientPub = unb64url(sub.p256dh);
  const auth = unb64url(sub.auth);
  if (clientPub.length !== 65 || auth.length !== 16) throw new Error('Bad subscription keys.');
  const clientKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: b64url(clientPub.slice(1, 33)), y: b64url(clientPub.slice(33, 65)) },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPub = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, ephemeral.privateKey, 256),
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(auth, shared);
  const cek = await hkdfExpand(prk, concatBytes(te.encode('WebPush: info'), new Uint8Array([0]), clientPub, serverPub), 16);
  const nonce = await hkdfExpand(prk, concatBytes(te.encode('Content-Encoding: nonce'), new Uint8Array([0]), clientPub, serverPub), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  // aes128gcm: payload + 0x02 padding delimiter, no extra padding.
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, concatBytes(plaintext, new Uint8Array([0x02]))),
  );
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const body = concatBytes(salt, rs, new Uint8Array([serverPub.length]), serverPub, ciphertext);
  return { body, serverPub };
}

async function sendPush(env, sub, payloadObj) {
  const keys = vapidKeys(env);
  if (!keys) return { status: 'not_configured' };
  let endpoint;
  try {
    endpoint = new URL(sub.endpoint);
  } catch {
    return { status: 'failed', error: 'Bad push endpoint.' };
  }
  if (endpoint.protocol !== 'https:') return { status: 'failed', error: 'Push endpoint must be https.' };
  try {
    const jwt = await makeVapidJwt(env, endpoint.origin);
    const { body } = await encryptPushPayload(sub, te.encode(JSON.stringify(payloadObj)));
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        TTL: String(PUSH_TTL_SECONDS),
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      },
      body,
    });
    if (res.status === 404 || res.status === 410) return { status: 'gone' };
    if (!res.ok) return { status: 'failed', error: `Push service ${res.status}` };
    return { status: 'sent' };
  } catch (err) {
    return { status: 'failed', error: String(err && err.message ? err.message : err) };
  }
}

async function sendPushToAll(env, payloadObj) {
  // Never let push break a booking: no keys / no table / no subs = skip.
  if (!vapidKeys(env)) return { sent: 0, failed: 0, skipped: 'not_configured' };
  let subs;
  try {
    const { results } = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all();
    subs = results || [];
  } catch {
    return { sent: 0, failed: 0, skipped: 'no_table' };
  }
  let sent = 0;
  let failed = 0;
  for (const sub of subs) {
    const r = await sendPush(env, sub, payloadObj);
    if (r.status === 'sent') sent += 1;
    else if (r.status === 'gone') {
      try {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(sub.endpoint).run();
      } catch { /* already gone is fine */ }
    } else failed += 1;
  }
  return { sent, failed, skipped: '' };
}

function pushPayloadForBooking({ ref, name, eventType, eventDate, startTime, venue, city, status }) {
  const loc = [venue, city].filter(Boolean).join(', ');
  const when = startTime ? `${eventDate} at ${startTime}` : eventDate;
  return {
    title: status === 'declined' ? 'Booking attempt for a taken date' : 'New STL Spin Co booking',
    body: `${name} — ${when}${loc ? ` — ${loc}` : ''}${eventType ? ` (${eventType})` : ''}`,
    url: '/owner',
    ref,
    eventDate,
    status,
  };
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function issueOwnerToken(env) {
  const payload = b64url(te.encode(JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env.OWNER_SESSION_SECRET), te.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

async function verifyOwnerToken(env, token) {
  if (!token || !env.OWNER_SESSION_SECRET) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sigB64] = parts;
  let sig;
  try {
    sig = unb64url(sigB64);
  } catch {
    return false;
  }
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(env.OWNER_SESSION_SECRET), sig, te.encode(payload));
  if (!ok) return false;
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(unb64url(payload)));
  } catch {
    return false;
  }
  return typeof data.exp === 'number' && data.exp > Date.now();
}

function requireOwner(env, request) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return verifyOwnerToken(env, token);
}

async function sendMail(env, { to, subject, text }) {
  const from = env.FROM_EMAIL || FROM_EMAIL_DEFAULT;
  if (!to) return { status: 'skipped', error: 'No recipient email.' };
  if (!env.RESEND_API_KEY) {
    console.log(`[email not_configured] From: ${from} To: ${to} Subject: ${subject}`);
    return { status: 'not_configured', error: 'RESEND_API_KEY not set — email not sent.' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { status: 'failed', error: `Resend ${res.status}: ${body.slice(0, 200)}` };
    }
    return { status: 'sent' };
  } catch (err) {
    return { status: 'failed', error: String(err && err.message ? err.message : err) };
  }
}

async function dateTaken(env, eventDate) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM bookings WHERE event_date = ? AND status IN ('under_review','booked')",
  )
    .bind(eventDate)
    .first();
  return (row?.n || 0) > 0;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!env.DB) return json({ ok: false, error: 'Database (D1) is not bound. See worker/README.md.' }, 500);

    // ------------------------------------------------------------ health
    if (request.method === 'GET' && path === '/api/health') {
      return json({ ok: true, service: 'stl-spin-co' });
    }

    // ------------------------------------------- live date check (guest)
    if (request.method === 'GET' && path === '/api/bookings/check-date') {
      const date = url.searchParams.get('date') || '';
      if (!isValidDate(date)) return json({ ok: false, error: 'Provide a valid date (YYYY-MM-DD).' }, 400);
      const taken = await dateTaken(env, date);
      return json({
        ok: true,
        date,
        taken,
        message: taken ? 'That date is already booked.' : 'That date looks free — your request will land as Under Review.',
      });
    }

    // ---------------------------------------- guest booking submission
    if (request.method === 'POST' && path === '/api/bookings') {
      let b;
      try {
        b = await request.json();
      } catch {
        return json({ ok: false, error: 'Invalid JSON body.' }, 400);
      }
      b = b || {};
      const name = String(b.name || '').trim();
      const email = String(b.email || '').trim().toLowerCase();
      const phone = String(b.phone || '').trim();
      const eventType = String(b.eventType || b.event_type || '').trim();
      const eventDate = String(b.eventDate || b.event_date || '').trim();
      const startTime = String(b.startTime || b.start_time || '').trim();
      const venue = String(b.venue || '').trim();
      const city = String(b.city || '').trim();
      const pkg = String(b.package || '').trim();
      const guests = String(b.guests || '').trim();
      const message = String(b.message || '').trim();

      if (!name) return json({ ok: false, error: 'Name is required.' }, 400);
      if (!isValidEmail(email)) {
        return json({ ok: false, error: 'A valid email is required — it is also how you log in to My bookings.' }, 400);
      }
      if (!isValidDate(eventDate)) return json({ ok: false, error: 'A valid event date is required.' }, 400);

      const taken = await dateTaken(env, eventDate);
      const status = taken ? 'declined' : 'under_review';
      const now = new Date().toISOString();
      const ownerEmail = env.OWNER_EMAIL || OWNER_EMAIL_DEFAULT;
      const result = await env.DB.prepare(
        `INSERT INTO bookings
          (name, email, phone, event_type, event_date, start_time, venue, city, package, guests, message, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(name, email, phone, eventType, eventDate, startTime, venue, city, pkg, guests, message, status, now, now)
        .run();
      const id = Number(result.meta.last_row_id);
      const ref = `STL-${String(id).padStart(4, '0')}`;
      await env.DB.prepare('UPDATE bookings SET ref = ? WHERE id = ?').bind(ref, id).run();

      const alert = await sendMail(env, {
        to: ownerEmail,
        subject: taken
          ? `STL Spin Co — booking attempt for a taken date (${eventDate})`
          : `STL Spin Co — new booking request (${eventDate})`,
        text:
          `New booking request ${ref}\n` +
          `Name: ${name}\nEmail: ${email}\nPhone: ${phone || 'Not provided yet'}\n` +
          `Event: ${eventType || 'Not specified'}\nDate: ${eventDate}\nTime: ${startTime || 'Not specified'}\n` +
          `Location: ${[venue, city].filter(Boolean).join(', ') || 'Not provided yet'}\n` +
          `Package: ${pkg || 'Not specified'}\nGuests: ${guests || 'Not specified'}\n` +
          `Status: ${statusLabel(status)}\n` +
          (message ? `Message: ${message}\n` : ''),
      });
      await env.DB.prepare('UPDATE bookings SET alert_email_status = ?, alert_email_error = ?, updated_at = ? WHERE id = ?')
        .bind(alert.status, alert.error || '', now, id)
        .run();

      // Web push to the owner's devices. Fire-and-forget in production
      // (ctx.waitUntil) so a slow push service never delays the guest;
      // awaited when there is no execution context (local tests).
      const pushPayload = pushPayloadForBooking({
        ref, name, eventType, eventDate, startTime, venue, city, status,
      });
      const doPush = sendPushToAll(env, pushPayload).catch((err) => {
        console.log(`[push failed] ${String(err && err.message ? err.message : err)}`);
        return { sent: 0, failed: 1, skipped: 'error' };
      });
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(doPush);
      else await doPush;

      const row = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
      return json(
        {
          ok: true,
          outcome: status,
          booking: publicBooking(row),
          alertEmail: alert.status,
          message: taken
            ? 'That date is already booked, so this request was auto-declined.'
            : "Your request was submitted — it's Under Review. A staff member will approve it by hand and you'll get a confirmation email from stlspinco@gmail.com once approved.",
        },
        201,
      );
    }

    // --------------------------------- guest My bookings (email login)
    if (request.method === 'GET' && path === '/api/bookings/mine') {
      const email = (url.searchParams.get('email') || '').trim().toLowerCase();
      if (!isValidEmail(email)) return json({ ok: false, error: 'Enter the email address you booked with.' }, 400);
      const { results } = await env.DB.prepare(
        'SELECT * FROM bookings WHERE lower(email) = ? ORDER BY event_date ASC, created_at ASC',
      )
        .bind(email)
        .all();
      return json({ ok: true, email, bookings: (results || []).map(publicBooking) });
    }

    // ------------------------------------------------------ owner login
    if (request.method === 'POST' && path === '/api/owner/login') {
      if (!env.OWNER_PASSWORD) {
        return json({ ok: false, error: 'Owner login is not configured on this server.' }, 503);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: 'Invalid JSON body.' }, 400);
      }
      const password = String((body || {}).password || '');
      const a = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(password)));
      const b = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(env.OWNER_PASSWORD)));
      if (!constantTimeEqual(a, b)) return json({ ok: false, error: 'Wrong password.' }, 401);
      return json({ ok: true, token: await issueOwnerToken(env) });
    }

    // --------------------------------------------------- owner bookings
    if (request.method === 'GET' && path === '/api/owner/bookings') {
      if (!(await requireOwner(env, request))) return json({ ok: false, error: 'Owner login required.' }, 401);
      const { results } = await env.DB.prepare('SELECT * FROM bookings ORDER BY event_date ASC, created_at ASC').all();
      return json({ ok: true, bookings: (results || []).map(publicBooking) });
    }

    const ownerAction = path.match(/^\/api\/owner\/bookings\/(\d+)\/(accept|decline)$/);
    if (request.method === 'POST' && ownerAction) {
      if (!(await requireOwner(env, request))) return json({ ok: false, error: 'Owner login required.' }, 401);
      const id = Number(ownerAction[1]);
      const action = ownerAction[2];
      const row = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
      if (!row) return json({ ok: false, error: 'Booking not found.' }, 404);
      if (row.status !== 'under_review') {
        return json(
          { ok: false, error: `Only an Under Review booking can be ${action === 'accept' ? 'accepted' : 'declined'} (this one is ${statusLabel(row.status)}).` },
          409,
        );
      }
      const now = new Date().toISOString();
      if (action === 'accept') {
        await env.DB.prepare("UPDATE bookings SET status = 'booked', updated_at = ? WHERE id = ?").bind(now, id).run();
        let confirmation = { status: 'skipped', error: 'No email on file — confirmation not sent.' };
        if (row.email) {
          confirmation = await sendMail(env, {
            to: row.email,
            subject: `STL Spin Co — your booking for ${row.event_date} is confirmed`,
            text:
              `Hi ${row.name},\n\nGreat news — your STL Spin Co booking is confirmed!\n\n` +
              `Event: ${row.event_type || '360 video booth'}\nDate: ${row.event_date}\nTime: ${row.start_time || 'To be confirmed'}\n` +
              `Location: ${[row.venue, row.city].filter(Boolean).join(', ') || 'To be confirmed'}\n` +
              `Package: ${row.package || 'To be confirmed'}\nReference: ${row.ref}\n\n` +
              `If anything about the details above needs to change, reply to this email.\n\n— STL Spin Co (stlspinco@gmail.com)\n`,
          });
        }
        await env.DB.prepare(
          'UPDATE bookings SET confirmation_email_status = ?, confirmation_email_error = ?, updated_at = ? WHERE id = ?',
        )
          .bind(confirmation.status, confirmation.error || '', now, id)
          .run();
        const updated = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
        return json({ ok: true, booking: publicBooking(updated), confirmationEmail: confirmation.status });
      }
      await env.DB.prepare("UPDATE bookings SET status = 'declined', updated_at = ? WHERE id = ?").bind(now, id).run();
      const updated = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
      return json({ ok: true, booking: publicBooking(updated) });
    }

    // --------------------------------------------------- web push
    // Public key: the browser needs it to subscribe; it is public by
    // design, so no owner login is needed to read it.
    if (request.method === 'GET' && path === '/api/push/vapid-public-key') {
      if (!env.VAPID_PUBLIC_KEY) {
        return json({ ok: false, error: 'Web push is not configured yet.' }, 503);
      }
      return json({ ok: true, publicKey: env.VAPID_PUBLIC_KEY });
    }

    // Owner-only: save this device's push subscription (from /owner,
    // after login). The subscription is a browser-generated endpoint +
    // keys — it identifies a device, not a person, and only the owner
    // can store one, so a guest cannot subscribe themselves to alerts.
    if (request.method === 'POST' && path === '/api/push/subscribe') {
      if (!(await requireOwner(env, request))) return json({ ok: false, error: 'Owner login required.' }, 401);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: 'Invalid JSON body.' }, 400);
      }
      const endpoint = String((body || {}).endpoint || '');
      const keys = (body || {}).keys || {};
      const p256dh = String(keys.p256dh || '');
      const auth = String(keys.auth || '');
      let endpointOk = false;
      try {
        endpointOk = new URL(endpoint).protocol === 'https:';
      } catch { endpointOk = false; }
      let keysOk = false;
      try {
        keysOk = unb64url(p256dh).length === 65 && unb64url(auth).length === 16;
      } catch { keysOk = false; }
      if (!endpointOk || !keysOk) {
        return json({ ok: false, error: 'Provide a valid push subscription (https endpoint, p256dh and auth keys).' }, 400);
      }
      try {
        await env.DB.prepare(
          `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`,
        )
          .bind(endpoint, p256dh, auth, new Date().toISOString())
          .run();
      } catch (err) {
        return json({ ok: false, error: `Could not save subscription: ${String(err && err.message ? err.message : err)}` }, 500);
      }
      return json({ ok: true, subscribed: true });
    }

    if (request.method === 'POST' && path === '/api/push/unsubscribe') {
      if (!(await requireOwner(env, request))) return json({ ok: false, error: 'Owner login required.' }, 401);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: 'Invalid JSON body.' }, 400);
      }
      const endpoint = String((body || {}).endpoint || '');
      if (!endpoint) return json({ ok: false, error: 'Provide the endpoint to remove.' }, 400);
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
      return json({ ok: true, subscribed: false });
    }

    // --------------------------------------------------- static site
    // /owner and everything else is served from public/ via the assets
    // binding. If the binding is missing (e.g. local test harness),
    // /api/* routes above already handled API calls, so this is a 404.
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }
    return json({ ok: false, error: 'Not found.' }, 404);
  },
};
