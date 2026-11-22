'use strict';

const $ = (id) => document.getElementById(id);
const statusLabel = (s) => ({ under_review: 'Under Review', booked: 'Booked — Confirmed', declined: 'Declined' }[s] || s);
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function token() { return sessionStorage.getItem('stl-owner-token') || ''; }
function authHeaders() { return { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` }; }
function showNotice(el, text, kind) { el.textContent = text; el.className = `notice show ${kind || ''}`; }

function bookingHtml(b) {
  const loc = b.location || [b.venue, b.city].filter(Boolean).join(', ') || 'Not provided yet';
  const actions = b.status === 'under_review'
    ? `<div class="row-actions">
         <button class="btn small" data-accept="${b.id}" type="button">Accept</button>
         <button class="btn small decline" data-decline="${b.id}" type="button">Decline</button>
       </div>`
    : '';
  return `
  <article class="booking">
    <div class="b-name">${escapeHtml(b.name)} — ${escapeHtml(b.eventType || 'Event')} <span class="pill ${b.status}">${statusLabel(b.status)}</span></div>
    <p class="b-line b-meta">${escapeHtml(b.eventDate)} &middot; ${escapeHtml(b.startTime || 'Time not specified')}</p>
    <p class="b-line"><strong>Location:</strong> ${escapeHtml(loc)}</p>
    <p class="b-line"><strong>Email:</strong> ${escapeHtml(b.email || 'Not provided yet')}</p>
    <p class="b-line"><strong>Phone:</strong> ${escapeHtml(b.phone || 'Not provided yet')}</p>
    ${b.package ? `<p class="b-line"><strong>Package:</strong> ${escapeHtml(b.package)}</p>` : ''}
    <p class="b-line"><strong>Reference:</strong> ${escapeHtml(b.ref || '')}</p>
    ${actions}
  </article>`;
}

async function loadBookings() {
  const notice = $('owner-notice');
  try {
    const res = await fetch('/api/owner/bookings', { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      if (res.status === 401) { logOut(); return; }
      showNotice(notice, data.error || 'Could not load bookings.', 'err');
      return;
    }
    notice.className = 'notice';
    notice.textContent = '';
    $('owner-list').innerHTML = data.bookings.length
      ? data.bookings.map(bookingHtml).join('')
      : '<p class="sub">No bookings yet. The first real booking will be the first thing in this list.</p>';
  } catch {
    showNotice(notice, 'Could not reach the server.', 'err');
  }
}

function logOut() {
  sessionStorage.removeItem('stl-owner-token');
  $('bookings-box').style.display = 'none';
  $('login-box').style.display = '';
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const notice = $('login-notice');
  try {
    const res = await fetch('/api/owner/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('owner-password').value }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) { showNotice(notice, data.error || 'Login failed.', 'err'); return; }
    sessionStorage.setItem('stl-owner-token', data.token);
    $('login-box').style.display = 'none';
    $('bookings-box').style.display = '';
    await loadBookings();
    refreshPushState();
  } catch {
    showNotice(notice, 'Could not reach the server.', 'err');
  }
});

$('refresh-btn').addEventListener('click', loadBookings);
$('logout-btn').addEventListener('click', logOut);

$('owner-list').addEventListener('click', async (e) => {
  const acceptBtn = e.target.closest('[data-accept]');
  const declineBtn = e.target.closest('[data-decline]');
  const id = acceptBtn ? acceptBtn.dataset.accept : declineBtn ? declineBtn.dataset.decline : null;
  if (!id) return;
  const action = acceptBtn ? 'accept' : 'decline';
  const notice = $('owner-notice');
  try {
    const res = await fetch(`/api/owner/bookings/${id}/${action}`, { method: 'POST', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok || !data.ok) { showNotice(notice, data.error || `Could not ${action} that booking.`, 'err'); return; }
    showNotice(notice, action === 'accept'
      ? `Accepted — confirmation email ${data.confirmationEmail === 'sent' ? 'sent' : `not sent (${data.confirmationEmail})`}.`
      : 'Declined — that date is free again.', 'ok');
    await loadBookings();
  } catch {
    showNotice(notice, 'Could not reach the server.', 'err');
  }
});

// ------------------------------------------------- booking notifications
// Web push, owner only. The button lives inside #bookings-box, so it
// only shows after login. On iPhone this only works in the Home Screen
// web app (iOS 16.4+) — in a plain Safari tab, subscribe() will fail
// and the notice below says so plainly instead of failing silently.
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
async function currentPushSubscription() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? await reg.pushManager.getSubscription() : null;
  } catch {
    return null;
  }
}
async function refreshPushState() {
  const btn = $('push-btn');
  const offBtn = $('push-off-btn');
  const notice = $('push-notice');
  if (!pushSupported()) {
    btn.disabled = true;
    showNotice(notice, 'This browser or device does not support web push notifications.', 'warn');
    return;
  }
  const sub = await currentPushSubscription();
  if (sub) {
    btn.style.display = 'none';
    offBtn.style.display = '';
    showNotice(notice, 'Notifications are on for this device.', 'ok');
  } else {
    btn.style.display = '';
    offBtn.style.display = 'none';
    notice.className = 'notice';
    notice.textContent = '';
  }
  if (Notification.permission === 'denied') {
    btn.disabled = true;
    showNotice(notice, 'Notifications are blocked for this app. On iPhone: open Settings, find STL Spin Co, turn Notifications on, then try again.', 'warn');
  }
}

$('push-btn').addEventListener('click', async () => {
  const notice = $('push-notice');
  try {
    const keyRes = await fetch('/api/push/vapid-public-key');
    const keyData = await keyRes.json();
    if (!keyRes.ok || !keyData.ok) {
      showNotice(notice, 'Web push is not set up on the server yet.', 'err');
      return;
    }
    await navigator.serviceWorker.register('/sw.js');
    // The just-registered worker is not active yet on a first install —
    // subscribing against it fails on iPhone, and only a second tap
    // (once the worker is active) shows the Allow prompt. Wait for the
    // active worker and subscribe against that registration instead.
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(keyData.publicKey),
    });
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.toJSON().keys }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      await sub.unsubscribe().catch(() => {});
      showNotice(notice, data.error || 'Could not save this device for notifications.', 'err');
      return;
    }
    showNotice(notice, 'Notifications are on for this device — you will get a notification when a new booking arrives.', 'ok');
    await refreshPushState();
  } catch (err) {
    if (Notification.permission === 'denied' || (err && err.name === 'NotAllowedError')) {
      showNotice(notice, 'Notifications are blocked for this app. On iPhone: open Settings, find STL Spin Co, turn Notifications on, then try again.', 'warn');
    } else {
      showNotice(notice, 'Could not turn notifications on here. On iPhone, open this page from the Home Screen app (not a Safari tab) and try again.', 'err');
    }
  }
});

$('push-test-btn').addEventListener('click', async () => {
  const notice = $('push-notice');
  const btn = $('push-test-btn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/push/test', { method: 'POST', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      showNotice(notice, data.error || 'Could not send a test notification.', 'err');
      return;
    }
    if (data.skipped === 'not_configured') {
      showNotice(notice, 'Web push is not set up on the server yet.', 'err');
    } else if (!data.total) {
      showNotice(notice, 'No devices are subscribed yet — tap "Enable booking notifications" first, then try the test again.', 'warn');
    } else if (data.failed > 0) {
      showNotice(notice, `Test notification: sent to ${data.sent} of ${data.total} device(s), ${data.failed} failed.`, 'warn');
    } else {
      showNotice(notice, `Test notification sent to ${data.sent} device(s) — check your phone for it.`, 'ok');
    }
  } catch {
    showNotice(notice, 'Could not reach the server.', 'err');
  } finally {
    btn.disabled = false;
  }
});

$('push-off-btn').addEventListener('click', async () => {
  const notice = $('push-notice');
  try {
    const sub = await currentPushSubscription();
    if (sub) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    showNotice(notice, 'Notifications are off for this device.', '');
    await refreshPushState();
  } catch {
    showNotice(notice, 'Could not turn notifications off — try again.', 'err');
  }
});

// If already logged in (same browser session), show the list straight away.
if (token()) {
  $('login-box').style.display = 'none';
  $('bookings-box').style.display = '';
  loadBookings();
  refreshPushState();
}
