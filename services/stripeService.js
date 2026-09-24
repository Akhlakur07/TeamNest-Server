const stripe = require('../config/stripe');

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

module.exports = { syncStripePrice };