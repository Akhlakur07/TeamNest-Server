const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT) || 5000,
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',
  MONGO_URI: process.env.MONGO_URI,
  DB_NAME: process.env.DB_NAME || 'teamnest',
  STRIPE_SECRET_KEY: process.env.PAYMENT_GATEWAY_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
  WEB_API_KEY: process.env.WEB_API_KEY || '',
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: Number(process.env.SMTP_PORT) || 587,
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  MAIL_FROM: process.env.MAIL_FROM || 'TeamNest <no-reply@teamnest.dev>',
  TRUST_PROXY: process.env.TRUST_PROXY === 'true',
  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX) || 600,
};

const required = ['MONGO_URI', 'STRIPE_SECRET_KEY'];

for (const key of required) {
  if (!env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

module.exports = env;