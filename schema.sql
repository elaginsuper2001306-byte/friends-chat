-- Messenger schema. All reads/writes go through the application server,
-- which enforces its own session checks; there are no client-facing DB policies.

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  password_iterations integer NOT NULL,
  created_at timestamptz NOT NULL
);

-- Profile fields. Defaults keep the ALTER statements below idempotent for existing databases.
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS first_name text NOT NULL DEFAULT '';
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS last_name text NOT NULL DEFAULT '';
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS nickname text NOT NULL DEFAULT '';
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS class_key text NOT NULL DEFAULT '';
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS avatar_mime text;
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS avatar_data bytea;
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS avatar_updated_at timestamptz;

-- Only token digests are stored; plaintext session tokens never reach the database.
CREATE TABLE IF NOT EXISTS app.sessions (
  token_digest text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.users (id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

-- Fixed-window rate limiting; the unique key makes the check atomic under concurrency.
CREATE TABLE IF NOT EXISTS app.auth_limiter (
  key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL
);

CREATE TABLE IF NOT EXISTS app.channels (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS app.channel_messages (
  seq bigserial,
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES app.channels (id),
  author_id uuid NOT NULL,
  author_name text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS channel_messages_channel_seq_idx ON app.channel_messages (channel_id, seq);

-- pair_key is the canonical "smallerUUID:largerUUID" pair; one thread per user pair.
CREATE TABLE IF NOT EXISTS app.dm_threads (
  id uuid NOT NULL UNIQUE,
  pair_key text PRIMARY KEY,
  user_a uuid NOT NULL,
  user_b uuid NOT NULL,
  user_a_name text NOT NULL,
  user_b_name text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS app.dm_messages (
  seq bigserial,
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES app.dm_threads (id),
  author_id uuid NOT NULL,
  author_name text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS dm_messages_thread_seq_idx ON app.dm_messages (thread_id, seq);

-- One cached Telemost conference per channel. Telemost join links are short-lived,
-- so a room is re-created once its cached link is about to expire.
CREATE TABLE IF NOT EXISTS app.voice_rooms (
  channel_id uuid PRIMARY KEY REFERENCES app.channels (id),
  conference_id text NOT NULL,
  join_url text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);