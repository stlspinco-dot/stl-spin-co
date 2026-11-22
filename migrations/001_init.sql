-- STL Spin Co — database schema.
-- Works as-is for SQLite (this project) and for Cloudflare D1 (SQLite).
-- See README.md / docs/cloudflare.md for the D1 deployment path.
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL DEFAULT '',
  event_date TEXT NOT NULL,
  start_time TEXT NOT NULL DEFAULT '',
  venue TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  package TEXT NOT NULL DEFAULT '',
  guests TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'under_review'
    CHECK (status IN ('under_review', 'booked', 'declined')),
  alert_email_status TEXT NOT NULL DEFAULT '',
  alert_email_error TEXT NOT NULL DEFAULT '',
  confirmation_email_status TEXT NOT NULL DEFAULT '',
  confirmation_email_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Fast lookups for the two queries that matter:
--  1. "Is this date taken?" (one booking per day)
--  2. "Show me my bookings" (guest login by email)
CREATE INDEX IF NOT EXISTS idx_bookings_date_status
  ON bookings (event_date, status);
CREATE INDEX IF NOT EXISTS idx_bookings_email
  ON bookings (email);
