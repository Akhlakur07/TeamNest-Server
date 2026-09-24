const stripe = require('../config/stripe');
const env = require('../config/env');

const INTERVAL_MAP = {
  monthly: 'month',
  yearly: 'year',
};

async function syncStripePrice(plan) {
  if (!plan.isEnabled || plan.priceCents <= 0) {
    return null;
  }

  if (!plan.stripeProductId) {
    const product = await stripe.products.create({
      name: plan.name,
      metadata: { planId: plan._id.toString() },
    });
    plan.stripeProductId = product.id;
  }

  const price = await stripe.prices.create({
    unit_amount: plan.priceCents,
    currency: plan.currency,
    recurring: { interval: INTERVAL_MAP[plan.billingInterval] || 'month' },
    product: plan.stripeProductId,
    metadata: { planId: plan._id.toString() },
  });

  plan.stripePriceId = price.id;
  return price.id;
}

function constructEvent(rawBody, signature) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    if (env.NODE_ENV === 'production') {
      throw new Error('STRIPE_WEBHOOK_SECRET must be set in production');
    }
    console.warn(
      '[stripe] STRIPE_WEBHOOK_SECRET not set — accepting unsigned webhook payload (development only).'
    );
    return JSON.parse(rawBody.toString('utf8'));
  }
  return stripe.webhooks.constructEvent(
    rawBody,
    signature,
    env.STRIPE_WEBHOOK_SECRET
  );
}

module.exports = { syncStripePrice, constructEvent };