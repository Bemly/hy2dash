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
   only — never add real secret values to it.

## Project facts

- Go, pure stdlib (`CGO_ENABLED=0`), `go:embed web/`. No Node build chain.
- Binary listens on `127.0.0.1:8787` by default; `base_path` mounts the panel
  under a sub-path (e.g. `/dash`). Login redirect must stay `BASE + "/"`
  (see `web/login.html`) — a hardcoded `"/"` 404s on sub-path deployments.
- Frontend: `web/login.html` + `web/register.html` standalone, `web/index.html`
  role-based console, `web/app.js` + `web/style.css` via virtual `base + "/static/"`.
  Zero-build vanilla JS/CSS only — never add a build chain.
- Subscriptions are served by Go (`/sub/<token>`, template `sub-template.yaml`
  with `__NODES__`/`__NODE_NAMES__`). The Cloudflare Worker is retired; do not
  reintroduce it. A server-side `<config-dir>/sub-template.yaml` overrides the
  embedded default.
- Hysteria auth is `userpass` with a static slot pool (`u01…`); hy2dash
  `config.Slots` must carry the same user/pass pairs (needed to print node
  lines). Registration claims free slots — never invent usernames outside the
  pool. Rotating a slot password = update both hysteria YAMLs + hy2dash config.
- Sessions are role-tagged (`v1|role|user|exp`); exactly one admin. The panel is
  single-instance (control plane); extra hysteria hosts are polled via
  `hysteria_nodes` (SSH-tunneled stats when remote).
- The production server runs this code under the name **hydash**
  (`/root/hydash-src/`, `/usr/local/bin/hydash`, cookie `hydash_session`,
  env `HYDASH_GOMAXPROCS`). When syncing, copy `web/` + `*.go` and
  `sed s/hy2dash/hydash/g` the web files — never overwrite the server's
  `*.service` unit or `go.mod` with the `hy2dash` versions.
- Cloudflare Worker routes: update with `POST {pattern, script}` or
  `DELETE` + recreate. `PUT` on a route silently drops the `script` binding.
- Docs: `README.md` is English, `README.zh.md` is Chinese. Keep them in sync.
