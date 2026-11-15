# hy2dash

Subscription panel as a **Cloudflare Worker**. The `main` branch is fully serverless now;
the former Go monolith is preserved untouched on the `archive/steam-host` branch.

The UI and the 3D skyport (every file under `web/` except `login.html`) are byte-for-byte
unchanged. There is no build step and no Node toolchain requirement — assets are served
directly by Workers Static Assets.

## Login: Microsoft device code -> genuine Minecraft identity

1. Request a Microsoft device code (consumer tenant, public client, no client_secret).
2. The user enters the code on the verification page; the Worker polls for the MSA token.
3. MSA token -> Xbox Live user token -> XSTS token.
4. XSTS -> Minecraft `login_with_xbox` -> Minecraft access token.
5. `/minecraft/profile` yields the Minecraft UUID (dashless hex) and the game name, used as the identity key.

`MS_CLIENT_ID` is a **Worker Secret** and is never hardcoded. Use an Azure Application ID
that is on the Mojang Minecraft API allow-list (a third-party launcher AppID). A 403 from
`login_with_xbox` means the AppID has not been approved: swap in an approved ID or apply
through the official App ID Review. Once approved, only the Secret changes — no code change.

> Do not commit the client_id. It is public by nature, but a public repo reusing someone
> else's AppID at high request volume invites reports and revocation.

## Caching: no second device-code login

- `hy2dash_session`: HttpOnly signed session cookie, 30 days.
- `hy2dash_id`: 180-day identification cookie; silently re-issues the session when it expires.
- KV user record plus an AES-GCM encrypted refresh_token. Profiles are refreshed in the
  background after 7 days; a failed refresh never logs the user out.

All signing/encryption keys derive from `SESSION_SECRET`.

## Subscriptions

`get /<token>` returns YAML. `sub-template.yaml` is the current production config:

- all 568 `rules` lines kept verbatim;
- one-line proxies / groups / providers / rule-providers stay one line and are **never**
  expanded into block YAML;
- the only dynamic parts are 8 `__XXX__` placeholders, filled from Worker Secrets via plain
  string replacement — no YAML parsing, no reformatting;
- missing or leftover placeholders yield 503 instead of shipping a broken config.

Each user gets a random token; an admin can rotate it, which invalidates the old link at once.

## Deploy

```sh
npm i -D wrangler                       # or install globally
wrangler login
wrangler kv namespace create USERS      # put the returned id into wrangler.toml
cp .dev.vars.example .dev.vars          # local dev only, fill in real values
wrangler secret put SESSION_SECRET      # repeat for every Secret below
wrangler deploy
```

Replace `REPLACE_WITH_KV_NAMESPACE_ID` in `wrangler.toml`. Then bind a custom domain in the
platform dashboard. `run_worker_first=true` sends every request (including `/`) through the
Worker first, so the login gate is enforced.

### Required Secrets

| Name | Purpose |
| --- | --- |
| `SESSION_SECRET` | HMAC session signing + refresh_token encryption |
| `MS_CLIENT_ID` | approved Azure Application ID |
| `ADMIN_PASSWORD` | initial admin password (persisted to KV on first login, changeable in panel) |
| `HY2_SERVER` / `HY2_PASSWORD` / `HY2_FINGERPRINT` / `HY2_CERT_FP` | Hysteria 2 node |
| `REALITY_SERVER` / `REALITY_UUID` / `REALITY_PUBLIC_KEY` | VLESS REALITY node |
| `EDGETUNNEL_URL` | third-party provider URL |

Optional: `ORIGIN_API_BASE` (traffic data origin), `BASE_PATH` (sub-path deploy), `SUB_TOTAL_BYTES`.

**Platform account credentials (global keys, API tokens, account email) must never appear in
any file.** They live only in the local wrangler login session; `.dev.vars` is gitignored.
Always scan twice before committing:

```sh
./scripts/scan-secrets.sh
git add -A
./scripts/scan-secrets.sh --staged
```

## Traffic data and graceful degradation

The Worker does not collect server traffic. When `ORIGIN_API_BASE` is set, the `live`,
`history`, `summary` and `domains` endpoints proxy through a Worker subrequest; the platform
injects official headers such as `CF-Worker`, and the origin must additionally verify the
official headers plus the egress IP ranges (do not authorize on headers alone). Without an
origin — or when it is unreachable — the endpoints return well-formed empty data, so the
original frontend keeps rendering without errors.

The Go-era collector, quota kicks, Xray SSH sync and Hostker stats are not reimplemented in
the Worker; restore them from `archive/steam-host` or provide them from an origin service.

## Layout

```
src/worker.js       routes, sessions, static assets, device-code endpoints
src/mc.js           Microsoft / Xbox / Minecraft login chain
src/store.js        KV users, signing, encryption, cookies
src/panel.js        panel API (keeps the old frontend contract)
src/sub.js          subscription rendering
web/                UI + 3D assets (untouched)
sub-template.yaml   subscription template (sanitized production config)
scripts/scan-secrets.sh  pre-commit secret scan
```
