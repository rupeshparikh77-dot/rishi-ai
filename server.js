/* ===========================================================================
 * RishiAI — server
 * Express backend: Google sign-in (real OAuth), Claude under the hood,
 * Stripe subscriptions with a 1-month free trial, Replit DB storage.
 * =========================================================================== */

const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const Anthropic = require("@anthropic-ai/sdk");
const Stripe = require("stripe");

const store = require("./store");

/* ---------- Config & secrets ---------- */
const {
  GOOGLE_CLIENT_ID,
  ANTHROPIC_API_KEY,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  SESSION_SECRET,
  COMP_MAX_EMAILS = "", // comma-separated emails that get MAX for free
  PORT = 3000,
} = process.env;

// A session signing secret is required; fall back to a random one per boot
// (fine for dev — sessions just won't survive a restart until you set it).
const JWT_SECRET =
  SESSION_SECRET || require("crypto").randomBytes(32).toString("hex");

const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const anthropic = ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  : null;
const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;

// Accounts that get MAX for free. Add more via the COMP_MAX_EMAILS secret
// (comma-separated). Google handles the actual password — the app never
// sees or stores one.
const COMP_DEFAULTS = ["rishi.parikh17@gmail.com"];
const COMP_SET = new Set(
  COMP_DEFAULTS.concat(COMP_MAX_EMAILS.split(","))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

/* ---------- Models ----------
 * Edit the `api` ids here if a model is retired — see
 * https://docs.claude.com/en/docs/about-claude/models
 */
const MODELS = [
  { id: "rishi-flash", name: "Rishi Flash", api: "claude-haiku-5-5",  chip: "Fast",     minPlan: "free",
    desc: "Quick replies for everyday questions, rewrites and summaries. Answers almost instantly." },
  { id: "rishi-core",  name: "Rishi Core",  api: "claude-sonnet-5-5", chip: "Balanced", minPlan: "free",
    desc: "The balanced all-rounder — solid reasoning with good speed. The default for most work." },
  { id: "rishi-pro",   name: "Rishi Pro",   api: "claude-sonnet-5-5", chip: "Pro",      minPlan: "pro",
    desc: "Deeper reasoning tuned for analysis, longer drafts and structured output. Needs Pro." },
  { id: "rishi-max",   name: "Rishi Max",   api: "claude-opus-5-5",   chip: "Max",      minPlan: "max",
    desc: "Most capable — hardest reasoning, long-horizon tasks, careful code. Thinks longest. Needs MAX." },
];

const PLANS = {
  free: { name: "Free", price: 0,  rank: 0 },
  pro:  { name: "Pro",  price: 18, rank: 1 },
  max:  { name: "MAX",  price: 30, rank: 2 },
};
const planRank = (p) => (PLANS[p] ? PLANS[p].rank : 0);

const EFFORT_TOKENS = { low: 700, medium: 1400, high: 2600 };

/* ---------- App ---------- */
const app = express();
app.set("trust proxy", 1);

// Stripe webhook needs the raw body — mount BEFORE express.json().
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  handleStripeWebhook
);

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(express.static("public"));

/* ---------- Storage helpers ---------- */
async function getUser(id) {
  try {
    const u = await store.get("user:" + id);
    return u || null;
  } catch (e) {
    return null;
  }
}
async function saveUser(u) {
  u.updatedAt = Date.now();
  await store.set("user:" + u.id, u);
  if (u.stripeCustomerId) await store.set("cust:" + u.stripeCustomerId, u.id);
  return u;
}
async function userIdByCustomer(customerId) {
  try {
    return (await store.get("cust:" + customerId)) || null;
  } catch (e) {
    return null;
  }
}

function isComp(email, name) {
  const e = (email || "").toLowerCase();
  const local = e.split("@")[0];
  if (COMP_SET.has(e)) return true;
  if (local === "rishi") return true;
  if ((name || "").trim().toLowerCase() === "rishi") return true;
  return false;
}

// Effective plan accounts for comp access and expired trials.
function effectivePlan(u) {
  if (u.comp) return "max";
  return PLANS[u.plan] ? u.plan : "free";
}

function publicUser(u) {
  const plan = effectivePlan(u);
  return {
    email: u.email,
    name: u.name,
    picture: u.picture || "",
    plan,
    comp: !!u.comp,
    trialEnds: u.trialEnds || 0,
    subStatus: u.subStatus || "none",
    models: MODELS.map((m) => ({
      id: m.id, name: m.name, chip: m.chip, desc: m.desc,
      minPlan: m.minPlan, allowed: planRank(plan) >= planRank(m.minPlan),
    })),
    plans: PLANS,
  };
}

/* ---------- Session ---------- */
const COOKIE = "rid_session";
function setSession(res, userId) {
  const token = jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: "30d" });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 30 * 24 * 3600 * 1000,
  });
}
function clearSession(res) {
  res.clearCookie(COOKIE);
}
async function currentUser(req) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return null;
  try {
    const { sub } = jwt.verify(token, JWT_SECRET);
    return await getUser(sub);
  } catch (e) {
    return null;
  }
}
async function requireAuth(req, res, next) {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ error: "not_authenticated" });
  req.user = u;
  next();
}

function baseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return proto + "://" + host;
}

/* ===========================================================================
 * Routes
 * =========================================================================== */

// Frontend config (public values only)
app.get("/api/config", (req, res) => {
  res.json({
    googleClientId: GOOGLE_CLIENT_ID || "",
    configured: {
      google: !!GOOGLE_CLIENT_ID,
      claude: !!anthropic,
      stripe: !!stripe,
    },
  });
});

// Who am I
app.get("/api/me", async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.json({ user: null });
  res.json({ user: publicUser(u) });
});

// Google sign-in: verify the ID token, upsert the user, set the session.
app.post("/api/auth/google", async (req, res) => {
  if (!googleClient)
    return res.status(500).json({ error: "google_not_configured" });
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: "missing_credential" });
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const p = ticket.getPayload();
    const id = "google:" + p.sub;
    let u = await getUser(id);
    if (!u) {
      u = {
        id,
        email: p.email,
        name: p.name || p.email,
        picture: p.picture || "",
        plan: "free",
        trialEnds: 0,
        subStatus: "none",
        stripeCustomerId: "",
        stripeSubId: "",
        createdAt: Date.now(),
      };
    } else {
      u.email = p.email;
      u.name = p.name || u.name;
      u.picture = p.picture || u.picture;
    }
    u.comp = isComp(u.email, u.name); // server-side MAX override
    await saveUser(u);
    setSession(res, u.id);
    res.json({ user: publicUser(u) });
  } catch (e) {
    console.error("google verify failed:", e.message);
    res.status(401).json({ error: "invalid_token" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

/* ---------- Chat / Co-work (Claude) ---------- */
app.post("/api/chat", requireAuth, async (req, res) => {
  if (!anthropic)
    return res.status(500).json({ error: "claude_not_configured" });

  const { messages, modelId, effort, system } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: "no_messages" });

  const model = MODELS.find((m) => m.id === modelId) || MODELS[1];
  const plan = effectivePlan(req.user);
  if (planRank(plan) < planRank(model.minPlan))
    return res.status(403).json({ error: "model_locked", minPlan: model.minPlan });

  // Sanitize turns.
  const turns = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 24000) }))
    .slice(-20);
  if (turns.length === 0 || turns[0].role !== "user")
    return res.status(400).json({ error: "bad_messages" });

  const maxTokens = EFFORT_TOKENS[effort] || EFFORT_TOKENS.medium;
  const sys =
    (typeof system === "string" && system.slice(0, 4000)) ||
    "You are RishiAI, a helpful, warm and precise AI assistant. Answer clearly " +
      "and concisely. Use short paragraphs, **bold** for key terms and ```code fences``` for code.";

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders && res.flushHeaders();

  const send = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");

  try {
    const stream = anthropic.messages.stream({
      model: model.api,
      max_tokens: maxTokens,
      system: sys,
      messages: turns,
    });
    stream.on("text", (delta) => send({ delta }));
    const final = await stream.finalMessage();
    const stop = final && final.stop_reason;
    send({ done: true, truncated: stop === "max_tokens" });
  } catch (e) {
    console.error("claude error:", e.status, e.message);
    let code = "upstream_error";
    if (e.status === 401) code = "auth_error";
    else if (e.status === 429) code = "rate_limited";
    else if (e.status === 400 && /model/i.test(e.message || "")) code = "bad_model";
    send({ error: code, message: e.message });
  } finally {
    res.end();
  }
});

/* ---------- Stripe: products / prices ---------- */
// Price IDs are cached in the DB so we create them only once.
async function getOrCreatePrice(planKey) {
  if (!stripe) throw new Error("stripe_not_configured");
  const envId =
    planKey === "pro" ? process.env.STRIPE_PRICE_PRO : process.env.STRIPE_PRICE_MAX;
  if (envId) return envId;

  const cacheKey = "price:" + planKey;
  const cached = await store.get(cacheKey).catch(() => null);
  if (cached) return cached;

  const plan = PLANS[planKey];
  const product = await stripe.products.create({
    name: "RishiAI " + plan.name,
    description: "RishiAI " + plan.name + " subscription",
  });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: plan.price * 100,
    currency: "usd",
    recurring: { interval: "month" },
    nickname: "RishiAI " + plan.name + " monthly",
  });
  await store.set(cacheKey, price.id);
  return price.id;
}

// Create a Checkout Session (subscription mode, 30-day trial unless skipped).
app.post("/api/checkout", requireAuth, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "stripe_not_configured" });
  const { plan, trial = true } = req.body || {};
  if (plan !== "pro" && plan !== "max")
    return res.status(400).json({ error: "bad_plan" });
  try {
    const u = req.user;
    const price = await getOrCreatePrice(plan);

    // Reuse or create the Stripe customer.
    let customerId = u.stripeCustomerId;
    if (!customerId) {
      const c = await stripe.customers.create({
        email: u.email,
        name: u.name,
        metadata: { userId: u.id },
      });
      customerId = c.id;
      u.stripeCustomerId = customerId;
      await saveUser(u);
    }

    const base = baseUrl(req);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: u.id,
      line_items: [{ price, quantity: 1 }],
      subscription_data: trial ? { trial_period_days: 30 } : {},
      metadata: { userId: u.id, plan },
      allow_promotion_codes: true,
      success_url: base + "/?checkout=success&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: base + "/?checkout=cancel",
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error("checkout error:", e.message);
    res.status(500).json({ error: "checkout_failed", message: e.message });
  }
});

// After redirect back, confirm the session so the plan unlocks immediately
// (the webhook also does this, but this avoids waiting on it).
app.post("/api/checkout/confirm", requireAuth, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "stripe_not_configured" });
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "missing_session" });
  try {
    const s = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });
    if (s.client_reference_id !== req.user.id)
      return res.status(403).json({ error: "not_your_session" });
    await applySubscription(req.user.id, s.metadata && s.metadata.plan, s.subscription);
    const u = await getUser(req.user.id);
    res.json({ user: publicUser(u) });
  } catch (e) {
    console.error("confirm error:", e.message);
    res.status(500).json({ error: "confirm_failed" });
  }
});

// Billing portal — manage/cancel.
app.post("/api/portal", requireAuth, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "stripe_not_configured" });
  if (!req.user.stripeCustomerId)
    return res.status(400).json({ error: "no_customer" });
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: req.user.stripeCustomerId,
      return_url: baseUrl(req) + "/",
    });
    res.json({ url: portal.url });
  } catch (e) {
    res.status(500).json({ error: "portal_failed", message: e.message });
  }
});

/* ---------- Apply subscription state to a user ---------- */
function planFromSubscription(sub) {
  // Determine plan from the subscription's price amount.
  try {
    const item = sub.items && sub.items.data && sub.items.data[0];
    const amount = item && item.price && item.price.unit_amount;
    if (amount >= 3000) return "max";
    if (amount >= 1800) return "pro";
  } catch (e) {}
  return null;
}

async function applySubscription(userId, planHint, sub) {
  const u = await getUser(userId);
  if (!u) return;
  const active = sub && ["trialing", "active", "past_due"].includes(sub.status);
  if (active) {
    u.plan = planFromSubscription(sub) || planHint || u.plan || "pro";
    u.stripeSubId = sub.id;
    u.subStatus = sub.status;
    u.trialEnds = sub.trial_end ? sub.trial_end * 1000 : 0;
  } else {
    // canceled / unpaid / incomplete_expired → drop to free
    u.plan = "free";
    u.subStatus = sub ? sub.status : "canceled";
    u.trialEnds = 0;
    u.stripeSubId = "";
  }
  await saveUser(u);
}

/* ---------- Stripe webhook ---------- */
async function handleStripeWebhook(req, res) {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send("stripe_not_configured");
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      STRIPE_WEBHOOK_SECRET
    );
  } catch (e) {
    console.error("webhook signature failed:", e.message);
    return res.status(400).send("bad_signature");
  }

  try {
    const obj = event.data.object;
    if (event.type === "checkout.session.completed") {
      const sub = obj.subscription
        ? await stripe.subscriptions.retrieve(obj.subscription)
        : null;
      const userId = obj.client_reference_id || (obj.metadata && obj.metadata.userId);
      if (userId) await applySubscription(userId, obj.metadata && obj.metadata.plan, sub);
    } else if (
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.deleted"
    ) {
      const userId = await userIdByCustomer(obj.customer);
      if (userId) await applySubscription(userId, null, obj);
    }
  } catch (e) {
    console.error("webhook handling error:", e.message);
  }
  res.json({ received: true });
}

/* ---------- Health check ---------- */
app.get("/healthz", (req, res) => res.json({ ok: true, store: store.backend }));

/* ---------- Fallback to SPA ---------- */
app.get("*", (req, res) => {
  res.sendFile(require("path").join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("RishiAI running on port " + PORT + " · storage: " + store.backend);
  const miss = [];
  if (!GOOGLE_CLIENT_ID) miss.push("GOOGLE_CLIENT_ID");
  if (!ANTHROPIC_API_KEY) miss.push("ANTHROPIC_API_KEY");
  if (!STRIPE_SECRET_KEY) miss.push("STRIPE_SECRET_KEY");
  if (!STRIPE_WEBHOOK_SECRET) miss.push("STRIPE_WEBHOOK_SECRET");
  if (!SESSION_SECRET) miss.push("SESSION_SECRET (using a temporary one)");
  if (miss.length) console.log("  ⚠ Not set yet: " + miss.join(", "));
});
