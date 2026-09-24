const { z } = require('zod');
const stripe = require('../config/stripe');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { Organization, Subscription, Plan, Payment } = require('../models');
const { ORG_STATUS, SUBSCRIPTION_STATUS } = require('../models/enums');

function requireOrgId(user) {
  if (!user.orgId) throw new ApiError(400, 'No organization linked to this account');
  return user.orgId;
}

async function loadOrg(orgId) {
  const org = await Organization.findById(orgId);
  if (!org) throw new ApiError(404, 'Organization not found');
  return org;
}

async function loadActiveSubscription(org) {
  if (org.status !== ORG_STATUS.ACTIVE) {
    throw new ApiError(400, 'Subscription management requires an active organization');
  }
  const subscription = await Subscription.findOne({ orgId: org._id, isCurrent: true });
  if (!subscription) throw new ApiError(404, 'No current subscription found');
  if (subscription.status !== SUBSCRIPTION_STATUS.ACTIVE) {
    throw new ApiError(400, `Cannot manage a subscription in state "${subscription.status}"`);
  }
  if (!org.stripeSubscriptionId) {
    throw new ApiError(400, 'No Stripe subscription linked to this organization');
  }
  return subscription;
}

exports.currentSubscription = async (req, res) => {
  const orgId = requireOrgId(req.dbUser);
  const org = await loadOrg(orgId);

  const subscription = await Subscription.findOne({ orgId: org._id, isCurrent: true });
  const plan = subscription?.planId ? await Plan.findById(subscription.planId) : null;

  const recentPayments = await Payment.find({ orgId: org._id }).sort({ paidAt: -1 }).limit(5);

  res.json({
    success: true,
    org: {
      id: org._id.toString(),
      name: org.name,
      status: org.status,
      activatedAt: org.activatedAt || null,
    },
    subscription: subscription
      ? {
          id: subscription._id.toString(),
          status: subscription.status,
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd,
          trialEnd: subscription.trialEnd,
          canceledAt: subscription.canceledAt,
          isCurrent: subscription.isCurrent,
        }
      : null,
    plan: plan
      ? {
          id: plan._id.toString(),
          name: plan.name,
          slug: plan.slug,
          priceCents: plan.priceCents,
          currency: plan.currency,
          billingInterval: plan.billingInterval,
          description: plan.description,
          features: plan.features,
        }
      : null,
    recentPayments: recentPayments.map((p) => ({
      id: p._id.toString(),
      amountCents: p.amountCents,
      currency: p.currency,
      status: p.status,
      invoiceNumber: p.invoiceNumber,
      paidAt: p.paidAt,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
    })),
  });
};

const changePlanSchema = z.object({
  planId: z.string().min(1, 'A plan is required'),
});

exports.changePlan = async (req, res) => {
  const { planId } = changePlanSchema.parse(req.body);
  const orgId = requireOrgId(req.dbUser);
  const org = await loadOrg(orgId);
  const subscription = await loadActiveSubscription(org);

  const newPlan = await Plan.findById(planId);
  if (!newPlan || !newPlan.isEnabled || !newPlan.stripePriceId || newPlan.priceCents <= 0) {
    throw new ApiError(400, 'Selected plan is not available');
  }
  if (subscription.planId && subscription.planId.toString() === newPlan._id.toString()) {
    throw new ApiError(400, 'Organization is already on this plan');
  }

  let remote;
  try {
    remote = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
  } catch {
    throw new ApiError(502, 'Could not reach the payment provider for this subscription');
  }
  const itemId = remote.items?.data?.[0]?.id;
  if (!itemId) {
    throw new ApiError(409, 'Payment provider has no billable item for this subscription');
  }

  await stripe.subscriptions.update(org.stripeSubscriptionId, {
    items: [{ id: itemId, price: newPlan.stripePriceId }],
    proration_behavior: 'create_prorations',
  });

  res.json({
    success: true,
    message: `Plan change to ${newPlan.name} is being processed. It may take a moment to reflect.`,
    nextPlanId: newPlan._id.toString(),
  });
};

exports.cancelAtPeriodEnd = async (req, res) => {
  const orgId = requireOrgId(req.dbUser);
  const org = await loadOrg(orgId);
  await loadActiveSubscription(org);

  await stripe.subscriptions.update(org.stripeSubscriptionId, {
    cancel_at_period_end: true,
  });

  res.json({
    success: true,
    message: 'Subscription will cancel at the end of the current billing period.',
  });
};

exports.reactivateSubscription = async (req, res) => {
  const orgId = requireOrgId(req.dbUser);
  const org = await loadOrg(orgId);
  await loadActiveSubscription(org);

  await stripe.subscriptions.update(org.stripeSubscriptionId, {
    cancel_at_period_end: false,
  });

  res.json({
    success: true,
    message: 'Subscription reactivated. It will renew automatically.',
  });
};

exports.billingPortal = async (req, res) => {
  const orgId = requireOrgId(req.dbUser);
  const org = await loadOrg(orgId);
  if (!org.stripeCustomerId) {
    throw new ApiError(400, 'No billing customer linked to this organization');
  }

  const portal = await stripe.billingPortal.sessions.create({
    customer: org.stripeCustomerId,
    return_url: `${env.FRONTEND_URL}/org/subscription`,
  });

  res.json({ success: true, url: portal.url });
};