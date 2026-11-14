# tmux-webhub

Web dashboard for **tmux** sessions on one or more hosts. Browse every session
grouped by host, click to attach, type, resize — the session keeps running in
tmux when you detach. New sessions run whatever `cmd` is set to (default `pi`);
existing ones attach to whatever is already running in them — pi, bash, a build,
anything.

![tmux-webhub demo](https://raw.githubusercontent.com/aginies/tmux-webhub/master/demo.gif)

- **Attach any session** — click a session in the list and you're in. Type,
  resize, scroll the scrollback — it's a full terminal. Close the tab and the
  session keeps running in tmux.
- **One host, many hosts** — sessions are grouped by host automatically. Local
  hosts, or remote ones reached over SSH (e.g. `aginies@192.168.1.50`), all in
  one view.
- **pi / pi-bolt activity** — the ⚡ says "doing something right now". For most
  programs it follows tmux output; for pi panes it reads pi's own state, so a
  settled pi is never shown as active just because its TUI redrew.
- **Network readout** — the header shows live bandwidth usage (5 s average), or
  is off entirely.
- **Two-factor** — optional TOTP (scan a QR at login); then every login needs
  token + code.

## Install

### 1. Install the server

```sh
npm install -g tmux-webhub
```

Or from a git checkout:

```sh
git clone https://github.com/aginies/tmux-webhub && cd tmux-webhub
npm install   # builds node-pty (a native module — prebuilt on common platforms)
```

This installs the `tmux-webhub` server command and the `pitux` helper.

### 2. Create a config file

The server reads `config.json` from the **directory you start it in** (override
with the `PC_CONFIG_FILE` env var). So with a global install, run it from the
directory where you put the config:

```sh
mkdir -p ~/.tmux-webhub && cd ~/.tmux-webhub
cp /usr/local/share/tmux-webhub/config.example.json ./config.json
# then edit: set a token, add your hosts
```

### 3. Configure

At minimum, set a **token** (the access password) and list your **hosts**.
Every field is documented in [docs/CONFIG.md](docs/CONFIG.md); a quick example:

```json
{
  "port": 8787,
  "token": "paste-an-openssl-rand-hex-32-here",
  "tls": true,
  "hosts": [
    { "name": "localhost" },
    { "name": "station2", "ssh": "aginies@192.168.1.50" }
  ]
}
```

- A host with no `ssh` runs commands **locally**. A host with `ssh` reaches
  **remote** machines over SSH, using the daemon user's SSH identity (their keys
  or agent), key auth only — so make sure `~/.ssh/known_hosts` has each host
  key.
- `cmd` is the command started in new sessions (default `pi`); set `PI_CMD` or a
  per-host `cmd` to anything else (`pi-bolt`, `htop`, `bash`).

### 4. Run it

```sh
tmux-webhub        # or: node server.js   (from the config directory)
```

On first start a self-signed TLS cert is generated in `.certs/`; the browser
shows a one-time "insecure connection" interstitial — accept it.

Then open **https://<host>:8787** in a browser and enter the token from
`config.json`. The cookie keeps you logged in for 30 days; ⚙ → *Log out* to sign
out (with 2FA enrolled, that also deletes the session server-side).

**Prereqs:** `node` (with `node-pty` built), `tmux`, `openssl`.

## Create a session

- **Web:** **"+New"** → pick host, tmux name, working directory (it
  autocompletes: click a subdirectory to descend, `.` for dot-dirs, empty = the
  host's home). The command started is the host's `cmd` (default `pi`).
- **Terminal (local):** `pitux new <name> [cwd]` starts a detached session and
  attaches, `pitux <name>` attaches to an existing one, `pitux ls` lists.
  Session names start with a letter/digit and contain only letters, digits,
  `.` `_` `-`.

## Stop / restart / daemonize

- **Stop:** `Ctrl+C`, or `pkill -f 'node server.js'`.
- **Restart** with new server settings: stop, edit `config.json` (or the ⚙
  editor), start again.
- **Keep it alive** without a terminal:
  ```sh
  setsid nohup node server.js >> tmux-webhub.log 2>&1 &
  ```
  or with a systemd **user** unit (the repo ships `deploy/tmux-webhub.service`):
  ```sh
  mkdir -p ~/.config/systemd/user
  cp deploy/tmux-webhub.service ~/.config/systemd/user/
  $EDITOR ~/.config/systemd/user/tmux-webhub.service   # set WorkingDirectory
  systemctl --user daemon-reload
  systemctl --user enable --now tmux-webhub
  loginctl enable-linger $USER    # start at boot, survive logout
  journalctl --user -u tmux-webhub -f   # logs
  ```

## Config editor

The ⚙ button opens a modal to edit `config.json` in the browser. The host list
and per-host `cmd` apply immediately; server settings (`port`, `token`, `tls`,
`cert`, `key`, `pollMs`, `netDisplay`, `twoFA`) need a restart. The write is
atomic and JSON-validated, so a broken file can never be saved. The same modal
has a **two-factor** panel and a **Log out** button.

## Environment variables

Override the config file for deployment-time settings:

| var | meaning |
|---|---|
| `PC_PORT` | listen port |
| `PC_HOST` | bind address |
| `PC_TOKEN` | access token (empty = auth disabled, dev mode) |
| `PC_TLS` | only the literal value `false` disables TLS (anything else = https) |
| `PI_CMD` | command started in new sessions (default `pi`) |
| `PC_CONFIG_FILE` | config file path (default `./config.json`) |

## Technical detail

The overview above is enough to run it. For how it works under the hood, the
full config reference, and the security model, see the docs:

- **[docs/CONFIG.md](docs/CONFIG.md)** — every config field, env var, the
  `pitux` helper, and daemonizing.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how attaching, the
  session poller, SSH connection pooling, backpressure, the network readout, and
  pi activity work.
- **[docs/SECURITY.md](docs/SECURITY.md)** — the full security model (TLS, token
  auth, TOTP two-factor, CSRF, rate limiting, session cookies).
