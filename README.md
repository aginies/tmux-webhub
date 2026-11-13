# tmux-webhub

Web dashboard for **tmux** sessions on one or more hosts. Browse all sessions
grouped by host, click to attach, type, resize — the session keeps running in
tmux when you detach. New sessions run whatever `cmd` is set to (default
`pi`); existing ones attach to whatever is already running in them — pi, bash,
a build, anything.

![tmux-webhub demo](https://raw.githubusercontent.com/aginies/tmux-webhub/master/demo.gif)

## How it works

- Each session lives in its own tmux session (created with `pitux` or the
  web UI's "+Session").
- A small Node daemon (`server.js`) lists tmux sessions on each configured host
  (locally, or over SSH for remote hosts) and bridges your browser to a session
  through a WebSocket + node-pty. Attaching from the web is exactly like
  `tmux attach` — the session is never killed by closing the tab.
- Sessions are **grouped by host automatically** — no manual grouping.
- The terminal stream travels as **UTF-8 text frames**: node-pty decodes pty bytes
  to strings before they reach the WebSocket, so output containing invalid UTF-8
  (rare — e.g. raw binary dumps in the terminal) is mangled. If it ever bites, the
  upgrade path is base64-encoding frames server-side and decoding in the client
  (small, symmetric change in `server.js` and `public/index.html`).

## Install

From npm (installs the `tmux-webhub` server command and the `pitux` helper):

```sh
npm install -g tmux-webhub
```

Or from a git checkout:

```sh
git clone https://github.com/aginies/tmux-webhub && cd tmux-webhub
npm install   # builds node-pty (native module — prebuilt on common platforms)
```

## Run

From this directory (or anywhere, after `npm i -g`):

```sh
cp config.example.json config.json   # then edit: token, hosts
tmux-webhub                          # the server (npm install) — or: node server.js
```

Then open **https://<host>:8787** in a browser and enter the token from
`config.json` (the cookie keeps you logged in for 30 days; `/logout` to sign
out). On first start a self-signed TLS cert is generated in `.certs/` — the
browser shows a one-time "insecure connection" interstitial, accept it.

Prereqs: `node` (with `node-pty` built — `npm install` once in this dir),
`tmux`, `openssl`, and a command to run in new sessions (default `pi` — set
`PI_CMD` or a per-host `cmd` in config.json to anything else).

Useful env vars (override the config file):

| var | meaning |
|---|---|
| `PC_PORT` | listen port |
| `PC_HOST` | bind address |
| `PC_TOKEN` | access token (empty = auth disabled, dev mode) |
| `PC_TLS` | only the literal value `false` disables TLS (anything else = https) |
| `PI_CMD` | command started in new sessions (default `pi`); a top-level config `cmd` takes precedence |
| `PC_CONFIG_FILE` | config file path (default `./config.json`) |

### Stop / restart / daemonize

- Stop: `Ctrl+C` in the terminal running it, or `pkill -f 'node server.js'`.
- Restart with new server settings: stop, edit `config.json` (or use the ⚙
  editor), start again (server settings are read at startup; the host list —
  incl. per-host `cmd` — is live-reloaded).
- Keep it alive without a terminal:
  ```sh
  setsid nohup node server.js >> tmux-webhub.log 2>&1 &
  ```
  or a systemd unit:
  ```ini
  [Unit]
  Description=tmux-webhub
  After=network.target
  [Service]
  WorkingDirectory=/path/to/tmux-webhub
  ExecStart=/usr/bin/node server.js
  Restart=on-failure
  [Install]
  WantedBy=default.target
  ```

## Config (`config.json`)

One file for everything: server settings + the host list. Re-read on every
poll (5 s), so it is live-editable:

```json
{
  "port": 8787,
  "host": "0.0.0.0",
  "token": "<openssl rand -hex 32>",
  "tls": true,
  "cert": ".certs/cert.pem",
  "key": ".certs/key.pem",
  "cmd": "pi",
  "pollMs": 5000,
  "netDisplay": true,
  "hosts": [
    { "name": "localhost" },
    { "name": "station2", "ssh": "aginies@192.168.1.50" },
    { "name": "lab-gpu", "ssh": "aginies@gpu.lab", "cmd": "pi-bolt" }
  ]
}
```

- No `ssh` key in a host → commands run **locally**.
- `cmd` (optional, top level): the **default** command started in new sessions
  on any host that doesn't set its own `cmd` — any terminal command (default
  `PI_CMD` / `pi`). Editable in the ⚙ config editor.
- `cmd` (optional, per host): command started in new sessions on that host —
  any terminal command (default: the top-level `cmd`, else `PI_CMD` / `pi`),
  e.g. `pi-bolt`, `htop`, `bash`. Without it, a host where the default command
  is missing creates sessions that die instantly (the command isn't found and
  the pane's shell exits).
- `pollMs` (optional): poll period in ms (default `5000`, clamped to 1000–60000) —
  how often the server refreshes the host list, and the pace of the browser's
  GET poll. Needs a **server restart**.
- `netDisplay` (optional): the header bandwidth readout (default `true`).
  When `false` the server doesn't count bytes at all. Needs a **server restart**.
- With `ssh` → `tmux list-sessions` / `attach` run over SSH
  (`ssh -o BatchMode=yes ...`, i.e. **key auth only**, no password prompts).
  Make sure `~/.ssh/known_hosts` has the host key (BatchMode refuses prompts).
- A host that is unreachable shows red as `offline` in the UI; its sessions
  reappear when it comes back.
- `cert`/`key` point to your own certs if you don't want the generated
  self-signed one (e.g. `mkcert` or an internal CA → no browser warning).
- The generated cert's SAN is a **snapshot of the machine's IPs at first
  start**. If the station's IP changes, the browser will reject the cert for
  the new address — `rm -rf .certs/` and restart to regenerate it.

## Create a session

- Web: **"+Session"** → pick host, tmux name, working directory; the
  command started is the host's `cmd` (default `pi`). The directory field
  autocompletes: subdirectories of the current path on the chosen host (local
  or over ssh) appear as you type — click one to descend a level, type `.` to
  include dot-dirs, empty field = the host's home.
- Terminal (local): `./pitux new <name> [cwd]` — starts the configured
  command (default `pi`) in a detached tmux session and attaches.
  `./pitux <name>` attaches to an existing session, `./pitux ls` lists.
  `PI_CMD` overrides the command (default `pi`).

Session names must start with a letter/digit and contain only letters, digits,
`.` `_` `-` (tmux target safety).

## Activity

The ⚡ indicator says "this session is doing something right now". For most
commands it is the tmux `window_activity` timestamp: the session is active
while it produces output, and idle 10 s after the last output. For
`pi`/`pi-bolt` panes it is driven by **pi's own state** instead, so a settled
pi is never shown as active just because its TUI redrew: the poller reads the
last entry of the pane's newest pi session file
(`~/.pi/agent/sessions/<cwd-hash>/*.jsonl`) — a user message or a `toolCall`
means work is in flight; a final assistant message means pi is waiting for
input. If the session file is missing or unreadable, the window-activity
fallback applies.

## UI notes

- Chips show the **basename of the session's working directory**; on collision
  the parent dir is added, then the tmux name (`proj (#0)`). Hover for
  `host · tmux name · full path`.
- A pulsing **⚡** is shown left of the session name while it is active
  (see [Activity](#activity)); idle sessions show no icon. The host label
  carries the **connection** dot: green = ok, orange = connected but slow
  (>2 s), red = host offline. Hover a session for details, including whether
  other clients are attached.
- `☰` / `Ctrl+B` hides the session strip. `Esc` detaches (only when the
  terminal isn't focused — Esc is a normal key in the running program).
- `⚙` (top right) opens the **config editor**: edit `config.json` in a modal
  and save. `hosts` / `cmd` apply immediately; `port`, `token`, `tls`,
  `cert`, `key`, `pollMs`, `netDisplay` need a server restart (changing the
  token logs out all clients). The write is atomic and JSON-validated — a
  broken file can never be saved.
- The header shows the server's current network usage (5 s average): `↓ in · ↑ out`;
  hover for the totals since server start. Disable with `"netDisplay": false`
  (restart) — the server then doesn't count bytes at all.
- Resizing the browser resizes the tmux pane live.
- When a session is attached from both your console and the web, tmux sizes the
  pane to whichever client was active last (standard tmux behavior).
- Debug hook: the client exposes `window.__pc` in the browser console
  (`hosts`, `active`, `refresh()`, `attach()`, `detach()`).
- If the server becomes unreachable, a banner appears above the terminal and
  the last data is shown (dimmed truth: it's stale). The same banner reports
  a broken `config.json` (the server then keeps the last good host list).

## Security

- **TLS**: self-signed cert auto-generated on first run (10 y, SAN =
  `localhost` + all local IPv4 addresses, so it's valid for LAN access too).
  Drop in `mkcert`/internal-CA certs via `cert`/`key` to remove the browser
  warning.
- **Token auth**: the page, the REST API and the WebSocket all require the
  token. Browsers get it via the login form → `HttpOnly; Secure; SameSite=Lax`
  cookie (30 days). Non-browser clients can pass `?token=…` on the WS URL —
  note that query strings can end up in proxy/access logs, so prefer the
  cookie for anything long-lived. Wrong tokens are rate-limited (5 / 15 min per
  source IP — the daemon's view of the connection, so behind a proxy or an
  `ssh -L` tunnel that is the proxy/tunnel's address, not each end user).
  Comparison is constant-time.
- The daemon binds to `0.0.0.0` by default so other LAN machines can reach it
  — the token is the gate. Anyone with the token can read/write every session
  (and the daemon uses the SSH keys of the user running it for remote hosts),
  so treat the token like a password: keep it out of version control
  (`.gitignore` already excludes `config.json`), rotate it by editing
  `config.json` (⚙ in the UI) and restarting
  the server (server settings are read at startup; the host list is
  live-reloaded). Old cookies die with the restart.
- For stricter setups: set `host` to `127.0.0.1` and browse through an SSH
  tunnel instead of exposing the port:
  ```sh
  ssh -L 8787:127.0.0.1:8787 user@station
  # then open https://127.0.0.1:8787 locally
  ```
