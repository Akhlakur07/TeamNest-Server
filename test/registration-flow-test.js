const mongoose = require('mongoose');
const api = require('../test/helpers/api');
const env = require('../config/env');
const { Plan, Organization, Subscription, User } = require('../models');

const API_KEY = 'AIzaSyCeIgzJIm9GKOlZyTsT-fwcf7kotL0J8e0';
const BASE = 'http://localhost:5000/api';

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
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
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

(async () => {
  await mongoose.connect(env.MONGO_URI, { dbName: env.DB_NAME });
  await mongoose.connection.dropCollection('organizations').catch(() => {});
  await mongoose.connection.dropCollection('subscriptions').catch(() => {});
  await mongoose.connection.dropCollection('users').catch(() => {});

  const pro = await Plan.findOne({ slug: 'pro' });
  const free = await Plan.findOne({ slug: 'free' });

  const email = `reg-${Date.now()}@example.com`;

  // 1. Register with paid plan -> 201 with checkoutUrl
  console.log('\n--- register /auth/register ---');
  const reg = await api.post('/auth/register', {
    organizationName: `RegCorp ${Date.now()}`,
    adminName: 'Reg Admin',
    email,
    password: 'Passw0rd!123',
    planId: pro._id.toString(),
  });
  check('register returns 201', reg.status === 201, `got ${reg.status} ${JSON.stringify(reg.body)}`);
  check('register returns checkoutUrl', typeof reg.body?.checkoutUrl === 'string' && reg.body.checkoutUrl.startsWith('https://'), reg.body?.checkoutUrl);

  const orgId = reg.body?.orgId;
  const org = await Organization.findById(orgId);
  check('org created', !!org);
  check('org is PENDING', org?.status === 'PENDING');
  check('org has stripeCustomerId path planned - checkoutSessionId', typeof org?.checkoutSessionId === 'string' && org.checkoutSessionId.length > 10);

  const sub = await Subscription.findOne({ orgId });
  check('pending subscription created', !!sub && sub.status === 'PENDING');

  const user = await User.findOne({ email });
  check('org_admin user created', !!user && user.role === 'org_admin');
  check('user linked to org', user?.orgId && user.orgId.toString() === String(orgId));
  check('user has firebaseUid', typeof user?.firebaseUid === 'string' && user.firebaseUid.length > 10);

  // 2. duplicate email -> 409
  console.log('\n--- duplicate email ---');
  const dup = await api.post('/auth/register', {
    organizationName: `RegCorp2 ${Date.now()}`,
    adminName: 'Reg Admin 2',
    email,
    password: 'Passw0rd!123',
    planId: pro._id.toString(),
  });
  check('duplicate email -> 409', dup.status === 409, `got ${dup.status}`);

  // 3. duplicate org name -> 409
  console.log('\n--- duplicate org name ---');
  const dupOrg = await api.post('/auth/register', {
    organizationName: org.name,
    adminName: 'Reg Admin 3',
    email: `reg3-${Date.now()}@example.com`,
    password: 'Passw0rd!123',
    planId: pro._id.toString(),
  });
  check('duplicate org name -> 409', dupOrg.status === 409, `got ${dupOrg.status}`);

  // 4. free plan (no stripe price) -> 400
  console.log('\n--- free plan blocked ---');
  const freeReg = await api.post('/auth/register', {
    organizationName: `FreeCorp ${Date.now()}`,
    adminName: 'Reg Admin 4',
    email: `reg4-${Date.now()}@example.com`,
    password: 'Passw0rd!123',
    planId: free._id.toString(),
  });
  check('free plan -> 400', freeReg.status === 400, `got ${freeReg.status} ${JSON.stringify(freeReg.body)}`);

  // 5. login -> returns org with PENDING
  console.log('\n--- login returns org ---');
  const token = await firebaseToken(email, 'Passw0rd!123');
  const login = await api.post('/auth/login', { token });
  check('login -> 200', login.status === 200, `got ${login.status}`);
  check('login returns org', login.body?.org?.status === 'PENDING' && login.body.org.name === org.name, JSON.stringify(login.body?.org));

  // 6. registration-status -> PENDING
  console.log('\n--- registration-status ---');
  const status = await api.get('/auth/registration-status', token);
  check('registration-status -> 200', status.status === 200, `got ${status.status}`);
  check('org status PENDING + sub PENDING', status.body?.org?.status === 'PENDING' && status.body?.subscription?.status === 'PENDING');

  // 7. retry-checkout -> fresh checkoutUrl
  console.log('\n--- retry-checkout ---');
  const retry = await api.post('/auth/retry-checkout', {}, token);
  check('retry-checkout -> 200', retry.status === 200, `got ${retry.status}`);
  check('retry-checkout returns new checkoutUrl', typeof retry.body?.checkoutUrl === 'string' && retry.body.checkoutUrl.startsWith('https://'));

  // 8. no token on register-ful route guards
  const noToken = await api.get('/auth/registration-status');
  check('registration-status without token -> 401', noToken.status === 401, `got ${noToken.status}`);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error('TEST CRASH:', err);
  await mongoose.disconnect();
  process.exit(1);
});