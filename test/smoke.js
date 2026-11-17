'use strict';
// Smoke test: boots the real server on an ephemeral port with a temp config
// (token auth on, TLS off, no hosts → no tmux needed) and checks the auth
// flows end to end. Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
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
  assert.match(await r.text(), /token/i);
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
  assert.equal(d.polling, false); // no hosts configured → first poll resolves instantly
});

test('GET /api/sessions with Authorization: Bearer → 200 (2FA off)', async () => {
  const r = await fetch(base + '/api/sessions', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(Array.isArray(d.hosts));
});

test('GET /api/sessions with a wrong Bearer token → 401', async () => {
  const r = await fetch(base + '/api/sessions', { headers: { Authorization: 'Bearer nope' } });
  assert.equal(r.status, 401);
});

test('GET /api/net-interfaces without cookie → 401', async () => {
  const r = await fetch(base + '/api/net-interfaces');
  assert.equal(r.status, 401);
});

test('GET /api/net-interfaces with cookie → 200 + addresses array', async () => {
  const r = await fetch(base + '/api/net-interfaces', { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(Array.isArray(d.addresses), 'addresses is an array');
  assert.ok(d.addresses.length >= 1, 'proposes at least one address');
});

test('GET /api/debug without cookie → 401', async () => {
  const r = await fetch(base + '/api/debug');
  assert.equal(r.status, 401);
});

test('GET /api/debug with cookie → 200 + version/logLevel/hosts', async () => {
  const r = await fetch(base + '/api/debug', { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.version, require(path.join(ROOT, 'package.json')).version);
  assert.equal(d.logLevel, 'info'); // no logLevel in the test config → default
  assert.equal(d.logFile, null);   // no logFile in the test config → off
  assert.ok(Number.isFinite(d.uptimeS) && d.uptimeS >= 0);
  assert.ok(Number.isInteger(d.wsClients));
  assert.ok(Array.isArray(d.hosts));
});

test('GET /api/sessions: net stats present, totals monotonic', async () => {
  const g1 = await fetch(base + '/api/sessions', { headers: { Cookie: cookie } });
  const d1 = await g1.json();
  assert.ok(d1.net && typeof d1.net === 'object', 'net object present');
  assert.ok(Number.isFinite(d1.net.inBps) && Number.isFinite(d1.net.outBps), 'rates numeric');
  assert.ok(d1.net.inTotal > 0 && d1.net.outTotal > 0, 'bytes counted');
  // let the 1 s ring timer tick (a crash in it would kill the server)
  await new Promise((res) => setTimeout(res, 1100));
  const g2 = await fetch(base + '/api/sessions', { headers: { Cookie: cookie } });
  const d2 = await g2.json();
  assert.ok(d2.net.inTotal >= d1.net.inTotal, 'inTotal non-decreasing');
  assert.ok(d2.net.outTotal >= d1.net.outTotal, 'outTotal non-decreasing');
});

test('config: pollMs + netDisplay=false (restart-scoped)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cfg2-'));
  const cfg = path.join(dir, 'config.json');
  const tok = 'testtoken2-' + Date.now();
  fs.writeFileSync(cfg, JSON.stringify({ port: 0, host: '127.0.0.1', token: tok, tls: false, hosts: [], pollMs: 1500, netDisplay: false }));
  const port = await freePort();
  const ch = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PC_CONFIG_FILE: cfg, PC_PORT: String(port), PC_TLS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('server did not start: ' + out)), 8000);
      const onData = (d) => { out += d; if (out.includes('tmux-webhub on')) { clearTimeout(timer); resolve(); } };
      ch.stdout.on('data', onData);
      ch.stderr.on('data', onData);
      ch.on('exit', (c) => { clearTimeout(timer); reject(new Error('server exited early (' + c + '): ' + out)); });
    });
    const lr = await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tok }),
    });
    assert.equal(lr.status, 200);
    const ck = (lr.headers.get('set-cookie') || '').split(';')[0];
    const d = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Cookie: ck } })).json();
    assert.equal(d.pollMs, 1500, 'pollMs from config');
    assert.strictEqual(d.net, undefined, 'net omitted when netDisplay=false');
  } finally {
    ch.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  // PUT now requires the one-use CSRF token from a matching GET /api/config
  const csrf = await (await fetch(base + '/api/config', { headers: { Cookie: cookie } })).json().then((d) => d.csrf);
  const r = await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ port: 0, host: '127.0.0.1', token, tls: false, hosts: [{ name: 'testhost' }], csrf }) });
  assert.equal(r.status, 200);
  const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(onDisk.hosts[0].name, 'testhost');
  const r2 = await fetch(base + '/api/sessions', { headers: { Cookie: cookie } });
  const d2 = await r2.json();
  assert.ok(d2.hosts.some((h) => h.name === 'testhost'));
});

test('PUT /api/config with __REDACTED__ token preserves it (form contract)', async () => {
  // isolated server so enrolling/changing secrets never disturbs the suite's shared cookie
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-redact-'));
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ port: 0, host: '127.0.0.1', token: 'seed-token', tls: false, hosts: [] }));
  const port = await freePort();
  const ch = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PC_CONFIG_FILE: cfg, PC_PORT: String(port), PC_TLS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('server did not start: ' + out)), 8000);
      const onData = (d) => { out += d; if (out.includes('tmux-webhub on')) { clearTimeout(timer); resolve(); } };
      ch.stdout.on('data', onData);
      ch.stderr.on('data', onData);
      ch.on('exit', (c) => { clearTimeout(timer); reject(new Error('server exited early (' + c + '): ' + out)); });
    });
    // log in with the seeded token, then save with token redacted + a changed field → token must survive, port must change
    const ck = ((await fetch(`http://127.0.0.1:${port}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'seed-token' }) })).headers.get('set-cookie') || '').split(';')[0];
    // PUT now requires the one-use CSRF token from a matching GET /api/config
    const cr = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { Cookie: ck } });
    const csrf = (await cr.json()).csrf;
    const r = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ port: 9999, host: '127.0.0.1', token: '__REDACTED__', tls: false, hosts: [{ name: 'seedhost' }], csrf }) });
    assert.equal(r.status, 200);
    const onDisk = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    assert.equal(onDisk.port, 9999, 'edited field applied');
    assert.equal(onDisk.token, 'seed-token', 'token preserved via __REDACTED__');
  } finally {
    ch.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('login: enrolled secret with 2FA OFF does not force a code (mode wins)', async () => {
  // regression: a lingering TOTP secret must not make login ask for a code once twoFA
  // is set to "off". The secret is enrolled (hot-reloaded) but the mode is off.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-2faoff-'));
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ port: 0, host: '127.0.0.1', token: 'seed-token', tls: false, totp: 'JBSWY3DPEHPK3PXP', hosts: [] }));
  const port = await freePort();
  const ch = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PC_CONFIG_FILE: cfg, PC_PORT: String(port), PC_TLS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('server did not start: ' + out)), 8000);
      const onData = (d) => { out += d; if (out.includes('tmux-webhub on')) { clearTimeout(timer); resolve(); } };
      ch.stdout.on('data', onData);
      ch.stderr.on('data', onData);
      ch.on('exit', (c) => { clearTimeout(timer); reject(new Error('server exited early (' + c + '): ' + out)); });
    });
    // login with token ONLY (no code) → must succeed, not ask for a verify code
    const r = await fetch(`http://127.0.0.1:${port}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'seed-token' }) });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.notEqual(body.next, 'verify', 'must not ask for a 2FA code when mode is off');
    assert.equal(body.ok, true, 'login succeeds with token only');
    // the issued raw-token cookie must pass auth even though a secret is enrolled
    const ck = (r.headers.get('set-cookie') || '').split(';')[0];
    const s = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Cookie: ck } });
    assert.equal(s.status, 200, 'raw-token cookie authenticated despite enrolled secret');
  } finally {
    ch.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('WS with cross-origin Origin header → close 4403', async () => {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + `/ws?host=x&session=y&token=${token}`, {
      headers: { Origin: 'http://evil.com' },
    });
    ws.on('close', (code) => (code === 4403 ? resolve() : reject(new Error('close code ' + code))));
    ws.on('error', reject);
  });
});

test('WS with matching Origin header → passes origin check', async () => {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + `/ws?host=x&session=y&token=${token}`, {
      headers: { Origin: base },
    });
    ws.on('close', (code) => (code === 4000 ? resolve() : reject(new Error('close code ' + code))));
    ws.on('error', reject);
  });
});

test('security headers: X-Frame-Options and X-Content-Type-Options present', async () => {
  const r1 = await fetch(base + '/');
  assert.equal(r1.headers.get('x-frame-options'), 'DENY');
  assert.equal(r1.headers.get('x-content-type-options'), 'nosniff');
  const r2 = await fetch(base + '/api/totp/status');
  assert.equal(r2.headers.get('x-frame-options'), 'DENY');
  assert.equal(r2.headers.get('x-content-type-options'), 'nosniff');
});

test('POST /logout clears cookie; GET /logout rejected with 405', async () => {
  const rGet = await fetch(base + '/logout');
  assert.equal(rGet.status, 405);

  const rPost = await fetch(base + '/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
  });
  assert.equal(rPost.status, 200);
  const sc = rPost.headers.get('set-cookie') || '';
  assert.match(sc, /Max-Age=0/);

  // log back in so remaining tests still have a valid cookie
  const rLogin = await fetch(base + '/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  cookie = (rLogin.headers.get('set-cookie') || '').split(';')[0];
});

test('PUT /api/config invalid totp Base32 → 400, file untouched', async () => {
  const before = fs.readFileSync(cfgPath, 'utf8');
  const r = await fetch(base + '/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ port: 0, host: '127.0.0.1', token, tls: false, totp: 'INVALID_BASE32_12345!', hosts: [{ name: 'testhost' }] }),
  });
  assert.equal(r.status, 400);
  assert.equal(fs.readFileSync(cfgPath, 'utf8'), before);
});

// ---------- session creation (POST /api/sessions) ----------
// The cwd-resolution fix (tmux 3.8 does not expand ~ in -c) needs a real tmux to observe
// the resulting pane cwd, so those two tests skip when tmux is absent. testhost is the
// local host created by the config PUT test above; its cmd is set to a live command
// (sleep) so the pane outlives the check — the default cmd (pi) may not be installed.
const hasTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const tmuxCwd = (name) => execFileSync('tmux', ['display-message', '-p', '-t', name, '#{pane_current_path}'], { encoding: 'utf8' }).trim();
const tmuxKill = (name) => { try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {} };
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
  const tildeCsrf = await (await fetch(base + '/api/config', { headers: { Cookie: cookie } })).json().then((d) => d.csrf);
  await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ port: 0, host: '127.0.0.1', token, tls: false, hosts: [{ name: 'testhost', cmd: 'sleep 60' }], csrf: tildeCsrf }) });
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

// ---------- REST API: host management (POST/PUT/DELETE /api/hosts) ----------
// Manipulates config.json directly (no tmux needed). testhost is the local host left
// by the config PUT test above; these add/update/remove a throwaway host and restore it.
test('POST/PUT/DELETE /api/hosts: add, update, remove a host', async () => {
  const name = 'pc-resthost-' + Date.now();
  // add (no ssh → local host)
  let r = await fetch(base + '/api/hosts', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name, cmd: 'bash' }) });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  let cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.ok(cfg.hosts.some((h) => h.name === name), 'host added to config.json');

  // duplicate name → 400
  r = await fetch(base + '/api/hosts', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name }) });
  assert.equal(r.status, 400);

  // invalid ssh string → 400 (rejected before it is ever saved)
  r = await fetch(base + '/api/hosts', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: 'pc-badssh-' + Date.now(), ssh: 'user@host; rm -rf /' }) });
  assert.equal(r.status, 400);

  // ssh with a port → accepted; out-of-range ports → 400 (sshSplit would otherwise
  // fall back to treating "host:70000" as a hostname and fail later as a DNS error)
  const portHost = 'pc-port-' + Date.now();
  r = await fetch(base + '/api/hosts', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: portHost, ssh: 'user@host:2222' }) });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.hosts.find((h) => h.name === portHost).ssh, 'user@host:2222', 'port kept verbatim in config.json');
  for (const bad of ['user@host:70000', 'user@host:0', 'user@host:abc']) {
    r = await fetch(base + '/api/hosts', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: 'pc-badport-' + Math.random().toString(36).slice(2), ssh: bad }) });
    assert.equal(r.status, 400, `ssh "${bad}" rejected`);
  }
  r = await fetch(base + '/api/hosts/' + portHost, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(r.status, 200);

  // update: change the cmd
  r = await fetch(base + '/api/hosts/' + name, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ cmd: 'htop' }) });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.hosts.find((h) => h.name === name).cmd, 'htop', 'cmd updated in config.json');

  // remove
  r = await fetch(base + '/api/hosts/' + name, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.ok(!cfg.hosts.some((h) => h.name === name), 'host removed from config.json');

  // remove again → 404
  r = await fetch(base + '/api/hosts/' + name, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(r.status, 404);

  // testhost must survive the round-trip
  assert.ok(cfg.hosts.some((h) => h.name === 'testhost'), 'testhost preserved');
});

// ---------- REST API: per-session endpoints (GET / send-keys / resize / DELETE) ----------
// These need a live tmux session on testhost (its cmd is `sleep 60` from the tilde test
// above, so the pane outlives the checks). Skipped when tmux is absent.
test('REST session endpoints: get, send-keys, resize, kill', { skip: !hasTmux }, async () => {
  const name = 'pc-restsess-' + Date.now();
  let r = await fetch(base + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ host: 'testhost', name, cwd: '~' }) });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  // a plain GET forces a poll of the (just-invalidated) host so the cache is fresh
  const prime = async () => { await fetch(base + '/api/sessions', { headers: { Cookie: cookie } }); };
  const detail = async () => fetch(base + '/api/sessions/testhost/' + name, { headers: { Cookie: cookie } });
  async function getUntilFound(timeoutMs = 10000) {
    const t0 = Date.now();
    for (;;) {
      await prime();
      const rr = await detail();
      if (rr.status === 200) return rr;
      if (Date.now() - t0 > timeoutMs) throw new Error('session never appeared in cache (last status ' + rr.status + ')');
      await new Promise((res) => setTimeout(res, 200));
    }
  }
  try {
    await waitForCwd(name);

    // GET details
    r = await getUntilFound();
    const d = await r.json();
    assert.equal(d.host, 'testhost');
    assert.equal(d.name, name);

    // send-keys: a harmless key → 200
    r = await fetch(base + '/api/sessions/testhost/' + name + '/send-keys', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ keys: ['Enter'] }) });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));

    // send-keys: invalid key → 400
    r = await fetch(base + '/api/sessions/testhost/' + name + '/send-keys', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ keys: ['NotAKey'] }) });
    assert.equal(r.status, 400);

    // resize: in-range → 200
    r = await fetch(base + '/api/sessions/testhost/' + name + '/resize', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ cols: 100, rows: 30 }) });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));

    // resize: out-of-range → 400
    r = await fetch(base + '/api/sessions/testhost/' + name + '/resize', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ cols: 1, rows: 30 }) });
    assert.equal(r.status, 400);

    // kill → 200
    r = await fetch(base + '/api/sessions/testhost/' + name, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));

    // GET after kill → 404 (retry until the poll reflects the kill)
    const t0 = Date.now();
    for (;;) {
      await prime();
      r = await detail();
      if (r.status === 404) break;
      if (Date.now() - t0 > 10000) throw new Error('session still visible after kill (status ' + r.status + ')');
      await new Promise((res) => setTimeout(res, 200));
    }
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
    const actCsrf = await (await fetch(base + '/api/config', { headers: { Cookie: cookie } })).json().then((d) => d.csrf);
    await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ port: 0, host: '127.0.0.1', token, tls: false, hosts: [{ name: 'pihost', cmd: fakePi }], csrf: actCsrf }) });
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

// ---------- TOTP two-factor ----------
// A second server with twoFA:"required" and no secret yet: login must force
// enrollment; afterwards the raw token is rejected everywhere and token+code works.
test('2FA: required forces enrollment, then token+code is mandatory', async () => {
  const crypto = require('node:crypto');
  // minimal TOTP for the test (HMAC-SHA1, 6 digits, 30 s) — same params as the server
  function b32decode(s) {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    s = s.toUpperCase().replace(/[\s=]/g, '');
    let bits = 0, value = 0; const out = [];
    for (const c of s) { value = (value << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; } }
    return Buffer.from(out);
  }
  function totp(secret, step) {
    const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(step));
    const h = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest();
    const off = h[h.length - 1] & 0x0f;
    return String((((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]) % 1000000).padStart(6, '0');
  }
  const step = () => Math.floor(Date.now() / 30000);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-2fa-'));
  const cfg = path.join(dir, 'config.json');
  const tok = 'testtoken2fa-' + Date.now();
  fs.writeFileSync(cfg, JSON.stringify({ port: 0, host: '127.0.0.1', token: tok, tls: false, hosts: [], twoFA: 'required' }));
  const port = await freePort();
  const ch = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PC_CONFIG_FILE: cfg, PC_PORT: String(port), PC_TLS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let b2 = '';
  const post = (u, body, headers = {}) => fetch(b2 + u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('server did not start: ' + out)), 8000);
      const onData = (d) => { out += d; if (out.includes('tmux-webhub on')) { clearTimeout(timer); resolve(); } };
      ch.stdout.on('data', onData);
      ch.stderr.on('data', onData);
      ch.on('exit', (c) => { clearTimeout(timer); reject(new Error('server exited early (' + c + '): ' + out)); });
    });
    b2 = `http://127.0.0.1:${port}`;

    // 1. status: mode required, not enrolled
    let d = await (await fetch(b2 + '/api/totp/status')).json();
    assert.equal(d.mode, 'required');
    assert.equal(d.enrolled, false);

    // 2. token only → enrollment step, no session cookie
    let r = await post('/login', { token: tok });
    assert.equal(r.status, 200);
    d = await r.json();
    assert.equal(d.next, 'enroll');
    assert.ok(!r.headers.get('set-cookie'), 'no session cookie before enrollment');
    assert.match(d.secret, /^[A-Z2-7]{32}$/);
    assert.match(d.otpauthUrl, /^otpauth:\/\/totp\/.*secret=/);
    const secret = d.secret;

    // 3. wrong code → 401
    const real = totp(d.secret, step());
    const wrong = String((Number(real) + 1) % 1000000).padStart(6, '0');
    r = await post('/login', { token: tok, code: wrong });
    assert.equal(r.status, 401);

    // 4. right code → session cookie + secret persisted to config.json
    r = await post('/login', { token: tok, code: totp(secret, step()) });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    const sc2 = r.headers.get('set-cookie') || '';
    assert.match(sc2, /pc_token=/);
    assert.match(sc2, /HttpOnly/);
    const sessCookie = sc2.split(';')[0];
    assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).totp, secret, 'secret saved to config.json');

    // 5. session cookie works
    r = await fetch(b2 + '/api/sessions', { headers: { Cookie: sessCookie } });
    assert.equal(r.status, 200);

    // 6. raw token no longer accepted anywhere once enrolled
    r = await fetch(b2 + '/api/sessions', { headers: { Cookie: 'pc_token=' + encodeURIComponent(tok) } });
    assert.equal(r.status, 401, 'raw-token cookie rejected once enrolled');
    // Bearer is the raw token too: it MUST be gated the same way, otherwise it is a
    // 2FA bypass (a token leaked from ?token= logs or a copied config.json would grant
    // the whole API + a terminal with no code)
    r = await fetch(b2 + '/api/sessions', { headers: { Authorization: 'Bearer ' + tok } });
    assert.equal(r.status, 401, 'Bearer token rejected once 2FA is enrolled');
    r = await fetch(b2 + '/api/config', { headers: { Authorization: 'Bearer ' + tok } });
    assert.equal(r.status, 401, 'Bearer token rejected on the config route too');
    r = await fetch(b2 + '/api/debug', { headers: { Authorization: 'Bearer ' + tok } });
    assert.equal(r.status, 401, 'Bearer token rejected on /api/debug too');
    r = await post('/login', { token: tok });
    // token is valid but no code yet → server asks for the 6-digit code (advances, no session)
    assert.equal(r.status, 200, 'token-only login once enrolled');
    assert.equal((await r.clone().json()).next, 'verify', 'server asks for the 6-digit code');
    assert.ok(!r.headers.get('set-cookie'), 'no session cookie until the code is verified');
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(b2.replace('http', 'ws') + '/ws?host=x&session=y&token=' + tok);
      ws.on('close', (code) => (code === 4401 ? resolve() : reject(new Error('close code ' + code))));
      ws.on('error', reject);
    });
    // the WS upgrade reads the same authed(): a Bearer header there must be rejected too
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(b2.replace('http', 'ws') + '/ws?host=x&session=y', { headers: { Authorization: 'Bearer ' + tok } });
      ws.on('close', (code) => (code === 4401 ? resolve() : reject(new Error('close code ' + code))));
      ws.on('error', reject);
    });

    // 7. fresh login with token + code → new session cookie
    r = await post('/login', { token: tok, code: totp(secret, step()) });
    assert.equal(r.status, 200);
    const sc3 = (r.headers.get('set-cookie') || '').split(';')[0];
    r = await fetch(b2 + '/api/sessions', { headers: { Cookie: sc3 } });
    assert.equal(r.status, 200);

    // 7b. PUT /api/config accepts a standard 26-char (128-bit) Base32 secret
    const secret26 = 'JBSWY3DPEHPK3PXPJBSWY3DPEP';
    const csrf26 = await (await fetch(b2 + '/api/config', { headers: { Cookie: sc3 } })).json().then((d) => d.csrf);
    r = await fetch(b2 + '/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: sc3 },
      body: JSON.stringify({ port: 0, host: '127.0.0.1', token: tok, tls: false, totp: secret26, hosts: [], csrf: csrf26 }),
    });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).totp, secret26, '26-char Base32 secret saved');
    // restore original secret (fresh CSRF per one-use write)
    const csrfR = await (await fetch(b2 + '/api/config', { headers: { Cookie: sc3 } })).json().then((d) => d.csrf);
    await fetch(b2 + '/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: sc3 },
      body: JSON.stringify({ port: 0, host: '127.0.0.1', token: tok, tls: false, totp: secret, hosts: [], csrf: csrfR }),
    });

    // 8. status now shows enrolled
    d = await (await fetch(b2 + '/api/totp/status')).json();
    assert.equal(d.enrolled, true);

    // 9. disable with a code → secret removed, token-only login works again
    r = await post('/api/totp/disable', { code: totp(secret, step()) }, { Cookie: sc3 });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).totp, undefined, 'secret removed');
    r = await post('/login', { token: tok });
    assert.equal(r.status, 200, 'token-only login works again after disable');
    // 2FA off again → the raw token (Bearer) is usable by non-browser clients
    r = await fetch(b2 + '/api/sessions', { headers: { Authorization: 'Bearer ' + tok } });
    assert.equal(r.status, 200, 'Bearer works again once 2FA is disabled');
  } finally {
    ch.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
