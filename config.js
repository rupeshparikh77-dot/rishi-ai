require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) console.warn(`[config] Warning: environment variable ${name} is not set.`);
  return v;
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '10000', 10),
  appUrl: (process.env.APP_URL || `http://localhost:${process.env.PORT || 10000}`).replace(/\/$/, ''),
  sessionSecret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',

  databaseUrl: required('DATABASE_URL'),

  // NOTE: The AI model runs in the visitor's browser (WebLLM) — the server
  // makes no AI calls, so there is no AI API key or provider to configure.

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    enabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    prices: {
      pro: process.env.STRIPE_PRICE_PRO,
      max: process.env.STRIPE_PRICE_MAX,
    },
    enabled: Boolean(process.env.STRIPE_SECRET_KEY),
  },
};
