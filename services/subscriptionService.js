const mongoose = require('mongoose');
const stripe = require('../config/stripe');
const { Organization, Subscription, Payment, Transaction, Plan, WebhookLog } = require('../models');
const {
  ORG_STATUS,
  SUBSCRIPTION_STATUS,
  PAYMENT_STATUS,
  TRANSACTION_STATUS,
  TRANSACTION_TYPE,
} = require('../models/enums');
const { sendActivationEmail, sendPaymentReceipt } = require('./emailService');

function isDuplicateKeyError(err) {
  return !!err && err.code === 11000;
}

function timestampToDate(value) {
  return value ? new Date(value * 1000) : null;
}

async function resolveOrganization(obj) {
  if (!obj) return null;

  const customer =
    typeof obj.customer === 'string' && obj.customer.startsWith('cus_') ? obj.customer : null;
  let subId =
    typeof obj.subscription === 'string' && obj.subscription.startsWith('sub_')
      ? obj.subscription
      : null;
  if (!subId && typeof obj.id === 'string' && obj.id.startsWith('sub_')) subId = obj.id;

  let org = null;
  if (customer) org = await Organization.findOne({ stripeCustomerId: customer });
  if (!org && subId) org = await Organization.findOne({ stripeSubscriptionId: subId });

  const metadataOrgId = obj.metadata?.orgId || obj.client_reference_id;
  if (!org && metadataOrgId) org = await Organization.findById(metadataOrgId);

  if (!org && subId) {
    try {
      const remoteSub = await stripe.subscriptions.retrieve(subId);
      if (remoteSub?.metadata?.orgId) {
        org = await Organization.findById(remoteSub.metadata.orgId);
      }
    } catch {
      // ignore resolution failures; treated as not ours below
    }
  }

  return org;
}

/**
 * Runs event processing atomically. The WebhookLog insert inside the
 * transaction is the idempotency lock: a unique index on stripeEventId
 * guarantees only one delivery of an event can commit, even with
 * concurrent retries or multi-node scale-out.
 */
async function processInTransaction(event, org, work) {
  if (await WebhookLog.exists({ stripeEventId: event.id })) {
    return { processed: false, alreadyProcessed: true };
  }

  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    await WebhookLog.create(
      [{ stripeEventId: event.id, type: event.type, orgId: org._id }],
      { session }
    );
    await work(session);
    await session.commitTransaction();
    return { processed: true };
  } catch (err) {
    await session.abortTransaction();
    if (isDuplicateKeyError(err)) {
      // Concurrent delivery of the same event lost the unique race.
      return { processed: false, alreadyProcessed: true };
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

// checkout.session.completed — transactional activation
async function handleCheckoutCompleted(event) {
  const session = event.data.object;
  if (session.payment_status === 'unpaid') {
    return { processed: false, ignored: true };
  }

  const org = await resolveOrganization(session);
  if (!org) return { processed: false, ignored: true };

  const wasPending = org.status === ORG_STATUS.PENDING;
  const isPlanSwitch = org.status === ORG_STATUS.ACTIVE && org.checkoutSessionId === session.id;
  if (!wasPending && !isPlanSwitch) {
    // Already active and this is not the plan-switch checkout we initiated.
    return { processed: false, ignored: true };
  }

  const stripeSubscriptionId = session.subscription || null;
  let priceId = null;
  let periodStart = null;
  let periodEnd = null;
  if (stripeSubscriptionId) {
    const remoteSub = await stripe.subscriptions.retrieve(stripeSubscriptionId).catch(() => null);
    if (remoteSub) {
      periodStart = timestampToDate(remoteSub.current_period_start);
      periodEnd = timestampToDate(remoteSub.current_period_end);
      priceId = remoteSub.items?.data?.[0]?.price?.id || null;
    }
  }
  const plan = priceId ? await Plan.findOne({ stripePriceId: priceId }) : null;

  const result = await processInTransaction(event, org, async (t) => {
    if (wasPending) {
      org.status = ORG_STATUS.ACTIVE;
      org.activatedAt = new Date();
    }
    if (session.customer) org.stripeCustomerId = session.customer;
    if (stripeSubscriptionId) org.stripeSubscriptionId = stripeSubscriptionId;
    if (plan) org.planId = plan._id;
    if (org.checkoutSessionId) org.checkoutSessionId = null;
    await org.save({ session: t });

    const current = await Subscription.findOne({ orgId: org._id, isCurrent: true }).session(t);
    if (current) {
      current.status = SUBSCRIPTION_STATUS.ACTIVE;
      if (stripeSubscriptionId) current.stripeSubscriptionId = stripeSubscriptionId;
      if (plan) current.planId = plan._id;
      if (periodStart) current.currentPeriodStart = periodStart;
      if (periodEnd) current.currentPeriodEnd = periodEnd;
      await current.save({ session: t });
    }
  });

  if (result.processed && wasPending) {
    sendActivationEmail({
      to: org.contactEmail,
      orgName: org.name,
      planName: plan?.name || null,
    }).catch((err) => console.error('[email] activation failed:', err.message));
  }
  return result;
}

// Direct confirmation fallback: when webhook delivery is delayed or unavailable,
// the pending org can still be activated by verifying the checkout session with
// Stripe directly. Reuses the already-tested activation logic (and its WebhookLog
// idempotency) by feeding the retrieved session through handleCheckoutCompleted.
const CONFIRM_THROTTLE_MS = 10 * 1000;
const confirmAttempts = new Map();

async function confirmCheckoutSession(orgId) {
  const org = await Organization.findById(orgId);
  if (!org || !org.checkoutSessionId) {
    return { processed: false, ignored: true, reason: 'no_pending_session' };
  }

  const sessionId = org.checkoutSessionId;
  const now = Date.now();
  const last = confirmAttempts.get(sessionId) || 0;
  if (now - last < CONFIRM_THROTTLE_MS) {
    return { processed: false, throttled: true };
  }
  confirmAttempts.set(sessionId, now);
  if (confirmAttempts.size > 500) confirmAttempts.clear();

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (error) {
    console.error('[stripe] checkout confirmation failed:', error.message);
    return { processed: false, ignored: true, reason: 'retrieve_failed' };
  }
  if (session.payment_status === 'unpaid') {
    return { processed: false, ignored: true, reason: 'unpaid' };
  }

  return handleCheckoutCompleted({
    id: `confirm_${orgId}_${sessionId}`,
    type: 'checkout.session.completed',
    data: { object: session },
  });
}

// invoice.paid — record payment + renewal/checkout ledger entry
async function handleInvoicePaid(event) {
  const invoice = event.data.object;
  const org = await resolveOrganization(invoice);
  if (!org) return { processed: false, ignored: true };

  if (await Payment.exists({ stripeInvoiceId: invoice.id })) {
    return { processed: false, ignored: true };
  }
  const hasPriorPayment = await Payment.exists({ orgId: org._id });
  const priceId = invoice.lines?.data?.[0]?.price?.id || null;
  const plan = priceId ? await Plan.findOne({ stripePriceId: priceId }) : null;
  const period = invoice.lines?.data?.[0]?.period || {};
  const amount = invoice.amount_paid ?? 0;

  const result = await processInTransaction(event, org, async (t) => {
    const current = await Subscription.findOne({ orgId: org._id, isCurrent: true }).session(t);
    const isFirstPayment =
      !hasPriorPayment ||
      !current ||
      current.status === SUBSCRIPTION_STATUS.PENDING ||
      org.status === ORG_STATUS.PENDING;

    const subscription =
      current ||
      (
        await Subscription.create(
          [
            {
              orgId: org._id,
              planId: plan?._id || org.planId,
              status: SUBSCRIPTION_STATUS.PENDING,
            },
          ],
          { session: t }
        )
      )[0];

    subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
    if (period.start) subscription.currentPeriodStart = timestampToDate(period.start);
    if (period.end) subscription.currentPeriodEnd = timestampToDate(period.end);
    if (plan) subscription.planId = plan._id;
    await subscription.save({ session: t });

    if (org.status === ORG_STATUS.PENDING) {
      org.status = ORG_STATUS.ACTIVE;
      org.activatedAt = new Date();
      if (plan) org.planId = plan._id;
    }
    if (invoice.customer) org.stripeCustomerId = invoice.customer;
    if (invoice.subscription) org.stripeSubscriptionId = invoice.subscription;
    await org.save({ session: t });

    const payment = (
      await Payment.create(
        [
          {
            orgId: org._id,
            subscriptionId: subscription._id,
            planId: plan?._id || org.planId,
            amountCents: amount,
            currency: invoice.currency || 'usd',
            status: PAYMENT_STATUS.SUCCESS,
            stripePaymentIntentId: invoice.payment_intent || null,
            stripeInvoiceId: invoice.id,
            stripeChargeId: invoice.charge || null,
            invoiceNumber: `INV-${invoice.number || invoice.id.slice(-12)}`,
            periodStart: period.start ? timestampToDate(period.start) : null,
            periodEnd: period.end ? timestampToDate(period.end) : null,
            paidAt: new Date(),
          },
        ],
        { session: t }
      )
    )[0];

    await Transaction.create(
      [
        {
          orgId: org._id,
          type: isFirstPayment ? TRANSACTION_TYPE.CHECKOUT : TRANSACTION_TYPE.RENEWAL,
          status: TRANSACTION_STATUS.SUCCESS,
          amountCents: amount,
          currency: invoice.currency || 'usd',
          paymentId: payment._id,
          subscriptionId: subscription._id,
          planId: plan?._id || org.planId,
          stripeEventId: event.id,
          gateway: 'stripe',
          metadata: { invoiceUrl: invoice.hosted_invoice_url || null },
        },
      ],
      { session: t }
    );
  });

  if (result.processed) {
    sendPaymentReceipt({
      to: org.contactEmail,
      orgName: org.name,
      planName: plan?.name || null,
      amountCents: amount,
      currency: invoice.currency || 'usd',
      invoiceNumber: `INV-${invoice.number || invoice.id.slice(-12)}`,
      invoiceUrl: invoice.hosted_invoice_url || null,
      periodStart: period.start ? timestampToDate(period.start) : null,
      periodEnd: period.end ? timestampToDate(period.end) : null,
    }).catch((err) => console.error('[email] receipt failed:', err.message));
  }
  return result;
}

// invoice.payment_failed — mark subscription failed, ledger FAILED entry
async function handleInvoicePaymentFailed(event) {
  const invoice = event.data.object;
  const org = await resolveOrganization(invoice);
  if (!org) return { processed: false, ignored: true };

  return processInTransaction(event, org, async (t) => {
    const current = await Subscription.findOne({ orgId: org._id, isCurrent: true }).session(t);
    if (current) {
      current.status = SUBSCRIPTION_STATUS.FAILED;
      await current.save({ session: t });
    }

    await Transaction.create(
      [
        {
          orgId: org._id,
          type: current ? TRANSACTION_TYPE.RENEWAL : TRANSACTION_TYPE.CHECKOUT,
          status: TRANSACTION_STATUS.FAILED,
          amountCents: invoice.amount_due || 0,
          currency: invoice.currency || 'usd',
          subscriptionId: current?._id || null,
          planId: current?.planId || org.planId,
          stripeEventId: event.id,
          gateway: 'stripe',
          errorMessage: invoice.last_finalization_error?.message || 'Invoice payment failed',
          metadata: { invoice: invoice.id },
        },
      ],
      { session: t }
    );
  });
}

const SUB_STATUS_MAP = {
  trialing: SUBSCRIPTION_STATUS.ACTIVE,
  active: SUBSCRIPTION_STATUS.ACTIVE,
  past_due: SUBSCRIPTION_STATUS.FAILED,
  unpaid: SUBSCRIPTION_STATUS.FAILED,
  incomplete: SUBSCRIPTION_STATUS.PENDING,
  incomplete_expired: SUBSCRIPTION_STATUS.EXPIRED,
  canceled: SUBSCRIPTION_STATUS.CANCELLED,
  paused: SUBSCRIPTION_STATUS.PENDING,
};

// customer.subscription.updated — sync status/period, detect plan change
async function handleSubscriptionUpdated(event) {
  const subObj = event.data.object;
  const org = await resolveOrganization(subObj);
  if (!org) return { processed: false, ignored: true };

  const current = await Subscription.findOne({ orgId: org._id, isCurrent: true });
  if (!current) return { processed: false, ignored: true };

  const status = SUB_STATUS_MAP[subObj.status] || SUBSCRIPTION_STATUS.PENDING;
  const priceId = subObj.items?.data?.[0]?.price?.id || null;
  const plan = priceId ? await Plan.findOne({ stripePriceId: priceId }) : null;
  const planChanged =
    !!plan && !!org.planId && plan._id.toString() !== org.planId.toString();

  return processInTransaction(event, org, async (t) => {
    current.status = status;
    if (!current.stripeSubscriptionId) current.stripeSubscriptionId = subObj.id;
    if (subObj.current_period_start) {
      current.currentPeriodStart = timestampToDate(subObj.current_period_start);
    }
    if (subObj.current_period_end) {
      current.currentPeriodEnd = timestampToDate(subObj.current_period_end);
    }
    if (subObj.canceled_at) current.canceledAt = timestampToDate(subObj.canceled_at);
    else if (subObj.cancel_at_period_end === true && !current.canceledAt)
      current.canceledAt = new Date();
    else if (subObj.cancel_at_period_end === false) current.canceledAt = null;
    if (subObj.trial_end) current.trialEnd = timestampToDate(subObj.trial_end);
    if (plan) current.planId = plan._id;
    await current.save({ session: t });

    if (planChanged) {
      const previousPlan = await Plan.findById(org.planId).session(t);
      const isUpgrade = (previousPlan?.priceCents || 0) < (plan.priceCents || 0);
      org.planId = plan._id;
      await org.save({ session: t });

      const result = await Transaction.create(
        [
          {
            orgId: org._id,
            type: isUpgrade ? TRANSACTION_TYPE.UPGRADE : TRANSACTION_TYPE.DOWNGRADE,
            status: TRANSACTION_STATUS.SUCCESS,
            amountCents: plan.priceCents,
            currency: plan.currency || 'usd',
            subscriptionId: current._id,
            planId: plan._id,
            stripeEventId: event.id,
            gateway: 'stripe',
            metadata: {
              from: previousPlan?._id.toString() || null,
              to: plan._id.toString(),
            },
          },
        ],
        { session: t }
      );
    }
  });
}

// customer.subscription.deleted — cancel subscription + organization
async function handleSubscriptionDeleted(event) {
  const subObj = event.data.object;
  const org = await resolveOrganization(subObj);
  if (!org) return { processed: false, ignored: true };
  if (org.status === ORG_STATUS.CANCELLED) {
    return { processed: false, ignored: true };
  }

  return processInTransaction(event, org, async (t) => {
    const current = await Subscription.findOne({ orgId: org._id, isCurrent: true }).session(t);
    if (current) {
      current.status = SUBSCRIPTION_STATUS.CANCELLED;
      current.isCurrent = false;
      current.canceledAt = timestampToDate(subObj.canceled_at) || new Date();
      await current.save({ session: t });
    }

    org.status = ORG_STATUS.CANCELLED;
    await org.save({ session: t });

    await Transaction.create(
      [
        {
          orgId: org._id,
          type: TRANSACTION_TYPE.CANCEL,
          status: TRANSACTION_STATUS.SUCCESS,
          amountCents: 0,
          currency: 'usd',
          subscriptionId: current?._id || null,
          planId: current?.planId || org.planId,
          stripeEventId: event.id,
          gateway: 'stripe',
          metadata: { reason: 'stripe subscription deleted' },
        },
      ],
      { session: t }
    );
  });
}

// charge.refunded — mark payment refunded, ledger REFUND entry
async function handleChargeRefunded(event) {
  const charge = event.data.object;
  const payIntent =
    typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
  const payment = payIntent
    ? await Payment.findOne({ stripePaymentIntentId: payIntent })
    : null;
  if (!payment) return { processed: false, ignored: true };

  const org = payment.orgId ? await Organization.findById(payment.orgId) : null;
  if (!org) return { processed: false, ignored: true };

  return processInTransaction(event, org, async (t) => {
    const pay = await Payment.findById(payment._id).session(t);
    if (!pay || pay.status === PAYMENT_STATUS.REFUNDED) return;

    pay.status = PAYMENT_STATUS.REFUNDED;
    await pay.save({ session: t });

    await Transaction.create(
      [
        {
          orgId: org._id,
          type: TRANSACTION_TYPE.REFUND,
          status: TRANSACTION_STATUS.SUCCESS,
          amountCents: charge.amount_refunded ?? pay.amountCents,
          currency: charge.currency || 'usd',
          paymentId: pay._id,
          subscriptionId: pay.subscriptionId,
          planId: pay.planId,
          stripeEventId: event.id,
          gateway: 'stripe',
          metadata: { refund: charge.id, amountRefunded: charge.amount_refunded ?? null },
        },
      ],
      { session: t }
    );
  });
}

module.exports = {
  handleCheckoutCompleted,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleChargeRefunded,
  confirmCheckoutSession,
};