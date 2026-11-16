#!/usr/bin/env node
'use strict';
// tmux-webhub setup / uninstall — onboarding wizard + clean removal.
//
// Invoked as `tmux-webhub setup` or `tmux-webhub uninstall`. server.js dispatches
// here *before* its fatal config load, so both work with no config.json present.
//
// setup:     detect the install, create a config (generated token, cert/key pinned
//            to the config dir), generate + install a correct systemd *user* unit
//            pointing at this install, enable it (+ optional linger), print next
//            steps.
// uninstall: the reverse — stop/disable + remove the unit, optionally disable
//            linger, `npm uninstall -g`, and remove the config dir (with warning).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const readline = require('readline/promises');

const UNIT_NAME = 'tmux-webhub.service';
const UNIT_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');
const UNIT_PATH = path.join(UNIT_DIR, UNIT_NAME);
const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.tmux-webhub');
const STABLE_LINK = path.join(os.homedir(), '.local', 'bin', 'tmux-webhub');

// ---------- small helpers ----------
function username() {
  try { return os.userInfo().username; } catch { return process.env.USER || process.env.USERNAME || 'youruser'; }
}
// run a command; never throws. {show} echoes output, {allowFail} is implicit (we
// always return a result object; callers decide what a failure means).
function run(cmd, args, { show = false } = {}) {
  let r;
  try { r = spawnSync(cmd, args, { encoding: 'utf8' }); }
  catch (e) { return { ok: false, stdout: '', stderr: String(e.message || e) }; }
  if (r.error) return { ok: false, stdout: '', stderr: String(r.error.message || r.error) };
  const stdout = (r.stdout || '').trim(), stderr = (r.stderr || '').trim();
  if (show) { if (stdout) console.log(stdout); if (stderr) console.error(stderr); }
  return { ok: r.status === 0, status: r.status, stdout, stderr };
}
// systemd quotes an ExecStart token only when it contains whitespace/quotes.
function q(t) { return /[\s"]/.test(t) ? `"${t.replace(/"/g, '\\"')}"` : t; }
function execStartLine(exe, args) { return [exe, ...args].map(q).join(' '); }

// ---------- arg parsing ----------
function parseArgs(args) {
  const o = { dryRun: false, yes: false, force: false, noLinger: false, noSystemd: false, keepConfig: false, configDir: null, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--force' || a === '-f') o.force = true;
    else if (a === '--no-linger') o.noLinger = true;
    else if (a === '--no-systemd') o.noSystemd = true;
    else if (a === '--keep-config') o.keepConfig = true;
    else if (a === '--config-dir') o.configDir = args[++i];
    else if (a === '-h' || a === '--help') o.help = true;
    else { console.error(`tmux-webhub: unknown option: ${a}\n`); usage(); process.exit(2); }
  }
  return o;
}
function usage() {
  console.log(`tmux-webhub setup [--dry-run] [--yes] [--force] [--config-dir <dir>] [--no-linger] [--no-systemd]
    Onboard: create a config (generated token, cert paths pinned to the config dir),
    install a correct systemd *user* unit pointing at this install, enable it
    (+ optional linger), and print next steps.

tmux-webhub uninstall [--yes] [--keep-config]
    Remove the systemd unit, optionally disable linger, npm-uninstall the package,
    and remove the config dir (deletes the token, the 2FA secret and the TLS cert).

options:
  --dry-run         show what would be done, change nothing
  --yes, -y         non-interactive, accept the defaults
  --force, -f       overwrite an existing config.json / unit without asking
  --config-dir <d>  config directory (default: ~/.tmux-webhub, or $PC_CONFIG_FILE's dir)
  --no-linger       skip \`loginctl enable-linger\`
  --no-systemd      skip the unit (just create the config, print run instructions)
  --keep-config     (uninstall) keep the config directory
  -h, --help        this help`);
}

// ---------- prompts (only used when interactive: not --yes and not --dry-run) ----------
let _rl = null;
function ask(question) {
  if (!_rl) _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return _rl.question(question);
}
async function yn(question, defYes) {
  const a = (await ask(`${question} [${defYes ? 'Y/n' : 'y/N'}] `)).trim();
  if (a === '') return defYes;
  return /^y/i.test(a);
}
function closeRl() { if (_rl) { _rl.close(); _rl = null; } }

// ---------- install detection: where is this install, and what should ExecStart be? ----------
function detectInstall() {
  const argv1 = path.resolve(process.argv[1] || __filename);
  let real;
  try { real = fs.realpathSync(argv1); } catch { real = argv1; }
  const isNpmGlobal = argv1 !== real; // invoked through a (bin) symlink → npm-global install
  const pkgdir = path.dirname(real);
  // ExecStart kept as exe + args so paths with spaces quote correctly in the unit.
  const exe = isNpmGlobal ? argv1 : process.execPath;
  const args = isNpmGlobal ? [] : [real];
  return { isNpmGlobal, argv1, real, pkgdir, exe, args };
}

// ---------- config ----------
function resolveConfigLocation(opts) {
  if (opts.configDir) {
    const d = path.resolve(opts.configDir);
    return { configDir: d, configFile: path.join(d, 'config.json') };
  }
  if (process.env.PC_CONFIG_FILE) {
    const f = path.resolve(process.env.PC_CONFIG_FILE);
    return { configDir: path.dirname(f), configFile: f };
  }
  return { configDir: DEFAULT_CONFIG_DIR, configFile: path.join(DEFAULT_CONFIG_DIR, 'config.json') };
}
// A fresh config: generated token, cert/key pinned to ABSOLUTE paths under the
// config dir (so they survive `npm update` and are removed cleanly on uninstall —
// server.js otherwise resolves relative cert paths against the *package* dir).
function buildConfig(configDir, token) {
  return {
    port: 8787,
    host: '0.0.0.0',
    token,
    tls: true,
    cert: path.join(configDir, '.certs', 'cert.pem'),
    key: path.join(configDir, '.certs', 'key.pem'),
    cmd: 'pi',
    pollMs: 5000,
    netDisplay: true,
    twoFA: 'optional',
    hosts: [{ name: 'localhost' }],
  };
}

// ---------- systemd ----------
function systemdAvailable(opts) {
  if (opts.noSystemd) return false;
  if (!process.env.XDG_RUNTIME_DIR) return false;
  // The binary must exist AND the user bus must be reachable. A missing unit is
  // fine (first run) — only a missing systemctl / unbooted systemd / dead bus
  // counts as "no systemd".
  const r = run('systemctl', ['--user', 'is-system-running']);
  return !/ENOENT|command not found|not been booted with systemd|Failed to connect to bus/i.test(r.stderr);
}
function unitContent({ configDir, configFile, exe, args }) {
  const envLine = /\s/.test(configFile)
    ? `Environment="PC_CONFIG_FILE=${configFile}"`
    : `Environment=PC_CONFIG_FILE=${configFile}`;
  return `# tmux-webhub — systemd user unit
# Generated by \`tmux-webhub setup\` on ${new Date().toISOString().slice(0, 10)}.
# Re-run \`tmux-webhub setup\` to regenerate, or \`tmux-webhub uninstall\` to remove.
#
# User scope: the server attaches to *your* tmux sessions and uses *your* ssh
# keys, so it runs as your user. With linger it starts at boot and survives
# logout.

[Unit]
Description=tmux-webhub — web dashboard for tmux sessions (local + ssh hosts)
After=network.target

[Service]
WorkingDirectory=${configDir}
${envLine}
ExecStart=${execStartLine(exe, args)}
Restart=on-failure
RestartSec=2

# Deliberately NOT set:
#   PrivateTmp         — the tmux socket lives in /tmp/tmux-$UID/ on the host
#   ProtectSystem=strict — the web UI's config editor writes config.json

[Install]
WantedBy=default.target
`;
}
function checkLinger() {
  const r = run('loginctl', ['show-user', username(), '--property=Linger']);
  return /Linger=yes/.test(r.stdout || '');
}

// Find an existing tmux-webhub config to migrate from, so running `setup` on an
// already-installed machine keeps the token/hosts/2FA instead of resetting them.
// Sources, in order: the installed unit's PC_CONFIG_FILE / WorkingDirectory, then
// a config.json in the current directory (running setup from a checkout).
function findExistingConfig(targetFile) {
  const target = path.resolve(targetFile);
  const candidates = [];
  if (fs.existsSync(UNIT_PATH)) {
    const txt = fs.readFileSync(UNIT_PATH, 'utf8');
    let m = txt.match(/^Environment="?PC_CONFIG_FILE=(\S+?)"?\s*$/m);
    if (m) candidates.push(m[1]);
    m = txt.match(/^WorkingDirectory=(\S+)\s*$/m);
    if (m) candidates.push(path.join(m[1], 'config.json'));
  }
  candidates.push(path.join(process.cwd(), 'config.json'));
  for (const c of candidates) {
    const r = path.resolve(c);
    if (r === target) continue;
    if (fs.existsSync(r) && looksLikeConfig(r)) return r;
  }
  return null;
}
function looksLikeConfig(p) {
  try {
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    return !!c && (Array.isArray(c.hosts) || typeof c.token === 'string' || typeof c.port === 'number');
  } catch { return false; }
}
// What config path does an installed unit point at? (PC_CONFIG_FILE, else
// WorkingDirectory/config.json.) Used to decide whether the unit needs updating.
function unitConfigPath(unitPath) {
  try {
    const txt = fs.readFileSync(unitPath, 'utf8');
    let m = txt.match(/^Environment="?PC_CONFIG_FILE=(\S+?)"?\s*$/m);
    if (m) return path.resolve(m[1]);
    m = txt.match(/^WorkingDirectory=(\S+)\s*$/m);
    if (m) return path.resolve(path.join(m[1], 'config.json'));
  } catch {}
  return null;
}

// ---------- SETUP ----------
async function runSetup(opts) {
  const inst = detectInstall();
  const { configDir, configFile } = resolveConfigLocation(opts);
  const configExists = fs.existsSync(configFile);
  const hasSystemd = systemdAvailable(opts);
  const unitExists = fs.existsSync(UNIT_PATH);

  // Config content: create fresh, or migrate an existing one (see findExistingConfig)
  // so an already-installed machine keeps its token/hosts/2FA. cert/key are always
  // re-pinned to absolute paths under the config dir.
  let token = null, configText = null, willCreateConfig = false, migratedFrom = null;
  if (!configExists || opts.force) {
    willCreateConfig = true;
    const source = configExists ? configFile : findExistingConfig(configFile);
    let cfg = {};
    if (source) {
      try { cfg = JSON.parse(fs.readFileSync(source, 'utf8')); } catch {}
      if (source !== configFile) migratedFrom = source; // a real move (not in-place force)
    }
    cfg.cert = path.join(configDir, '.certs', 'cert.pem');
    cfg.key = path.join(configDir, '.certs', 'key.pem');
    if (!(typeof cfg.token === 'string' && cfg.token)) cfg.token = crypto.randomBytes(32).toString('hex');
    token = cfg.token;
    configText = JSON.stringify(cfg, null, 2);
  }
  // The unit must point at configFile. Keep an existing unit only if it already
  // does (and we're not forcing); otherwise (re)write it — this also covers the
  // migration case, where the config moved to a new location.
  const unitCfg = unitExists ? unitConfigPath(UNIT_PATH) : null;
  const unitMatches = unitExists && unitCfg === path.resolve(configFile);
  const willWriteUnit = hasSystemd && (!unitMatches || opts.force);

  // Optional stable link (npm-global only): a symlink that never moves, even if
  // the npm prefix changes. When chosen, the unit points at it.
  let useStableLink = false;
  let exe = inst.exe, args = inst.args;

  console.log('tmux-webhub setup');
  console.log(`  install : ${inst.isNpmGlobal ? 'npm-global (bin link)' : 'git checkout / node'}`);
  console.log(`  bin     : ${inst.argv1}`);
  console.log(`  package : ${inst.pkgdir}`);
  const configNote = configExists
    ? (opts.force ? '(exists — will overwrite)' : '(exists — will keep)')
    : (migratedFrom ? `(will migrate from ${migratedFrom})` : '(will create)');
  console.log(`  config  : ${configFile}  ${configNote}`);
  if (hasSystemd) console.log(`  unit    : ${UNIT_PATH}  ${willWriteUnit ? (unitExists ? '(exists — will update)' : '(will create)') : '(exists — will keep)'}`);
  else console.log(`  unit    : skipped (no user systemd${opts.noSystemd ? ' — --no-systemd' : ''})`);

  // Interactive decisions (skipped under --yes / --dry-run).
  if (!opts.dryRun && !opts.yes) {
    if (inst.isNpmGlobal) {
      useStableLink = await yn(`Create a stable link at ${STABLE_LINK} (survives npm prefix changes)?`, false);
    }
    if (useStableLink) { exe = STABLE_LINK; args = []; }
  }

  const unitText = hasSystemd ? unitContent({ configDir, configFile, exe, args }) : '';

  if (opts.dryRun) {
    console.log('\n[dry-run] would make these changes:');
    if (willCreateConfig) {
      console.log(`  ${migratedFrom ? `migrate ${migratedFrom} → ` : ''}write ${configFile}:\n${indent(configText)}`);
      if (migratedFrom) console.log('  (would also copy the existing .certs/ so the TLS cert is preserved)');
    }
    if (willWriteUnit) { console.log(`  write ${UNIT_PATH}:\n${indent(unitText)}`); console.log('  run: systemctl --user daemon-reload && systemctl --user enable --now tmux-webhub'); if (!opts.noLinger) console.log(`  run: loginctl enable-linger ${username()}`); }
    if (useStableLink) console.log(`  symlink ${STABLE_LINK} -> ${inst.real}`);
    console.log('\n[dry-run] nothing was changed.');
    return;
  }

  // Confirm (unless --yes).
  if (!opts.yes) {
    if (!(await yn('Proceed?', true))) { console.log('aborted — nothing changed.'); return; }
  }

  // 1) config
  if (willCreateConfig) {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configFile, configText + '\n');
    fs.chmodSync(configFile, 0o600); // holds the access token
    if (migratedFrom) {
      // Carry the TLS cert over so browser trust / known-hosts survive the move.
      const srcCerts = path.join(path.dirname(migratedFrom), '.certs');
      if (fs.existsSync(srcCerts)) fs.cpSync(srcCerts, path.join(configDir, '.certs'), { recursive: true });
      console.log(`  ✓ migrated config from ${migratedFrom} (token/hosts/2FA + cert preserved)`);
    } else {
      console.log(`  ✓ wrote ${configFile}`);
      console.log(`    token: ${token}`);
    }
  } else {
    console.log(`  · kept existing ${configFile}`);
  }

  // 2) optional stable link
  if (useStableLink) {
    fs.mkdirSync(path.dirname(STABLE_LINK), { recursive: true });
    try { fs.unlinkSync(STABLE_LINK); } catch {}
    fs.symlinkSync(inst.real, STABLE_LINK);
    console.log(`  ✓ linked ${STABLE_LINK} -> ${inst.real}`);
  }

  // 3) systemd unit + enable (enable --now is idempotent — run it whether or not
  // we just wrote the unit, so a pre-existing unit also ends up enabled+started)
  if (hasSystemd) {
    if (willWriteUnit) {
      fs.mkdirSync(UNIT_DIR, { recursive: true });
      fs.writeFileSync(UNIT_PATH, unitText);
      console.log(`  ✓ wrote ${UNIT_PATH}`);
      run('systemctl', ['--user', 'daemon-reload']);
    } else {
      console.log(`  · kept existing ${UNIT_PATH} (use --force to regenerate)`);
    }
    const en = run('systemctl', ['--user', 'enable', '--now', UNIT_NAME], { show: true });
    console.log(en.ok ? '  ✓ enabled + started tmux-webhub' : `  ⚠ enable/start failed:\n${indent(en.stderr || en.stdout)}`);
    // 4) linger
    if (!opts.noLinger) {
      const already = checkLinger();
      if (already) console.log('  · linger already enabled');
      else {
        const doLinger = opts.yes ? true : await yn('Enable linger (start at boot, keep running after logout)?', true);
        if (doLinger) {
          const r = run('loginctl', ['enable-linger', username()], { show: true });
          console.log(r.ok ? '  ✓ linger enabled' : '  ⚠ could not enable linger (run: loginctl enable-linger)');
        } else console.log('  · skipped linger (--no-linger to silence)');
      }
    }
  } else {
    console.log('  · no user systemd — run it manually:');
    console.log(indent(`    cd ${configDir}
    setsid nohup ${execStartLine(exe, args)} >> tmux-webhub.log 2>&1 &`));
  }

  // 5) next steps
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch {}
  const port = cfg.port || 8787;
  const proto = cfg.tls === false ? 'http' : 'https';
  console.log('\nnext steps:');
  console.log(`  · open  ${proto}://<this-host>:${port}   (accept the self-signed cert once)`);
  console.log(`  · token ${configFile}  (field "token")`);
  if (hasSystemd) console.log('  · logs  journalctl --user -u tmux-webhub -f');
  if (cfg.twoFA !== 'required') console.log(`  · 2FA is ${JSON.stringify(cfg.twoFA || 'off')} — set "twoFA":"required" in config (or ⚙) to enforce it`);
}

function indent(s) { return (s || '').split('\n').map((l) => '    ' + l).join('\n'); }

// ---------- UNINSTALL ----------
async function runUninstall(opts) {
  const inst = detectInstall();
  const { configDir } = resolveConfigLocation(opts);
  const unitExists = fs.existsSync(UNIT_PATH);
  const configPresent = fs.existsSync(configDir);
  const lingerOn = checkLinger();

  console.log('tmux-webhub uninstall');
  console.log(`  unit    : ${UNIT_PATH}  ${unitExists ? '(installed)' : '(not found)'}`);
  console.log(`  config  : ${configDir}  ${configPresent ? '(present)' : '(not found)'}`);
  console.log(`  package : ${inst.isNpmGlobal ? 'npm-global → will run \`npm uninstall -g tmux-webhub\`' : `git checkout → remove it yourself: rm -rf ${inst.pkgdir}`}`);
  if (lingerOn) console.log(`  linger  : enabled → will offer to disable`);

  if (!opts.dryRun && !opts.yes && !(await yn('Proceed?', true))) { console.log('aborted — nothing changed.'); return; }

  // 1) unit
  if (unitExists) {
    if (opts.dryRun) console.log(`  [dry-run] systemctl --user disable --now ${UNIT_NAME}; rm ${UNIT_PATH}; daemon-reload`);
    else {
      run('systemctl', ['--user', 'disable', '--now', UNIT_NAME], { show: true });
      try { fs.unlinkSync(UNIT_PATH); } catch {}
      run('systemctl', ['--user', 'daemon-reload']);
      console.log('  ✓ removed unit');
    }
  } else console.log('  · unit not installed, skipping');

  // 2) linger
  if (lingerOn) {
    const doLinger = opts.dryRun ? false : (opts.yes ? true : await yn('Disable linger? (other user services may rely on it)', false));
    if (opts.dryRun) console.log(`  [dry-run] loginctl disable-linger ${username()}`);
    else if (doLinger) {
      const r = run('loginctl', ['disable-linger', username()], { show: true });
      console.log(r.ok ? '  ✓ linger disabled' : '  ⚠ could not disable linger');
    } else console.log('  · keeping linger');
  }

  // 3) npm package
  if (inst.isNpmGlobal) {
    if (opts.dryRun) console.log('  [dry-run] npm uninstall -g tmux-webhub');
    else {
      const r = run('npm', ['uninstall', '-g', 'tmux-webhub'], { show: true });
      console.log(r.ok ? '  ✓ npm package removed' : '  ⚠ npm uninstall failed — remove it manually');
    }
  } else {
    console.log(`  · git checkout — remove it yourself: rm -rf ${inst.pkgdir}`);
  }

  // 4) config dir
  if (opts.keepConfig) console.log('  · keeping config dir (--keep-config)');
  else if (configPresent) {
    const doRm = opts.dryRun ? false : (opts.yes ? true : await yn(`Remove config dir ${configDir}? (deletes token + 2FA secret + TLS cert)`, false));
    if (opts.dryRun) console.log(`  [dry-run] rm -rf ${configDir}`);
    else if (doRm) { fs.rmSync(configDir, { recursive: true, force: true }); console.log('  ✓ config dir removed'); }
    else console.log('  · keeping config dir');
  } else console.log('  · config dir not found, skipping');

  console.log('\ndone. verify: systemctl --user status tmux-webhub   (should be inactive/missing)');
}

// ---------- entry ----------
async function main(sub, args) {
  const opts = parseArgs(args);
  if (opts.help) { usage(); process.exit(0); }
  try {
    if (sub === 'setup') await runSetup(opts);
    else if (sub === 'uninstall') await runUninstall(opts);
    else { usage(); process.exit(2); }
    closeRl();
    process.exit(0);
  } catch (e) {
    closeRl();
    console.error(`tmux-webhub: ${e.message || e}`);
    process.exit(1);
  }
}
module.exports = { main };
