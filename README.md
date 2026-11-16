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
app and submitting it via `aka.ms/mce-reviewappid`. Password login has been removed:
admin rights come from a Minecraft account carrying `admin: true` (currently `bemly_`),
so there is no second credential path.

To switch AppIDs later, no other code changes are needed:

- edit that single constant in `src/mc.js` and commit (the secret scan reads its GUID
  whitelist from this line automatically), or
- set the Worker Secret / `.dev.vars` key `MS_CLIENT_ID`, which overrides the built-in value
  without a code change.

> The built-in client_id is the only GUID allowed anywhere in the repo. The scan allows it
> in that one file only; node UUIDs, tenant IDs and any other GUIDs are still rejected.

## Caching: no second device-code login

- `hy2dash_session`: HttpOnly signed session cookie, 30 days.
- `hy2dash_id`: 180-day identification cookie; re-issues the session automatically when it
  expires, so the user does not need a new device code.
- KV user record plus an AES-GCM encrypted refresh_token. Profiles refresh in the background
  after 7 days. **A failed refresh is logged and re-thrown** — the login state is unaffected,
  but the fault must be visible. A decryption failure is data corruption and throws; it is
  never disguised as "no token".

All signing/encryption keys derive from `SESSION_SECRET`.

## Subscriptions

`GET /<word-word-word>` returns YAML. `sub-template.yaml` is the current production config:

- all 568 `rules` lines kept verbatim;
- one-line proxies / groups / providers / rule-providers stay one line and are **never**
  expanded into block YAML;
- the only dynamic parts are 8 `__XXX__` placeholders, filled from Worker Secrets via plain
  string replacement — no YAML parsing, no reformatting;
- missing or leftover placeholders yield 503 instead of shipping a broken config.

Each subscription link is **three memorable words joined by `-`** (repeatable, ordered),
drawn from `words.enc` (4736-line word list stored as ROT47; 4716 valid words after decoding).
Words themselves may contain hyphens, so `src/words.js` uses DP to split a token into exactly
three dictionary words. If fewer than 64 valid words remain, **module load throws and the
Worker refuses to start** — there is no hex fallback, and legacy 32-hex links are no longer
accepted. An admin can rotate a link; the old one is invalidated immediately.

`Subscription-Userinfo` is not emitted: with no metering enforcement point there is no
truthful value, so the fabricated `upload=0; download=0` header was removed.

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
| `HY2_SERVER` / `HY2_FINGERPRINT` / `HY2_CERT_FP` | Hysteria 2 node |
| `REALITY_SERVER` / `REALITY_PUBLIC_KEY` | VLESS REALITY node |
| `EDGETUNNEL_URL` | third-party provider URL |
| `ORIGIN_API_BASE` | proxied origin hostname (no port); shared by auth relay and traffic data, required for device-code sign-in |
| `PROBE_TOKEN` | origin shared token, sent as `X-Probe-Token` on every origin call and compared constant-time by the probe |

Node **credentials are per user**: `HY2_PASSWORD` / `REALITY_UUID` are no longer global
secrets but `hy2_pass` / `vless_uuid` on each user record, substituted into the template at
render time and rotated when a user exceeds their monthly allowance.

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

## Traffic data: no graceful degradation

The Worker does not collect server traffic; that is the job of the `probe/` module in this
repo. It reads Hysteria 2 `trafficStats`, tracks live connections and per-day JSONL history,
and serves `/api/live`, `/api/summary`, `/api/history` and `/api/overview`. `originJson()` in
`src/panel.js` validates and passes those bodies through.

The path is: Worker subrequest -> proxied hostname (no port in the URL) -> an origin rule
that rewrites the origin port -> the probe on 2096. Authorization requires **both** the
Cloudflare egress IP ranges and an explicit `X-Probe-Token` header that the Worker adds
itself (value from the `PROBE_TOKEN` secret, compared constant-time at the origin).

`CF-Worker` / `CF-Ray` are **not** used as a gate: Cloudflare only injects them on subrequests
that came through the edge, and Cron Trigger subrequests do not reliably carry them — when
they do, the value is `<script>.<subdomain>.workers.dev`, not the custom domain, so an exact
match would make every scheduled run fail with 403. They are logged as corroboration only.

**Failures are errors, not empty data.** Missing `ORIGIN_API_BASE` yields 503; unreachable
origin, non-2xx upstream or non-JSON bodies yield 502 with a reason. `/api/fleet` takes
online counts and connections from the real `/api/live` fields; day/month counters have no
enforcement point and are simply not returned. `user_total` is keyed by hy2 auth user, not
by panel slot (`u01`…), so per-user mapping is not attempted — the users tab shows a
site-wide cumulative total instead.

User-scoped endpoints (`/api/my/live`, `/api/my/domains`, `/api/my/summary`,
`/api/my/renew`) plus `/api/base_path`, `/api/restart` and `/api/hostker/refresh` return
**501 Not Implemented**: a Worker identity is a Minecraft UUID with no mapping to hy2 auth
users, and the serverless build has no DNS-sync capability. They never return
`{ok:true}` or well-formed empty data pretending to succeed.

**Monthly quota only, no daily cap.** Defaults to 100G (`monthly_gb`). Admin accounts
(`admin: true` on the user record, currently `bemly_`) and `monthly_gb <= 0` are unlimited;
`/api/user/quota` accepts only `monthly_gb` (0 = unlimited) and refuses to set a limit for
an admin account.

**Over the cap means revocation, not a kick.** Every minute (`src/quota.js`) the Worker
compares the probe's current-month usage against the allowance; when a user is over it sets
`blocked_month` and rotates that user's `hy2_pass` / `vless_uuid`. The probe then kicks the
live session, removes the UUID from Xray (`rmu`) and answers `ok:false` to any
`/auth/hy2` attempt with that credential — every node in the old subscription dies at once
and reconnects simply time out. The subscription URL itself returns **403** until the next
month, when the block is lifted and fresh credentials are issued; the user has to pull the
subscription again. Only usage tagged with the **current** month is trusted, so a month
rollover cannot re-block a user that was just released.

Xray SSH sync, Hostker stats and other Go-era capabilities are not reimplemented on either
side; their full code stays on `archive/steam-host`. Probe deployment, API contracts and
access control are documented in `probe/README.md`.

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
