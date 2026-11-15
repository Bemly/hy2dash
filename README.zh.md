# hy2dash

Cloudflare Worker 版订阅与面板服务。**主分支已全面 serverless 化**：Go 单体已完整备份到
`archive/steam-host` 分支；原本单体里的流量采集被**拆成独立的源站后端** `probe/`
（纯标准库 Python + systemd，跑在 Hysteria 2 源站，详见 `probe/README.md`）。
主分支现在由「边缘 Worker + 静态资源 + 订阅模板 + 源站采集模块」四部分组成，
两侧只通过一组 `/api/*` JSON 契约耦合。

UI 与 3D 空港（`web/` 下除 `login.html` 以外的全部文件）保持字节不变，没有构建步骤、
没有 Node 工具链依赖，直接由 Workers Static Assets 托管。

## 登录：Microsoft 设备码 → Minecraft 正版

用户点登录按钮后走完整链路：

1. 微软设备码申请（`consumers` 租户，公共客户端，不带 client_secret）；
2. 用户在验证页输入代码；Worker 轮询 MSA token；
3. MSA token → Xbox Live user token → XSTS token；
4. XSTS → Minecraft 的 `login_with_xbox` → Minecraft access token；
5. `/minecraft/profile` 拿到正版 UUID 与游戏 ID，作为全局唯一身份。

Microsoft client_id 内置在 `src/mc.js` 的 `MS_CLIENT_ID` 常量里（当前是 Axolotl 启动器的
公共客户端 AppID）。它是公开的 OAuth 应用标识、不带 client_secret，因此不需要注入 Secret；
生产环境另设 `MS_CLIENT_ID` Secret 作为不改代码即可切换的覆盖入口。

**AppID 允许名单**：Mojang 自 2023 年起对 `login_with_xbox` 实行名单制，未过审的 Azure
应用返回 `403 Invalid app registration`，且前四步都成功、只有第 5 步被拒。2026-11-15
实测：最初内置的 SJMCL AppID 在此列；换成 Axolotl AppID 后本机直连六步全部 200，
**AppID 本身已不是障碍**。

**出站方式：6 个认证请求由源站探针代发，不从 Worker 直发。** `src/mc.js` 把每次调用
打包成 `{op, headers, body}`，POST 到 `ORIGIN_API_BASE + /api/relay/mc`；
`probe/hy2dash_probe.py` 用固定映射表（`RELAY_OPS`，仅 6 项）把 op 还原成微软/Mojang 的
官方 URL 并由源站出口发出，再把状态码与响应体原样回传。**端点不接受调用方提供的任意
URL**，因此不是开放代理；它复用探针的双层访问控制，不保管密钥、不落盘任何 token。
UI、会话、KV、订阅仍留在 Worker。

这么做的原因：Cloudflare Workers 的出站 IP 被 `api.minecraftservices.com` 前面的
Cloudflare WAF 拦截（2026-11-15 生产实测 `403 text/html`，响应头 `server: cloudflare` +
`cf-ray`，body 是 HTML 拦截页而非 JSON）；连不带 token 的 `GET /minecraft/profile`
基线也一样。同一请求从家宽 IP 或源站直连返回正常的 `401 {"error":"UNAUTHORIZED"}`。
若认证请求留在 Worker 里，第 5 步会失败且官方 JSON 错误原文为空，页面只显示 `HTTP 403`。
**这与 AppID、账号、正版资格、User-Agent 都无关**（UA 已做对照排除）。

代价与边界：登录依赖源站在线；平台边缘终止 TLS 后明文回源，MSA / XSTS / Minecraft
token 会经过 CF → 源站这一段；源站必须保持「回源 IP 段 + `CF-Worker` 精确值」双层校验，
否则代发端点可能被滥用。`ORIGIN_API_BASE` 因此是设备码登录的必需配置，不只是流量数据回源。

风险与后续：当前 AppID 仍是借用第三方启动器的过渡值，官方明确不鼓励且随时可能吊销；
长期应自己注册 Azure 应用（Personal Microsoft accounts only + 允许公共客户端流），
把 client_id 通过 `aka.ms/mce-reviewappid` 提交审核。管理员口令登录作为兜底入口保留。

以后换 AppID 有两种方式，其它代码都不用动：

- 改 `src/mc.js` 里那一行常量后提交（脱敏脚本的 GUID 白名单会自动跟着它走）；
- 或注入 Worker Secret / `.dev.vars` 的 `MS_CLIENT_ID`，它优先于内置值，可不改代码临时切换。

> 仓库里唯一允许出现的 GUID 就是这个内置 client_id；脱敏脚本按文件放行，
> 订阅节点 UUID、租户 ID 等其它 GUID 仍一律拦截。

## 缓存：免二次登录

- `hy2dash_session`：HttpOnly 签名会话 cookie，30 天；
- `hy2dash_id`：180 天识别 cookie。会话过期时静默重签，用户无需重新输码；
- KV 用户档案 + AES-GCM 加密的 refresh_token。超过 7 天后台静默刷新档案与令牌，
  失败也不影响已登录状态。

会话签名与 refresh_token 加密的密钥都由 `SESSION_SECRET` 派生。

## 订阅

`get /<token>` 返回 YAML。模板 `sub-template.yaml` 以当前线上 yml 为准：

- 568 条 `rules` 逐行原样保留；
- 一行式节点 / 分组 / provider / rule-provider 配置保持单行，**不拆成块状 YAML**；
- 只有 8 个 `__XXX__` 占位符是动态的，真实值全部来自 Worker Secrets，
  渲染时仅做字符串替换，不解析、不重排 YAML；
- 占位符缺失或残留时返回 503，绝不把半截配置下发给客户端。

订阅链接按用户随机生成，管理员可在面板里换链；换链后旧 token 立即失效。

## 部署

```sh
npm i -D wrangler                       # 或全局安装
wrangler login
wrangler kv namespace create USERS      # 把返回的 namespace id 填进 wrangler.toml
cp .dev.vars.example .dev.vars          # 本地开发用；填真实值
wrangler secret put SESSION_SECRET      # 生产逐个注入，见下方清单
wrangler deploy
```

`wrangler.toml` 里的 `REPLACE_WITH_KV_NAMESPACE_ID` 必须替换。部署后在平台控制台把自定义域
绑定到该 Worker；`run_worker_first=true` 已开启，所有请求（含 `/`）都会先经过 Worker 做登录检查。

### 必填 Secrets

| 名称 | 用途 |
| --- | --- |
| `SESSION_SECRET` | 会话 HMAC 签名 + refresh_token 加密 |
| `ADMIN_PASSWORD` | 管理员初始口令（首次登录时写入 KV，之后可在面板修改） |
| `HY2_SERVER` / `HY2_PASSWORD` / `HY2_FINGERPRINT` / `HY2_CERT_FP` | Hysteria 2 节点参数 |
| `REALITY_SERVER` / `REALITY_UUID` / `REALITY_PUBLIC_KEY` | VLESS REALITY 节点参数 |
| `EDGETUNNEL_URL` | 第三方 provider 地址 |
| `ORIGIN_API_BASE` | 橙云 proxied 回源域名（不带端口）：认证代发 + 流量数据回源共用；设备码登录必需 |

可选：`MS_CLIENT_ID`（覆盖内置的 client_id）、`BASE_PATH`（子路径部署）、`SUB_TOTAL_BYTES`。

**平台账号凭据（全局密钥、API Token、邮箱）绝不写进任何文件**，只用于本机 wrangler 登录态；
`.dev.vars` 已被 `.gitignore` 排除。提交前务必跑两次扫描：

```sh
./scripts/scan-secrets.sh
git add -A
./scripts/scan-secrets.sh --staged
```

## 数据回源与降级

Worker 本身不采集服务器流量；采集由仓库内的 `probe/` 模块在源站完成：
读取 Hysteria 2 `trafficStats`，维护活跃连接与按日 JSONL 历史，对外提供
`/api/live`、`/api/summary`、`/api/history`、`/api/overview`、`/api/my/*`。
`src/panel.js` 的 `fromOrigin()` 原样透传这些 JSON，`web/app.js` 无需改动。

链路是「Worker 子请求 → 橙云 proxied 域名（URL 不带端口）→ Origin Rule 改写回源端口
→ `probe` 的 2096」。配置了 `ORIGIN_API_BASE` 时 `live` / `history` / `summary` / `domains`
等接口走这条通道，平台自动注入 `CF-Worker`、`CF-Ray` 等官方头；源站**同时**校验官方头
（可精确到值）与回源 IP 段，绝不只靠请求头授权，也不把源站地址写进公共 DNS。

未配置或回源不可用时返回结构完整的空数据，前端不会报错、界面保持原样。
`/api/my/*` 也固定返回空数据：Worker 身份是 Minecraft UUID，与 hy2 auth 用户没有映射，
不能把全站连接数据下发给个人。

Go 时代的配额踢人、Xray SSH 同步、Hostker 统计等能力不在两侧重实现，完整代码保留在
`archive/steam-host` 分支。探针的部署、接口契约与访问控制见 `probe/README.md`。

## 目录

```
src/worker.js       路由、会话、静态资源、设备码端点
src/mc.js           Microsoft / Xbox / Minecraft 登录链路
src/store.js        KV 用户存储、签名与加密、cookie
src/panel.js        面板 API（保持旧前端契约）
src/sub.js          订阅模板渲染
probe/              源站数据采集后端（Python + systemd，从 Go collector 拆出）
web/                UI + 3D 资源（原样）
sub-template.yaml   订阅模板（当前线上 yml，脱敏）
scripts/scan-secrets.sh  提交前明文扫描
```
