// Optional one-off script to create the tables (server.js also does this
// automatically on boot). Run via `npm run db:init` if you ever want to.
const db = require('../db');

db.init()
  .then(() => { console.log('Done.'); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
