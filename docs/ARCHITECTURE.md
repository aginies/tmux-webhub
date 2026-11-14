# How it works — tmux-webhub

Scope: `server.js` (the daemon), `public/index.html` / `public/login.html`
(the client). This is the "under the hood" detail; the feature overview is in
the top-level [README.md](../README.md).

## The pieces

- One Node daemon (`server.js`, CommonJS, Node ≥ 20, deps: `node-pty`, `ws`).
- A browser client (xterm.js + a small amount of vanilla JS), served as static
  files from `public/`. Vendored libs (`xterm.js`, `qrcode-generator`) live in
  `public/vendor/` — no build step, no CDN.
- `pitux` is a thin bash helper that starts/attaches tmux sessions the daemon
  will discover.

## Attaching: browser ⇄ tmux

- Attaching from the web is exactly `tmux attach`. The daemon spawns an
  interactive attach through `node-pty`:
  - local → `tmux attach-session -t <name>`
  - remote → `ssh -tt <user@host> 'tmux attach-session -t <name>'`
- The pty is allocated with `name: xterm-256color`. Terminal output travels back
  to the browser as **UTF-8 text frames** over a WebSocket: `node-pty` decodes
  the pty bytes to strings before they reach the socket. Output with invalid
  UTF-8 (rare — e.g. a raw binary dump) is therefore mangled; the documented
  upgrade path is base64-encoding frames server-side and decoding in the client
  (a small, symmetric change in `server.js` and `public/index.html`).
- The session is never killed by closing the tab — `ws.on('close')` just kills
  the pty bridge; the tmux session keeps running.

## Listing sessions: the poller

- A single POSIX `sh` script (`LIST_SH`) runs `tmux list-sessions` once per poll
  and prints one tab-separated row per session — name, attached, cwd
  (`pane_current_path`, the live foreground cwd), `window_activity`, pane
  command — plus a trailing `__NOW__` line carrying the **host's own clock**
  (`date +%s`), so activity age is measured against the remote time, not the
  daemon's.
- **One refresh per `POLL_MS` for all clients**, in-flight deduped
  (`hostsInflight`). The work scales with the host count, not the client count.
  `GET /api/sessions` just serves the cache.
- The poller only runs while someone is looking: a live WS connection, or a
  `/api/sessions` GET within `CLIENT_IDLE_MS`. With zero clients the interval
  skips the per-host `sh`/`ssh` work entirely.
- Only **stale** hosts are re-poled; fresh entries are reused. A host that is
  unreachable is marked `offline` but its last-known sessions are still served,
  and they reappear when it comes back.
- Per-host connection state: **ok**, **slow** (>2 s to answer), or **offline**,
  decided by the command's exit status and stderr phrases (a host with tmux but
  no sessions is `ok` + empty, not `offline`).

## SSH: key auth only, connections pooled

Remote hosts are reached over `ssh` **using the identity of the user running the
daemon** — their SSH keys or an SSH agent — with **key auth only**
(`BatchMode=yes`, so there are never password/passphrase prompts). Make sure
`~/.ssh/known_hosts` has each host key (BatchMode refuses prompts). Options:

- `ControlMaster=auto` + `ControlPersist=60` — reuse **one** authenticated ssh
  connection per host (a cold connect ~100 ms drops to ~5 ms warm); the master
  stays up 60 s after the last command so the ~5 s poller never re-auths. The
  `ControlPath` is a short MD5 hash of the target to stay under the ~108-char
  Unix-socket path limit.
- `ConnectTimeout` is 2 s for the poller (a dead host never holds it up) and 5 s
  for an attach; `ServerAliveInterval/CountMax` detect a dead host so the pty
  exits.
- A stale crash-leftover master socket makes ssh fail with "Control socket
  connect …"; the daemon unlinks it and retries once.

## Backpressure & bounds

- Terminal output flow-controls the pty: when the client's socket buffer
  (`ws.bufferedAmount`) exceeds `WS_PAUSE_BYTES` (8 MB) the pty is paused; it
  resumes once the buffer drains under `WS_RESUME_BYTES` (2 MB). Hysteresis
  avoids flapping at a single threshold. The already-sent frame is never lost.
- Client input and the pre-attach message queue are both bounded (1000 items); a
  stalled client can't grow them without limit. Session names, commands, paths,
  and terminal sizes are all clamped/validated.

## Network usage readout

- When `netDisplay` is on, one byte hook is attached per socket (a `WeakSet`
  guard handles the TLS `secureConnection`/`connection` pair on the same socket;
  the WS upgrade reuses the socket, so terminal traffic is counted for free).
- Rates are a rolling 5 s average (matching the poll cadence), maintained
  incrementally; totals are since server start. When `netDisplay` is off the
  hooks and timer aren't attached at all — nothing is counted.

## pi / pi-bolt activity

For most programs the ⚡ indicator follows tmux `window_activity` (active while
it produces output, idle 10 s after the last output). For `pi`/`pi-bolt` panes
it reads the **last entry of the pane's newest pi session file**
(`~/.pi/agent/sessions/<cwd-hash>/*.jsonl`): a user message or a `toolCall`
means work is in flight; a final assistant message means pi is waiting for input.
While the window is stale the poll script skips the file read (an append always
coincides with window output) and emits a `__CACHED__` sentinel, so Node reuses
the cached entry with zero file I/O. Missing/unreadable file → window-activity
fallback.

## Config hot-reload

`config.json` is stat-gated: the daemon re-parses only when the file's mtime
(nanosecond-precision) changes, so per-request cost is ~0 and edits are live
(picked up on the next poll). Writes are atomic (temp file + rename, `0600`).
Host-list changes invalidate the poll cache; server settings (`port`, `token`,
`tls`, `cert`, `key`, `pollMs`, `netDisplay`, `twoFA`) are read at startup and
need a restart. See [CONFIG.md](CONFIG.md).
