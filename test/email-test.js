const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const api = require('../test/helpers/api');
const env = require('../config/env');
const { Plan } = require('../models');
const { sendInvitationEmail, sendPaymentReceipt } = require('../services/emailService');

const PREVIEW_DIR = path.resolve(__dirname, '../preview-emails');

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function previewFiles() {
  if (!fs.existsSync(PREVIEW_DIR)) return [];
  return fs
    .readdirSync(PREVIEW_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

function fileFor(name, count) {
  const files = previewFiles();
  return files[count] ? JSON.parse(fs.readFileSync(path.join(PREVIEW_DIR, name), 'utf8')) : null;
}

async function waitForFileCount(minCount, until = 4000) {
  const start = Date.now();
  while (previewFiles().length < minCount) {
    if (Date.now() - start > until) return previewFiles().length;
    await sleep(100);
  }
  return previewFiles().length;
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
  fs.rmSync(PREVIEW_DIR, { recursive: true, force: true });

  await mongoose.connect(env.MONGO_URI, { dbName: env.DB_NAME });
  for (const col of ['organizations', 'subscriptions', 'users', 'payments', 'transactions', 'webhooklogs', 'invitations']) {
    await mongoose.connection.dropCollection(col).catch(() => {});
  }

  const pro = await Plan.findOne({ slug: 'pro' });
  const stamp = Date.now();
  const adminEmail = `mail-admin-${stamp}@example.com`;
  const memberEmail = `mail-member-${stamp}@example.com`;

  console.log('\n--- unit: preview transport ---');
  const direct = await sendInvitationEmail({
    to: 'unit@example.com',
    orgName: 'Unit Org',
    inviteUrl: 'http://localhost:5173/invite?token=unit123',
    expiresAt: new Date(Date.now() + 86400000),
  });
  check('direct send resolves with preview flag', direct.preview === true, JSON.stringify(direct));
  check('direct send wrote a file', previewFiles().length >= 1, `files=${previewFiles().length}`);

  console.log('\n--- integration: welcome + receipt + invitation emails ---');
  const orgId = (await api.post('/auth/register', {
    organizationName: `MailOrg ${stamp}`,
    adminName: 'Mail Admin',
    email: adminEmail,
    password: 'Passw0rd!123',
    planId: pro._id.toString(),
  })).body.orgId;

  await deliverWebhook({
    id: `evt_cp12_${stamp}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_cp12_${stamp}`,
        customer: `cus_cp12_${stamp}`,
        subscription: `sub_cp12_${stamp}`,
        payment_status: 'paid',
        client_reference_id: orgId,
        metadata: { orgId, planId: pro._id.toString() },
      },
    },
  });
  await waitForFileCount(2);

  await deliverWebhook({
    id: `evt_cp12_inv_${stamp}`,
    type: 'invoice.paid',
    data: {
      object: {
        id: `in_cp12_${stamp}`,
        subscription: `sub_cp12_${stamp}`,
        customer: `cus_cp12_${stamp}`,
        amount_paid: pro.priceCents,
        currency: 'usd',
        number: `CP12-${stamp}`,
        payment_intent: `pi_cp12_${stamp}`,
        charge: `ch_cp12_${stamp}`,
        hosted_invoice_url: 'https://pay.stripe.com/invoice/cp12',
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
  await waitForFileCount(3);

  const files = previewFiles();
  const welcome = JSON.parse(fs.readFileSync(path.join(PREVIEW_DIR, files[1]), 'utf8'));
  const receipt = JSON.parse(fs.readFileSync(path.join(PREVIEW_DIR, files[2]), 'utf8'));

  check('welcome email to org admin', welcome.to[0]?.address === adminEmail, JSON.stringify(welcome.to));
  check('welcome email lists org plan', welcome.subject.includes(`MailOrg ${stamp}`) && welcome.subject.toLowerCase().includes('active'));
  check('receipt email to org admin', receipt.to[0]?.address === adminEmail, JSON.stringify(receipt.to));
  check('receipt has invoice number', JSON.stringify(receipt).includes(`INV-CP12-${stamp}`));
  check('receipt has amount', JSON.stringify(receipt).includes('$19.99'));
  check('receipt has invoice link', JSON.stringify(receipt).includes('pay.stripe.com/invoice/cp12'));

  const adminToken = await login(adminEmail, 'Passw0rd!123');
  const invite = await api.post('/members/invite', { email: memberEmail, role: 'org_member' }, adminToken);
  check('invite request ok', invite.status === 201, `got ${invite.status}`);
  await waitForFileCount(4);
  const inviteMail = JSON.parse(fs.readFileSync(path.join(PREVIEW_DIR, previewFiles()[3]), 'utf8'));
  check('invitation email to member', inviteMail.to[0]?.address === memberEmail, JSON.stringify(inviteMail.to));
  check('invitation mentions org', inviteMail.subject.includes(`MailOrg ${stamp}`));
  check('invitation has accept link', invite.body.invite.url.split('token=')[1].length > 10 && JSON.stringify(inviteMail).includes('token='));

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error('TEST CRASH:', err);
  await mongoose.disconnect();
  process.exit(1);
});