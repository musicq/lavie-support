-- Request counts for /api/statement: per hashed IP per hour and day, and for everyone per day.
CREATE TABLE IF NOT EXISTS usage (
  bucket TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_day ON usage (day);
