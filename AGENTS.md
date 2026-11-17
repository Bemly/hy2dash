# AGENTS.md

Instructions for any coding agent working in this repo. Follow these strictly.

## Architecture (current)

- **`main` is a Cloudflare Worker, not a Go service.** The former Go monolith (collector,
  Xray sync, quota kicks, Hostker stats) is preserved on branch `archive/steam-host`.
  Do not reintroduce Go server code into `main`.
- **Quota policy: monthly only, no daily cap.** Default `monthly_gb: 100`; `monthly_gb <= 0`
  and accounts with `admin: true` are unlimited. `/api/user/quota` accepts only
  `monthly_gb` (0 = unlimited). Do not reintroduce `daily_gb` / `day_used` / daily caps.
- **No password login.** `/api/login` and `/api/password` return 410; admin rights come
  solely from `admin: true` on a Minecraft user record. Do not add a second credential path.
- `src/worker.js` is the entry point; `src/mc.js` handles the Microsoft device-code ->
  Xbox -> XSTS -> Minecraft chain; `src/store.js` owns KV + cookies + crypto;
  `src/panel.js` implements the panel API; `src/sub.js` renders subscriptions.
- **`probe/` is the split-out origin data collector** (plain-stdlib Python + systemd),
  running on the Hysteria 2 host and listening on 2096. It replaces the Go-era
  `collector.go` and serves the `/api/*` JSON contract consumed by `fromOrigin()` in
  `src/panel.js`. Keep it independent: no Worker runtime imports, no login/subscription
  logic, no changes to `web/`. `probe/README.md` is the deployment contract.
- `web/` is served verbatim by Workers Static Assets. **The UI and 3D files are frozen**:
  never reformat, reindent or "modernize" `web/index.html`, `web/app.js`, `web/sky.js`,
  the scene modules, `web/style.css` or `web/vendor/*`. The only frontend file that may be
  edited for auth is `web/login.html`. `/static/<file>` maps to the asset named `<file>`.
- `sub-template.yaml` is the production config **as given**: 566 rule lines verbatim,
  one-line proxies/groups/providers kept on one line. Render by string replacement of the
  13 scalar `__XXX__` placeholders plus the derived `__SERVER_DIRECT_RULES__` only.
  Never parse or reformat the YAML. Never split a one-line node into block style.
- Identity is the Minecraft UUID once device-code sign-in succeeds. Login uses a
  public-client device code. The Microsoft client_id is hardcoded as `MS_CLIENT_ID` in
  `src/mc.js`; `resolveClientId(env)` is the single lookup point and lets an optional
  `MS_CLIENT_ID` Secret override it. No client_secret.
- **Mojang AppID allow-list:** since 2023 `login_with_xbox` accepts only approved Azure
  AppIDs. A 403 with `Invalid app registration` means the AppID is not approved — never
  describe it as an account, entitlement or password problem. On 2026-11-15 the original
  built-in SJMCL AppID was verified to fail this way, while the current built-in Axolotl
  AppID was verified end to end (all six steps 200, Minecraft UUID returned). Do not
  generalise from one borrowed AppID to another: approval is per AppID and must be tested.
  The proper long-term fix is owning an app registration and submitting it via
  `aka.ms/mce-reviewappid`; surface the official error body instead of a guessed diagnosis.
- **Cloudflare Workers egress to Minecraft Services is blocked:** verified 2026-11-15 from
  a Worker (colo NRT): every subrequest to `api.minecraftservices.com`, including a bare
  `GET /minecraft/profile`, returns `403 text/html` with `server: cloudflare` and a
  `cf-ray`. The same call from a residential IP and from the origin host returns a normal
  `401 {"error":"UNAUTHORIZED"}`. Never diagnose this as an AppID, account, entitlement or
  UA problem. The implemented fix: `src/mc.js` sends all 6 auth calls as `{op, headers,
  body}` to `ORIGIN_API_BASE + /api/relay/mc`, and `probe/hy2dash_probe.py` maps the op
  through a fixed 6-entry whitelist and performs the request from origin egress. Do NOT
  revert to direct `fetch()` of Microsoft/Mojang URLs inside the Worker, and do NOT turn
  the relay into a caller-supplied-URL open proxy. `ORIGIN_API_BASE` is required for
  device-code sign-in.
- Caching is mandatory: signed session cookie (30d) + long-lived id cookie (180d, silent
  re-issue) + KV user record with encrypted refresh_token. Do not force a device-code login
  on every visit.
- **No silent degradation, no fake data, no compatibility fallbacks.** Any dependency
  failure (origin API, KV rate-limit store, auth relay, word list) must fail closed with an
  explicit error status. Never return an empty-but-well-formed payload, a hardcoded `0`
  usage value, or `{ok:true}` for an operation that did nothing; unimplemented endpoints
  return 501. Never add a fallback format "in case X breaks". Removed on 2026-11-16 and
  must not be reintroduced: 32-hex subscription tokens, the PBKDF2 admin-record branch,
  the `PROBE_TOKEN`-empty weak-check mode, unconditional loopback trust, the
  `Subscription-Userinfo` zero header, and `document.execCommand("copy")`.
- Sub tokens are exactly three dictionary words (`src/words.js`, word list `words.enc`).
  A damaged/short word list throws at module load; do not add a hex fallback.

## Secrets (mandatory)

- **No real credentials in tracked files.** This includes the session secret, admin
  password, subscription node parameters, source host addresses, the probe's
  `HY2_STATS_SECRET` / `PROBE_TOKEN` values, and above all any platform account
  credential (global keys, API tokens, account email). Those belong only in Worker
  Secrets, the local wrangler login, `.dev.vars` (gitignored), and the origin host's
  `/etc/hysteria/probe.env` (0600). `probe/probe.env.example` is a name-only template.
- **One deliberate exception:** the Microsoft client_id is a public OAuth identifier (not a
  credential) and lives as `MS_CLIENT_ID` in `src/mc.js`. The GUID scan allows exactly this
  one value in exactly that one file; every other GUID is rejected. Switching AppIDs means
  editing that single line, or setting the override Secret.
- `ORIGIN_API_BASE` is a required Secret for device-code sign-in: `src/mc.js` POSTs every
  auth call to `<ORIGIN_API_BASE>/api/relay/mc`, and `probe/hy2dash_probe.py` performs the
  request from origin egress. It must be a proxied hostname without a port. Never inject a
  raw source-host IP or a port here.
- `wrangler.toml` contains a KV placeholder id, not a real one. `.dev.vars.example` is a
  name-only template.
- Scan twice before every commit:
  ```sh
  ./scripts/scan-secrets.sh
  git add -A
  ./scripts/scan-secrets.sh --staged
  ```
  Commit only when both print `scan: OK`. Keep the deny-list of your own assets in
  `~/.config/hy2dash/scan-deny` (0600, never in git).
- `src/sub.js` must fail closed: any missing or leftover placeholder returns 503 rather
  than shipping a partially filled config.

## Deploy

- **Commit after every change**, then push to `origin/main`. Never accumulate unrelated edits.
- Deploy with `wrangler deploy` from a clean tree. `run_worker_first=true` is required so
  the Worker can gate `/` and map `/static/*`; do not turn it off.
- First-time setup: create the `USERS` KV namespace, put its id into `wrangler.toml`,
  inject every Secret listed in the READMEs, then bind a custom domain.
- Traffic endpoints proxy to `ORIGIN_API_BASE` when set. The platform injects official
  headers such as `CF-Worker` on subrequests; the origin must verify those **and** the
  egress IP ranges. Never authorize on a homemade header alone, and never expose the source
  host in public DNS. When the origin is absent, return well-formed empty data so the
  frozen frontend keeps working.
- Do not put a port on the origin URL in a Worker fetch; origin port rewriting belongs in
  the platform's origin rule.
- Deploy or upgrade the origin collector with `probe/install.sh` on the origin host. After
  changing `probe/hy2dash_probe.py`, sync the deployed copy and restart the service so the
  repo stays the single source of truth.

## Docs

- `README.md` (English) and `README.zh.md` (Chinese) must stay in sync.
- Keep this file accurate: it previously said "the Worker is retired, do not reintroduce
  it". That statement is obsolete and was removed when `main` became serverless.
