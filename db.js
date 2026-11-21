const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');

// Neon requires SSL. The connection string should include ?sslmode=require,
// but we also set ssl here to be safe.
const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: { rejectUnauthorized: false },
});

async function query(text, params) {
  return pool.query(text, params);
}

// Run schema.sql on startup so the tables always exist.
async function init() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[db] Schema ensured.');
}

module.exports = { pool, query, init };
