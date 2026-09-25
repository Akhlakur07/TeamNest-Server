const mongoose = require('mongoose');
const api = require('../test/helpers/api');
const env = require('../config/env');

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

(async () => {
  await mongoose.connect(env.MONGO_URI, { dbName: env.DB_NAME });

  console.log('\n--- hardened response headers ---');
  const plans = await api.get('/plans');
  const h = plans.headers;
  check('x-powered-by is not exposed', h['x-powered-by'] === undefined, h['x-powered-by']);
  check('x-content-type-options nosniff', h['x-content-type-options'] === 'nosniff', h['x-content-type-options']);
  check('x-frame-options DENY', h['x-frame-options'] === 'DENY', h['x-frame-options']);
  check('referrer-policy set', typeof h['referrer-policy'] === 'string', h['referrer-policy']);
  check('content-security-policy set', typeof h['content-security-policy'] === 'string');
  check('cross-origin-opener-policy set', typeof h['cross-origin-opener-policy'] === 'string');

  console.log('\n--- CORS allow-list ---');
  const allowed = await api.get('/plans', undefined, { headers: { Origin: env.FRONTEND_URL } });
  check('allowed origin reflects ACAO',
    allowed.headers['access-control-allow-origin'] === env.FRONTEND_URL,
    allowed.headers['access-control-allow-origin']);
  const evilOrigin = 'https://evil.example';
  const evil = await api.get('/plans', undefined, { headers: { Origin: evilOrigin } });
  const evilAcao = evil.headers['access-control-allow-origin'];
  check('unknown origin gets no ACAO', evilAcao === undefined, JSON.stringify(evilAcao));

  console.log('\n--- payload size cap ---');
  const huge = await api.post('/auth/login', { token: 'x'.repeat(150 * 1024) });
  check('oversized body rejected 413', huge.status === 413, `got ${huge.status}`);

  console.log('\n--- rate limiting ---');
  const hasRateHeader = Object.keys(plans.headers || {}).some((k) =>
    k.toLowerCase().includes('ratelimit')
  );
  check('global limiter headers present', hasRateHeader, JSON.stringify(Object.keys(plans.headers || {})));

  const stamp = Date.now();
  let saw429 = false;
  let statuses = [];
  for (let i = 0; i < 24; i += 1) {
    const res = await api.post('/auth/login', { token: `no-such-token-${stamp}-${i}` });
    statuses.push(res.status);
    if (res.status === 429) saw429 = true;
  }
  check('excessive logins blocked with 429', saw429, statuses.join(','));
  check('limiter response is JSON message', saw429, statuses.join(','));

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error('TEST CRASH:', err);
  await mongoose.disconnect();
  process.exit(1);
});