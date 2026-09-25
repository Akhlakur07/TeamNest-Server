const { spawn, spawnSync } = require('child_process');
const path = require('path');
const http = require('http');

const BACK_ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 5000;
const HEALTH_URL = `http://localhost:${PORT}/api/plans`;

const SUITES = [
  'registration-flow-test.js',
  'webhook-flow-test.js',
  'billing-test.js',
  'members-test.js',
  'transactions-test.js',
  'admin-org-test.js',
  'account-test.js',
  'email-test.js',
  'security-test.js',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listenersOnPort() {
  try {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || '';
    const rows = out.split(/\r?\n/).filter((line) => line.includes(`:${PORT}`) && /LISTENING/i.test(line));
    return rows
      .map((line) => line.trim().split(/\s+/).pop())
      .filter((pid) => /^\d+$/.test(pid))
      .filter((pid, idx, arr) => arr.indexOf(pid) === idx);
  } catch {
    return [];
  }
}

function killPid(pid) {
  spawnSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
}

async function killBackend() {
  for (const pid of listenersOnPort()) killPid(pid);
  await sleep(500);
}

function startBackend() {
  const child = spawn('node', ['index.js'], {
    cwd: BACK_ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });
  return child;
}

async function waitHealthy(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.get(HEALTH_URL, (r) => resolve(r));
        req.on('error', reject);
      });
      res.resume();
      if (res.statusCode === 200) return true;
    } catch {
      // backend not up yet
    }
    await sleep(500);
  }
  return false;
}

function runSuite(file) {
  return new Promise((resolve) => {
    const child = spawn('node', [path.join('test', file)], {
      cwd: BACK_ROOT,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', (err) => {
      console.error(`[run-all] failed to spawn ${file}: ${err.message}`);
      resolve({ file, ok: false, code: 2 });
    });
    child.on('close', (code) => {
      resolve({ file, ok: code === 0, code });
    });
  });
}

(async () => {
  const results = [];

  console.log('========================================');
  console.log(' TeamNest test runner (fresh backend per suite)');
  console.log('========================================\n');

  for (const file of SUITES) {
    const started = Date.now();

    await killBackend();
    const backend = startBackend();
    const healthy = await waitHealthy();
    if (!healthy) {
      backend.kill();
      console.error(`[run-all] backend did not become healthy before ${file}`);
      results.push({ file, ok: false, code: 2 });
      continue;
    }

    console.log(`\n--- ${file} ---`);
    const { ok, code } = await runSuite(file);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    results.push({ file, ok, code, seconds });
    backend.kill();
    await sleep(300);
  }

  console.log('\n========================================');
  console.log(' Summary');
  console.log('========================================');
  let failures = 0;
  for (const r of results) {
    const status = r.ok ? 'PASS' : 'FAIL';
    if (!r.ok) failures += 1;
    console.log(`  ${status}  ${r.file}  (${r.seconds}s)${r.ok ? '' : ` exit=${r.code}`}`);
  }
  console.log(`\n${results.length - failures}/${results.length} suites passed`);

  // Leave a fresh backend running so the dev server keeps working.
  console.log('\nRestarting a fresh backend for development...');
  await killBackend();
  startBackend();
  if (await waitHealthy()) {
    console.log(`Backend is running on port ${PORT}.`);
  } else {
    console.error(`WARNING: could not confirm backend health on port ${PORT}.`);
  }

  process.exit(failures ? 1 : 0);
})();