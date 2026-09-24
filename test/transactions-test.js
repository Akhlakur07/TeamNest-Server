const mongoose = require('mongoose');
const api = require('../test/helpers/api');
const env = require('../config/env');
const { Plan, Organization, User, Subscription } = require('../models');
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
  const res = await fetch('http://localhost:5000/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  return res;
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

function event(id, type, object) {
  return { id, type, data: { object } };
}

const nowSec = Math.floor(Date.now() / 1000);

(async () => {
  await mongoose.connect(env.MONGO_URI, { dbName: env.DB_NAME });
  for (const col of ['organizations', 'subscriptions', 'users', 'payments', 'transactions', 'webhooklogs', 'invitations']) {
    await mongoose.connection.dropCollection(col).catch(() => {});
  }

  const pro = await Plan.findOne({ slug: 'pro' });
  const enterprise = await Plan.findOne({ slug: 'enterprise' });
  const stamp = Date.now();
  const emailA = `tx-a-${stamp}@example.com`;

  console.log('\n--- build org A ledger through webhook events ---');
  const orgA = await registerOrg(`TxA ${stamp}`, emailA, pro);
  const tokenA = await login(emailA, 'Passw0rd!123');

  const checkoutA = event(
    `evt_csA_${stamp}`,
    'checkout.session.completed',
    {
      id: `cs_A_${stamp}`,
      customer: `cus_A_${stamp}`,
      subscription: `sub_A_${stamp}`,
      payment_status: 'paid',
      client_reference_id: orgA,
      metadata: { orgId: orgA, planId: pro._id.toString() },
    }
  );
  check('checkout.session.completed delivered', (await deliverWebhook(checkoutA)).status === 200);

  const inv1 = event(
    `evt_inv1_${stamp}`,
    'invoice.paid',
    {
      id: `in_1_${stamp}`,
      subscription: `sub_A_${stamp}`,
      customer: `cus_A_${stamp}`,
      amount_paid: pro.priceCents,
      currency: 'usd',
      number: `INV-${stamp}`,
      payment_intent: `pi_1_${stamp}`,
      charge: `ch_1_${stamp}`,
      hosted_invoice_url: 'https://pay.stripe.com/invoice/inv_1',
      lines: {
        data: [
          {
            price: { id: pro.stripePriceId },
            period: { start: nowSec - 2592000, end: nowSec },
          },
        ],
      },
    }
  );
  check('invoice.paid (setup payment) delivered', (await deliverWebhook(inv1)).status === 200);

  const subUpdate = event(
    `evt_up_${stamp}`,
    'customer.subscription.updated',
    {
      id: `sub_A_${stamp}`,
      subscription: `sub_A_${stamp}`,
      status: 'active',
      current_period_start: nowSec - 2592000,
      current_period_end: nowSec,
      items: {
        data: [{ id: 'si_1', price: { id: enterprise.stripePriceId } }],
      },
    }
  );
  check('subscription.updated (upgrade) delivered', (await deliverWebhook(subUpdate)).status === 200);

  const inv2 = event(
    `evt_inv2_${stamp}`,
    'invoice.paid',
    {
      id: `in_2_${stamp}`,
      subscription: `sub_A_${stamp}`,
      customer: `cus_A_${stamp}`,
      amount_paid: enterprise.priceCents,
      currency: 'usd',
      number: `INV-${stamp}-2`,
      payment_intent: `pi_2_${stamp}`,
      charge: `ch_2_${stamp}`,
      hosted_invoice_url: 'https://pay.stripe.com/invoice/inv_2',
      lines: {
        data: [
          {
            price: { id: enterprise.stripePriceId },
            period: { start: nowSec - 2592000, end: nowSec },
          },
        ],
      },
    }
  );
  check('invoice.paid (renewal) delivered', (await deliverWebhook(inv2)).status === 200);

  const refund = event(
    `evt_ref_${stamp}`,
    'charge.refunded',
    {
      id: `ch_2_${stamp}`,
      payment_intent: `pi_2_${stamp}`,
      amount_refunded: enterprise.priceCents,
      currency: 'usd',
    }
  );
  check('charge.refunded delivered', (await deliverWebhook(refund)).status === 200);

  const deleted = event(
    `evt_del_${stamp}`,
    'customer.subscription.deleted',
    {
      id: `sub_A_${stamp}`,
      subscription: `sub_A_${stamp}`,
      canceled_at: nowSec,
    }
  );
  check('subscription.deleted delivered', (await deliverWebhook(deleted)).status === 200);

  const orgADoc = await Organization.findById(orgA);
  check('org A ended CANCELLED', orgADoc.status === ORG_STATUS.CANCELLED, orgADoc.status);

  const expectedCollected = pro.priceCents + enterprise.priceCents + enterprise.priceCents;
  const expectedRefunded = enterprise.priceCents;

  console.log('\n--- GET /transactions list + summary ---');
  const list = await api.get('/transactions', tokenA);
  check('list -> 200', list.status === 200, `got ${list.status}`);
  check('total = 5 transactions', list.body?.total === 5, `total=${list.body?.total}`);
  check('summary count = 5', list.body?.summary?.count === 5);
  check('summary collected computed', list.body?.summary?.collected === expectedCollected, `got ${list.body?.summary?.collected}`);
  check('summary refunded computed', list.body?.summary?.refunded === expectedRefunded, `got ${list.body?.summary?.refunded}`);
  check('summary net computed', list.body?.summary?.net === expectedCollected - expectedRefunded);
  check('type counts', list.body?.summary?.byType?.checkout === 1 && list.body?.summary?.byType?.renewal === 1 && list.body?.summary?.byType?.upgrade === 1 && list.body?.summary?.byType?.refund === 1 && list.body?.summary?.byType?.cancel === 1, JSON.stringify(list.body?.summary?.byType));
  const typesInList = [...new Set(list.body.transactions.map((t) => t.type))].sort();
  check('ledger has all 5 types', typesInList.join() === 'cancel,checkout,refund,renewal,upgrade', typesInList.join());
  const upgradeTx = list.body.transactions.find((t) => t.type === 'upgrade');
  check('upgrade references enterprise plan', upgradeTx?.plan?.slug === 'enterprise' && upgradeTx?.amountCents === enterprise.priceCents, JSON.stringify(upgradeTx?.plan));

  console.log('\n--- pagination + filters ---');
  const page1 = await api.get('/transactions?page=1&limit=2', tokenA);
  check('page1 limit respects limit', page1.body?.transactions?.length === 2 && page1.body?.total === 5 && page1.body?.page === 1);
  const page3 = await api.get('/transactions?page=3&limit=2', tokenA);
  check('page3 has 1 row (5 total)', page3.body?.transactions?.length === 1 && page3.body?.total === 5);
  const onlyRefund = await api.get('/transactions?type=refund', tokenA);
  check('filter type=refund', onlyRefund.body?.total === 1 && onlyRefund.body?.transactions?.[0]?.type === 'refund' && onlyRefund.body?.transactions?.[0]?.amountCents === enterprise.priceCents);
  const onlyStatus = await api.get('/transactions?status=SUCCESS', tokenA);
  check('filter status=SUCCESS -> 5', onlyStatus.body?.total === 5);
  const onlyFailed = await api.get('/transactions?status=FAILED', tokenA);
  check('filter status=FAILED -> 0', onlyFailed.body?.total === 0);
  const badType = await api.get('/transactions?type=nonsense', tokenA);
  check('invalid type -> 400', badType.status === 400, `got ${badType.status}`);
  const future = await api.get('/transactions?from=2031-01-01', tokenA);
  check('from-filter in future -> 0', future.body?.total === 0);

  console.log('\n--- detail ---');
  const firstId = list.body.transactions[0].id;
  const detail = await api.get(`/transactions/${firstId}`, tokenA);
  check('detail -> 200 + type', detail.status === 200 && !!detail.body?.transaction?.type, `got ${detail.status}`);
  const missing = await api.get('/transactions/000000000000000000000000', tokenA);
  check('unknown detail -> 404', missing.status === 404, `got ${missing.status}`);

  console.log('\n--- CSV export ---');
  const csvRes = await fetch(`http://localhost:5000/api/transactions/export`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  const csv = await csvRes.text();
  const lines = csv.trim().split('\r\n');
  check('export csv has header + 5 rows', csvRes.status === 200 && lines.length === 6 && lines[0].startsWith('date,type,status,amount'), `${csvRes.status} lines=${lines.length}`);
  check('export content-type csv', (csvRes.headers.get('content-type') || '').includes('text/csv'));

  console.log('\n--- tenant isolation on transactions ---');
  const orgB = await registerOrg(`TxB ${stamp}`, `tx-b-${stamp}@example.com`, pro);
  const checkoutB = event(`evt_cob_${stamp}`, 'checkout.session.completed', {
    id: `cs_B_${stamp}`,
    customer: `cus_B_${stamp}`,
    subscription: `sub_B_${stamp}`,
    payment_status: 'paid',
    client_reference_id: orgB,
    metadata: { orgId: orgB, planId: pro._id.toString() },
  });
  await deliverWebhook(checkoutB);
  const tokenB = await login(`tx-b-${stamp}@example.com`, 'Passw0rd!123');
  const listB = await api.get('/transactions', tokenB);
  check('org B has no transactions', listB.status === 200 && listB.body?.total === 0 && listB.body?.summary?.count === 0);
  const crossDetail = await api.get(`/transactions/${firstId}`, tokenB);
  check('org B cannot see org A transaction -> 404', crossDetail.status === 404, `got ${crossDetail.status}`);
  const csvB = await (await fetch('http://localhost:5000/api/transactions/export', {
    headers: { Authorization: `Bearer ${tokenB}` },
  })).text();
  check('org B export is header only', csvB.trim().split('\r\n').length === 1);

  console.log('\n--- platform admin revenue overview ---');
  const adminEmail = `platform-${stamp}@teamnest.dev`;
  const fbAdmin = await createFirebaseUser(adminEmail, 'Admin@12345');
  await User.create({
    email: adminEmail,
    name: 'Platform Admin',
    role: ROLES.PLATFORM_ADMIN,
    status: 'active',
    firebaseUid: fbAdmin.localId,
  });
  const adminToken = await login(adminEmail, 'Admin@12345');
  const revenue = await api.get('/admin/revenue', adminToken);
  check('revenue -> 200', revenue.status === 200, `got ${revenue.status}`);
  check('revenue gross', revenue.body?.grossCents === expectedCollected, `got ${revenue.body?.grossCents}`);
  check('revenue refunds', revenue.body?.refundsCents === expectedRefunded);
  check('revenue net', revenue.body?.netCents === expectedCollected - expectedRefunded);
  check('active orgs = 1 (A cancelled)', revenue.body?.activeOrganizations === 1, `got ${revenue.body?.activeOrganizations}`);
  check('total orgs = 2', revenue.body?.totalOrganizations === 2);
  check('monthly revenue includes current month', Array.isArray(revenue.body?.monthly) && revenue.body?.monthly.length >= 1);
  const proPlanRow = revenue.body?.byPlan?.find((p) => p.planName === pro.name);
  const entPlanRow = revenue.body?.byPlan?.find((p) => p.planName === enterprise.name);
  check('byPlan has pro + enterprise', !!proPlanRow && !!entPlanRow, JSON.stringify(revenue.body?.byPlan));
  check('byPlan pro revenue', proPlanRow?.revenue === pro.priceCents);
  check('recent transactions annotated with org name', revenue.body?.recent?.some((r) => r.orgName.startsWith('TxA')), JSON.stringify(revenue.body?.recent?.map((r) => r.orgName)));
  const forbidden = await api.get('/admin/revenue', tokenA);
  check('org admin cannot fetch revenue -> 403', forbidden.status === 403, `got ${forbidden.status}`);
  const anonRevenue = await api.get('/admin/revenue');
  check('revenue without session -> 401', anonRevenue.status === 401, `got ${anonRevenue.status}`);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error('TEST CRASH:', err);
  await mongoose.disconnect();
  process.exit(1);
});