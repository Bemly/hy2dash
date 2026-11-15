# hy2dash

Cloudflare Worker 版订阅与面板服务。**主分支已全面 serverless 化**：Go 单体已完整备份到
`archive/steam-host` 分支，主分支只保留 Worker 代码、`web/` 静态资源与订阅模板。

UI 与 3D 空港（`web/` 下除 `login.html` 以外的全部文件）保持字节不变，没有构建步骤、
没有 Node 工具链依赖，直接由 Workers Static Assets 托管。

## 登录：Microsoft 设备码 → Minecraft 正版

用户点登录按钮后走完整链路：

1. 微软设备码申请（`consumers` 租户，公共客户端，不带 client_secret）；
2. 用户在验证页输入代码；Worker 轮询 MSA token；
3. MSA token → Xbox Live user token → XSTS token；
4. XSTS → Minecraft 的 `login_with_xbox` → Minecraft access token；
5. `/minecraft/profile` 拿到正版 UUID 与游戏 ID，作为全局唯一身份。

`MS_CLIENT_ID` 是 **Worker Secret**，代码与仓库里都不写死。使用已通过 Mojang Minecraft API
审核（允许名单）的第三方启动器 AppID；若 `login_with_xbox` 返回 403，说明该 AppID 未过审，
换一个已获批的 ID 或走官方 App ID Review 流程。审批通过后只需替换 Secret，代码零改动。

> 不要把 client_id 提交进仓库：它不是秘密，但公开仓库高频借用他人 AppID 容易被举报/吊销。

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
| `MS_CLIENT_ID` | 已过审的 Azure Application ID |
| `ADMIN_PASSWORD` | 管理员初始口令（首次登录时写入 KV，之后可在面板修改） |
| `HY2_SERVER` / `HY2_PASSWORD` / `HY2_FINGERPRINT` / `HY2_CERT_FP` | Hysteria 2 节点参数 |
| `REALITY_SERVER` / `REALITY_UUID` / `REALITY_PUBLIC_KEY` | VLESS REALITY 节点参数 |
| `EDGETUNNEL_URL` | 第三方 provider 地址 |

可选：`ORIGIN_API_BASE`（流量数据回源域名）、`BASE_PATH`（子路径部署）、`SUB_TOTAL_BYTES`。

**平台账号凭据（全局密钥、API Token、邮箱）绝不写进任何文件**，只用于本机 wrangler 登录态；
`.dev.vars` 已被 `.gitignore` 排除。提交前务必跑两次扫描：

```sh
./scripts/scan-secrets.sh
git add -A
./scripts/scan-secrets.sh --staged
```

## 数据回源与降级

Worker 本身不采集服务器流量。配置了 `ORIGIN_API_BASE` 时，`live` / `history` / `summary` /
`domains` 等接口通过 Worker 子请求回源，平台会自动注入 `CF-Worker` 等官方头，源站应同时校验
官方头与回源 IP 段（不要只靠请求头授权）。未配置或回源不可用时返回结构完整的空数据，
前端不会报错、界面保持原样。

Go 时代的 Hy2 采集器、配额踢人、Xray SSH 同步、Hostker 统计等能力不在 Worker 里实现，
完整代码可从 `archive/steam-host` 分支恢复，或由源站数据服务提供。

## 目录

```
src/worker.js       路由、会话、静态资源、设备码端点
src/mc.js           Microsoft / Xbox / Minecraft 登录链路
src/store.js        KV 用户存储、签名与加密、cookie
src/panel.js        面板 API（保持旧前端契约）
src/sub.js          订阅模板渲染
web/                UI + 3D 资源（原样）
sub-template.yaml   订阅模板（当前线上 yml，脱敏）
scripts/scan-secrets.sh  提交前明文扫描
```
