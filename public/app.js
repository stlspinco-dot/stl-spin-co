'use strict';

const $ = (id) => document.getElementById(id);
const statusLabel = (s) => ({ under_review: 'Under Review', booked: 'Booked — Confirmed', declined: 'Declined' }[s] || s);

function bookingHtml(b) {
  const loc = b.location || [b.venue, b.city].filter(Boolean).join(', ') || 'Not provided yet';
  return `
  <article class="booking">
    <div class="b-name">${escapeHtml(b.name)} — ${escapeHtml(b.eventType || 'Event')} <span class="pill ${b.status}">${statusLabel(b.status)}</span></div>
    <p class="b-line b-meta">${escapeHtml(b.eventDate)} &middot; ${escapeHtml(b.startTime || 'Time not specified')}</p>
    <p class="b-line"><strong>Location:</strong> ${escapeHtml(loc)}</p>
    <p class="b-line"><strong>Email:</strong> ${escapeHtml(b.email || 'Not provided yet')}</p>
    <p class="b-line"><strong>Phone:</strong> ${escapeHtml(b.phone || 'Not provided yet')}</p>
    ${b.package ? `<p class="b-line"><strong>Package:</strong> ${escapeHtml(b.package)}</p>` : ''}
    <p class="b-line"><strong>Reference:</strong> ${escapeHtml(b.ref || '')}</p>
  </article>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showNotice(el, text, kind) {
  el.textContent = text;
  el.className = `notice show ${kind || ''}`;
}

// Live date check as the guest picks a date.
$('f-date').addEventListener('change', async () => {
  const date = $('f-date').value;
  const hint = $('date-hint');
  if (!date) { hint.textContent = ''; hint.className = 'hint'; return; }
  try {
    const res = await fetch(`/api/bookings/check-date?date=${encodeURIComponent(date)}`);
    const data = await res.json();
    hint.textContent = data.message || '';
    hint.className = `hint ${data.taken ? 'taken' : 'free'}`;
    $('submit-btn').disabled = !!data.taken;
  } catch {
    hint.textContent = 'Could not check that date right now — you can still send the request and we will check it.';
    hint.className = 'hint';
  }
});

// Booking form submit.
$('booking-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const payload = Object.fromEntries(form.entries());
  const notice = $('booking-notice');
  $('submit-btn').disabled = true;
  try {
    const res = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      showNotice(notice, data.error || 'Something went wrong sending your request. Please try again or email stlspinco@gmail.com.', 'err');
      return;
    }
    if (data.outcome === 'declined') {
      showNotice(notice, `That date is already booked, so this request was auto-declined. Please pick another date. (Ref ${data.booking.ref})`, 'warn');
    } else {
      showNotice(notice, `Request ${data.booking.ref} submitted — Under Review. A staff member will approve it by hand and you'll get a confirmation email from stlspinco@gmail.com once approved.`, 'ok');
      e.target.reset();
      $('date-hint').textContent = '';
    }
  } catch {
    showNotice(notice, 'Could not reach the server. Please try again or email stlspinco@gmail.com.', 'err');
  } finally {
    $('submit-btn').disabled = false;
  }
});

// My bookings login (email only — see README about this trade-off).
$('my-bookings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('m-email').value.trim();
  const notice = $('my-notice');
  const list = $('my-list');
  list.innerHTML = '';
  try {
    const res = await fetch(`/api/bookings/mine?email=${encodeURIComponent(email)}`);
    const data = await res.json();
    if (!res.ok || !data.ok) {
      showNotice(notice, data.error || 'Could not load your bookings.', 'err');
      return;
    }
    if (!data.bookings.length) {
      showNotice(notice, `No bookings found for ${email}. Check the email you booked with, or send a new booking request above.`, 'warn');
      return;
    }
    notice.className = 'notice';
    notice.textContent = '';
    list.innerHTML = data.bookings.map(bookingHtml).join('');
  } catch {
    showNotice(notice, 'Could not reach the server. Please try again.', 'err');
  }
});
