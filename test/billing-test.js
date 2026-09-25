const mongoose = require('mongoose');
const api = require('../test/helpers/api');
const env = require('../config/env');
const stripe = require('../config/stripe');
const { Plan, Organization, Subscription, User } = require('../models');
const { ROLES, ORG_STATUS, SUBSCRIPTION_STATUS } = require('../models/enums');

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

async function firebaseToken(email, password) {
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=AIzaSyCeIgzJIm9GKOlZyTsT-fwcf7kotL0J8e0',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  const data = await res.json();
  if (!data.idToken) throw new Error(`firebase sign-in failed: ${data.error?.message || res.status}`);
  return data.idToken;
}

async function login(email, password) {
  const token = await firebaseToken(email, password);
  const res = await api.post('/auth/login', { token });
  if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.body)}`);
  return token;
}

(async () => {
  await mongoose.connect(env.MONGO_URI, { dbName: env.DB_NAME });
  await mongoose.connection.dropCollection('organizations').catch(() => {});
  await mongoose.connection.dropCollection('subscriptions').catch(() => {});
  await mongoose.connection.dropCollection('users').catch(() => {});
  await mongoose.connection.dropCollection('payments').catch(() => {});
  await mongoose.connection.dropCollection('transactions').catch(() => {});

  const pro = await Plan.findOne({ slug: 'pro' });
  const enterprise = await Plan.findOne({ slug: 'enterprise' });
  const free = await Plan.findOne({ slug: 'free' });
  const stamp = Date.now();
  const email = `lifecycle-${stamp}@example.com`;

  console.log('\n--- register org, then attach a REAL Stripe subscription ---');
  const reg = await api.post('/auth/register', {
    organizationName: `Lifecycle ${stamp}`,
    adminName: 'LC Admin',
    email,
    password: 'Passw0rd!123',
    planId: pro._id.toString(),
  });
  check('register -> 201', reg.status === 201, JSON.stringify(reg.body));
  const orgId = reg.body.orgId;

  const customer = await stripe.customers.create({ email });
  const pm = await stripe.paymentMethods.create({ type: 'card', card: { token: 'tok_visa' } });
  await stripe.paymentMethods.attach(pm.id, { customer: customer.id });
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
  const remoteSub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: pro.stripePriceId }],
    payment_settings: { save_default_payment_method: 'on_subscription' },
  });
  check('real Stripe subscription active', remoteSub.status === 'active', `status=${remoteSub.status}`);

  const org = await Organization.findById(orgId);
  org.status = ORG_STATUS.ACTIVE;
  org.activatedAt = new Date();
  org.stripeCustomerId = customer.id;
  org.stripeSubscriptionId = remoteSub.id;
  await org.save();
  const sub = await Subscription.findOne({ orgId, isCurrent: true });
  sub.status = SUBSCRIPTION_STATUS.ACTIVE;
  sub.stripeSubscriptionId = remoteSub.id;
  sub.planId = pro._id;
  const nowSec = Math.floor(Date.now() / 1000);
  sub.currentPeriodStart = new Date((remoteSub.current_period_start || nowSec) * 1000);
  sub.currentPeriodEnd = new Date((remoteSub.current_period_end || nowSec + 2592000) * 1000);
  await sub.save();

  const token = await login(email, 'Passw0rd!123');

  console.log('\n--- GET /billing/current ---');
  const current = await api.get('/billing/current', token);
  check('current -> 200', current.status === 200, `got ${current.status}`);
  check('returns org name + status', current.body?.org?.name === org.name && current.body?.org?.status === 'ACTIVE');
  check('returns subscription ACTIVE + plan', current.body?.subscription?.status === 'ACTIVE' && current.body?.plan?.slug === 'pro');
  check('plan price matches', current.body?.plan?.priceCents === pro.priceCents);
  check('period end present', !!current.body?.subscription?.currentPeriodEnd);
  check('recent payments empty list', Array.isArray(current.body?.recentPayments) && current.body?.recentPayments.length === 0);

  console.log('\n--- change plan pro -> enterprise ---');
  const change = await api.post('/billing/change-plan', { planId: enterprise._id.toString() }, token);
  check('change-plan -> 200', change.status === 200, `got ${change.status} ${JSON.stringify(change.body)}`);
  let remoteReload = await stripe.subscriptions.retrieve(remoteSub.id);
  check('Stripe subscription now on enterprise price', remoteReload.items.data[0].price.id === enterprise.stripePriceId, remoteReload.items.data[0].price.id);
  const orgReload = await Organization.findById(orgId);
  const subReload = await Subscription.findById(sub._id);
  check('org plan synced locally immediately', orgReload?.planId?.toString() === enterprise._id.toString(), `got ${orgReload?.planId}`);
  check('subscription plan synced locally immediately', subReload?.planId?.toString() === enterprise._id.toString(), `got ${subReload?.planId}`);
  const txUpgManual = await mongoose.connection.collection('transactions').findOne({ orgId: org._id, type: 'upgrade' });
  check('UPGRADE transaction logged synchronously', !!txUpgManual && txUpgManual?.metadata?.to === enterprise._id.toString(), JSON.stringify(txUpgManual?.metadata));

  console.log('\n--- change plan guards ---');
  const same = await api.post('/billing/change-plan', { planId: enterprise._id.toString() }, token);
  check('already on plan -> 400', same.status === 400, `got ${same.status} ${JSON.stringify(same.body)}`);
  const toFree = await api.post('/billing/change-plan', { planId: free._id.toString() }, token);
  check('free plan (no price) -> 400', toFree.status === 400, `got ${toFree.status} ${JSON.stringify(toFree.body)}`);
  const badShape = await api.post('/billing/change-plan', {}, token);
  check('missing planId -> 400', badShape.status === 400, `got ${badShape.status}`);

  console.log('\n--- free org upgrade via hosted checkout ---');
  const freeReg = await api.post('/auth/register', {
    organizationName: `FreeUpgrade ${stamp}`,
    adminName: 'Free Upgrade Admin',
    email: `freeup-${stamp}@example.com`,
    password: 'Passw0rd!123',
    planId: free._id.toString(),
  });
  check('free org register -> 201', freeReg.status === 201, JSON.stringify(freeReg.body));
  const freeOrgDoc = await Organization.findById(freeReg.body.orgId);
  check('free org is ACTIVE', freeOrgDoc?.status === 'ACTIVE', `got ${freeOrgDoc?.status}`);
  const freeToken = await login(`freeup-${stamp}@example.com`, 'Passw0rd!123');
  const upgrade = await api.post('/billing/change-plan', { planId: pro._id.toString() }, freeToken);
  check('free -> paid returns hosted checkoutUrl', upgrade.status === 200 && typeof upgrade.body?.checkoutUrl === 'string' && upgrade.body.checkoutUrl.startsWith('https://'), JSON.stringify(upgrade.body));
  const freeOrgAfterUpgrade = await Organization.findById(freeReg.body.orgId);
  check('checkout session stored for plan change', typeof freeOrgAfterUpgrade?.checkoutSessionId === 'string' && freeOrgAfterUpgrade.checkoutSessionId.startsWith('cs_'));

  console.log('\n--- cancel at period end + reactivate ---');
  const cancel = await api.post('/billing/cancel', {}, token);
  check('cancel -> 200', cancel.status === 200, `got ${cancel.status}`);
  remoteReload = await stripe.subscriptions.retrieve(remoteSub.id);
  check('Stripe cancel_at_period_end true', remoteReload.cancel_at_period_end === true);

  const reactivate = await api.post('/billing/reactivate', {}, token);
  check('reactivate -> 200', reactivate.status === 200, `got ${reactivate.status}`);
  remoteReload = await stripe.subscriptions.retrieve(remoteSub.id);
  check('Stripe cancel_at_period_end false', remoteReload.cancel_at_period_end === false);

  console.log('\n--- billing portal ---');
  const portal = await api.post('/billing/portal', {}, token);
  check('portal -> 200 with hosted url', portal.status === 200 && typeof portal.body?.url === 'string' && portal.body.url.startsWith('http'), portal.body?.url);

  console.log('\n--- role + auth guards ---');
  await api.post('/auth/register', {
    organizationName: `MemberSrc ${stamp}`,
    adminName: 'Member Source',
    email: `msrc-${stamp}@example.com`,
    password: 'Passw0rd!123',
    planId: pro._id.toString(),
  });
  await User.updateOne({ email: `msrc-${stamp}@example.com` }, { role: ROLES.ORG_MEMBER, orgId });
  const memberToken = await login(`msrc-${stamp}@example.com`, 'Passw0rd!123');
  const memberChange = await api.post('/billing/change-plan', { planId: pro._id.toString() }, memberToken);
  check('org_member change-plan -> 403', memberChange.status === 403, `got ${memberChange.status}`);

  const noToken = await api.post('/billing/cancel', {});
  check('cancel without session -> 401', noToken.status === 401, `got ${noToken.status}`);

  console.log('\n--- pending org cannot manage ---');
  await api.post('/auth/register', {
    organizationName: `PendingLifecycle ${stamp}`,
    adminName: 'Pending Admin',
    email: `pending-${stamp}@example.com`,
    password: 'Passw0rd!123',
    planId: pro._id.toString(),
  });
  const pendingToken = await login(`pending-${stamp}@example.com`, 'Passw0rd!123');
  const pendingCancel = await api.post('/billing/cancel', {}, pendingToken);
  check('pending org cancel -> 400', pendingCancel.status === 400, `got ${pendingCancel.status} ${JSON.stringify(pendingCancel.body)}`);
  const pendingCurrent = await api.get('/billing/current', pendingToken);
  check('pending org can still read current', pendingCurrent.status === 200, `got ${pendingCurrent.status}`);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error('TEST CRASH:', err);
  await mongoose.disconnect();
  process.exit(1);
});