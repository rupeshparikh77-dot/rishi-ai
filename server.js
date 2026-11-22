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
        // Map the active price back to a tier.
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

app.use(express.json({ limit: '1mb' }));

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
          // Find by google_id, then by email, else create.
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

// Create a guest account and log in.
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
    models: config.ai.models,
    defaultModel: config.ai.defaultModel,
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
// Chat (streaming via Server-Sent Events)
// body: { conversationId?, message, model?, systemPrompt? }
// ─────────────────────────────────────────────────────────────
app.post('/api/chat', requireUser, async (req, res, next) => {
  const { message, model, systemPrompt } = req.body || {};
  let { conversationId } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'Empty message' });

  // Enforce tier limits.
  const gate = await quota.checkQuota(req.user);
  if (!gate.allowed) {
    return res.status(429).json({ error: gate.reason, resetAt: gate.resetAt, tier: req.user.tier });
  }

  const chosenModel = config.ai.models.includes(model) ? model : config.ai.defaultModel;

  try {
    // Create a conversation if needed, titled from the first message.
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

    // Persist the user's message and count it toward quota.
    await db.query('INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)', [
      conversationId, 'user', message,
    ]);
    await quota.recordMessage(req.user.id);

    // Build the context sent to the model (recent history).
    const history = await db.query(
      `SELECT role, content FROM messages WHERE conversation_id = $1 AND role <> 'system'
        ORDER BY created_at DESC LIMIT 30`,
      [conversationId]
    );
    const ordered = history.rows.reverse();
    const apiMessages = [];
    const baseSystem =
      'You are RishiAI, a helpful AI assistant. When you produce a complete, ' +
      'self-contained document, web page, or code file (especially HTML or SVG), ' +
      'put it in a single fenced code block with a correct language tag (e.g. ```html). ' +
      'The interface renders such blocks as a live, previewable artifact, so keep ' +
      'explanatory prose outside the code block.';
    const combinedSystem = [baseSystem, (systemPrompt || '').trim()].filter(Boolean).join('\n\n');
    apiMessages.push({ role: 'system', content: combinedSystem });
    for (const m of ordered) apiMessages.push({ role: m.role, content: m.content });

    // Open the SSE stream to the browser.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders && res.flushHeaders();
    res.write(`event: meta\ndata: ${JSON.stringify({ conversationId })}\n\n`);

    // Call the AI provider with streaming enabled.
    const aiHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.ai.apiKey}`,
    };
    // Anthropic requires this header when the key isn't scoped to a workspace.
    if (config.ai.workspaceId) aiHeaders['anthropic-workspace-id'] = config.ai.workspaceId;

    const upstream = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: aiHeaders,
      body: JSON.stringify({ model: chosenModel, messages: apiMessages, stream: true }),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => '');
      console.error('[ai] upstream error', upstream.status, errText);
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'AI provider error. Check AI_API_KEY / AI_MODEL.' })}\n\n`);
      return res.end();
    }

    let full = '';
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
          if (delta) {
            full += delta;
            res.write(`event: delta\ndata: ${JSON.stringify({ text: delta })}\n\n`);
          }
        } catch (_) { /* ignore keep-alive / partial */ }
      }
    }

    // Save the assistant reply and bump the conversation timestamp.
    await db.query('INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)', [
      conversationId, 'assistant', full,
    ]);
    await db.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);

    res.write(`event: done\ndata: ${JSON.stringify({ conversationId })}\n\n`);
    res.end();
  } catch (e) {
    console.error('[chat] error', e);
    if (!res.headersSent) return next(e);
    res.write(`event: error\ndata: ${JSON.stringify({ error: 'Server error during generation.' })}\n\n`);
    res.end();
  }
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

// Let the user manage/cancel their subscription in Stripe's portal.
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
