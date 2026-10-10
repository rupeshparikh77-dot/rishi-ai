/* ===========================================================================
 * Portable key/value store.
 *   - DATABASE_URL set  -> Postgres  (Render, Neon, Supabase, etc.)
 *   - REPLIT_DB_URL set -> Replit DB (when running on Replit)
 *   - neither           -> in-memory (dev only; resets on restart)
 * Exposes get(key) / set(key, value) / del(key), all async.
 * Values are JSON-serializable objects or strings.
 * =========================================================================== */

const DATABASE_URL = process.env.DATABASE_URL;
const REPLIT_DB_URL = process.env.REPLIT_DB_URL;

let backend, impl;

/* ---------- Postgres ---------- */
function makePostgres() {
  const { Pool } = require("pg");
  // Render/Neon/Supabase need SSL; a local Postgres usually does not.
  const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 5,
  });

  let ready = null;
  function init() {
    if (!ready) {
      ready = pool.query(
        "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())"
      );
    }
    return ready;
  }

  return {
    async get(key) {
      await init();
      const r = await pool.query("SELECT value FROM kv WHERE key = $1", [key]);
      return r.rows.length ? r.rows[0].value : null;
    },
    async set(key, value) {
      await init();
      await pool.query(
        "INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, now()) " +
          "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        [key, JSON.stringify(value)]
      );
    },
    async del(key) {
      await init();
      await pool.query("DELETE FROM kv WHERE key = $1", [key]);
    },
  };
}

/* ---------- Replit DB ---------- */
function makeReplit() {
  const Database = require("@replit/database");
  const db = new Database();
  return {
    async get(key) {
      const v = await db.get(key);
      return v === undefined ? null : v;
    },
    async set(key, value) {
      await db.set(key, value);
    },
    async del(key) {
      await db.delete(key);
    },
  };
}

/* ---------- In-memory ---------- */
function makeMemory() {
  const m = new Map();
  return {
    async get(key) {
      return m.has(key) ? JSON.parse(m.get(key)) : null;
    },
    async set(key, value) {
      m.set(key, JSON.stringify(value));
    },
    async del(key) {
      m.delete(key);
    },
  };
}

if (DATABASE_URL) {
  backend = "postgres";
  impl = makePostgres();
} else if (REPLIT_DB_URL) {
  backend = "replit";
  impl = makeReplit();
} else {
  backend = "memory";
  impl = makeMemory();
}

module.exports = {
  backend,
  get: (k) => impl.get(k),
  set: (k, v) => impl.set(k, v),
  del: (k) => impl.del(k),
};
