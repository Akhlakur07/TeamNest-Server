const { z } = require('zod');
const stripe = require('../config/stripe');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { Organization, Subscription, Plan, Payment, Transaction } = require('../models');
const {
  ORG_STATUS,
  SUBSCRIPTION_STATUS,
  ROLES,
  TRANSACTION_TYPE,
  TRANSACTION_STATUS,
} = require('../models/enums');
const { confirmCheckoutSession } = require('../services/subscriptionService');

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

  const recentPayments =
    req.dbUser.role === ROLES.ORG_ADMIN
      ? await Payment.find({ orgId: org._id }).sort({ paidAt: -1 }).limit(5)
      : [];

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
  if (org.status !== ORG_STATUS.ACTIVE) {
    throw new ApiError(400, 'Subscription management requires an active organization');
  }

  const newPlan = await Plan.findById(planId);
  if (!newPlan || !newPlan.isEnabled || !newPlan.stripePriceId || newPlan.priceCents <= 0) {
    throw new ApiError(400, 'Selected plan is not available');
  }

  // Free org (no Stripe subscription yet) -> start a paid subscription via hosted checkout
  if (!org.stripeSubscriptionId) {
    let checkout;
    try {
      checkout = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer_email: org.billingEmail || org.contactEmail || req.dbUser.email,
        client_reference_id: org._id.toString(),
        line_items: [{ price: newPlan.stripePriceId, quantity: 1 }],
        metadata: { orgId: org._id.toString(), planId: newPlan._id.toString() },
        subscription_data: {
          metadata: { orgId: org._id.toString(), planId: newPlan._id.toString() },
        },
        success_url: `${env.FRONTEND_URL}/org/subscription?checkout=success`,
        cancel_url: `${env.FRONTEND_URL}/org/subscription?checkout=cancelled`,
      });
    } catch (error) {
      console.error('Plan change checkout creation failed:', error);
      throw new ApiError(502, 'Could not start payment for the plan change. Please try again.');
    }

    org.checkoutSessionId = checkout.id;
    await org.save();

    return res.json({
      success: true,
      message: `Pay to upgrade to ${newPlan.name}.`,
      checkoutUrl: checkout.url,
      pendingPlanId: newPlan._id.toString(),
    });
  }

  // Existing paid subscription -> swap the price immediately
  const current = await loadActiveSubscription(org);
  if (current.planId && current.planId.toString() === newPlan._id.toString()) {
    throw new ApiError(400, 'Organization is already on this plan');
  }

  const alreadyApplied = org.planId && org.planId.toString() === newPlan._id.toString();
  const previousPlan = alreadyApplied ? null : await Plan.findById(org.planId);
  const isUpgrade =
    !!previousPlan && (previousPlan.priceCents || 0) < (newPlan.priceCents || 0);

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

  try {
    await stripe.subscriptions.update(org.stripeSubscriptionId, {
      items: [{ id: itemId, price: newPlan.stripePriceId }],
      proration_behavior: 'create_prorations',
    });
  } catch (error) {
    console.error('Stripe subscription update failed:', error);
    throw new ApiError(502, 'Payment provider rejected the plan change.');
  }

  const updated = await stripe.subscriptions.retrieve(org.stripeSubscriptionId).catch(() => null);

  // Apply the change locally right away so the UI reflects it without waiting
  // for a webhook. When the real webhook arrives it only re-syncs the plan/periods
  // and no longer needs to log the change (we log it here if not already applied).
  current.planId = newPlan._id;
  if (updated?.current_period_start) {
    current.currentPeriodStart = new Date(updated.current_period_start * 1000);
  }
  if (updated?.current_period_end) {
    current.currentPeriodEnd = new Date(updated.current_period_end * 1000);
  }
  await current.save();
  org.planId = newPlan._id;
  await org.save();

  if (!alreadyApplied) {
    await Transaction.create({
      orgId: org._id,
      type: isUpgrade ? TRANSACTION_TYPE.UPGRADE : TRANSACTION_TYPE.DOWNGRADE,
      status: TRANSACTION_STATUS.SUCCESS,
      amountCents: newPlan.priceCents,
      currency: newPlan.currency || 'usd',
      subscriptionId: current._id,
      planId: newPlan._id,
      gateway: 'stripe',
      metadata: {
        from: previousPlan?._id ? previousPlan._id.toString() : null,
        to: newPlan._id.toString(),
      },
    });
  }

  res.json({
    success: true,
    message: `Plan changed to ${newPlan.name}. It may take a moment to fully reflect.`,
    nextPlanId: newPlan._id.toString(),
  });
};

// Confirms a plan-change checkout directly with Stripe when the webhook has not
// arrived yet (e.g. local development without a webhook tunnel configured).
exports.confirmPendingPlan = async (req, res) => {
  const orgId = requireOrgId(req.dbUser);
  const org = await loadOrg(orgId);

  if (!org.checkoutSessionId) {
    if (org.stripeSubscriptionId) {
      return res.json({
        success: true,
        planId: org.planId ? org.planId.toString() : null,
        message: 'Your plan change is confirmed.',
      });
    }
    return res.json({ success: false, message: 'No pending plan change found.' });
  }

  await confirmCheckoutSession(org._id);
  const refreshed = await Organization.findById(orgId);

  if (refreshed?.stripeSubscriptionId) {
    return res.json({
      success: true,
      planId: refreshed.planId ? refreshed.planId.toString() : null,
      message: 'Your plan change is confirmed.',
    });
  }
  return res.json({
    success: false,
    message: 'Payment is not confirmed yet. It may take a few seconds.',
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