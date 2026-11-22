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

// If already logged in (same browser session), show the list straight away.
if (token()) {
  $('login-box').style.display = 'none';
  $('bookings-box').style.display = '';
  loadBookings();
}
