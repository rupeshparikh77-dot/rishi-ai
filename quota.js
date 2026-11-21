const db = require('./db');

// Singapore is a fixed UTC+8 with no daylight saving, so we can compute
// "Singapore time" by adding 8 hours to UTC and reading the UTC fields.
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

function sgtParts(now = Date.now()) {
  const sgt = new Date(now + SGT_OFFSET_MS);
  const dateStr = sgt.toISOString().slice(0, 10); // YYYY-MM-DD in SGT
  const hour = sgt.getUTCHours(); // hour of day in SGT (0-23)
  return { sgt, dateStr, hour };
}

// Returns the real (UTC) Date of the next Singapore midnight — i.e. when
// free/pro limits reset.
function nextSgtMidnight(now = Date.now()) {
  const sgt = new Date(now + SGT_OFFSET_MS);
  const nextMidnightSgt = Date.UTC(
    sgt.getUTCFullYear(),
    sgt.getUTCMonth(),
    sgt.getUTCDate() + 1,
    0, 0, 0, 0
  );
  // Convert that SGT wall-clock midnight back to real UTC time.
  return new Date(nextMidnightSgt - SGT_OFFSET_MS);
}

const FREE_DAILY_MESSAGES = 5;
const FREE_SESSION_MS = 60 * 60 * 1000; // 1 hour
const PRO_CLOSE_HOUR = 18; // 6pm SGT

// Fetch (or create a blank) usage row for the user's current SGT day.
async function getUsage(userId) {
  const { dateStr } = sgtParts();
  const { rows } = await db.query(
    `SELECT message_count, first_message_at
       FROM usage_daily
      WHERE user_id = $1 AND sgt_date = $2`,
    [userId, dateStr]
  );
  return rows[0] || { message_count: 0, first_message_at: null };
}

/**
 * Decide whether `user` may send another message right now.
 * Returns { allowed, reason, resetAt, remaining }.
 */
async function checkQuota(user) {
  const { hour } = sgtParts();

  if (user.tier === 'max') {
    return { allowed: true, remaining: null };
  }

  if (user.tier === 'pro') {
    if (hour >= PRO_CLOSE_HOUR) {
      return {
        allowed: false,
        reason: 'Pro access is closed from 6:00pm. It reopens at midnight Singapore time.',
        resetAt: nextSgtMidnight(),
      };
    }
    return { allowed: true, remaining: null };
  }

  // Free tier
  const usage = await getUsage(user.id);

  if (usage.message_count >= FREE_DAILY_MESSAGES) {
    return {
      allowed: false,
      reason: `Free plan daily limit reached (${FREE_DAILY_MESSAGES} messages). Resets at midnight Singapore time.`,
      resetAt: nextSgtMidnight(),
    };
  }

  if (usage.first_message_at) {
    const elapsed = Date.now() - new Date(usage.first_message_at).getTime();
    if (elapsed > FREE_SESSION_MS) {
      return {
        allowed: false,
        reason: 'Free plan 1-hour session window has ended for today. Resets at midnight Singapore time.',
        resetAt: nextSgtMidnight(),
      };
    }
  }

  return {
    allowed: true,
    remaining: FREE_DAILY_MESSAGES - usage.message_count,
  };
}

// Record that a message was sent (increments the daily counter and stamps
// the session start on the first message of the day).
async function recordMessage(userId) {
  const { dateStr } = sgtParts();
  await db.query(
    `INSERT INTO usage_daily (user_id, sgt_date, message_count, first_message_at)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (user_id, sgt_date)
     DO UPDATE SET
       message_count = usage_daily.message_count + 1,
       first_message_at = COALESCE(usage_daily.first_message_at, NOW())`,
    [userId, dateStr]
  );
}

// Build a plain summary of the user's current limits for the UI.
async function quotaSummary(user) {
  const q = await checkQuota(user);
  const base = {
    tier: user.tier,
    allowed: q.allowed,
    reason: q.reason || null,
    resetAt: q.resetAt || null,
  };
  if (user.tier === 'free') {
    const usage = await getUsage(user.id);
    base.messagesUsed = usage.message_count;
    base.messagesLimit = FREE_DAILY_MESSAGES;
    base.sessionStartedAt = usage.first_message_at;
    base.sessionWindowMs = FREE_SESSION_MS;
  }
  return base;
}

module.exports = {
  checkQuota,
  recordMessage,
  quotaSummary,
  sgtParts,
  nextSgtMidnight,
  FREE_DAILY_MESSAGES,
  FREE_SESSION_MS,
  PRO_CLOSE_HOUR,
};
