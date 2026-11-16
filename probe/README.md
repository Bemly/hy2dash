# probe/ — 源站数据采集后端

## 定位：从 Go 单体拆出来的独立模块

`main` 变成 Cloudflare Worker 之后，登录、订阅、会话都在边缘运行，但两件事必须落在
Hysteria 2 源站：流量数据采集，以及**微软 / Mojang 认证请求的代发**。这一层原本是
`archive/steam-host` 分支里 Go 单体自带的 `collector.go`；本目录就是把它**拆开、独立**
后的实现：一个纯标准库 Python 服务，跑在源站，不依赖 Worker 运行时、不保管密钥、
不改动 `web/` 前端的任何一行。

两条链路共用一个橙云 proxied 回源入口；`ORIGIN_API_BASE` 指向它且**不能带端口**，
端口改写由平台的 Origin Rule 完成：

| Worker 侧 | 请求 | probe 侧动作 |
| --- | --- | --- |
| `src/panel.js` `fromOrigin()` | `GET /api/live` 等 | 读采集数据并透传 JSON |
| `src/mc.js` `relayCall()` | `POST /api/relay/mc` | 按固定映射表代发到微软 / Mojang |

`probe/hy2dash_probe.py` 监听 `0.0.0.0:2096` 明文 HTTP；边缘终止 TLS 后明文回源，
所以本服务不监听公网 TLS。采集数据来自 Hysteria 2 `trafficStats`（`127.0.0.1:9999`）。

## 接口契约

与旧面板完全一致，`src/panel.js` 的 `fromOrigin()` 直接透传，前端无需适配。

| 路径 | 返回 |
| --- | --- |
| `/api/health` | `ok`、`upstream_ok`、`last_error`、`last_ok`、`uptime`、`live` |
| `/api/live` | `live[]`、`count`、`online`、`user_total`、`last_error`、`last_ok`、`uptime` |
| `/api/summary?days=7` | `today_tx/rx`、`total_*`、`days[]`、`top_domains[]` |
| `/api/history?date=YYYY-MM-DD&q=&limit=200&offset=0` | `date`、`total`、`rows[]` |
| `/api/overview` | `users_tx`、`users_rx`、`device` |
| `/api/my/live`、`/api/my/domains` | `501` + 明确错误（无映射，不返回空数据） |
| `POST /api/relay/mc` | `{status, body}` —— 认证请求代发结果（见下节） |

`/api/my/*` 返回 501：Worker 身份是 Minecraft UUID，与 Hysteria 2 的 auth 用户不是同一套，
没有真实数据可给；结构完整的空数据会被前端当成正常响应，因此不返回。

采集器每 2 秒拉一次 `/dump/streams` 维护活跃连接，连接结束落一行 JSONL 到
`PROBE_DATA_DIR/history-YYYY-MM-DD.jsonl`；每 30 秒拉一次 `/traffic` 与 `/online`。
`summary` 与 `history` 直接由这些文件聚合，无数据库依赖。

## 认证代发：`POST /api/relay/mc`

Cloudflare Workers 的出站 IP 被 `api.minecraftservices.com` 前置的 Cloudflare WAF 拦截
（`403 text/html` 拦截页而非 JSON），而源站出口正常。因此 Worker 不直发认证请求，
改为把 6 个调用交给本服务代发。

请求体（Worker → probe）：

```json
{ "op": "mc_login", "headers": {"Content-Type": "application/json"}, "body": "{\"identityToken\":\"...\"}" }
```

响应体：`{"status": 401, "body": "<上游原始响应文本>"}`。**非 2xx 的上游响应体原样回传**，
因为 `authorization_pending`、Mojang 的 `errorMessage` 都在错误响应里，Worker 要靠它诊断。

`RELAY_OPS` 是固定的 6 项映射表：

| op | 目标 |
| --- | --- |
| `devicecode` / `token` | `login.microsoftonline.com/consumers/oauth2/v2.0/*` |
| `xbl` / `xsts` | `user.auth.xboxlive.com` / `xsts.auth.xboxlive.com` |
| `mc_login` / `profile` | `api.minecraftservices.com` |

安全边界：

- **只接受 op 名，绝不接受调用方提供的 URL**，所以不是开放代理；未知 op 返回 400。
- 请求头白名单只有 `Content-Type` / `Accept` / `Authorization`，其余一律丢弃，并拒绝
  含换行的值；body 上限 64 KiB，非 POST 返回 405。
- 代发与采集共用同一套双层访问控制（见下节）。
- 响应体只在内存里，不写日志、不写 JSONL；日志只记录固定路径与上游异常类型。
- 边缘到源站是明文回源，token 会经过这一段，务必保持回源 IP 段与 `CF-Worker` 精确值校验。

## 访问控制（两层，缺一不可，无降级模式）

1. **回源 IP 段**：TCP 对端必须落在 `hy2dash_probe.py` 内置的 Cloudflare 官方 v4/v6 回源段内。
2. **官方头**：请求必须同时带 `CF-Worker` 与 `CF-Ray`，且 `CF-Worker` **必须精确等于**
   `CF_WORKER_VALUE`。

`CF_WORKER_VALUE` 未配置时 `main()` 直接 `SystemExit`，**拒绝以弱校验模式启动**；
不存在「只要求头存在」的中间态。本机 `127.0.0.1` 默认同样拒绝，只有显式设置
`PROBE_ALLOW_LOOPBACK=1` 才放行（临时自测用，测完移除）。

只靠请求头授权是不够的 —— 任何客户端都能伪造头，所以 IP 段校验必须保留。不带自制头、
不把源站地址写进公共 DNS、不建灰云记录。`/api/relay/mc` 与所有 `/api/*` 走完全相同的
校验，没有额外后门。

## 部署（在源站本机执行）

1. 准备运行期配置（**绝不入库**）：

   ```sh
   cp probe/probe.env.example /etc/hysteria/probe.env
   chmod 600 /etc/hysteria/probe.env
   # 填入 HY2_STATS_SECRET：python3 -c "import secrets; print(secrets.token_hex(24))"
   ```

2. 在源站 clone 本仓库，以 root 执行：

   ```sh
   sh probe/install.sh
   ```

   脚本会安装 `hy2dash_probe.py` 与 systemd 单元、备份并幂等写入 Hysteria 2 的
   `trafficStats` 段、`daemon-reload`、启用探针，并**重启一次 hysteria-server**。

3. 平台侧：建一个橙云 proxied 域名指向源站，配 Origin Rule 把该域名回源端口改为 2096；
   Worker 注入 `ORIGIN_API_BASE=https://<PROXIED_HOSTNAME>`。

4. `CF_WORKER_VALUE` **必须在启动前配好**（平台侧 Worker 子请求注入的实测值）；
   未配置时探针拒绝启动，没有「先留空观察再收紧」的宽松阶段。
   如确需本机自测，临时在 env 里加 `PROBE_ALLOW_LOOPBACK=1` 放行 127.0.0.1，测完立即移除。

验证：

```sh
systemctl is-active hysteria-server hy2dash-probe
curl -fsS http://127.0.0.1:2096/api/health
journalctl -u hy2dash-probe -n 20 --no-pager
```

公网直连源站 2096 应返回 403；普通浏览器访问 proxied 域名也应 403；只有 Worker 子请求
才返回 200。未设 `PROBE_ALLOW_LOOPBACK` 时，源站本机 `curl 127.0.0.1:2096/api/health`
同样应 403 —— 这是预期行为，不是故障。

## 文件

| 文件 | 用途 |
| --- | --- |
| `hy2dash_probe.py` | 采集 + HTTP API + 认证代发主程序（仅标准库） |
| `hy2dash-probe.service` | systemd 单元，`EnvironmentFile=/etc/hysteria/probe.env` |
| `setup_origin.py` | 幂等把 `trafficStats` 段追加到 Hysteria 2 配置 |
| `probe.env.example` | 变量名清单，无真实值 |
| `install.sh` | 源站本机一键安装/升级 |
| `README.md` | 本文档 |

真实凭据、源站地址、平台凭据一律不进仓库，只存在源站的 `/etc/hysteria/probe.env`
与本机 `~/.config/hy2dash/`（0600）。提交前 `scripts/scan-secrets.sh` 会检查本目录。
