# Configuration reference — tmux-webhub

`config.json` holds everything: server settings + the host list. The daemon
stat-gates it and re-parses only when the mtime changes, so edits are **live**
(picked up on the next poll, ~5 s); writes from the ⚙ editor are atomic and
JSON-validated, so a broken file can never be saved.

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
  "twoFA": "required",
  "hosts": [
    { "name": "localhost" },
    { "name": "station2", "ssh": "aginies@192.168.1.50" },
    { "name": "lab-gpu", "ssh": "aginies@gpu.lab", "cmd": "pi-bolt" }
  ]
}
```

## Server settings

| field | type | default | takes effect |
|---|---|---|---|
| `port` | number | `8787` | **restart** |
| `host` | bind address | `0.0.0.0` | **restart** |
| `token` | string | — | live (hot-reloaded) |
| `tls` | boolean | `true` | **restart** |
| `cert` / `key` | path | `.certs/cert.pem` / `.certs/key.pem` | **restart** |
| `cmd` | string | `pi` (or `PI_CMD`) | immediate (per-host default command) |
| `pollMs` | ms | `5000` (clamped 1000–60000) | **restart** |
| `netDisplay` | boolean | `true` | **restart** |
| `twoFA` | `"required"` \| `"optional"` | off | **restart** |
| `totp` | base32 secret | — | live (enroll/disable writes it) |

- `token` — the access token. Hot-reloaded (a runtime edit via `PUT /api/config`
  takes effect without a restart); `PC_TOKEN` env always wins and is **not**
  hot-reloaded (deployment-time setting). The live token is never sent to the
  browser: `GET /api/config` redacts it, and a PUT that leaves it redacted
  restores the on-disk value. Changing it logs out all clients.
- `twoFA` — `"required"` forces enrollment at login while no secret is set;
  `"optional"` only asks for the code once one is enrolled. Absent = 2FA off.
- `totp` — the enrolled base32 TOTP secret. Filled in automatically by the
  login-page enrollment (QR + confirm code) or by the ⚙ editor. An invalid value
  is ignored (treated as not enrolled, so you're never locked out).

## Hosts

Each host is `{ "name": …, "ssh"?: …, "cmd"?: …, "enabled"?: false }`.

- `name` — required, must match `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` (a tmux target
  name; the same rule is mirrored in the web UI and in `pitux`).
- `ssh` — if present, commands run over SSH; absent → commands run **locally**.
  An optional port may be appended (`user@host:2222`) and is passed to ssh as
  `-p 2222`.
  Remote connections use **the identity of the user running the daemon** — their
  SSH keys or an SSH agent — with **key auth only** (`BatchMode=yes`, no password
  prompts). Make sure `~/.ssh/known_hosts` has the host key (BatchMode refuses
  prompts). See [ARCHITECTURE.md](ARCHITECTURE.md#ssh-key-auth-only-connections-pooled).
- `cmd` — command started in new sessions on that host (any terminal command;
  default: the top-level `cmd`, else `PI_CMD` / `pi`), e.g. `pi-bolt`, `htop`,
  `bash`. Without it, a host where the default command is missing creates
  sessions that die instantly (the command isn't found and the shell exits).
- `enabled` — set to `false` to **hide the host** in the UI: no sessions shown,
  not polled, can't receive new sessions. The host stays dimmed so you can
  re-enable it. Toggle by clicking the host badge, or edit the flag here; the
  change is written to `config.json` and applies on the next poll (no restart).
  Absent = enabled.

## Environment variables (override the config file)

| var | meaning |
|---|---|
| `PC_PORT` | listen port |
| `PC_HOST` | bind address |
| `PC_TOKEN` | access token (empty = auth disabled, dev mode) |
| `PC_TLS` | only the literal value `false` disables TLS (anything else = https) |
| `PI_CMD` | command started in new sessions (default `pi`); a top-level config `cmd` takes precedence |
| `PC_CONFIG_FILE` | config file path (default `./config.json`) |

## Running & daemonizing

- The server reads `config.json` from the **directory you start it in** (override
  with `PC_CONFIG_FILE`) — so with a global install, run `tmux-webhub` from the
  directory where you put the config file.
- Stop: `Ctrl+C`, or `pkill -f 'node server.js'`.
- Restart with new server settings: stop, edit `config.json` (or the ⚙ editor),
  start again. Server settings are read at startup; the host list (incl. per-host
  `cmd`) is live-reloaded.
- Keep it alive without a terminal — the easy way is the wizard, which detects
  your install, creates the config (generated token, cert paths pinned to the
  config dir) and writes a correct systemd **user** unit pointing at it:
  ```sh
  tmux-webhub setup          # --dry-run previews, --yes is non-interactive
  ```
  On an existing install it **migrates** the current config (token/hosts/2FA/cert)
  instead of resetting it. Or a plain background process:
  ```sh
  setsid nohup node server.js >> tmux-webhub.log 2>&1 &
  ```
  Or a systemd **user** unit by hand (the repo ships `deploy/tmux-webhub.service`):
  ```sh
  mkdir -p ~/.config/systemd/user
  cp deploy/tmux-webhub.service ~/.config/systemd/user/
  $EDITOR ~/.config/systemd/user/tmux-webhub.service   # set WorkingDirectory
  systemctl --user daemon-reload
  systemctl --user enable --now tmux-webhub
  loginctl enable-linger $USER    # start at boot, survive logout
  journalctl --user -u tmux-webhub -f   # logs
  ```

### Uninstall

`tmux-webhub uninstall` removes the systemd user unit (stop + disable + delete),
offers to disable linger, runs `npm uninstall -g tmux-webhub` (npm installs only)
and removes the config dir `~/.tmux-webhub` (prompted — it holds the token, the
TOTP 2FA secret and the TLS cert). `--yes` is non-interactive, `--keep-config`
keeps the config dir. For a git checkout it prints the `rm -rf <checkout>` for
you to run. By hand: `systemctl --user disable --now tmux-webhub &&
rm ~/.config/systemd/user/tmux-webhub.service && systemctl --user daemon-reload`,
then `npm uninstall -g tmux-webhub` and `rm -rf ~/.tmux-webhub`.

## Creating sessions

- Web: **"+New"** → pick host, tmux name, working directory, command. The
  command started is the host's `cmd` (default `pi`). The directory field
  autocompletes: subdirectories of the current path on the chosen host (local or
  over ssh) appear as you type — click one to descend a level, type `.` to
  include dot-dirs, empty field = the host's home.
- Terminal (local): `./pitux new <name> [cwd]` — starts the configured command
  (default `pi`) in a detached tmux session and attaches. `./pitux <name>`
  attaches to an existing session, `./pitux ls` lists. `PI_CMD` overrides the
  command.

Session names must start with a letter/digit and contain only letters, digits,
`.` `_` `-` (tmux target safety).

## The ⚙ config editor

Edits `config.json` through a friendly form. `hosts` / per-host `cmd` apply
immediately; `port`, `token`, `tls`, `cert`, `key`, `pollMs`, `netDisplay`,
`twoFA` need a server restart (changing the token logs out all clients). The
write is atomic and JSON-validated — a broken file can never be saved. The same
modal has a **two-factor** panel (shows the 2FA state, disables it with a
6-digit code) and a **Log out** button (ends this browser's session — with 2FA
enrolled, the session is also deleted server-side).
