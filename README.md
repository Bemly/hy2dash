# hy2dash

Subscription panel as a **Cloudflare Worker**. The `main` branch is fully serverless now;
the former Go monolith is preserved untouched on the `archive/steam-host` branch.
Its traffic collector was **split out into a standalone origin backend** in `probe/`
(plain-stdlib Python + systemd, running on the Hysteria 2 origin; see `probe/README.md`).
The main branch therefore has four parts: edge Worker, static assets, subscription template
and the origin collector; the two sides share only a set of `/api/*` JSON contracts.

The UI and the 3D skyport (every file under `web/` except `login.html`) are byte-for-byte
unchanged. There is no build step and no Node toolchain requirement — assets are served
directly by Workers Static Assets.

## Login: Microsoft device code -> genuine Minecraft identity

1. Request a Microsoft device code (consumer tenant, public client, no client_secret).
2. The user enters the code on the verification page; the Worker polls for the MSA token.
3. MSA token -> Xbox Live user token -> XSTS token.
4. XSTS -> Minecraft `login_with_xbox` -> Minecraft access token.
5. `/minecraft/profile` yields the Minecraft UUID (dashless hex) and the game name, used as the identity key.

The Microsoft client_id is hardcoded as `MS_CLIENT_ID` in `src/mc.js` (currently the
public-client AppID used by Axolotl). It is a public OAuth identifier with no
client_secret, so no Secret is required; production also sets the `MS_CLIENT_ID` Secret
as an override that can be switched without a code change.

**AppID allow-list:** since 2023 Mojang enforces an allow-list on `login_with_xbox`.
Unapproved Azure applications get `403 Invalid app registration`, with the first four
steps succeeding and only step 5 rejected. Verified 2026-11-15: the original built-in
SJMCL AppID failed this way, while the Axolotl AppID passed all six steps from a direct
connection — **the AppID is no longer the blocker**.

**Egress: all 6 auth calls are relayed by the origin probe, never sent directly from the
Worker.** `src/mc.js` wraps each call as `{op, headers, body}` and POSTs it to
`ORIGIN_API_BASE + /api/relay/mc`. `probe/hy2dash_probe.py` maps the op back to a fixed
Microsoft/Mojang URL (`RELAY_OPS`, exactly 6 entries), performs the request from the origin
egress, and returns the status code and body verbatim. **The endpoint never accepts a
caller-supplied URL**, so it is not an open proxy. It reuses the probe's two-layer access
control, holds no secrets and persists no token. UI, session, KV and subscriptions remain
in the Worker.

Why: Cloudflare Workers egress to `api.minecraftservices.com` is rejected by the
Cloudflare WAF in front of that host (verified in production 2026-11-15: `403 text/html`,
`server: cloudflare`, a `cf-ray` header and an HTML block page instead of JSON). Even a
bare `GET /minecraft/profile` with no token is blocked. The same call from a residential IP
or the origin returns a normal `401 {"error":"UNAUTHORIZED"}`. Keeping auth calls inside
the Worker makes step 5 fail with an empty JSON error body, so the UI only shows
`HTTP 403`. **This is unrelated to the AppID, account, entitlement or User-Agent** (a
browser UA was tested as a control).

Trade-offs: sign-in depends on the origin being online; the edge terminates TLS and
origin pull is plaintext, so MSA/XSTS/Minecraft tokens traverse the CF -> origin leg;
the origin must keep both the CF egress IP allow-list and the exact `CF-Worker` value
check, or the relay could be abused. `ORIGIN_API_BASE` is therefore required for
device-code sign-in, not just optional traffic-data backfill.

Risks: the current AppID is still a borrowed third-party launcher value that Mojang
explicitly discourages and may revoke. The long-term fix is registering your own Azure
app and submitting it via `aka.ms/mce-reviewappid`. Admin-password login remains a
fallback that does not depend on the device-code flow.

To switch AppIDs later, no other code changes are needed:

- edit that single constant in `src/mc.js` and commit (the secret scan reads its GUID
  whitelist from this line automatically), or
- set the Worker Secret / `.dev.vars` key `MS_CLIENT_ID`, which overrides the built-in value
  without a code change.

> The built-in client_id is the only GUID allowed anywhere in the repo. The scan allows it
> in that one file only; node UUIDs, tenant IDs and any other GUIDs are still rejected.

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
| `ADMIN_PASSWORD` | initial admin password (persisted to KV on first login, changeable in panel) |
| `HY2_SERVER` / `HY2_PASSWORD` / `HY2_FINGERPRINT` / `HY2_CERT_FP` | Hysteria 2 node |
| `REALITY_SERVER` / `REALITY_UUID` / `REALITY_PUBLIC_KEY` | VLESS REALITY node |
| `EDGETUNNEL_URL` | third-party provider URL |
| `ORIGIN_API_BASE` | proxied origin hostname (no port); shared by auth relay and traffic data, required for device-code sign-in |

Optional: `MS_CLIENT_ID` (overrides the built-in client_id), `BASE_PATH` (sub-path deploy),
`SUB_TOTAL_BYTES`.

**Platform account credentials (global keys, API tokens, account email) must never appear in
any file.** They live only in the local wrangler login session; `.dev.vars` is gitignored.
Always scan twice before committing:

```sh
./scripts/scan-secrets.sh
git add -A
./scripts/scan-secrets.sh --staged
```

## Traffic data and graceful degradation

The Worker does not collect server traffic; that is the job of the `probe/` module in this
repo. It reads Hysteria 2 `trafficStats`, tracks live connections and per-day JSONL history,
and serves `/api/live`, `/api/summary`, `/api/history`, `/api/overview` and `/api/my/*`.
`fromOrigin()` in `src/panel.js` passes those JSON bodies through verbatim, so `web/app.js`
needs no changes.

The path is: Worker subrequest -> proxied hostname (no port in the URL) -> an origin rule
that rewrites the origin port -> the probe on 2096. When `ORIGIN_API_BASE` is set, `live`,
`history`, `summary` and `domains` use that path; the platform injects official headers such
as `CF-Worker` and `CF-Ray`, and the origin verifies **both** those headers (optionally down
to the exact value) and the egress IP ranges. Never authorize on headers alone, and never
publish the origin address in public DNS.

Without an origin — or when it is unreachable — the endpoints return well-formed empty data,
so the frozen frontend keeps rendering without errors. `/api/my/*` also returns empty data
on purpose: a Worker identity is a Minecraft UUID with no mapping to hy2 auth users, so
site-wide connection data must not be handed to an individual login.

Go-era quota kicks, Xray SSH sync and Hostker stats are not reimplemented on either side;
their full code stays on `archive/steam-host`. Probe deployment, API contracts and access
control are documented in `probe/README.md`.

## Layout

```
src/worker.js       routes, sessions, static assets, device-code endpoints
src/mc.js           Microsoft / Xbox / Minecraft login chain
src/store.js        KV users, signing, encryption, cookies
src/panel.js        panel API (keeps the old frontend contract)
src/sub.js          subscription rendering
probe/              origin data collector (Python + systemd, split from the Go collector)
web/                UI + 3D assets (untouched)
sub-template.yaml   subscription template (sanitized production config)
scripts/scan-secrets.sh  pre-commit secret scan
```
