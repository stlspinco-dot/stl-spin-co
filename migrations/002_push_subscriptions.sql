-- STL Spin Co — web push subscriptions (migration 002).
-- Apply after 001_init.sql:
--   npx wrangler d1 execute stl-spin-co --file ../migrations/002_push_subscriptions.sql
-- One row per device/browser the owner subscribed from /owner.
-- endpoint is the push service URL (FCM / Mozilla / Apple); p256dh and
-- auth are the browser-generated keys, stored as base64url strings.
-- No guest data lives here — only owner devices can subscribe, and the
-- owner page is the only place that calls /api/push/subscribe.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
