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
  binary; restart the service.
- No production backup before syncing (sync never touches the data dir).
- Verify via the public static asset, e.g. the deployed `static/app.js`
  must contain the new code.

## Project facts

- Go, pure stdlib (`CGO_ENABLED=0`), `go:embed web/`. No Node build chain.
- Binary listens on `127.0.0.1:8787` by default; `base_path` mounts the panel
  under a sub-path (e.g. `/dash`). Login redirect must stay `BASE + "/"`
  (see `web/login.html`) — a hardcoded `"/"` 404s on sub-path deployments.
- Frontend: `web/login.html` + `web/register.html` standalone, `web/index.html`
  role-based console, `web/app.js` + `web/style.css` via virtual `base + "/static/"`.
  Zero-build vanilla JS/CSS only — never add a build chain.
- Subscriptions are served by Go (`/<token>`, template `sub-template.yaml`
  with `__NODES__`/`__NODE_NAMES__`). The Cloudflare Worker is retired; do not
  reintroduce it. A server-side `<config-dir>/sub-template.yaml` overrides the
  embedded default — it carries the shared third-party providers
  (never commit that file).
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
