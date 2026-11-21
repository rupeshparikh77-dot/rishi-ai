-- ─────────────────────────────────────────────────────────────
-- Database schema. Runs automatically on server start, but you
-- can also paste it into the Neon SQL editor to create tables.
-- Safe to run multiple times (uses IF NOT EXISTS).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id                  BIGSERIAL PRIMARY KEY,
  email               TEXT UNIQUE,
  name                TEXT,
  avatar_url          TEXT,
  google_id           TEXT UNIQUE,
  is_guest            BOOLEAN NOT NULL DEFAULT FALSE,
  tier                TEXT NOT NULL DEFAULT 'free',   -- free | pro | max
  stripe_customer_id  TEXT,
  subscription_status TEXT,                            -- active | canceled | etc.
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversations (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'New chat',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id               BIGSERIAL PRIMARY KEY,
  conversation_id  BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL,   -- user | assistant | system
  content          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

-- One row per user per Singapore-time day, for enforcing free-tier limits.
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sgt_date         DATE NOT NULL,
  message_count    INTEGER NOT NULL DEFAULT 0,
  first_message_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, sgt_date)
);

-- Session store table used by connect-pg-simple.
CREATE TABLE IF NOT EXISTS "session" (
  "sid"    VARCHAR NOT NULL COLLATE "default",
  "sess"   JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
