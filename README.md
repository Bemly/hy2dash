# hy2dash

**An ultra-light Hysteria2 airport-lite panel** — a single static Go binary,
pure standard library, zero runtime dependencies, ~**12MB** resident.

> Open registration + login; each user gets a private subscription link and an
> isolated hysteria identity. The admin sees live connections, history, and
> per-user traffic. Data comes from Hysteria2's built-in Traffic Stats API —
> **no proxy kernel swap, zero client changes**.

[English](README.md) · [中文](README.zh.md)

---

## Roles

| Side | Who | Sees |
|---|---|---|
| **Admin** (exactly one account) | panel owner | live / history / overview across all hysteria upstreams, user list with traffic, enable / delete / rotate-link |
| **User** (open registration) | everyone else | own traffic, own subscription link (copy + one-click Clash import), change own password |

Sessions are HMAC-signed and role-tagged (`v1|role|user|exp`); old-format cookies
are rejected, i.e. everyone re-logs-in once after upgrading to this version.

## How users map to hysteria

Hysteria2 runs `auth.type: userpass`, so every connection carries `username:password`
and the panel can tell users apart. Usernames come from a **pre-provisioned slot
pool** (`u01…u08` by default): registration claims the first free slot, whose
static password lives in both hysteria configs **and** in hy2dash's config
(needed to print node lines). Consequences:

- No hysteria restart is ever needed when users register.
- When slots run out, the admin adds more (same password in both hysteria
  YAMLs + `slots` in hy2dash config, restart hysterias).
- Deleting/disabling a user kills their panel session and subscription link
  immediately. To fully revoke their *connection* right, rotate that slot's
  password in all three places (both hysteria configs + hy2dash config).

## Subscriptions (replaces the Cloudflare Worker)

`GET {base}/sub/<token>` — public, token-gated, no login needed. Returns a Clash
YAML containing **only that user's nodes** (one per server in `servers`), plus a
live `Subscription-Userinfo` header summed across all `hysteria_nodes`:

```
upload=<bytes>; download=<bytes>; total=<quota_gb>GiB
```

The YAML body comes from `sub-template.yaml` (`__NODES__` / `__NODE_NAMES__`
placeholders). A server-side file at `<config-dir>/sub-template.yaml`, if present,
overrides the embedded default — that's where provider-specific rules live
(never commit real passwords).

The old shared link (`/iku-iku-o-hohho`, previously served by the Worker)
returns `410 Gone`: after the userpass cutover the old single password is dead,
every client must move to a personal link.

## Features

| Capability | Details |
|---|---|
| **Live connection table** (admin) | server, target (domain/IP:port), user, state, up/down bytes, elapsed, last active; 1s refresh, searchable, pausable |
| **History** (admin) | persisted per day (with server tag), date + keyword search, paginated |
| **Overview** (admin) | today's traffic, 7/14/30-day charts (hand-drawn Canvas), Top 20 targets |
| **Users** (admin) | list with live totals, enable/disable, delete, rotate subscription token |
| **Access control** | single admin (random creds on first start); users PBKDF2-SHA256 (150k rounds + salt); 12 attempts / 5 min / IP on login+register |
| **Deploy-friendly** | embedded frontend (`go:embed`), localhost-only by default, sub-path mount (`base_path`), multiple listen addresses |

## Architecture

```
Hysteria2 trafficStats API × N  (/dump/streams, /traffic, /online)
        │  1s polling + diffing (live, merged with server tag)
        │  30s cached totals (user list, subscription headers)
        ▼
   hy2dash  (Go / pure stdlib / CGO_ENABLED=0 / single static binary)
     ├─ Collector: established→closed diffing, ring buffer (400) + per-day JSONL
     ├─ Users: users.json (0600) — PBKDF2 creds, slot binding, sub token
     └─ HTTP: login / register / role-based console / JSON API / /sub/<token>
        ▼
   Browser / Clash clients
```

**Why no SQLite**: skips CGO and driver dependencies in favor of per-day JSONL +
fixed-capacity ring + a tiny JSON user store; fast enough at personal scale.

## Quick start

### 1. Hysteria2: userpass auth + stats API

```yaml
# /etc/hysteria/config.yaml (same user/pass map on every server)
auth:
  type: userpass
  userpass:
    u01: "<slot-password-1>"
trafficStats:
  listen: 127.0.0.1:9999
  secret: "<stats-secret>"
```

### 2. Build & install

```bash
git clone https://github.com/Bemly/hy2dash && cd hy2dash
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /usr/local/bin/hy2dash .

sudo mkdir -p /etc/hy2dash /var/lib/hy2dash
sudo cp hy2dash.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now hy2dash
```

First start prints random admin credentials to the terminal / journal:

```bash
journalctl -u hy2dash --no-pager | grep -A3 'first start'
```

### 3. Configure (`/etc/hy2dash/config.json`, 0600)

```json
{
  "listen": "127.0.0.1:8787",
  "public_listen": "0.0.0.0:80",
  "base_path": "/dash",
  "quota_gb": 1200,
  "hysteria_nodes": [
    {"name": "us", "stats_url": "http://127.0.0.1:9999", "stats_secret": "***"},
    {"name": "jp", "stats_url": "http://127.0.0.1:19999", "stats_secret": "***"}
  ],
  "slots": [{"user": "u01", "pass": "***"}],
  "servers": [
    {"name": "node-us", "host": "1.2.3.4", "port": 36598, "ports": "36599-55555",
     "sni": "example.com", "cert_fp": "***"}
  ]
}
```

(`hysteria_stats_url/secret` single fields still migrate automatically.)

## API

All paths carry the `base_path` prefix (examples use `/dash`).

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/dash/api/register` | public | register (claims a free slot, auto-login) |
| POST | `/dash/api/login` | public | admin or user login |
| POST | `/dash/api/logout` | login | logout |
| GET | `/dash/api/me` | login | `{user, role}` (+ `hy_user`, `sub_token` for users) |
| POST | `/dash/api/password` | login | change own password |
| GET | `/dash/api/users` | admin | users + live totals + slot usage |
| POST | `/dash/api/user/enable` | admin | enable/disable |
| POST | `/dash/api/user/delete` | admin | delete (frees the slot) |
| POST | `/dash/api/user/rotate` | admin | new subscription token |
| GET | `/dash/api/my/summary` | login | own totals + quota |
| GET | `/dash/api/live` | admin | live + online + per-user totals |
| GET | `/dash/api/recent?limit=` | admin | recently closed |
| GET | `/dash/api/history?date=&q=&limit=&offset=` | admin | history search |
| GET | `/dash/api/summary?days=` | admin | aggregates + Top 20 |
| GET | `/dash/api/health` | public | RSS / heap / goroutines |
| GET | `/dash/sub/<token>` | token | personal Clash YAML + userinfo |

## Memory

Steady-state RSS **12MB** class (heap <1MB). `CGO_ENABLED=0` + `-trimpath
-ldflags="-s -w"` (~7.5MB binary), `SetGCPercent(25)` + `SetMemoryLimit(24MiB)`,
`FreeOSMemory()` every 90s, systemd `MemoryHigh=64M`/`MemoryMax=96M` cap.
No SQLite / ORM / web framework / Node toolchain; frontend is dependency-free
vanilla JS+CSS (the previous RhineLabUI build is archived on branch
`archive/rhinelab-ui`).

## Notes

- Connection details come from Hysteria2's TCP stream list; **UDP sessions are
  not included**.
- The admin panel shows the equivalent of a full access log — bind to
  localhost or restrict sources, never deploy publicly.
- History defaults to 90 days retention, ~200 bytes per connection.

## License

MIT
