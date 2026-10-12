# AGENTS.md

Instructions for any coding agent working in this repo. Follow these strictly.

## Git / secrets workflow (mandatory)

1. **Commit after every change.** Each completed fix/feature must end with a
   commit (and push to `origin/main` when network allows). Do not accumulate
   unrelated changes.
2. **Never commit plaintext secrets.** No real passwords, API tokens, session
   keys, private keys, server IPs, or secret URL paths in tracked files.
   Runtime config/data (`config.json`, `data/`, `*.jsonl`, `*.log`) is already
   in `.gitignore` — keep it that way.
3. **Scan before every commit, twice:**
   ```bash
   ./scripts/scan-secrets.sh          # working tree (tracked files)
   git add -A
   ./scripts/scan-secrets.sh --staged # what is about to be committed
   ```
   Commit only when both report `scan: OK`. The script uses generic patterns
   only — never add real secret values, IPs, or domains to it
   (2026-10-05: hardcoded VPS IP + subscription domain removed after exposure).

## Deploy (mandatory)

- After every committed change, sync to production the same session:
  copy `*.go` + `web/` + `sub-template.yaml` + `words.enc` only (never `*.service`,
  `go.mod`, docs, `tag.txt`/`tag.enc`); build on the build host
  (`CGO_ENABLED=0 go build -trimpath -ldflags="-s -w"`) and distribute the
  binary; restart the service. The panel host has no Go toolchain and no source
  dir: cross-compile locally (`GOOS=linux GOARCH=amd64`), upload as
  `/usr/local/bin/hy2dash.new`, keep the old binary as `hy2dash.prev`, `mv`, restart.
- No production backup before syncing (sync never touches the data dir).
- Verify via the public static asset, e.g. the deployed `static/app.js`
  must contain the new code.

## Project facts

- Go, pure stdlib (`CGO_ENABLED=0`), `go:embed web/`. No Node build chain.
- Binary listens on `127.0.0.1:8787` by default; `base_path` mounts the panel
  under a sub-path (e.g. `/dash`). Login redirect must stay `BASE + "/"`
  (see `web/login.html`) — a hardcoded `"/"` 404s on sub-path deployments.
- Frontend: `web/login.html` standalone; `web/index.html` is the full-screen 3D
  skyport ported from mihomoui (`web/sky.js` = assembly + data binding; the other
  scene modules are verbatim copies — keep them in sync with mihomoui, only
  `skyport.js`'s departure board differs). Seating is decided server-side (`seat.go`,
  online-first, self-pick via `/api/my/gate`); online users fly (`/api/fleet`). The role-based console (`web/app.js`) lives in the
  `#console` drawer; its styles are scoped under `.ui` in `web/style.css`.
  Everything is served via virtual `base + "/static/"`.
  No build step and no Node toolchain on the server; prebuilt vendored static
  assets (e.g. `web/vendor/three.module.js` + scene files, browser-side only)
  are allowed. Server stays pure stdlib — vendored assets cost bandwidth/disk,
  not server compute.
- Subscriptions are served by Go (`/<token>`, template `sub-template.yaml`
  with `__NODES__`/`__NODE_NAMES__`). The Cloudflare Worker is retired; do not
  reintroduce it. A server-side `<config-dir>/sub-template.yaml` overrides the
  embedded default — it carries the shared third-party providers
  (never commit that file).
- Optional `hy_auth_secret` in config switches hysteria to HTTP auth
  (`auth.type: http`, url `http://127.0.0.1:8787<base>/api/hy/auth/<secret>`,
  loopback only): passwords then live per user in hy2dash (`hy_pass`), and
  rotating a subscription link also rotates the hy2 password and kicks the user.
  VLESS UUIDs are never touched. Unset = static userpass as described next.
  **Production runs in this mode since 2026-10-12** on both hysteria hosts; the
  remote one reaches the endpoint through a reverse forward (`-R …:18787`) added
  to the `hy2stats-tunnel` unit. hy2dash is therefore on hysteria's auth path:
  while it restarts, new hy2 connections fail auth (existing ones are unaffected).
  When editing a hysteria YAML, replace only the `auth:` block and keep
  `masquerade` / `trafficStats` intact.
- VLESS is monitor-only (`xray.go`, config `xray_nodes`): xray needs `stats`,
  `policy.levels.0.statsUser*`, `metrics.listen` and each client's `email` set to
  the channel name (`u0x`). Optional `log_cmd` (e.g. `ssh … tail -n0 -F /var/log/xray/access.log`) tails
  xray's access log for per-domain connection counts and recent connections —
  the log has no byte counts, so VLESS never gets per-domain traffic.
  User UUIDs sync automatically (`xray_sync.go`): set `sync_ssh` (e.g.
  `root@host`, plus `sync_key`/`sync_path`/`sync_restart`/`sync_port` as needed)
  and enabled users' UUIDs are written into that xray's clients (`email` = channel
  name) on startup, on registration, and every 2 minutes; only rewritten + restarted
  when the set actually changes. Disabled users are removed; unknown emails are left
  alone; an empty user set skips the round (never wipes). known_hosts self-seeds
  under the data dir (strict checking; systemd-hardened services can't use /root). VLESS bytes live in
  `vless_buckets`, outside quota.
- Hysteria auth is `userpass` with a static slot pool (`u01…`); hy2dash
  `config.Slots` must carry the same user/pass pairs (needed to print node
  lines). Registration claims free slots — never invent usernames outside the
  pool. Rotating a slot password = update both hysteria YAMLs + hy2dash config.
- Sessions are role-tagged (`v1|role|user|exp`); exactly one admin (password).
  Users authenticate only via Steam (first login auto-registers). The panel is
  single-instance (control plane); extra hysteria hosts are polled via
  `hysteria_nodes` (SSH-tunneled stats when remote).
- The production servers run this code under the name **hy2dash**
  (build source `/root/hy2dash-src/`, `/usr/local/bin/hy2dash`, cookie
  `hy2dash_session`, env `HY2DASH_GOMAXPROCS`). The old `hydash` naming was
  retired 2026-10-05: no `sed` rename step, no `hydash.*` remnants anywhere.
- Cloudflare Worker routes: update with `POST {pattern, script}` or
  `DELETE` + recreate. `PUT` on a route silently drops the `script` binding.
- Docs: `README.md` is English, `README.zh.md` is Chinese. Keep them in sync.
