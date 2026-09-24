const mongoose = require('mongoose');
const api = require('../test/helpers/api');
const env = require('../config/env');
const { Plan, Organization, User } = require('../models');
const { ORG_STATUS, ROLES } = require('../models/enums');

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

async function createFirebaseUser(email, password) {
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=AIzaSyCeIgzJIm9GKOlZyTsT-fwcf7kotL0J8e0',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  const data = await res.json();
  if (!data.idToken) throw new Error(`firebase signUp failed: ${data.error?.message || res.status}`);
  return data;
}

async function login(email, password) {
  const token = await firebaseToken(email, password);
  const res = await api.post('/auth/login', { token });
  if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.body)}`);
  return token;
}

async function deliverWebhook(event) {
  return fetch('http://localhost:5000/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
}

async function registerOrg(name, email, plan) {
  const reg = await api.post('/auth/register', {
    organizationName: name,
    adminName: 'Org Admin',
    email,
    password: 'Passw0rd!123',
    planId: plan._id.toString(),
  });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  return reg.body.orgId;
}

(async () => {
  await mongoose.connect(env.MONGO_URI, { dbName: env.DB_NAME });
  for (const col of ['organizations', 'subscriptions', 'users', 'payments', 'transactions', 'webhooklogs', 'invitations']) {
    await mongoose.connection.dropCollection(col).catch(() => {});
  }

  const pro = await Plan.findOne({ slug: 'pro' });
  const stamp = Date.now();
  const emailA = `cpa-a-${stamp}@example.com`;
  const emailB = `cpa-b-${stamp}@example.com`;

  console.log('\n--- setup orgs: A active (paid), B pending ---');
  const orgA = await registerOrg(`CPA-OrgA ${stamp}`, emailA, pro);
  await deliverWebhook({
    id: `evt_cpa_a_${stamp}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_cpa_a_${stamp}`,
        customer: `cus_cpa_a_${stamp}`,
        subscription: `sub_cpa_a_${stamp}`,
        payment_status: 'paid',
        client_reference_id: orgA,
        metadata: { orgId: orgA, planId: pro._id.toString() },
      },
    },
  });
  await deliverWebhook({
    id: `evt_cpa_inv_${stamp}`,
    type: 'invoice.paid',
    data: {
      object: {
        id: `in_cpa_${stamp}`,
        subscription: `sub_cpa_a_${stamp}`,
        customer: `cus_cpa_a_${stamp}`,
        amount_paid: pro.priceCents,
        currency: 'usd',
        number: `INV-CPA-${stamp}`,
        payment_intent: `pi_cpa_${stamp}`,
        charge: `ch_cpa_${stamp}`,
        hosted_invoice_url: 'https://pay.stripe.com/invoice/cpa',
        lines: {
          data: [
            {
              price: { id: pro.stripePriceId },
              period: { start: Math.floor(Date.now() / 1000) - 2592000, end: Math.floor(Date.now() / 1000) },
            },
          ],
        },
      },
    },
  });
  const orgB = await registerOrg(`CPA-OrgB ${stamp}`, emailB, pro);
  const tokenA = await login(emailA, 'Passw0rd!123');

  const adminEmail = `platform-cpa-${stamp}@teamnest.dev`;
  const fbAdmin = await createFirebaseUser(adminEmail, 'Admin@12345');
  await User.create({
    email: adminEmail,
    name: 'Platform Admin',
    role: ROLES.PLATFORM_ADMIN,
    status: 'active',
    firebaseUid: fbAdmin.localId,
  });
  const adminToken = await login(adminEmail, 'Admin@12345');

  console.log('\n--- list organizations ---');
  const list = await api.get('/admin/organizations', adminToken);
  check('list -> 200', list.status === 200, `got ${list.status}`);
  check('total = 2 orgs', list.body?.total === 2, `total=${list.body?.total}`);
  const orgARow = list.body?.organizations?.find((o) => o.id === orgA);
  check('org A row ACTIVE + member count', orgARow?.status === 'ACTIVE' && orgARow?.memberCount === 1 && orgARow?.plan?.slug === 'pro', JSON.stringify(orgARow));

  const search = await api.get(`/admin/organizations?search=OrgA ${stamp}`, adminToken);
  check('search by name', search.body?.total === 1 && search.body?.organizations?.[0]?.id === orgA);
  const searchEmail = await api.get(`/admin/organizations?search=${stamp}`, adminToken);
  check('search catches contact email', searchEmail.body?.total === 2, `total=${searchEmail.body?.total}`);

  const pending = await api.get('/admin/organizations?status=PENDING', adminToken);
  check('filter status=PENDING -> only org B', pending.body?.total === 1 && pending.body?.organizations[0].id === orgB);

  const page1 = await api.get('/admin/organizations?limit=1&page=1', adminToken);
  const page2 = await api.get('/admin/organizations?limit=1&page=2', adminToken);
  check('pagination works', page1.body?.organizations?.length === 1 && page2.body?.organizations?.length === 1 && page2.body?.organizations?.[0]?.id !== page1.body?.organizations?.[0]?.id);

  const badStatus = await api.get('/admin/organizations?status=NOPE', adminToken);
  check('invalid status filter -> 400', badStatus.status === 400, `got ${badStatus.status}`);

  console.log('\n--- organization detail ---');
  const detail = await api.get(`/admin/organizations/${orgA}`, adminToken);
  check('detail -> 200', detail.status === 200, `got ${detail.status}`);
  check('detail has plan + subscription + members + payments', detail.body?.organization?.status === 'ACTIVE' && detail.body?.organization?.plan?.slug === 'pro' && detail.body?.subscription?.status === 'ACTIVE' && detail.body?.members?.length === 1 && detail.body?.recentPayments?.length === 1, JSON.stringify({ sub: detail.body?.subscription?.status, payments: detail.body?.recentPayments?.length }));
  check('detail exposes billing identifiers', !!detail.body?.organization?.stripeCustomerId);
  const missing = await api.get('/admin/organizations/000000000000000000000000', adminToken);
  check('unknown org detail -> 404', missing.status === 404, `got ${missing.status}`);

  console.log('\n--- suspend / reactivate lifecycle ---');
  const suspend = await api.patch(`/admin/organizations/${orgA}/status`, { status: 'SUSPENDED' }, adminToken);
  check('suspend -> 200', suspend.status === 200 && suspend.body?.organization?.status === 'SUSPENDED', `got ${suspend.status}`);
  const suspendedOrg = await Organization.findById(orgA);
  check('suspendedAt recorded', !!suspendedOrg.suspendedAt);

  const blockedSession = await api.get('/billing/current', tokenA);
  check('suspended org member blocked at API -> 403', blockedSession.status === 403, `got ${blockedSession.status} ${JSON.stringify(blockedSession.body)}`);
  const relogin = await api.post('/auth/login', { token: await firebaseToken(emailA, 'Passw0rd!123') });
  check('suspended org login blocked -> 403', relogin.status === 403, `got ${relogin.status} ${JSON.stringify(relogin.body)}`);

  const suspendAgain = await api.patch(`/admin/organizations/${orgA}/status`, { status: 'SUSPENDED' }, adminToken);
  check('suspend twice -> 400', suspendAgain.status === 400, `got ${suspendAgain.status}`);

  const resumeWrong = await api.patch(`/admin/organizations/${orgB}/status`, { status: 'ACTIVE' }, adminToken);
  check('resume non-suspended -> 400', resumeWrong.status === 400, `got ${resumeWrong.status}`);

  const resume = await api.patch(`/admin/organizations/${orgA}/status`, { status: 'ACTIVE' }, adminToken);
  check('reactivate -> 200', resume.status === 200 && resume.body?.organization?.status === 'ACTIVE');
  const restored = await Organization.findById(orgA);
  check('suspendedAt cleared', restored.suspendedAt === null);
  const unblocked = await api.get('/billing/current', tokenA);
  check('reactivated org accessible again -> 200', unblocked.status === 200, `got ${unblocked.status}`);
  const relogin2 = await api.post('/auth/login', { token: await firebaseToken(emailA, 'Passw0rd!123') });
  check('login allowed after reactivation -> 200', relogin2.status === 200, `got ${relogin2.status}`);

  console.log('\n--- authorization guards ---');
  const orgAdminForbidden = await api.get('/admin/organizations', tokenA);
  check('org admin cannot list orgs -> 403', orgAdminForbidden.status === 403, `got ${orgAdminForbidden.status}`);
  const anonList = await api.get('/admin/organizations');
  check('anon cannot list orgs -> 401', anonList.status === 401, `got ${anonList.status}`);
  const badStatusBody = await api.patch(`/admin/organizations/${orgA}/status`, { status: 'TRIAL' }, adminToken);
  check('invalid target status -> 400', badStatusBody.status === 400, `got ${badStatusBody.status}`);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error('TEST CRASH:', err);
  await mongoose.disconnect();
  process.exit(1);
});