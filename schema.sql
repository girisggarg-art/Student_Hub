-- CampusLink v3 Production PostgreSQL Schema (Admin, Client, Freelancer, User)
-- Safe to run repeatedly on every server startup.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  university TEXT NOT NULL,
  year TEXT NOT NULL,
  hostel TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'both',
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  is_banned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'both';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  budget INTEGER NOT NULL CHECK (budget >= 10),
  deadline TEXT NOT NULL,
  description TEXT NOT NULL,
  poster_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  poster_name TEXT NOT NULL,
  poster_phone TEXT NOT NULL,
  poster_university TEXT NOT NULL,
  poster_year TEXT NOT NULL,
  poster_hostel TEXT NOT NULL,
  accepted_bid_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at BIGINT NOT NULL
);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';

CREATE TABLE IF NOT EXISTS bids (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  bidder_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bidder_name TEXT NOT NULL,
  bidder_phone TEXT NOT NULL,
  bidder_university TEXT NOT NULL,
  bidder_year TEXT NOT NULL,
  bidder_hostel TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 10),
  eta TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(job_id, bidder_id)
);

CREATE TABLE IF NOT EXISTS pools (
  id TEXT PRIMARY KEY,
  university TEXT NOT NULL,
  platform TEXT NOT NULL,
  hostel TEXT NOT NULL,
  target INTEGER NOT NULL CHECK (target >= 50),
  closes TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  starter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starter_name TEXT NOT NULL,
  starter_year TEXT NOT NULL,
  starter_phone TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS pool_items (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_name TEXT NOT NULL,
  student_phone TEXT NOT NULL,
  student_year TEXT NOT NULL,
  item_name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 5),
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_university ON jobs(poster_university);
CREATE INDEX IF NOT EXISTS idx_bids_job_id ON bids(job_id);
CREATE INDEX IF NOT EXISTS idx_pools_university ON pools(university);
CREATE INDEX IF NOT EXISTS idx_pool_items_pool_id ON pool_items(pool_id);
