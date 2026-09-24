const mongoose = require('mongoose');
const api = require('../test/helpers/api');
const env = require('../config/env');
const { Plan, Organization, Subscription, Payment, Transaction, WebhookLog } = require('../models');

let passed = 0;
let failed = 0;

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name} ${extra}`);
  }
}

async function deliverRawEvent(event) {
  const res = await fetch('http://localhost:5000/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  return { status: res.status, body: await res.json() };
}

async function registerOrg(name, email, plan) {
  const res = await api.post('/auth/register', {
    organizationName: name,
    adminName: 'WH Test',
    email,
    password: 'Passw0rd!123',
    planId: plan._id.toString(),
  });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  const org = await Organization.findById(res.body.orgId);
  return { orgId: res.body.orgId, checkoutSessionId: org.checkoutSessionId };
}

function checkoutCompletedEvent(idSuffix, orgId, planId, customer, sub) {
  return {
    id: `evt_test_${idSuffix}_checkout`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_test_${idSuffix}`,
        customer,
        subscription: sub,
        payment_status: 'paid',
        client_reference_id: orgId,
        metadata: { orgId, planId },
      },
    },
  };
}

function invoiceEvent(idSuffix, type, orgId, plan, customer, sub, pi) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `evt_test_${idSuffix}`,
    type,
    data: {
      object: {
        id: `in_test_${idSuffix}`,
        number: String(idSuffix),
        customer,
        subscription: sub,
        currency: 'usd',
        amount_paid: plan.priceCents,
        amount_due: plan.priceCents,
        payment_intent: pi,
        hosted_invoice_url: 'https://pay.stripe.com/invoice/testmock',
        lines: { data: [{ period: { start: now - 86400, end: now + 2592000 }, price: { id: plan.stripePriceId } }] },
        last_finalization_error: { message: 'Your card was declined.' },
      },
    },
  };
}

(async () => {
  await mongoose.connect(env.MONGO_URI, { dbName: env.DB_NAME });
  await mongoose.connection.dropCollection('organizations').catch(() => {});
  await mongoose.connection.dropCollection('subscriptions').catch(() => {});
  await mongoose.connection.dropCollection('users').catch(() => {});
  await mongoose.connection.dropCollection('webhooklogs').catch(() => {});
  await mongoose.connection.dropCollection('payments').catch(() => {});
  await mongoose.connection.dropCollection('transactions').catch(() => {});

  const pro = await Plan.findOne({ slug: 'pro' });
  const enterprise = await Plan.findOne({ slug: 'enterprise' });
  const stamp = Date.now();

  console.log('\n--- register two orgs (real Stripe checkout sessions, unconsumed) ---');
  const org1 = await registerOrg(`WHOne ${stamp}`, `wh1-${stamp}@example.com`, pro);
  const org2 = await registerOrg(`WHTwo ${stamp}`, `wh2-${stamp}@example.com`, pro);
  check('org1 checkout session id stored', typeof org1.checkoutSessionId === 'string' && org1.checkoutSessionId.startsWith('cs_'));

  // org1: dedicated Stripe ids, as Stripe would emit after a completed checkout
  const O1 = { customer: 'cus_test_org1', sub: 'sub_test_org1', pi: 'pi_test_org1', invoice: 'in_test_org1' };

  console.log('\n--- checkout.session.completed (transactional activation) ---');
  const resCheckout1 = await deliverRawEvent(checkoutCompletedEvent('o1a', org1.orgId, pro._id.toString(), O1.customer, O1.sub));
  check('checkout.session.completed -> 200', resCheckout1.status === 200, `got ${resCheckout1.status}`);
  let org = await Organization.findById(org1.orgId);
  check('org1 ACTIVE', org.status === 'ACTIVE');
  check('org1.activatedAt set', !!org.activatedAt);
  check('org1.stripeCustomerId stored', org.stripeCustomerId === O1.customer);
  check('org1.stripeSubscriptionId stored', org.stripeSubscriptionId === O1.sub);
  let sub1 = await Subscription.findOne({ orgId: org1.orgId, isCurrent: true });
  check('subscription ACTIVE', sub1?.status === 'ACTIVE');
  check('subscription stripeSubscriptionId set', sub1?.stripeSubscriptionId === O1.sub);

  console.log('\n--- verify taken-stock: no payment yet (comes with invoice.paid) ---');
  check('no payment yet', (await Payment.countDocuments({ orgId: org1.orgId })) === 0);

  console.log('\n--- invoice.paid (first payment -> Payment + CHECKOUT ledger, idempotent) ---');
  const paidEvent = invoiceEvent('o1b', 'invoice.paid', org1.orgId, pro, O1.customer, O1.sub, O1.pi);
  const resPaid = await deliverRawEvent(paidEvent);
  check('invoice.paid -> 200', resPaid.status === 200, `got ${resPaid.status}`);
  org = await Organization.findById(org1.orgId);
  check('org1 stays ACTIVE', org.status === 'ACTIVE');
  const pay1 = await Payment.findOne({ orgId: org1.orgId });
  check('payment created with invoice id', !!pay1 && pay1.stripeInvoiceId === paidEvent.data.object.id, JSON.stringify(pay1?.stripeInvoiceId));
  check('payment amount matches plan', pay1?.amountCents === pro.priceCents);
  check('payment has invoiceNumber', typeof pay1?.invoiceNumber === 'string');
  check('payment period fields set', !!pay1?.periodStart && !!pay1?.periodEnd);
  sub1 = await Subscription.findById(sub1._id);
  check('subscription periods updated by invoice', !!sub1?.currentPeriodStart && !!sub1?.currentPeriodEnd);
  const txn1 = await Transaction.findOne({ orgId: org1.orgId, type: 'checkout' });
  check('CHECKOUT transaction logged with event id', !!txn1 && txn1.stripeEventId === paidEvent.id);
  check('checkout lane status SUCCESS', txn1?.status === 'SUCCESS');

  console.log('\n--- idempotency: replay identical invoice.paid event ---');
  const replay = await deliverRawEvent(paidEvent);
  check('replay -> 200', replay.status === 200, `got ${replay.status}`);
  check('no duplicate payment', (await Payment.countDocuments({ orgId: org1.orgId })) === 1);

  console.log('\n--- idempotency: different event id, same invoice ---');
  const paidEvent2 = { ...paidEvent, id: 'evt_test_o1c' };
  await deliverRawEvent(paidEvent2);
  check('still exactly one payment', (await Payment.countDocuments({ orgId: org1.orgId })) === 1, `count=${await Payment.countDocuments({ orgId: org1.orgId })}`);

  console.log('\n--- re-deliver checkout.session.completed (already ACTIVE -> no-op) ---');
  const resCheckout1b = await deliverRawEvent(checkoutCompletedEvent('o1repeat', org1.orgId, pro._id.toString(), O1.customer, O1.sub));
  check('re-delivered checkout -> 200', resCheckout1b.status === 200, `got ${resCheckout1b.status}`);
  check('org1 status unchanged', (await Organization.findById(org1.orgId)).status === 'ACTIVE');

  console.log('\n--- charge.refunded (org1) ---');
  const resRefund = await deliverRawEvent({
    id: 'evt_test_o1refund',
    type: 'charge.refunded',
    data: {
      object: { id: 'ch_test_org1', payment_intent: O1.pi, amount_refunded: pro.priceCents, currency: 'usd' },
    },
  });
  check('charge.refunded -> 200', resRefund.status === 200, `got ${resRefund.status}`);
  const pay1Reload = await Payment.findById(pay1._id);
  check('payment marked REFUNDED', pay1Reload?.status === 'REFUNDED');
  const txnRefund = await Transaction.findOne({ orgId: org1.orgId, type: 'refund' });
  check('REFUND transaction logged with amount', !!txnRefund && txnRefund.amountCents === pro.priceCents);

  // org2: separate Stripe identity
  const O2 = { customer: 'cus_test_org2', sub: 'sub_test_org2', pi: 'pi_test_org2' };

  console.log('\n--- org2 activation via checkout.session.completed ---');
  const resCheckout2 = await deliverRawEvent(checkoutCompletedEvent('o2a', org2.orgId, pro._id.toString(), O2.customer, O2.sub));
  check('org2 checkout -> 200', resCheckout2.status === 200, `got ${resCheckout2.status}`);
  const org2doc = await Organization.findById(org2.orgId);
  check('org2 ACTIVE + ids stored', org2doc.status === 'ACTIVE' && org2doc.stripeCustomerId === O2.customer && org2doc.stripeSubscriptionId === O2.sub);

  console.log('\n--- invoice.payment_failed (org2) ---');
  const resFail = await deliverRawEvent(invoiceEvent('o2b', 'invoice.payment_failed', org2.orgId, pro, O2.customer, O2.sub, O2.pi));
  check('invoice.payment_failed -> 200', resFail.status === 200, `got ${resFail.status}`);
  let sub2 = await Subscription.findOne({ orgId: org2.orgId, isCurrent: true });
  check('subscription marked FAILED', sub2?.status === 'FAILED');
  const txnFail = await Transaction.findOne({ orgId: org2.orgId, status: 'FAILED' });
  check('FAILED transaction logged with errorMessage', !!txnFail?.errorMessage, txnFail?.errorMessage);

  console.log('\n--- customer.subscription.updated: cancel_at_period_end ---');
  const now = Math.floor(Date.now() / 1000);
  const evUpd1 = {
    id: 'evt_test_o2upd1',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: O2.sub, customer: O2.customer, status: 'active',
        cancel_at_period_end: true, canceled_at: null,
        current_period_start: now - 86400, current_period_end: now + 2592000,
        items: { data: [{ price: { id: pro.stripePriceId }, quantity: 1 }] },
        metadata: {},
      },
    },
  };
  await deliverRawEvent(evUpd1);
  sub2 = await Subscription.findById(sub2._id);
  check('canceledAt set', !!sub2?.canceledAt);

  console.log('\n--- customer.subscription.updated: plan change pro -> enterprise ---');
  const evUpd2 = {
    id: 'evt_test_o2upd2',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: O2.sub, customer: O2.customer, status: 'active',
        cancel_at_period_end: true,
        current_period_start: now - 86400, current_period_end: now + 2592000,
        items: { data: [{ price: { id: enterprise.stripePriceId }, quantity: 1 }] },
        metadata: {},
      },
    },
  };
  await deliverRawEvent(evUpd2);
  const org2Reload = await Organization.findById(org2.orgId);
  check('org2 plan changed to enterprise', org2Reload.planId.toString() === enterprise._id.toString());
  const txnUpg = await Transaction.findOne({ orgId: org2.orgId, type: 'upgrade' });
  check('UPGRADE transaction logged (from->to)', !!txnUpg && txnUpg.metadata?.from === pro._id.toString() && txnUpg.metadata?.to === enterprise._id.toString());
  sub2 = await Subscription.findById(sub2._id);
  check('subscription plan synced to enterprise', sub2.planId.toString() === enterprise._id.toString());

  console.log('\n--- customer.subscription.deleted (org2) ---');
  const resDel = await deliverRawEvent({
    id: 'evt_test_o2del',
    type: 'customer.subscription.deleted',
    data: { object: { id: O2.sub, customer: O2.customer, canceled_at: now, metadata: {} } },
  });
  check('subscription.deleted -> 200', resDel.status === 200, `got ${resDel.status}`);
  const org2Final = await Organization.findById(org2.orgId);
  check('org2 CANCELLED', org2Final.status === 'CANCELLED');
  const sub2Final = await Subscription.findById(sub2._id);
  check('subscription CANCELLED + isCurrent false', sub2Final.status === 'CANCELLED' && sub2Final.isCurrent === false);
  const txnCancel = await Transaction.findOne({ orgId: org2.orgId, type: 'cancel' });
  check('CANCEL transaction logged', !!txnCancel);

  console.log('\n--- unknown event type ignored gracefully ---');
  const unknown = await deliverRawEvent({ id: 'evt_test_unknown', type: 'product.updated', data: { object: { id: 'prod_test' } } });
  check('unknown event -> 200 + ignored', unknown.status === 200 && unknown.body.ignored === true);

  console.log('\n--- concurrency safety: parallel identical deliveries ---');
  const parallel = await Promise.all([
    deliverRawEvent(paidEvent2), // already processed invoice id -> ignored
    deliverRawEvent(paidEvent2),
    deliverRawEvent(paidEvent2),
  ]);
  check('all parallel deliveries 200', parallel.every((r) => r.status === 200));
  check('payment count still 1 under parallel load', (await Payment.countDocuments({ orgId: org1.orgId })) === 1);

  console.log('\n--- webhook logs written (idempotency ledger) ---');
  const logs = await WebhookLog.find({ orgId: { $in: [org1.orgId, org2.orgId] } });
  check('webhook logs recorded', logs.length >= 8, `logs=${logs.length}`);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error('TEST CRASH:', err);
  await mongoose.disconnect();
  process.exit(1);
});