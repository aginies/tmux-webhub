# tmux-webhub REST API

tmux-webhub exposes a REST API for programmatic control of tmux sessions and hosts. All endpoints are authenticated using the same token as the web UI.

## Authentication

Pass the token via the `Authorization: Bearer <token>` header:

```bash
curl -H "Authorization: Bearer your-token" https://localhost:8787/api/sessions
```

The token is configured in `config.json` (`token` field) or via the `PC_TOKEN` environment variable.

## Base URL

```
https://localhost:8787/api
```

(Use `http://` if TLS is disabled in config.)

## Session Management

### List all sessions

```http
GET /api/sessions
```

Returns sessions for all hosts, including state (ok/slow/offline) and activity.

### Create a session

```http
POST /api/sessions
Content-Type: application/json

{
  "host": "myhost",
  "name": "my-session",
  "cwd": "~",
  "cmd": "bash"
}
```

- `host` (required): Host name from config
- `name` (required): Session name (alphanumeric, `.`, `_`, `-`, must start with letter/digit)
- `cwd` (optional): Working directory (default: `~`)
- `cmd` (optional): Command to run (default: per-host config or `pi`)

Response: `{"ok": true, "host": "myhost", "name": "my-session"}`

### Get session details

```http
GET /api/sessions/:host/:name
```

Response: `{"host": "myhost", "name": "my-session", "attached": 0, "cwd": "/home/user", "activity": false}`

### Kill a session

```http
DELETE /api/sessions/:host/:name
```

Response: `{"ok": true, "host": "myhost", "name": "my-session"}`

### Rename a session

```http
POST /api/sessions/rename
Content-Type: application/json

{
  "host": "myhost",
  "from": "old-name",
  "to": "new-name"
}
```

Response: `{"ok": true, "host": "myhost", "from": "old-name", "to": "new-name"}`

### Send keys to a session

```http
POST /api/sessions/:host/:name/send-keys
Content-Type: application/json

{
  "keys": ["Enter"]
}
```

Send up to 8 keys in sequence. Key names follow tmux's syntax:
- Named keys: `Enter`, `Escape`, `Tab`, `Space`, `Up`, `Down`, `Left`, `Right`, `Pageup`, `Pagedown`, `Home`, `End`, `Delete`, `Insert`, `F1`-`F10`
- Characters: `a`-`z`, `0`-`9`, `;`, `,`, `.`, `/`
- Modified keys: `C-a` (Ctrl+A), `M-a` (Alt+A), `C-M-a` (Ctrl+Alt+A)
- Shift: `S-A` (Shift+A → `A`), `S-1` (Shift+1 → `!`)

Examples:
```json
{"keys": ["Enter"]}
{"keys": ["ls", "-la", "Enter"]}
{"keys": ["C-c"]}
{"keys": ["Escape"]}
```

Response: `{"ok": true, "host": "myhost", "name": "my-session", "keys": ["Enter"]}`

### Resize terminal

```http
POST /api/sessions/:host/:name/resize
Content-Type: application/json

{
  "cols": 80,
  "rows": 24
}
```

- `cols`: 2-1000
- `rows`: 2-500

Response: `{"ok": true, "host": "myhost", "name": "my-session", "cols": 80, "rows": 24}`

## Host Management

### List all hosts

Included in `GET /api/sessions` response.

### Add a host

```http
POST /api/hosts
Content-Type: application/json

{
  "name": "newhost",
  "ssh": "user@host",
  "cmd": "pi-bolt"
}
```

- `name` (required): Host name
- `ssh` (optional): SSH target (omit for local host). An optional port may be
  appended — `user@host:2222` — and is passed to ssh as `-p 2222`.
- `cmd` (optional): Default command for new sessions

Response: `{"ok": true, "host": "newhost"}`

### Remove a host

```http
DELETE /api/hosts/:name
```

Response: `{"ok": true, "host": "newhost"}`

### Update a host

```http
PUT /api/hosts/:name
Content-Type: application/json

{
  "ssh": "user@newhost",
  "cmd": "bash"
}
```

Only update fields you specify.

Response: `{"ok": true, "host": "newhost"}`

### Toggle host enabled/disabled

```http
POST /api/hosts/toggle
Content-Type: application/json

{
  "host": "myhost"
}
```

Response: `{"ok": true, "host": "myhost", "enabled": true}`

## Configuration

### Get config

```http
GET /api/config
```

Returns the current config with token redacted.

### Update config

```http
PUT /api/config
Content-Type: application/json

{
  "port": 8787,
  "token": "new-token",
  "hosts": [...]
}
```

Requires CSRF token from `GET /api/config` response.

## Directory Completion

```http
GET /api/dirs?host=myhost&path=/home/user
```

Returns subdirectories of the given path for autocomplete.

## Version

```http
GET /api/version
```

Response: `{"version": "0.2.2"}`

## Error Responses

All endpoints return JSON error objects on failure:

```json
{"error": "unknown host"}
{"error": "bad session name: start with letter/digit, then letters, digits, . _ -"}
{"error": "failed to send key Enter: no such session"}
```

HTTP status codes:
- `200`: Success
- `400`: Bad request (validation error)
- `401`: Unauthorized (wrong/missing token)
- `404`: Not found (host/session doesn't exist)
- `405`: Method not allowed
- `500`: Server error
- `502`: Bad gateway (tmux/ssh command failed)
- `504`: Gateway timeout
