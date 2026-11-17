# do-always chain report — 2026-11-16 17:52

- Project: /home/aginies/devel/github/aginies/tmux-webhub
- Steps: Security → Performance → Propose features

## 1. Security — error (17:52 → 17:55)

_(no result text)_

## 1. Security (retry) — completed (17:55 → 17:58)

Audit complete. `DIRS_SH` is a constant with the path passed as a positional arg (`cd "$p"`, quoted) — safe. No prototype-pollution patterns. 

Here's what I found across the whole codebase:

**The code is very well-hardened** — the `docs/SECURITY.md` claims are accurate for nearly everything. I verified: no hardcoded/committed secrets (`config.json`/`.certs/` gitignored, never in git history; example uses placeholders), no command injection (`execFile` with argv, `shellQuote` for SSH, `NAME_RE` validation, `cmd`/`dir` passed as ARGV elements, `keyToArgv` whitelist), no path traversal (static handler: decode → `path.resolve` → `startsWith(PUBLIC_DIR+sep)` → `isFile()`), no unsafe deserialization (`JSON.parse` only, no `eval`/`Function`/`vm`), and `npm audit` is clean (node-pty 1.1.0, ws 8.23.0 — both current). Transport/headers are strong (TLS 1.2+, CSP without `unsafe-inline`/`unsafe-eval`, nosniff, X-Frame-Options DENY, HSTS, `SameSite=Lax`+`HttpOnly` cookies, correct RFC-6238 TOTP, constant-time compares, one-use CSRF synchronizer, CSWSH Origin check, 1MB body cap, atomic 0600 config writes).

**But I found one real bug:** a 2FA bypass via the `Authorization: Bearer` header.

In `authed()` (`server.js:691-700`), the raw-token **cookie** path (line 696) and the WS **`?token=`** path (line 1617) are both gated on 2FA being off — but the **Bearer header** check (line 699) is not. So with 2FA enrolled, anyone who knows the token can hit any `/api/` route (and the WS, which also calls `authed()`) with `Authorization: Bearer <token>` and skip the 6-digit code entirely. That defeats the second factor and contradicts the documented model ("the raw token no longer grants access anywhere").

```plan
{"summary":"Security audit: one real bug — 2FA bypass via the Bearer header in authed(); code otherwise well-hardened","tiers":[{"id":"P0","label":"Critical — 2FA bypass","items":[{"title":"Gate the Bearer-header token check on 2FA in authed()","detail":"server.js:699 — `if (auth.startsWith('Bearer ') && validToken(auth.slice(7))) return true;` accepts the raw token regardless of 2FA, while the raw-token cookie (line 696) and WS ?token= (line 1617) are both gated on `(TWOFA === null || totpSecret() === null)`. With 2FA enrolled, `Authorization: Bearer <token>` grants access to every /api/ route and the WS with no 6-digit code. Fix: add the same guard — `if ((TWOFA === null || totpSecret() === null) && auth.startsWith('Bearer ') && validToken(auth.slice(7))) return true;`. Note the behavior change: non-browser API clients (curl/scripts) that rely on the raw Bearer token will need to POST /login (token+code) for a session cookie once 2FA is on — this matches the documented 'raw token no longer grants access anywhere' model. Add a regression test: with a TOTP secret enrolled, Bearer raw-token → 401, session cookie → 200."}]},{"id":"P2","label":"Housekeeping (optional, not shipped vulns)","items":[{"title":"Prune dev-only packages from local node_modules","detail":"node_modules has 27 top-level packages (puppeteer, chromium-bidi, etc.) but package-lock.json only lists node-pty, ws, node-addon-api. The extras are gitignored and not in package.json, so they are NOT shipped or installed by `npm install` — no security impact. A `npm ci` would clean them. No action required for the product."}]}]}
```

## 2. Performance — aborted (17:58 → 18:00)

_(no result text)_

