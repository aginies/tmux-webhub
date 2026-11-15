# Security model — tmux-webhub

Scope: `server.js`, `public/index.html`, `public/login.html`, `pitux`,
`test/smoke.js`. Method: source review + `npm audit` (clean for the installed
`node-pty` / `ws`). The daemon can read/write every session and uses the SSH
keys of the user running it for remote hosts, so the threat model is: **keep the
token out of stranger hands, and assume a local-network attacker.**

## TLS

- Self-signed cert auto-generated on first run (10 y, SAN = `localhost` + all
  local IPv4 addresses, so it's valid for LAN access too). Drop in `mkcert` /
  internal-CA certs via `cert`/`key` to remove the browser warning.
- The `Secure` cookie flag is set **only over TLS**. Over plain `http://` (the
  `tls:false` dev mode) a `Secure` cookie would never be sent by the browser, so
  it's dropped — otherwise dev auth would silently never persist.

## Token auth

- The page, the REST API and the WebSocket all require the token. Browsers get it
  via the login form → an `HttpOnly` cookie (30 days). Non-browser clients can
  pass `?token=…` on the WS URL, or — **preferred** — an `Authorization: Bearer
  <token>` header, because query strings land in proxy/access logs and the
  `Referer` header and leak the token.
- Wrong tokens are rate-limited (5 / 15 min per source IP — the daemon's view of
  the connection, so behind a proxy or an `ssh -L` tunnel that is the
  proxy/tunnel's address, not each end user). Comparison is constant-time.
- The WS upgrade is rate-limited the same way (`/login`'s guard applies there
  too), so a wrong `?token=` can't be brute-forced over the socket with 2FA off.
- `?token=` on the WS URL is retained **only** for the pitux/mobile companion, which
  can't set an `Authorization` header. Its residual risk is the token appearing in
  proxy/access/`Referer` logs; enrolling 2FA closes it (the raw token is rejected at
  the WS once a TOTP secret is set). Use the Bearer header for any client that can
  set headers.

## Two-factor (TOTP)

- With `"twoFA": "required"` (or `"optional"`), the login page enrolls a TOTP
  secret on first login — scan the QR code with any authenticator app (or type
  the base32 secret), confirm with a 6-digit code, and the secret is saved to
  `config.json`. From then on every login needs **token + code**, and the raw
  token no longer grants access anywhere (login cookie, `?token=`, WS) — it's
  replaced by a random session cookie (30 days, in-memory, so a restart logs
  everyone out). Wrong codes share the token rate limit.
- Disable from ⚙ → *two-factor* with a 6-digit code (the phone must be in hand),
  or delete the `totp` key in `config.json` (takes effect live, no restart).
  Recovery if the phone is lost: same — delete `totp` (you have the server's
  filesystem).
- The QR is rendered by a vendored copy of `qrcode-generator` (MIT) in
  `public/vendor/` — no CDN, works offline.

## CSRF

- `PUT /api/config` can rewrite the access token, 2FA/totp (i.e. disable
  two-factor), TLS and the whole host list — a single high-privilege action. It
  is protected by a **synchronizer CSRF token**: every `GET /api/config` issues a
  fresh one-use token, stored server-side and bound to the caller's session; the
  `PUT` must echo it back. A cross-origin attacker can't read the token (it comes
  back in a same-origin JSON body, behind the `HttpOnly` auth cookie), so a
  forged write can't carry a valid value. This complements — doesn't replace —
  the `SameSite=Lax` cookie and the `application/json` Content-Type gate.

## Blast radius

- The daemon binds to `0.0.0.0` by default so other LAN machines can reach it —
  the token is the gate. Anyone with the token can read/write every session (and
  the daemon uses the SSH keys of the user running it for remote hosts), so treat
  the token like a password: keep it out of version control (`.gitignore` already
  excludes `config.json`), rotate it by editing `config.json` (⚙ in the UI) and
  restarting the server (server settings are read at startup; the host list is
  live-reloaded). Old cookies die with the restart.
- For stricter setups: set `host` to `127.0.0.1` and browse through an SSH tunnel
  instead of exposing the port:
  ```sh
  ssh -L 8787:127.0.0.1:8787 user@station
  # then open https://127.0.0.1:8787 locally
  ```
