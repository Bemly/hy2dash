# hy2dash

**An ultra-light Hysteria2 connection monitoring dashboard** — a single static
Go binary, pure standard library, zero runtime dependencies, ~**12MB** resident.

> See in real time (and historically) which addresses clients accessed via
> Hysteria2, with per-connection up/down traffic and durations.
> Data comes from Hysteria2's built-in Traffic Stats API — **no proxy kernel
> swap, zero client changes**.

[English](README.md) · [中文](README.zh.md)

---

## Features

| Capability | Details |
|---|---|
| **Live connection table** | Target address (domain/IP:port), user, state, up/down bytes, elapsed time, last active; 1s refresh, searchable, pausable |
| **History** | Persisted per day, searchable by date + keyword, paginated |
| **Overview** | Today's traffic, 7/14/30-day charts (hand-drawn Canvas, no chart lib), Top 20 targets |
| **Access control** | Single admin; random username+password generated on first start and printed to the terminal; PBKDF2-SHA256 (150k rounds + random salt); HMAC-signed stateless sessions |
| **Deploy-friendly** | Embedded frontend (`go:embed`), localhost-only by default, mountable under a sub-path (`base_path`), multiple listen addresses |
| **Forced HTTPS** | `X-Forwarded-Proto`-based 301 redirect, compatible with Cloudflare Flexible (HTTP origin pull) without redirect loops |

## Architecture

```
Hysteria2 trafficStats API  (/dump/streams, /traffic, /online)
        │  1s polling + diffing
        ▼
   hy2dash  (Go / pure stdlib / CGO_ENABLED=0 / single static binary)
     ├─ Collector: established→closed diffing, in-memory ring buffer (400) + per-day JSONL persistence
     └─ HTTP: go:embed UI + JSON API, multiple listen addresses + base_path prefix
        ▼
   Browser
```

**Why no SQLite**: skips CGO and driver dependencies (and the binary/memory
they cost) in favor of "per-day JSONL + fixed-capacity in-memory ring";
history queries stream-scan the day's file, fast enough at personal scale.

**Why Go**: a Python interpreter alone is >10MB, Node >30MB; Go gives a single
binary with no runtime, and HTTP/JSON/PBKDF2 in the stdlib — zero deploy deps.

## Quick start

### 1. Expose the Hysteria2 stats API

```yaml
# append to /etc/hysteria/config.yaml
trafficStats:
  listen: 127.0.0.1:9999
  secret: "replace-with-your-own-random-string"
```

Verify after restarting hysteria2:

```bash
curl -H "Authorization: your-secret" http://127.0.0.1:9999/dump/streams
```

### 2. Build & install

```bash
git clone https://github.com/Bemly/hy2dash && cd hy2dash
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /usr/local/bin/hy2dash .

sudo mkdir -p /etc/hy2dash /var/lib/hy2dash
sudo cp hy2dash.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now hy2dash
```

The first start generates random admin credentials and prints them to the
terminal / journal:

```bash
journalctl -u hy2dash --no-pager | grep -A3 'first start'
```

### 3. Access

Listens only on `127.0.0.1:8787` by default. Pick one of three ways to expose it:

| Way | How |
|---|---|
| SSH tunnel (zero exposure) | `ssh -N -L 8787:127.0.0.1:8787 you@server` → `http://127.0.0.1:8787/dash/` |
| Cloudflare Tunnel | Outbound-only connection, no inbound ports (recommended) |
| Reverse proxy / CF origin pull | Set `public_listen` and firewall-restrict it to origin-pull IP ranges |

## Config

`/etc/hy2dash/config.json` (auto-generated on first start, 0600)

```json
{
  "listen": "127.0.0.1:8787",
  "public_listen": "",
  "public_tls_listen": "",
  "tls_cert": "", "tls_key": "",
  "base_path": "/dash",
  "poll_ms": 1000,
  "retention_days": 90,
  "data_dir": "/var/lib/hy2dash/data",
  "hysteria_stats_url": "http://127.0.0.1:9999",
  "hysteria_stats_secret": "***",
  "admin_user": "admin_xxxxxx",
  "pass_salt": "***", "pass_hash": "***", "pass_iter": 150000,
  "session_key": "***"
}
```

## API

All paths carry the `base_path` prefix (examples below use `/dash`).

| Method | Path | Notes |
|---|---|---|
| POST | `/dash/api/login` | Login (12 attempts / 5 min per IP) |
| POST | `/dash/api/logout` | Logout |
| POST | `/dash/api/password` | Change password (needs old password, re-hashes with fresh salt) |
| GET | `/dash/api/live` | Live connections + online users + per-user totals |
| GET | `/dash/api/recent?limit=` | Recently closed connections |
| GET | `/dash/api/history?date=&q=&limit=&offset=` | History search |
| GET | `/dash/api/summary?days=` | Per-day aggregates + Top 20 targets |
| GET | `/dash/api/health` | Real RSS / heap / goroutine count |

## Memory

Steady-state RSS **12.0 – 13.1MB** (heap only 0.4–1.0MB, the rest is the Go
runtime and code pages). Optimizations applied:

- `CGO_ENABLED=0` + `-trimpath -ldflags="-s -w"` (~6.6MB binary)
- In-code `debug.SetGCPercent(25)` + `debug.SetMemoryLimit(24MiB)`
- `HY2DASH_GOMAXPROCS=1`; systemd `MemoryHigh=64M` / `MemoryMax=96M` as a hard cap
- `debug.FreeOSMemory()` every 90s to hand memory back to the OS
- No SQLite / ORM / web framework / Node toolchain

Same-host comparison: `firewalld 47.7MB`, `hysteria2 33.0MB`, **hy2dash 12.2MB**.

## Notes

- Connection details come from Hysteria2's TCP stream list; **UDP sessions are
  not included** (enable hysteria debug logging and collect separately if needed)
- The panel shows the equivalent of a full client access log — bind to
  localhost or restrict sources, use a strong password, never deploy publicly
- History defaults to 90 days retention, ~200 bytes per connection

## UI

The design language comes from [LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI)
(MIT): warm paper / ink-black surfaces, bronze accents, 1px hairlines, HUD
corner ticks. The core panel is a zero-build static page; the header also has
a `3D/2D` toggle where 3D is a lightweight RhineLabUI homage (transparent
archive-box 5×8 array + waves + breathing + parallax in `web/bg3d.js`,
three.js lazy-loaded from CDN with automatic offline fallback to 2D) and 2D is
a pure-CSS grid. Preference is stored in the browser.

## License

MIT
