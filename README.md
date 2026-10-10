# RishiAI

A great chatbot with real Google sign-in and real Stripe subscriptions.
Chat + Co-work modes, a model picker with descriptions, an effort selector, and
tier-locked models (Free / Pro $18 / MAX $30, each paid plan with a 1-month free trial).

Built to run on **Replit** with no terminal — everything is configured through
Replit's web UI (Secrets panel) and `package.json`.

---

## What you'll set up (about 15 minutes)

You need three accounts: **Google Cloud**, **Anthropic**, and **Stripe**. You paste
a handful of keys into Replit's **Secrets** panel (lock icon in the left sidebar).
Nothing sensitive goes into the code.

### 1. Put the files in Replit
- Create a new Repl → import this folder (or drag the files in).
- Click **Run** once. Replit installs the dependencies from `package.json` and starts
  the server. It'll warn in the console which secrets aren't set yet — that's expected.
- Note your app's public URL (top of the webview, e.g. `https://rishiai.<you>.repl.co`).

### 2. Google sign-in → `GOOGLE_CLIENT_ID`
1. Go to **console.cloud.google.com** → create/select a project.
2. **APIs & Services → OAuth consent screen** → set it up (External), add your email as a
   test user.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.**
4. Under **Authorized JavaScript origins**, add your Repl URL exactly
   (e.g. `https://rishiai.<you>.repl.co`, no trailing slash).
5. Copy the **Client ID** → Replit Secrets → `GOOGLE_CLIENT_ID`.

> Google handles the password. The app never sees or stores one.

### 3. Claude → `ANTHROPIC_API_KEY`
1. **console.anthropic.com → API Keys → Create Key.**
2. Paste into Replit Secrets → `ANTHROPIC_API_KEY`.

### 4. Stripe → `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
1. **dashboard.stripe.com** (keep it in **Test mode** while trying it out).
2. **Developers → API keys** → copy the **Secret key** → Secrets → `STRIPE_SECRET_KEY`.
3. **Developers → Webhooks → Add endpoint:**
   - URL: `https://rishiai.<you>.repl.co/api/stripe/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`.
   - After creating it, copy the **Signing secret** → Secrets → `STRIPE_WEBHOOK_SECRET`.
4. You don't need to create products — the app creates the Pro ($18) and MAX ($30)
   prices automatically the first time someone checks out. (If you prefer to make them
   yourself, paste their price IDs into `STRIPE_PRICE_PRO` / `STRIPE_PRICE_MAX`.)

Use Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC.

### 5. Session secret → `SESSION_SECRET`
Any long random string. Keeps people signed in across restarts.

### 6. Reload
Stop and Run the Repl again so it picks up the secrets. Open the URL and sign in.

---

## Free MAX account

`rishi.parikh17@gmail.com` is set as a **complimentary MAX** account — signing in with
that Google account unlocks every model with no payment. Add more emails via the
`COMP_MAX_EMAILS` secret (comma-separated).

---

## How it works

- **Auth** — Google Identity Services returns an ID token; the server verifies it with
  `google-auth-library` and sets a signed, http-only session cookie. Users live in Replit DB.
- **Claude** — the browser never holds your API key. It calls `POST /api/chat`; the server
  checks the chosen model is allowed for the user's plan, then streams Claude's reply back
  over SSE.
- **Stripe** — `POST /api/checkout` creates a Checkout Session in subscription mode with a
  30-day trial and redirects to Stripe. A webhook (and an immediate confirm on return)
  updates the user's plan. `POST /api/portal` opens Stripe's billing portal to cancel/manage.
- **Models** — defined at the top of `server.js`. If a model id is ever retired, update the
  `api:` field there (see https://docs.claude.com/en/docs/about-claude/models).

## Going live
Switch Stripe to live keys, publish the OAuth consent screen, and deploy (Replit
**Deployments** gives a stable URL — update the Google origin and Stripe webhook URL to match).

## Files
- `server.js` — backend (auth, Claude proxy, Stripe, DB)
- `public/index.html` — UI + styles
- `public/app.js` — frontend logic
- `package.json`, `.replit`, `replit.nix` — Replit run config
- `.env.example` — the secrets to set (set them in Replit Secrets, not in a file)
