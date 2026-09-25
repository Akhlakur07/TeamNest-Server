const mongoose = require('mongoose');
const api = require('../test/helpers/api');
const env = require('../config/env');
const { Plan } = require('../models');

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

async function deliverWebhook(event) {
  return fetch('http://localhost:5000/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
}

(async () => {
  await mongoose.connect(env.MONGO_URI, { dbName: env.DB_NAME });
  for (const col of ['organizations', 'subscriptions', 'users', 'payments', 'transactions', 'webhooklogs', 'invitations']) {
    await mongoose.connection.dropCollection(col).catch(() => {});
  }

  const pro = await Plan.findOne({ slug: 'pro' });
  const stamp = Date.now();
  const adminEmail = `memb-admin-${stamp}@example.com`;
  const memberEmail = `memb-user-${stamp}@example.com`;

  const orgId = (await api.post('/auth/register', {
    organizationName: `MemberOrg ${stamp}`,
    adminName: 'Org Admin',
    email: adminEmail,
    password: 'Passw0rd!123',
    planId: pro._id.toString(),
  })).body.orgId;

  await deliverWebhook({
    id: `evt_cp11_${stamp}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_cp11_${stamp}`,
        customer: `cus_cp11_${stamp}`,
        subscription: `sub_cp11_${stamp}`,
        payment_status: 'paid',
        client_reference_id: orgId,
        metadata: { orgId, planId: pro._id.toString() },
      },
    },
  });
  await deliverWebhook({
    id: `evt_cp11_inv_${stamp}`,
    type: 'invoice.paid',
    data: {
      object: {
        id: `in_cp11_${stamp}`,
        subscription: `sub_cp11_${stamp}`,
        customer: `cus_cp11_${stamp}`,
        amount_paid: pro.priceCents,
        currency: 'usd',
        number: `INV-CP11-${stamp}`,
        payment_intent: `pi_cp11_${stamp}`,
        charge: `ch_cp11_${stamp}`,
        hosted_invoice_url: 'https://pay.stripe.com/invoice/cp11',
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

  const adminToken = await login(adminEmail, 'Passw0rd!123');
  const invite = await api.post('/members/invite', { email: memberEmail, role: 'org_member' }, adminToken);
  const inviteToken = invite.body.invite.url.split('token=')[1];
  const join = await api.post('/auth/join', { token: inviteToken, name: 'Member Jane', password: 'Passw0rd!123' });
  check('member joins org', join.status === 201 && join.body?.org?.role === 'org_member', JSON.stringify(join.body));
  const memberToken = await login(memberEmail, 'Passw0rd!123');

  console.log('\n--- profile update ---');
  const update = await api.patch('/account/profile', { name: 'Jane Doe Renamed' }, memberToken);
  check('update profile -> 200', update.status === 200, `got ${update.status}`);
  const me = await api.get('/auth/me', memberToken);
  check('profile persisted in /auth/me', me.body?.user?.name === 'Jane Doe Renamed', JSON.stringify(me.body?.user));
  const badName = await api.patch('/account/profile', { name: 'X' }, memberToken);
  check('invalid name -> 400', badName.status === 400, `got ${badName.status}`);
  const anonProfile = await api.patch('/account/profile', { name: 'Nope' });
  check('profile edit without session -> 401', anonProfile.status === 401, `got ${anonProfile.status}`);

  console.log('\n--- password change ---');
  const wrongCurrent = await api.post('/account/change-password', { currentPassword: 'WrongPass!1', newPassword: 'NewPassw0rd!22' }, memberToken);
  check('wrong current password -> 400', wrongCurrent.status === 400, `got ${wrongCurrent.status} ${JSON.stringify(wrongCurrent.body)}`);
  const shortNew = await api.post('/account/change-password', { currentPassword: 'Passw0rd!123', newPassword: 'short' }, memberToken);
  check('short new password -> 400', shortNew.status === 400, `got ${shortNew.status}`);

  const change = await api.post('/account/change-password', { currentPassword: 'Passw0rd!123', newPassword: 'NewPassw0rd!22' }, memberToken);
  check('change password -> 200', change.status === 200, `got ${change.status} ${JSON.stringify(change.body)}`);

  const oldPwFails = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=AIzaSyCeIgzJIm9GKOlZyTsT-fwcf7kotL0J8e0',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: memberEmail, password: 'Passw0rd!123', returnSecureToken: true }),
    }
  );
  check('old password no longer works', oldPwFails.status !== 200, `status=${oldPwFails.status}`);
  const newLogin = await login(memberEmail, 'NewPassw0rd!22');
  check('login with new password works', typeof newLogin === 'string');

  console.log('\n--- member read-only billing view ---');
  const billing = await api.get('/billing/current', newLogin);
  check('member billing -> 200', billing.status === 200, `got ${billing.status}`);
  check('member sees plan + subscription', billing.body?.plan?.slug === 'pro' && billing.body?.subscription?.status === 'ACTIVE');
  check('member does NOT receive payments', Array.isArray(billing.body?.recentPayments) && billing.body?.recentPayments?.length === 0, JSON.stringify(billing.body?.recentPayments));

  const adminBilling = await api.get('/billing/current', adminToken);
  check('admin still receives payments', adminBilling.body?.recentPayments?.length === 1, `got ${adminBilling.body?.recentPayments?.length}`);

  console.log('\n--- member cannot mutate billing ---');
  const memberCancel = await api.post('/billing/cancel', undefined, newLogin);
  check('member cancel -> 403', memberCancel.status === 403, `got ${memberCancel.status}`);

  console.log('\n--- password reset link ---');
  const reset = await api.post('/auth/password-reset', { email: adminEmail });
  check('password-reset -> 200', reset.status === 200, `got ${reset.status}`);
  check(
    'reset returns link in dev',
    typeof reset.body?.resetLink === 'string' && reset.body.resetLink.startsWith('https://'),
    JSON.stringify(reset.body)
  );
  const resetBad = await api.post('/auth/password-reset', { email: 'not-an-email' });
  check('invalid reset email -> 400', resetBad.status === 400, `got ${resetBad.status}`);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error('TEST CRASH:', err);
  await mongoose.disconnect();
  process.exit(1);
});