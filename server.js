#!/usr/bin/env node
'use strict';
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const WebSocket = require('ws');
const pty = require('node-pty');

// ---------- config (single file: server settings + hosts) ----------
const CONFIG_FILE = process.env.PC_CONFIG_FILE || path.join(__dirname, 'config.json');
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// validate a raw config's hosts array → the well-formed hosts (bad entries dropped,
// never invented). Single source of truth for host shape, shared by startup + runtime.
function parseHosts(raw) {
  const list = (raw && raw.hosts) || [];
  return list.filter((h) => h && typeof h.name === 'string' && NAME_RE.test(h.name) && (!h.ssh || typeof h.ssh === 'string') && (!h.cmd || typeof h.cmd === 'string'));
}
// read + parse the config file. fatal (startup) → exit(1) on error; non-fatal (runtime)
// → throw so the caller can keep its last-good state.
function readConfig(fatal) {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    if (!fatal) throw e;
    console.error(`tmux-webhub: cannot read config: ${CONFIG_FILE}\ncopy config.example.json to config.json and edit it (${e.message})`);
    process.exit(1);
  }
}
// Atomic config write: write a temp file then rename over the target, so a
// concurrent reader never sees a half-written file. Returns an error message
// on failure, null on success (the caller owns the HTTP response).
function writeConfigAtomic(obj) {
  const tmp = CONFIG_FILE + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    fs.renameSync(tmp, CONFIG_FILE);
    return null;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return e.message;
  }
}
const CONFIG = readConfig(true);
const HOST = process.env.PC_HOST || CONFIG.host || '0.0.0.0';
const PORT = parseInt(process.env.PC_PORT || CONFIG.port || '8787', 10);
const TOKEN = process.env.PC_TOKEN || (typeof CONFIG.token === 'string' ? CONFIG.token : '');
const TLS = process.env.PC_TLS !== undefined ? process.env.PC_TLS !== 'false' : CONFIG.tls !== false;
const CERT = path.resolve(__dirname, CONFIG.cert || '.certs/cert.pem');
const KEY = path.resolve(__dirname, CONFIG.key || '.certs/key.pem');
// default command for new sessions: config "cmd" (editable in the ⚙ UI) → PI_CMD env → pi
const PI_CMD = (typeof CONFIG.cmd === 'string' && CONFIG.cmd) || process.env.PI_CMD || 'pi';
const PUBLIC_DIR = path.join(__dirname, 'public');
// tunables (named so the two ends of a value can't drift)
const SLOW_MS = 2000;              // a host slower than this to answer is "slow"
const CMD_TIMEOUT_MS = 5000;       // default per-command timeout (list/dirs)
const BUF_4MB = 4 * 1024 * 1024;   // maxBuffer: list-sessions / runOn default
// poll period (ms): config "pollMs" (clamped so a typo can't hammer the hosts or
// freeze the UI). Restart-scoped like the other server settings.
const POLL_MS = Math.min(60000, Math.max(1000, parseInt(CONFIG.pollMs, 10) || 5000));
const ACTIVE_WINDOW_MS = 2 * POLL_MS; // a session is "active" if it produced output within this window
// bandwidth readout (header ↓/↑ + /api/sessions "net"): config "netDisplay"
// (default on). When off the socket hooks aren't attached at all — nothing is counted.
const NET_DISPLAY = CONFIG.netDisplay !== false;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // brute-force guard window
// WS terminal backpressure: a slow/throttled client (high-latency link, background tab)
// must not grow the socket write queue without bound — pause the pty above
// WS_PAUSE_BYTES, resume once the queue drains back under WS_RESUME_BYTES
// (hysteresis so we don't flap pause/resume at a single threshold)
const WS_PAUSE_BYTES = 8 * 1024 * 1024;
const WS_RESUME_BYTES = 2 * 1024 * 1024;

// key-auth only (no password prompts); ServerAlive detects a dead host so the pty exits.
// ControlMaster: reuse ONE authenticated ssh connection per host (ssh ~100 ms → ~5 ms);
// ControlPersist keeps it warm 60 s after the last command so the 4 s poller never re-auths.
// ControlPath is a short hash of the target: %C's 40-char hash plus ssh's random suffix
// can exceed the ~108-char Unix socket path limit under long TMPDIRs (no tokens → no suffix).
const CM_DIR = path.join(os.tmpdir(), 'tc-cm-' + (process.getuid ? process.getuid() : 0));
fs.mkdirSync(CM_DIR, { recursive: true });
// crash leftovers: a stale master socket makes ssh fail with "Control socket connect ..."
// instead of opening a fresh master — clear the directory at startup (single-instance app)
for (const f of fs.readdirSync(CM_DIR)) {
  if (f.startsWith('cm-')) { try { fs.unlinkSync(path.join(CM_DIR, f)); } catch {} }
}
const cmPath = (target) => path.join(CM_DIR, 'cm-' + crypto.createHash('md5').update(target).digest('hex').slice(0, 8));
const SSH_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=5',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=2',
  '-o', 'ControlMaster=auto',
  '-o', 'ControlPersist=60',
];
// ControlPath is per-host, so it is appended where the ssh target is known
const sshOptsFor = (host, base) => (host.ssh ? [...base, '-o', `ControlPath=${cmPath(host.ssh)}`] : base);
// polls fail fast (2 s) so a dead host never holds up the poller; WS attach keeps 5 s
const POLL_SSH_OPTS = SSH_OPTS.flatMap((o) => (o === 'ConnectTimeout=5' ? ['ConnectTimeout=2'] : [o]));

// ---------- hosts ----------
// config.json: { port, host, token, tls, cert, key, hosts: [ { "name": "localhost" }, { "name": "station2", "ssh": "user@host", "cmd": "pi-bolt" } ] }
// no "ssh" key → commands run locally. cmd: per-host command started in new sessions (any command, default PI_CMD)
// no "ssh" key → commands run locally. Live-editable: re-read only when the file's mtime
// changes (statSync is cheap; the read+parse used to run on every call). On parse error
// keep the LAST GOOD list (never invent a host that can receive sessions).
let lastGoodHosts = null;
let configError = null;
let cfgMtimeNs = null;
let cfgHosts = null;
let cfgStatAt = 0;
const CFG_STAT_GATE_MS = 500; // hostByName() runs on every request/WS: stat at most twice a second
function loadHosts() {
  const now = Date.now();
  // time-gate the statSync: it used to run on the event loop for EVERY request and
  // WS connection; the file can only matter after CFG_STAT_GATE_MS, so the cached
  // list is safe until then (per-request cost: zero)
  if (cfgHosts && now - cfgStatAt < CFG_STAT_GATE_MS) return cfgHosts;
  cfgStatAt = now;
  try {
    // { bigint: true }: plain Stats has no mtimeNs (it was always undefined, so the hosts
    // list was never re-read after the first load); BigInt gives exact nanoseconds
    const mtimeNs = fs.statSync(CONFIG_FILE, { bigint: true }).mtimeNs;
    if (cfgHosts && mtimeNs === cfgMtimeNs) return cfgHosts;
    const hosts = parseHosts(readConfig(false));
    lastGoodHosts = hosts;
    configError = null;
    cfgMtimeNs = mtimeNs;
    cfgHosts = hosts;
    return hosts;
  } catch (e) {
    configError = e.message;
    console.warn(`tmux-webhub: config unreadable (${e.message}) — keeping last good host list`);
    return lastGoodHosts || [];
  }
}

function hostByName(name) {
  return loadHosts().find((h) => h.name === name) || null;
}
// called after we write the config ourselves: don't wait out the stat gate
function configTouched() { cfgStatAt = 0; }

// run a command on a host (locally, or through ssh); non-interactive, so -T is fine.
// Remote: args are shell-quoted into ONE command string, because ssh joins argv with
// spaces and the remote shell would otherwise re-split them (tabs in -F format etc.).
function shellQuote(s) {
  return /^[A-Za-z0-9._~/-]*$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
// one execFile → { ok, stdout, stderr, timeout }. err.killed means the timeout fired
// (not a connection failure). Shared by runOn (local/ssh) and the local `sh -c` paths.
function execFileP(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, opts, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', timeout: !!(err && err.killed) });
    });
  });
}
function runOn(host, args, timeoutMs = CMD_TIMEOUT_MS, maxBuffer = BUF_4MB, sshOpts = SSH_OPTS) {
  const cmd = host.ssh ? ['ssh', '-T', ...sshOptsFor(host, sshOpts), host.ssh, args.map(shellQuote).join(' ')] : args;
  return execFileP(cmd[0], cmd.slice(1), { timeout: timeoutMs, maxBuffer });
}

// activity: for pi / pi-bolt panes the LAST entry of pi's session JSONL is the
// source of truth (see piActive) — a TUI spinner or redraw keeps #{window_activity}
// fresh long after the agent settled. For everything else, tmux's window_activity
// (epoch seconds of last window output) is used: a working process streams output,
// an idle one goes stale. The age is measured against the HOST's own clock (echoed
// via `date +%s`), so a skewed host clock can't make every session look active or
// idle. No pane capture, hashing, or spinner parsing.
//
// One POSIX sh script for BOTH local and ssh hosts: ssh joins argv into one remote
// command string, and a local `sh` fork per poll is negligible. It prints one
// tab-separated row per session — name, attached, cwd (pane_current_path, the LIVE
// cwd of the pane's foreground process), window_activity, pane command, and (for
// pi panes) the last line of the newest session JSONL for that pane's cwd — plus a
// __NOW__ line carrying the host clock. It exits with tmux's own status so the
// no-server / offline detection below is unchanged. (The \t below are REAL tabs.)
const LIST_SH = `now=$(date +%s)
out=$(tmux list-sessions -F '#{session_name}\t#{session_attached}\t#{pane_current_path}\t#{window_activity}\t#{pane_current_command}')
st=$?
[ "$st" -eq 0 ] || printf '%s\\n' "$out" >&2
if [ -n "$out" ]; then
  printf '%s\\n' "$out" | while IFS='\t' read -r n a c w cmd; do
    pe=''
    case "$cmd" in
      pi|pi-bolt)
        # a session-file append always coincides with window output, so a stale window
        # (no output for ACTIVE_WINDOW_MS) means neither the newest file nor its last
        # entry can have changed since the last fresh poll: emit the sentinel and let
        # Node reuse the cached entry — zero file I/O per poll while pi is idle
        if [ "$w" -gt 0 ] && [ $(( now - w )) -le ${ACTIVE_WINDOW_MS / 1000} ]; then
          d="$HOME/.pi/agent/sessions/-$(printf '%s/' "$c" | tr / -)-"
          f=$(ls -t "$d"/*.jsonl 2>/dev/null | head -n1)
          [ -n "$f" ] && pe=$(tail -n1 "$f")
        else
          pe='__CACHED__'
        fi
        ;;
    esac
    printf '%s\t%s\t%s\t%s\t%s\t%s\\n' "$n" "$a" "$c" "$w" "$cmd" "$pe"
  done
fi
echo "__NOW__$now"
exit "$st"`;

// pi panes: while the window is stale the poll script skips the session-file read
// (an append always coincides with window output, so the last entry can't have
// changed) and emits this sentinel; Node then reuses the entry cached from the last
// fresh poll. Cache key: host + session + cwd (the pane's identity).
const PI_CACHED = '__CACHED__';
const piLastCache = new Map();

// pi / pi-bolt: the last session entry says what pi is doing right now.
// A final assistant message (no toolCall) means the run settled → idle. Anything
// else — user message (model call in flight), toolResult (next model call),
// assistant with toolCall (tool running / permission or ask_user pending),
// compaction — means pi is working → active. No session file (--no-session) or an
// unparseable line (mid-append) → fall back to window_activity.
function piActive(cmd, piLast, winActive) {
  if ((cmd === 'pi' || cmd === 'pi-bolt') && piLast) {
    try {
      const e = JSON.parse(piLast);
      if (e && e.type === 'message' && e.message && e.message.role === 'assistant') {
        const content = e.message.content;
        // toolCall present → a tool is running (or permission/ask_user pending) → active;
        // no toolCall → the run settled, pi waits for input → idle
        return Array.isArray(content) && content.some((c) => c && c.type === 'toolCall');
      }
      return true;
    } catch { /* partial write → window fallback */ }
  }
  return winActive;
}

async function listHostSessions(host) {
  // config "enabled": false → hidden in the UI: no ssh/tmux work at all (the host
  // stays in the state as a stub so the UI can show it dimmed and re-enable it)
  if (host.enabled === false) return { name: host.name, enabled: false, state: 'ok', sessions: [] };
  const t0 = Date.now();
  let r;
  let remoteNow = 0;
  if (host.ssh) {
    r = await runOn(host, ['sh', '-c', LIST_SH], CMD_TIMEOUT_MS, BUF_4MB, POLL_SSH_OPTS);
    // a stale ControlMaster socket (crash, or the master died out-of-band) fails the
    // command with "Control socket connect ..." — unlink it and retry once with a fresh master
    if (!r.ok && /control socket|master process has not completed/i.test(r.stderr || '')) {
      try { fs.unlinkSync(cmPath(host.ssh)); } catch {}
      r = await runOn(host, ['sh', '-c', LIST_SH], CMD_TIMEOUT_MS, BUF_4MB, POLL_SSH_OPTS);
    }
  } else {
    r = await execFileP('sh', ['-c', LIST_SH], { timeout: CMD_TIMEOUT_MS, maxBuffer: BUF_4MB });
  }
  const elapsed = Date.now() - t0;
  if (!r.ok) {
    if (r.timeout) return { name: host.name, state: 'slow', error: 'timed out', sessions: [] };
    const msg = (r.stderr || r.stdout || '').trim();
    if (/no server running|no sessions? (exist|found)/i.test(msg)) return { name: host.name, state: elapsed > SLOW_MS ? 'slow' : 'ok', sessions: [] };
    return { name: host.name, state: 'offline', error: msg.split('\n').pop() || 'unreachable', sessions: [] };
  }
  // the __NOW__ line carries the host clock (remote for ssh, wall clock for local);
  // every other non-empty line is one session
  const rows = [];
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('__NOW__')) remoteNow = parseInt(line.slice(7), 10) || remoteNow;
    else if (line.trim()) rows.push(line);
  }
  const seenCache = new Set();
  const sessions = rows.map((line) => {
    const [name, attached, pth, act, cmd, piLast] = line.split('\t');
    const actSec = parseInt(act, 10) || 0;
    const ageMs = remoteNow ? (remoteNow - actSec) * 1000 : -1; // -1 = unknown clock → not active
    // window fallback: the window produced output within the last ACTIVE_WINDOW_MS
    const winActive = actSec > 0 && ageMs >= 0 && ageMs <= ACTIVE_WINDOW_MS;
    // resolve the __CACHED__ sentinel (stale window → the shell skipped the file read)
    // against the entry cached from the last fresh poll; drop it when the file is gone
    const cacheKey = host.name + '\t' + name + '\t' + (pth || '');
    seenCache.add(cacheKey);
    let piEntry = piLast;
    if (piEntry === PI_CACHED) piEntry = piLastCache.get(cacheKey) || '';
    else if (piEntry) piLastCache.set(cacheKey, piEntry);
    else piLastCache.delete(cacheKey);
    return {
      name,
      attached: parseInt(attached, 10) || 0,
      cwd: pth || '',
      activity: piActive(cmd, piEntry, winActive),
    };
  });
  // prune cache entries for this host's panes that no longer exist
  for (const k of piLastCache.keys())
    if (k.startsWith(host.name + '\t') && !seenCache.has(k)) piLastCache.delete(k);
  // host connection state: ok / slow (>2 s to answer, or timed out) / offline
  const state = elapsed > SLOW_MS ? 'slow' : 'ok';
  return { name: host.name, state, sessions };
}

// ---------- poller: ONE refresh per POLL_MS for ALL clients (in-flight deduped) ----------
// Previously every browser tab's poll spawned its own tmux/ssh work; now the work scales
// with the host count, and GET /api/sessions serves the cache instantly — a dead host no
// longer blocks the response (last-known state is served instead).
// The poller only runs while someone is actually looking: a live WS connection, or a
// /api/sessions GET within CLIENT_IDLE_MS. With zero clients the interval skips the
// per-host sh/ssh work entirely; the first arriving client triggers an immediate poll.
let wsClients = 0;
let lastSessionsGet = 0;
const CLIENT_IDLE_MS = 10 * 1000;
const hasClients = () => wsClients > 0 || Date.now() - lastSessionsGet < CLIENT_IDLE_MS;
let hostsCache = null;    // { hosts: [ { at, name, state, sessions, ...} ], configError } — per-host `at`
let hostsInflight = null; // shared promise while a poll is running
function refreshHosts() {
  if (hostsInflight) return hostsInflight;
  if (!hasClients()) return Promise.resolve(hostsCache ? hostsCache.hosts : null);
  const now = Date.now();
  const wanted = loadHosts();
  const cached = new Map((hostsCache ? hostsCache.hosts : []).map((h) => [h.name, h]));
  // poll only the hosts whose entry is stale (or missing); fresh entries are kept
  const stale = wanted.filter((h) => !cached.has(h.name) || now - cached.get(h.name).at > POLL_MS - 500);
  if (!stale.length) {
    if (!hostsCache) hostsCache = { hosts: [], configError }; // empty host list, first call
    // the host list may have changed by direct file edit (not via PUT, which nulls the
    // cache): a removed host would otherwise linger forever — re-merge against `wanted`
    if (hostsCache.hosts.length !== wanted.length || !wanted.every((h) => cached.has(h.name)))
      hostsCache = { hosts: wanted.map((h) => ({ ...cached.get(h.name), at: now })), configError };
    return Promise.resolve(hostsCache.hosts);
  }
  hostsInflight = Promise.all(stale.map(listHostSessions))
    .then((fresh) => {
      const freshByName = new Map(fresh.map((h) => [h.name, h]));
      const hosts = wanted.map((h) => {
        const f = freshByName.get(h.name);
        return f ? { ...f, at: now } : cached.get(h.name);
      });
      hostsCache = { hosts, configError };
      return hosts;
    })
    .finally(() => { hostsInflight = null; });
  return hostsInflight;
}
// Mark ONE host's cache entry stale (at: 0) so the next poll re-fetches just that
// host; the others keep their fresh data. No-op while there is no cache yet.
function invalidateHost(name) {
  if (hostsCache) hostsCache.hosts = hostsCache.hosts.map((h) => (h.name === name ? { ...h, at: 0 } : h));
}
setInterval(() => { refreshHosts().catch(() => {}); }, POLL_MS).unref();
refreshHosts().catch(() => {});

// ---------- tls: self-signed cert on first run (or user-provided via config) ----------
function ensureCert() {
  if (!TLS) return;
  if (fs.existsSync(CERT) && fs.existsSync(KEY)) return;
  fs.mkdirSync(path.dirname(CERT), { recursive: true });
  // SAN: localhost + every IPv4 address of this box, so the cert is valid for LAN access too
  const ips = new Set(['127.0.0.1']);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) ips.add(i.address);
  const san = ['DNS:localhost', ...[...ips].map((ip) => 'IP:' + ip)].join(',');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', KEY, '-out', CERT, '-days', '3650', '-nodes',
      '-subj', '/CN=tmux-webhub', '-addext', `subjectAltName=${san}`,
    ], { stdio: 'pipe' });
  } catch (e) {
    console.error(`tmux-webhub: could not generate the TLS cert with openssl (${e.message || e}).\n` +
      `Install openssl, or provide your own cert/key paths in config.json (or set "tls": false).`);
    process.exit(1);
  }
  console.log(`generated self-signed cert (10y, SAN: ${san}) → ${CERT}`);
}

// ---------- auth: shared token → HttpOnly cookie (WS: cookie or ?token=) ----------
const COOKIE = 'pc_token';
function validToken(t) {
  if (!TOKEN || !t) return false;
  const a = Buffer.from(String(t));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cookieOf(req) {
  const m = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='));
  return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : null;
}
function authed(req) {
  return !TOKEN || validToken(cookieOf(req)); // no token configured → open (dev mode)
}
// brute-force guard: 5 failed logins / 15 min per source IP
const loginFails = new Map();
function tooManyLogins(ip) {
  const now = Date.now();
  let e = loginFails.get(ip);
  if (!e || now > e.resetAt) e = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  loginFails.set(ip, e);
  return e.count >= 5;
}
function recordLoginFail(ip) { const e = loginFails.get(ip); if (e) e.count++; }
// keep the map bounded: drop entries whose window has expired
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginFails) if (now > v.resetAt) loginFails.delete(k);
}, LOGIN_WINDOW_MS).unref();

// ---------- http api + static files ----------
function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
// in-memory static buffer cache: non-vendor files are no-cache, so every load used to
// stat + read from disk; now the disk read happens only when size/mtime changed
const staticCache = new Map(); // full path → { size, mtimeMs, buffer, etag }

ensureCert();
let tlsOpts = {};
if (TLS) {
  try {
    tlsOpts = { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) };
  } catch (e) {
    console.error(`tmux-webhub: cannot read TLS cert/key (${e.message}).\nFix the cert/key paths in config.json (or set "tls": false).`);
    process.exit(1);
  }
}
// ---------- http routes ----------
async function handleLogin(req, res, url, send, ip) {
  if (!TOKEN) return send(400, { error: 'token auth is not configured' });
  if (tooManyLogins(ip)) return send(429, { error: 'too many failed attempts, try again in 15 min' });
  const body = await readBody(req);
  let token = null;
  try { token = (JSON.parse(body || '{}') || {}).token; } catch {}
  if (!validToken(token)) {
    recordLoginFail(ip);
    return send(401, { error: 'wrong token' });
  }
  loginFails.delete(ip);
  return send(200, { ok: true }, {
    'Set-Cookie': `${COOKIE}=${encodeURIComponent(TOKEN)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
  });
}

function handleLogout(res) {
  res.writeHead(302, { 'Set-Cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`, Location: '/' });
  res.end();
}

// Session-creation script (runs on the host). ~ is expanded on the HOST side:
// tmux 3.8 does not expand tildes in -c and silently falls back to its default
// directory. name is NAME_RE-validated; cmd/dir travel as ARGV elements
// (sh -c 'script' sh <name> <cmd> <dir>), never embedded in the script.
const NEW_SH = `d=$3
case $d in
  "~") d=$HOME ;;
  "~"/*) d=$HOME/\${d#"~/"} ;;
  /*) [ -d "$d" ] || { echo "not a directory: $d" >&2; exit 1; } ;;
esac
tmux new-session -d -s "$1" -c "$d" "$2"`;

async function handleApiSessions(req, res, url, send) {
  if (req.method === 'GET') {
    lastSessionsGet = Date.now(); // this request IS a client → allow the poll below
    await refreshHosts(); // fresh cache, or a coalesced poll if stale
    const snap = hostsCache || { hosts: [], configError: null };
    // strip the internal per-host `at` (would churn the client's change-detection snapshot)
    return send(200, { hosts: snap.hosts.map(({ at, ...h }) => h), pi: PI_CMD, pollMs: POLL_MS, configError: snap.configError, net: NET_DISPLAY ? netRate() : undefined });
  }
  if (req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return send(400, { error: 'bad request body' });
    let parsed;
    try { parsed = JSON.parse(body); } catch { return send(400, { error: 'invalid JSON' }); }
    const host = hostByName(String(parsed.host || 'localhost'));
    const name = String(parsed.name || '');
    if (!host) return send(400, { error: 'unknown host' });
    if (!NAME_RE.test(name)) return send(400, { error: 'bad session name: start with letter/digit, then letters, digits, . _ -' });
    const dir = (typeof parsed.cwd === 'string' && parsed.cwd.trim()) ? parsed.cwd.trim() : '~';
    // per-host override: hosts may run a different binary (e.g. pi-bolt) or none of the default PI_CMD
    const cmd = (typeof host.cmd === 'string' && host.cmd.trim()) ? host.cmd.trim() : PI_CMD;
    const r = await runOn(host, ['sh', '-c', NEW_SH, 'sh', name, cmd, dir], 8000);
    if (!r.ok) return send(400, { error: (r.stderr || r.stdout || 'failed').trim().split('\n').pop() });
    // invalidate ONLY this host's entry: the client's immediate GET re-polls it, while
    // the other hosts keep their <3.5 s-old data
    invalidateHost(host.name);
    return send(200, { ok: true, host: host.name, name });
  }
  return send(405, { error: 'method not allowed' });
}

// POST /api/sessions/rename {host, from, to} — tmux rename-session. Attached clients
// follow the session (not its name), so an open terminal keeps working after a rename.
async function handleApiRename(req, res, send) {
  if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
  const body = await readBody(req);
  if (!body) return send(400, { error: 'bad request body' });
  let parsed;
  try { parsed = JSON.parse(body); } catch { return send(400, { error: 'invalid JSON' }); }
  const host = hostByName(String(parsed.host || 'localhost'));
  const from = String(parsed.from || '');
  const to = String(parsed.to || '');
  if (!host) return send(400, { error: 'unknown host' });
  if (!NAME_RE.test(from)) return send(400, { error: 'bad session name' });
  if (!NAME_RE.test(to)) return send(400, { error: 'bad new name: start with letter/digit, then letters, digits, . _ -' });
  if (from === to) return send(200, { ok: true, host: host.name, from, to }); // no-op
  const r = await runOn(host, ['tmux', 'rename-session', '-t', from, to], 6000);
  if (!r.ok) return send(400, { error: (r.stderr || r.stdout || 'failed').trim().split('\n').pop() });
  invalidateHost(host.name);
  return send(200, { ok: true, host: host.name, from, to });
}

// ---------- config editing: GET redacted file, PUT validated JSON (atomic write) ----------
// Hosts/cmd edits hot-reload (loadHosts checks mtime) and invalidate the poll cache so the
// next GET /api/sessions sees them. port/token/tls/cert/key are read at startup → restart.
// The live token is never sent to the browser: GET redacts it to REDACTED, and a PUT that
// leaves it redacted restores the on-disk value (so editing other fields doesn't wipe it).
const REDACTED = '__REDACTED__';
async function handleApiConfig(req, res, send) {
  if (req.method === 'GET') {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (typeof cfg.token === 'string' && cfg.token) cfg.token = REDACTED;
      return send(200, { raw: JSON.stringify(cfg, null, 2) + '\n', path: CONFIG_FILE });
    } catch (e) {
      return send(500, { error: 'cannot read config: ' + e.message });
    }
  }
  if (req.method === 'PUT') {
    const body = await readBody(req);
    if (!body) return send(400, { error: 'bad request body' });
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { return send(400, { error: 'invalid JSON: ' + e.message }); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return send(400, { error: 'config must be a JSON object' });
    // a redacted token means "unchanged" → restore the live one so saving other
    // fields doesn't wipe it (the user can still set a new value by replacing it)
    if (parsed.token === REDACTED) {
      let cur;
      try { cur = readConfig(false).token; } catch { cur = undefined; }
      if (typeof cur === 'string' && cur) parsed.token = cur; else delete parsed.token;
    }
    const werr = writeConfigAtomic(parsed);
    if (werr) return send(500, { error: 'cannot write config: ' + werr });
    configTouched(); // don't wait out the loadHosts stat gate
    hostsCache = null; // the host LIST itself may have changed (added/removed/renamed) → full re-poll
    return send(200, { ok: true });
  }
  return send(405, { error: 'method not allowed' });
}

// POST /api/hosts/toggle {host} — flip the host's "enabled" flag in config.json
// (click the host badge in the UI). Absent flag = enabled, so enabling deletes the
// key to keep the file clean.
async function handleHostToggle(req, res, send) {
  if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
  let parsed;
  try { parsed = JSON.parse((await readBody(req)) || ''); } catch { return send(400, { error: 'invalid JSON' }); }
  const name = parsed && parsed.host;
  if (typeof name !== 'string' || !NAME_RE.test(name)) return send(400, { error: 'bad host name' });
  let cfg;
  try { cfg = readConfig(false); } catch (e) { return send(500, { error: 'cannot read config: ' + e.message }); }
  const entry = ((cfg && cfg.hosts) || []).find((h) => h && h.name === name);
  if (!entry) return send(404, { error: 'host not in config: ' + name });
  const enabled = entry.enabled === false; // the new value (toggle)
  if (enabled) delete entry.enabled; else entry.enabled = false;
  const werr = writeConfigAtomic(cfg);
  if (werr) return send(500, { error: 'cannot write config: ' + werr });
  configTouched();
  // force a re-poll of just this host on the next cycle (a disabled stub or a fresh
  // entry would otherwise look "not stale" and hide the change for up to POLL_MS)
  invalidateHost(name);
  return send(200, { ok: true, host: name, enabled });
}

// ---------- directory completion: subdirectories of a path on a host ----------
// The path is passed as an ARGV element (sh -c 'script' sh <path>), never embedded in the
// script — user text cannot inject shell. Only directories are listed (cwd must be a dir).
const DIRS_SH = `
p=$1
[ -n "$p" ] || p=$HOME
case $p in "~") p=$HOME ;; "~/"*) p=$HOME/\${p#"~/"} ;; esac
[ -d "$p" ] || { echo "ERR not a directory: $p"; exit 0; }
cd "$p" || { echo "ERR cannot cd: $p"; exit 0; }
echo "PWD $(pwd)"
# dot-dirs only when the client asks (input ends with '.'), otherwise they dominate the list
dot=$2
for x in * .*; do
  [ "$x" = "." ] || [ "$x" = ".." ] || [ -d "$x" ] || continue
  case $x in .*) [ -n "$dot" ] || continue ;; esac
  echo "$x"
done
`;
async function handleApiDirs(req, res, url, send) {
  const host = hostByName(url.searchParams.get('host') || 'localhost');
  if (!host) return send(400, { error: 'unknown host' });
  const p = url.searchParams.get('path') || '';
  if (p.length > 4096) return send(400, { error: 'path too long' });
  const r = await runOn(host, ['sh', '-c', DIRS_SH, 'sh', p, url.searchParams.get('dot') || ''], CMD_TIMEOUT_MS, 1024 * 1024);
  if (!r.ok) {
    const msg = (r.stderr || r.stdout || '').trim().split('\n').pop() || 'failed';
    return send(r.timeout ? 504 : 502, { error: msg });
  }
  const lines = r.stdout.split('\n').filter(Boolean);
  if (lines[0] && lines[0].startsWith('ERR ')) return send(404, { error: lines[0].slice(4) });
  const path = (lines[0] || '').replace(/^PWD /, '');
  return send(200, { path, dirs: lines.slice(1) });
}

// static files: unauthenticated browsers get the login page for '/', other assets 401.
// ETag (size+mtime) + Cache-Control: vendored assets are immutable, html revalidates.
function serveStatic(req, res, url) {
  if (!authed(req)) {
    if (url.pathname === '/') {
      return fs.readFile(path.join(PUBLIC_DIR, 'login.html'), (err, data) => {
        if (err) { res.writeHead(500); return res.end('login page missing'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : data);
      });
    }
    res.writeHead(401); return res.end('unauthorized');
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  try { p = decodeURIComponent(p); } catch {}
  const full = path.normalize(path.join(PUBLIC_DIR, p));
  if (!full.startsWith(PUBLIC_DIR + path.sep) && full !== PUBLIC_DIR) {
    res.writeHead(404); return res.end('not found');
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const cc = full.startsWith(PUBLIC_DIR + path.sep + 'vendor' + path.sep)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    const respond = (c) => {
      if (req.headers['if-none-match'] === c.etag) {
        res.writeHead(304, { ETag: c.etag, 'Cache-Control': cc });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', ETag: c.etag, 'Cache-Control': cc });
      res.end(req.method === 'HEAD' ? undefined : c.buffer);
    };
    const c = staticCache.get(full);
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return respond(c);
    fs.readFile(full, (err2, data) => {
      if (err2) { res.writeHead(404); return res.end('not found'); }
      staticCache.set(full, { size: st.size, mtimeMs: st.mtimeMs, buffer: data, etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"` });
      respond(staticCache.get(full));
    });
  });
}

const server = (TLS ? https : http).createServer(tlsOpts, async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, obj, extraHeaders = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...extraHeaders });
    res.end(JSON.stringify(obj));
  };
  const ip = req.socket.remoteAddress || '?';
  try {
    if (req.method === 'POST' && url.pathname === '/login') return await handleLogin(req, res, url, send, ip);
    if (req.method === 'GET' && url.pathname === '/logout') return handleLogout(res);
    if (url.pathname.startsWith('/api/')) {
      if (!authed(req)) return send(401, { error: 'unauthorized' });
      if (url.pathname === '/api/sessions') return await handleApiSessions(req, res, url, send);
      if (url.pathname === '/api/sessions/rename') return await handleApiRename(req, res, send);
      if (url.pathname === '/api/config') return await handleApiConfig(req, res, send);
      if (url.pathname === '/api/hosts/toggle') return await handleHostToggle(req, res, send);
      if (url.pathname === '/api/dirs') return await handleApiDirs(req, res, url, send);
      return send(404, { error: 'not found' });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url);
    res.writeHead(405); res.end();
  } catch (e) {
    send(500, { error: String(e.message || e) });
  }
});

// ---------- network usage: app-level bytes per socket (pre/post TLS layer) ----------
// one hook per socket (WeakSet guard: a TLS server may emit 'connection' and
// 'secureConnection' for the same socket). The WS upgrade reuses the socket, so
// terminal traffic is counted for free. Rate = last 5 s of per-second deltas
// (matches the poll cadence); totals are since server start. Disabled by
// config "netDisplay": false — then no hooks, no timer, no counting.
const netStats = { inTotal: 0, outTotal: 0, inSec: 0, outSec: 0, histIn: [], histOut: [] };
const hookedSockets = new WeakSet();
function hookSocketBytes(s) {
  if (hookedSockets.has(s)) return;
  hookedSockets.add(s);
  s.on('data', (d) => { netStats.inTotal += d.length; netStats.inSec += d.length; });
  const ow = s.write.bind(s);
  s.write = (chunk, enc, cb) => {
    if (chunk) {
      const n = typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof enc === 'string' ? enc : 'utf8') : chunk.length;
      netStats.outTotal += n; netStats.outSec += n;
    }
    return ow(chunk, enc, cb);
  };
}
if (NET_DISPLAY) {
  server.on('connection', hookSocketBytes);
  server.on('secureConnection', hookSocketBytes);
  setInterval(() => {
    netStats.histIn.push(netStats.inSec); netStats.inSec = 0;
    netStats.histOut.push(netStats.outSec); netStats.outSec = 0;
    if (netStats.histIn.length > 60) netStats.histIn.shift();
    if (netStats.histOut.length > 60) netStats.histOut.shift();
  }, 1000).unref();
}
function netRate() {
  const sum5 = (h) => h.slice(-5).reduce((a, b) => a + b, 0);
  return { inBps: sum5(netStats.histIn), outBps: sum5(netStats.histOut), inTotal: netStats.inTotal, outTotal: netStats.outTotal };
}

// ---------- websocket: browser ⇄ tmux session (local or over ssh) ----------
// terminal frames are tiny; bound per-message memory against a buggy/malicious client
// Keys the UI may inject via send-keys (phone shortcuts + special-key palette):
// whitelist — the client only names a key, the server decides the exact argv.
// Modifier prefixes are tmux's: C- ctrl, M- alt, S- shift. S-Tab is special:
// tmux 3.8's S-Tab is just a plain tab, so the real xterm Shift+Tab sequence
// (\x1b[Z) is sent with -l (literal).
const SEND_KEYS = {
  Escape: ['Escape'], Enter: ['Enter'], Space: ['Space'], Tab: ['Tab'], BSpace: ['BSpace'],
  Up: ['Up'], Down: ['Down'], Left: ['Left'], Right: ['Right'],
  Pageup: ['Pageup'], Pagedown: ['Pagedown'], Home: ['Home'], End: ['End'],
  'C-c': ['C-c'], F1: ['F1'], F2: ['F2'], F3: ['F3'], F4: ['F4'],
  'M-m': ['M-m'], 'S-Tab': ['-l', '\x1b[Z'], 'M-Up': ['M-Up'],
};
const wss = new WebSocket.Server({ server, path: '/ws', maxPayload: 4 * 1024 * 1024 });
wss.on('connection', (ws, req) => {
  wsClients++;
  refreshHosts().catch(() => {}); // a client just arrived → fresh data now
  const url = new URL(req.url, 'http://localhost');
  // cookie (same-origin browsers) or ?token= (non-browser clients)
  if (TOKEN && !authed(req) && !validToken(url.searchParams.get('token'))) {
    ws.close(4401, 'unauthorized'); return;
  }
  const host = hostByName(url.searchParams.get('host') || 'localhost');
  const name = url.searchParams.get('session') || '';
  if (!host) { ws.close(4000, 'unknown host'); return; }
  if (!NAME_RE.test(name)) { ws.close(4000, 'bad session name'); return; }

  // initial size from the client (its fitted xterm), so the pty starts at the right size
  const clamp = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 2 && n <= 1000 ? n : d; };
  const cols = clamp(url.searchParams.get('cols'), 80);
  const rows = clamp(url.searchParams.get('rows'), 24);

  // the pty is spawned asynchronously (after has-session); queue messages until it exists,
  // otherwise the client's first resize (sent on ws open) is lost. Bounded like the
  // client's input queue: a stalled attach must not accumulate messages forever.
  let term = null;
  let closed = false;
  const pending = [];
  const PENDING_MAX = 1000;
  const handleMsg = (m) => {
    if (m.type === 'input' && typeof m.data === 'string') term.write(m.data);
    else if (m.type === 'resize' && m.cols > 0 && m.rows > 0) {
      try { term.resize(Math.floor(m.cols), Math.floor(m.rows)); } catch {}
    } else if (m.type === 'send-keys' && Array.isArray(m.keys) && m.keys.length > 0 && m.keys.length <= 8 && m.keys.every((k) => typeof k === 'string' && k in SEND_KEYS)) {
      // phone shortcuts + special-key palette: inject via `tmux send-keys` ON THE
      // HOST (ssh or local), targeting the session's active pane — what the client
      // is looking at. Immune to client-side focus loss (tapping the button blurs
      // the terminal) and to xterm's bracketed-paste wrapping (paste() would hand
      // the app a literal paste, not an Esc key).
      // One invocation per key, sequential (order preserved): tmux's -l flag
      // applies to ALL following args, so mixing literal and named keys in one
      // call would corrupt the sequence. ~5 ms each with a warm ControlMaster.
      m.keys.reduce(
        (p, k) => p.then(() => runOn(host, ['tmux', 'send-keys', '-t', name, ...SEND_KEYS[k]], 3000)),
        Promise.resolve()
      ).catch(() => {});
    }
  };
  ws.on('message', (msg) => {
    let m;
    try { m = JSON.parse(msg.toString()); } catch { return; }
    if (!term) {
      if (pending.length >= PENDING_MAX) pending.shift(); // drop oldest
      pending.push(m);
    } else handleMsg(m);
  });
  ws.on('error', () => {}); // socket errors always lead to 'close'; avoid unhandled throw
  ws.on('close', () => {
    wsClients--;
    closed = true;
    if (term) { try { term.kill(); } catch {} } // detach; tmux session keeps running
  });

  runOn(host, ['tmux', 'has-session', '-t', name], 6000).then((r) => {
    if (closed) return;
    try {
      if (!r.ok) { ws.close(4001, 'no such tmux session'); return; }
      // interactive attach: -tt forces remote pty allocation (plain ssh does not allocate one
      // when spawned from node-pty), no -T obviously
      const remote = ['tmux', 'attach-session', '-t', name].map(shellQuote).join(' ');
      const args = host.ssh
        ? ['ssh', '-tt', ...sshOptsFor(host, SSH_OPTS), host.ssh, remote]
        : ['tmux', 'attach-session', '-t', name];
      term = pty.spawn(args[0], args.slice(1), {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: process.env.HOME,
        env: process.env,
      });
      // Protocol: server→client text frames = terminal output (xterm 5.5 write() takes strings,
      // NOT Blobs — binary frames would arrive as Blob and be silently dropped by the browser).
      // Backpressure: pause the pty when the client's socket buffer exceeds WS_PAUSE_BYTES
      // (the frame already read is still sent — pausing only stops FURTHER reads, so no
      // output is lost); the send callback fires when the queue flushes and resumes the pty
      // once bufferedAmount is back under WS_RESUME_BYTES.
      let ptyPaused = false;
      const maybeResumePty = () => {
        if (ptyPaused && ws.bufferedAmount < WS_RESUME_BYTES) { ptyPaused = false; term.resume(); }
      };
      term.onData((data) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!ptyPaused && ws.bufferedAmount > WS_PAUSE_BYTES) { ptyPaused = true; term.pause(); }
        ws.send(data, maybeResumePty);
      });
      term.onExit(() => { try { ws.close(1000, 'session ended'); } catch {} });
      for (const m of pending.splice(0)) handleMsg(m);
    } catch (e) {
      try { ws.close(4002, 'attach failed: ' + (e.message || e)); } catch {}
    }
  });
});

// ---------- process-level safety net ----------
process.on('unhandledRejection', (reason) => {
  console.error('tmux-webhub: unhandled rejection (continuing):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('tmux-webhub: uncaught exception, shutting down:', err);
  try { server.close(); } catch {}
  setTimeout(() => process.exit(1), 500).unref();
});

server.listen(PORT, HOST, () => {
  const proto = TLS ? 'https' : 'http';
  console.log(`tmux-webhub on ${proto}://${HOST}:${PORT}  (pi: ${PI_CMD}, config: ${CONFIG_FILE})` + (TOKEN ? '' : '  ⚠ NO token configured — open access'));
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`port ${PORT} already in use (PC_PORT to change)`);
  else console.error(e);
  process.exit(1);
});
