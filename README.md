# RishiAI

A Claude-style AI chat web app you own and host yourself.

- **Guest accounts** (no sign-up) and **Google sign-in**
- Chats stored in **Neon Postgres**
- **Stripe** subscriptions with three tiers
- **Artifacts** — HTML/SVG pages and larger code/documents open in a live
  side-panel with Preview (sandboxed iframe) + Code tabs, copy & download
- Streaming replies, markdown + code highlighting, multiple conversations,
  model picker, custom instructions, dark mode, live quota display
- Works with any **OpenAI-compatible** model provider (OpenAI, OpenRouter, Together, Groq, …)

Everything below is done through web dashboards — **no terminal required.**

---

## The subscription tiers (as built)

| Plan | What it allows |
|------|----------------|
| **Free** | 5 messages per day **and** a 1-hour usage window per day. Both reset at **midnight Singapore time**. |
| **Pro** | Unlimited messages, but **locked from 6:00pm**; reopens at **midnight SGT**. |
| **Max** | Unlimited, no time limits. |

> **Note on "Free = 1 hour limit":** your request didn't say one hour *of what*, so
> I implemented it as a **1-hour window that starts on your first message each day** —
> after 60 minutes you're locked until midnight SGT (on top of the 5-message cap).
> If you meant something else (e.g. a 1-hour session that can restart), it's a small
> change in `quota.js` — tell me and I'll adjust.

All the numbers live at the top of **`quota.js`** (`FREE_DAILY_MESSAGES`,
`FREE_SESSION_MS`, `PRO_CLOSE_HOUR`) so they're easy to tweak.

---

## Setup — step by step

You need four external accounts: **Neon**, an **AI provider**, **Google Cloud**, and **Stripe**.
Then you put the code on **GitHub** and deploy on **Render**.

### 1. Put the code on GitHub
1. Create a new repository on github.com (e.g. `ai-chat-app`), **without** a README.
2. On the repo page click **Add file → Upload files**, then drag in **all** the files
   and folders from this project (keep the folder structure — `public/` and `scripts/`
   must stay as folders). Commit.
   - Do **not** upload a `.env` file. Secrets go into Render later.

### 2. Create the database (Neon)
1. Sign up at neon.tech and create a project.
2. Copy the **connection string** (it looks like
   `postgresql://user:pass@...neon.tech/dbname?sslmode=require`). Keep it for later.
   - Tables are created automatically the first time the server starts — nothing else to do.

### 3. Get an AI API key
- **OpenAI:** create a key at platform.openai.com → keep `AI_BASE_URL=https://api.openai.com/v1`.
- **Or OpenRouter** (access to many models): key from openrouter.ai, set
  `AI_BASE_URL=https://openrouter.ai/api/v1` and put model names like
  `openai/gpt-4o-mini,anthropic/claude-3.5-sonnet` in `AI_MODELS`.

### 4. Google sign-in
1. Go to console.cloud.google.com → **APIs & Services → Credentials**.
2. **Create Credentials → OAuth client ID → Web application.**
3. Under **Authorized redirect URIs** add:
   `https://YOUR-APP.onrender.com/api/auth/google/callback`
   (you'll know the exact URL after step 6 — you can add it then and it updates instantly).
4. Copy the **Client ID** and **Client secret**.

### 5. Stripe subscriptions
1. In the Stripe dashboard → **Product catalog** → create two products,
   each with a **recurring (monthly) price**: one "Pro", one "Max".
2. Copy each **Price ID** (`price_...`) → these are `STRIPE_PRICE_PRO` / `STRIPE_PRICE_MAX`.
3. Copy your **Secret key** (`sk_...`) from **Developers → API keys**.
4. The **webhook secret** comes in step 7 (after the app has a URL).

### 6. Deploy on Render
1. On render.com → **New + → Web Service** → connect your GitHub repo.
2. Settings: **Build Command** `npm install`, **Start Command** `npm start`.
   (Or use **New + → Blueprint** and let it read `render.yaml`.)
3. Add **Environment Variables** (copy names from `.env.example`):
   `APP_URL` (set to your `https://<name>.onrender.com`), `SESSION_SECRET`
   (any long random string), `DATABASE_URL`, `AI_API_KEY`, `AI_BASE_URL`,
   `AI_MODELS`, `AI_DEFAULT_MODEL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_MAX`.
   (Leave `STRIPE_WEBHOOK_SECRET` blank for now.)
4. Deploy. Once live, open the URL — guest login should already work.
5. Go back to Google (step 4) and make sure the redirect URI uses your real Render URL.

### 7. Finish Stripe webhooks
1. Stripe dashboard → **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://YOUR-APP.onrender.com/api/billing/webhook`
3. Select events: `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`.
4. Copy the endpoint's **Signing secret** (`whsec_...`) into Render as
   `STRIPE_WEBHOOK_SECRET`, then redeploy (Render → Manual Deploy).

Done. Subscriptions will now upgrade/downgrade users automatically.

---

## How it works (quick map)

| File | Purpose |
|------|---------|
| `server.js` | Express server: auth, chat streaming, Stripe, serves the frontend |
| `quota.js` | All tier/limit logic, in Singapore time |
| `db.js` / `schema.sql` | Neon connection + table definitions (auto-created) |
| `config.js` | Reads environment variables |
| `public/` | The browser UI (no build step) |

## Local testing (optional, needs Node — skip if you're web-only)
`npm install`, copy `.env.example` to `.env`, fill it in, then `npm start`.

## Security notes
- Never commit real keys. Only `.env.example` (placeholders) is in the repo.
- Stripe webhook signatures are verified; DB queries are parameterized.
- Sessions are stored in Neon and cookies are `httpOnly` + `secure` in production.
