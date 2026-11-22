const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const config = require('./config');
const db = require('./db');
const quota = require('./quota');

const app = express();
app.set('trust proxy', 1); // required on Render for secure cookies

// ── Stripe (optional) ──
const stripe = config.stripe.enabled ? require('stripe')(config.stripe.secretKey) : null;

// ─────────────────────────────────────────────────────────────
// Stripe webhook needs the RAW body, so it MUST be registered
// before express.json(). Everything else uses JSON.
// ─────────────────────────────────────────────────────────────
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !config.stripe.webhookSecret) return res.status(400).send('Stripe not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.stripe.webhookSecret);
  } catch (err) {
    console.error('[stripe] webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const userId = s.client_reference_id;
        const tier = s.metadata && s.metadata.tier;
        if (userId && tier) {
          await db.query(
            `UPDATE users SET tier = $1, stripe_customer_id = $2, subscription_status = 'active' WHERE id = $3`,
            [tier, s.customer, userId]
          );
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const status = sub.status;
        let tier = 'free';
        const priceId = sub.items && sub.items.data[0] && sub.items.data[0].price.id;
        if (status === 'active' || status === 'trialing') {
          if (priceId === config.stripe.prices.pro) tier = 'pro';
          else if (priceId === config.stripe.prices.max) tier = 'max';
        }
        await db.query(
          `UPDATE users SET tier = $1, subscription_status = $2 WHERE stripe_customer_id = $3`,
          [tier, status, sub.customer]
        );
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('[stripe] webhook handling error:', err);
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '2mb' }));

// ── Sessions stored in Neon ──
app.use(
  session({
    store: new PgSession({ pool: db.pool, tableName: 'session', createTableIfMissing: false }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
      httpOnly: true,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production',
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    done(null, rows[0] || null);
  } catch (e) {
    done(e);
  }
});

if (config.google.enabled) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: config.google.clientId,
        clientSecret: config.google.clientSecret,
        callbackURL: `${config.appUrl}/api/auth/google/callback`,
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const email = profile.emails && profile.emails[0] && profile.emails[0].value;
          const name = profile.displayName;
          const avatar = profile.photos && profile.photos[0] && profile.photos[0].value;
          let { rows } = await db.query('SELECT * FROM users WHERE google_id = $1', [profile.id]);
          if (!rows[0] && email) {
            ({ rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]));
            if (rows[0]) {
              await db.query('UPDATE users SET google_id = $1, avatar_url = $2, is_guest = FALSE WHERE id = $3', [
                profile.id, avatar, rows[0].id,
              ]);
            }
          }
          if (!rows[0]) {
            ({ rows } = await db.query(
              `INSERT INTO users (email, name, avatar_url, google_id, is_guest, tier)
               VALUES ($1, $2, $3, $4, FALSE, 'free') RETURNING *`,
              [email, name, avatar, profile.id]
            ));
          }
          done(null, rows[0]);
        } catch (e) {
          done(e);
        }
      }
    )
  );
}

// ─────────────────────────────────────────────────────────────
// Auth routes
// ─────────────────────────────────────────────────────────────
function requireUser(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: 'Not signed in' });
}

app.post('/api/auth/guest', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `INSERT INTO users (name, is_guest, tier) VALUES ('Guest', TRUE, 'free') RETURNING *`
    );
    req.login(rows[0], (err) => {
      if (err) return next(err);
      res.json({ ok: true });
    });
  } catch (e) {
    next(e);
  }
});

if (config.google.enabled) {
  app.get('/api/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
  app.get(
    '/api/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/?auth=failed' }),
    (req, res) => res.redirect('/')
  );
}

app.post('/api/auth/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.json({ ok: true });
  });
});

app.get('/api/me', async (req, res) => {
  if (!req.user) return res.json({ user: null, googleEnabled: config.google.enabled, stripeEnabled: config.stripe.enabled });
  const summary = await quota.quotaSummary(req.user);
  res.json({
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      avatarUrl: req.user.avatar_url,
      isGuest: req.user.is_guest,
      tier: req.user.tier,
    },
    quota: summary,
    googleEnabled: config.google.enabled,
    stripeEnabled: config.stripe.enabled,
  });
});

// ─────────────────────────────────────────────────────────────
// Conversation routes
// ─────────────────────────────────────────────────────────────
app.get('/api/conversations', requireUser, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, title, updated_at FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100',
      [req.user.id]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

app.get('/api/conversations/:id', requireUser, async (req, res, next) => {
  try {
    const conv = await db.query('SELECT * FROM conversations WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!conv.rows[0]) return res.status(404).json({ error: 'Not found' });
    const msgs = await db.query(
      `SELECT id, role, content, created_at FROM messages
        WHERE conversation_id = $1 AND role <> 'system' ORDER BY created_at`,
      [req.params.id]
    );
    res.json({ conversation: conv.rows[0], messages: msgs.rows });
  } catch (e) { next(e); }
});

app.delete('/api/conversations/:id', requireUser, async (req, res, next) => {
  try {
    await db.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────
// Chat — the AI runs in the visitor's BROWSER (WebLLM), not here.
// The server only: checks the tier limit, stores the user's message,
// returns recent history for context, and later stores the reply.
// ─────────────────────────────────────────────────────────────

// Step 1: user sends a message. Enforce quota, save it, return history.
app.post('/api/chat/user', requireUser, async (req, res, next) => {
  const { message } = req.body || {};
  let { conversationId } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'Empty message' });

  const gate = await quota.checkQuota(req.user);
  if (!gate.allowed) {
    return res.status(429).json({ error: gate.reason, resetAt: gate.resetAt, tier: req.user.tier });
  }

  try {
    if (!conversationId) {
      const title = message.trim().slice(0, 60);
      const { rows } = await db.query(
        'INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id',
        [req.user.id, title]
      );
      conversationId = rows[0].id;
    } else {
      const own = await db.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, req.user.id]);
      if (!own.rows[0]) return res.status(404).json({ error: 'Conversation not found' });
    }

    await db.query('INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)', [
      conversationId, 'user', message,
    ]);
    await quota.recordMessage(req.user.id);

    const history = await db.query(
      `SELECT role, content FROM messages WHERE conversation_id = $1 AND role <> 'system'
        ORDER BY created_at DESC LIMIT 20`,
      [conversationId]
    );
    res.json({ conversationId, messages: history.rows.reverse() });
  } catch (e) { next(e); }
});

// Step 2: browser finished generating. Store the assistant's reply.
app.post('/api/chat/assistant', requireUser, async (req, res, next) => {
  const { conversationId, content } = req.body || {};
  if (!conversationId || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'Missing conversationId or content' });
  }
  try {
    const own = await db.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, req.user.id]);
    if (!own.rows[0]) return res.status(404).json({ error: 'Conversation not found' });
    await db.query('INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)', [
      conversationId, 'assistant', content,
    ]);
    await db.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────
// Billing (Stripe)
// ─────────────────────────────────────────────────────────────
app.post('/api/billing/checkout', requireUser, async (req, res, next) => {
  if (!stripe) return res.status(400).json({ error: 'Billing not configured' });
  const { tier } = req.body || {};
  const priceId = config.stripe.prices[tier];
  if (!priceId) return res.status(400).json({ error: 'Unknown tier' });
  if (req.user.is_guest) return res.status(400).json({ error: 'Sign in with Google before subscribing.' });

  try {
    const sessionObj = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: String(req.user.id),
      customer_email: req.user.email || undefined,
      metadata: { tier, userId: String(req.user.id) },
      success_url: `${config.appUrl}/?checkout=success`,
      cancel_url: `${config.appUrl}/?checkout=cancel`,
    });
    res.json({ url: sessionObj.url });
  } catch (e) { next(e); }
});

app.post('/api/billing/portal', requireUser, async (req, res, next) => {
  if (!stripe) return res.status(400).json({ error: 'Billing not configured' });
  if (!req.user.stripe_customer_id) return res.status(400).json({ error: 'No subscription found' });
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: req.user.stripe_customer_id,
      return_url: config.appUrl,
    });
    res.json({ url: portal.url });
  } catch (e) { next(e); }
});

// ── Static frontend ──
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Boot ──
db.init()
  .then(() => {
    app.listen(config.port, () => console.log(`[server] listening on ${config.port} (${config.appUrl})`));
  })
  .catch((err) => {
    console.error('[server] failed to init database:', err);
    process.exit(1);
  });
