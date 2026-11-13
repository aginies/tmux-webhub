'use strict';
// Smoke test: boots the real server on an ephemeral port with a temp config
// (token auth on, TLS off, no hosts → no tmux needed) and checks the auth
// flows end to end. Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
let child = null;
let base = '';
let token = '';
let cookie = '';
let cfgPath = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

before(async () => {
  token = 'testtoken-' + Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-test-'));
  const cfg = path.join(dir, 'config.json');
  cfgPath = cfg;
  fs.writeFileSync(cfg, JSON.stringify({ port: 0, host: '127.0.0.1', token, tls: false, hosts: [] }));
  const port = await freePort();
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PC_CONFIG_FILE: cfg, PC_PORT: String(port), PC_TLS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = `http://127.0.0.1:${port}`;
  await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('server did not start: ' + out)), 8000);
    const onData = (d) => {
      out += d;
      if (out.includes('tmux-webhub on')) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (c) => { clearTimeout(timer); reject(new Error('server exited early (' + c + '): ' + out)); });
  });
});

after(() => { if (child) child.kill('SIGTERM'); });

test('GET / without token → login page', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /access token/i);
});

test('GET /assets without token → 401', async () => {
  const r = await fetch(base + '/vendor/xterm.js');
  assert.equal(r.status, 401);
});

test('POST /login wrong token → 401', async () => {
  const r = await fetch(base + '/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'nope' }),
  });
  assert.equal(r.status, 401);
});

test('POST /login right token → 200 + pc_token cookie', async () => {
  const r = await fetch(base + '/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie') || '';
  assert.match(sc, /pc_token=/);
  assert.match(sc, /HttpOnly/);
  cookie = sc.split(';')[0];
});

test('GET /api/sessions without cookie → 401', async () => {
  const r = await fetch(base + '/api/sessions');
  assert.equal(r.status, 401);
});

test('GET /api/sessions with cookie → 200 + hosts array', async () => {
  const r = await fetch(base + '/api/sessions', { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(Array.isArray(d.hosts));
});

test('GET / with cookie → index.html', async () => {
  const r = await fetch(base + '/', { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /tmux-webhub/);
});

test('GET /api/config with cookie → 200 + raw file', async () => {
  const r = await fetch(base + '/api/config', { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.raw.includes('"hosts"'));
});

test('PUT /api/config invalid JSON → 400, file untouched', async () => {
  const before = fs.readFileSync(cfgPath, 'utf8');
  const r = await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{oops' });
  assert.equal(r.status, 400);
  assert.equal(fs.readFileSync(cfgPath, 'utf8'), before);
});

test('PUT /api/config valid → 200, file updated, hosts hot-reload', async () => {
  const r = await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ port: 0, host: '127.0.0.1', token, tls: false, hosts: [{ name: 'testhost' }] }) });
  assert.equal(r.status, 200);
  const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(onDisk.hosts[0].name, 'testhost');
  const r2 = await fetch(base + '/api/sessions', { headers: { Cookie: cookie } });
  const d2 = await r2.json();
  assert.ok(d2.hosts.some((h) => h.name === 'testhost'));
});

test('GET /api/config without cookie → 401', async () => {
  const r = await fetch(base + '/api/config');
  assert.equal(r.status, 401);
});

test('GET /api/dirs → resolved path + subdirectories (local host)', async () => {
  const r = await fetch(base + '/api/dirs?host=testhost&path=' + encodeURIComponent(os.tmpdir()), { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.path.startsWith('/'));
  assert.ok(Array.isArray(d.dirs));
});

test('GET /api/dirs non-directory → 404', async () => {
  const r = await fetch(base + '/api/dirs?host=testhost&path=' + encodeURIComponent(path.join(os.tmpdir(), 'no-such-dir-pc')), { headers: { Cookie: cookie } });
  assert.equal(r.status, 404);
});

test('GET /api/dirs unknown host → 400', async () => {
  const r = await fetch(base + '/api/dirs?host=nowhere', { headers: { Cookie: cookie } });
  assert.equal(r.status, 400);
});

test('WS without auth → close 4401', async () => {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws?host=x&session=y');
    ws.on('close', (code) => (code === 4401 ? resolve() : reject(new Error('close code ' + code))));
    ws.on('error', reject);
  });
});

test('WS with ?token= → auth passes (then unknown-host 4000, not 4401)', async () => {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + `/ws?host=x&session=y&token=${token}`);
    ws.on('close', (code) => (code === 4401 ? reject(new Error('rejected with 4401')) : resolve()));
    ws.on('error', reject);
  });
});

// ---------- session creation (POST /api/sessions) ----------
// The cwd-resolution fix (tmux 3.8 does not expand ~ in -c) needs a real tmux to observe
// the resulting pane cwd, so those two tests skip when tmux is absent. testhost is the
// local host created by the config PUT test above; its cmd is set to a live command
// (sleep) so the pane outlives the check — the default cmd (pi) may not be installed.
const cp = require('node:child_process');
const hasTmux = (() => { try { cp.execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const tmuxCwd = (name) => cp.execFileSync('tmux', ['display-message', '-p', '-t', name, '#{pane_current_path}'], { encoding: 'utf8' }).trim();
const tmuxKill = (name) => { try { cp.execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {} };
async function waitForCwd(name, timeoutMs = 3000) {
  const t0 = Date.now();
  for (;;) {
    try { return tmuxCwd(name); }
    catch { if (Date.now() - t0 > timeoutMs) return null; await new Promise((r) => setTimeout(r, 100)); }
  }
}

// pure shell check (the [ -d ] guard fails before tmux is invoked) → runs without tmux
test('POST /api/sessions: nonexistent absolute dir → 400 "not a directory"', async () => {
  const r = await fetch(base + '/api/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ host: 'testhost', name: 'pc-nonexist', cwd: '/no/such/dir-pc-' + Date.now() }),
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not a directory/);
});

test('POST /api/sessions: ~/x resolves to an absolute path', { skip: !hasTmux }, async () => {
  await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ port: 0, host: '127.0.0.1', token, tls: false, hosts: [{ name: 'testhost', cmd: 'sleep 60' }] }) });
  const sub = 'pc-tilde-' + Date.now();
  const homeSub = path.join(os.homedir(), sub);
  fs.mkdirSync(homeSub);
  const name = 'pc-tilde-s-' + Date.now();
  try {
    const r = await fetch(base + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ host: 'testhost', name, cwd: '~/' + sub }) });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    assert.equal(await waitForCwd(name), homeSub);
  } finally {
    tmuxKill(name);
    try { fs.rmSync(homeSub, { recursive: true, force: true }); } catch {}
  }
});

test('POST /api/sessions: empty cwd → home', { skip: !hasTmux }, async () => {
  const name = 'pc-home-' + Date.now();
  try {
    const r = await fetch(base + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ host: 'testhost', name, cwd: '' }) });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    assert.equal(await waitForCwd(name), os.homedir());
  } finally {
    tmuxKill(name);
  }
});

// ---------- pi activity: the LAST session-JSONL entry drives the flag, not window output ----------
// A fake `pi` (node script that sets process.title, like the real one) runs in a tmux
// session; the test appends entries to a fake session file under $HOME and checks the
// activity flag follows the LAST entry: final assistant (no toolCall) → idle, anything
// else (user msg, toolCall, toolResult) → active — even while the window is fresh.
test('pi pane: activity from last session entry', { skip: !hasTmux }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-piact-'));
  const enc = '-' + (dir + '/').replace(/\//g, '-') + '-';
  const sessDir = path.join(os.homedir(), '.pi', 'agent', 'sessions', enc);
  const jsonl = path.join(sessDir, '2026-01-01T00-00-00-000Z_00000000-0000-4000-8000-000000000000.jsonl');
  const name = 'pc-piact-' + Date.now();
  const entry = (role, content) => JSON.stringify({ type: 'message', id: 'x' + Math.random().toString(16).slice(2), parentId: null, timestamp: new Date().toISOString(), message: { role, content } });
  const FINAL = entry('assistant', [{ type: 'text', text: 'done' }]);
  const USER = entry('user', [{ type: 'text', text: 'hi' }]);
  const TOOLCALL = entry('assistant', [{ type: 'toolCall', id: 't1', name: 'bash', arguments: {} }]);
  try {
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(jsonl, FINAL + '\n');
    // fake pi: emits like a spinner every 2 s unless <cwd>/pause exists (test control),
    // so a session-file append in the test always coincides with a fresh window — the
    // same invariant the production poll script relies on
    const fakePi = path.join(dir, 'bin', 'pi');
    fs.writeFileSync(fakePi, '#!/usr/bin/env node\nprocess.title = "pi";\nsetInterval(() => { try { if (!require("fs").existsSync(require("path").join(process.cwd(), "pause"))) process.stdout.write(".\\n"); } catch {} }, 2000);\n');
    fs.chmodSync(fakePi, 0o755);
    await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ port: 0, host: '127.0.0.1', token, tls: false, hosts: [{ name: 'pihost', cmd: fakePi }] }) });
    const r = await fetch(base + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ host: 'pihost', name, cwd: dir }) });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    // poll until the flag matches (the poller refreshes every POLL_MS while a client is present)
    async function expectActivity(want, timeoutMs = 15000) {
      const t0 = Date.now();
      for (;;) {
        const g = await fetch(base + '/api/sessions', { headers: { Cookie: cookie } });
        const d = await g.json();
        const s = (d.hosts.find((h) => h.name === 'pihost') || { sessions: [] }).sessions.find((x) => x.name === name);
        if (s && s.activity === want) return;
        if (Date.now() - t0 > timeoutMs) throw new Error(`activity=${s ? s.activity : 'session missing'}, wanted ${want}`);
        await new Promise((res) => setTimeout(res, 500));
      }
    }
    await expectActivity(false); // final assistant entry → settled, although the window is fresh
    fs.appendFileSync(jsonl, USER + '\n');
    await expectActivity(true);  // user message → model call in flight
    fs.appendFileSync(jsonl, FINAL + '\n');
    await expectActivity(false); // settled again
    fs.appendFileSync(jsonl, TOOLCALL + '\n');
    await expectActivity(true);  // tool running / permission pending
    // now the fake pi goes silent: once the window goes stale, the poll script skips the
    // file read and Node must serve the cached TOOLCALL entry — a broken cache would fall
    // back to the stale window and flip to idle
    fs.writeFileSync(path.join(dir, 'pause'), '');
    await new Promise((res) => setTimeout(res, 14000)); // last output + ACTIVE_WINDOW_MS (10 s)
    await expectActivity(true, 5000);
  } finally {
    tmuxKill(name);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(sessDir, { recursive: true, force: true }); } catch {}
  }
});
