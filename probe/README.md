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

## 故障方向：谁连谁

- 探针**不主动连 Cloudflare**。全文件唯一的出站是 `127.0.0.1:9999`（hysteria stats）、
  `127.0.0.1:10085`（xray api），以及认证代发里写死的微软 / Mojang 域名。没有任何
  通往 Worker、自定义域或 `*.workers.dev` 的请求。
- 所以「Cloudflare 挂了 / DNS 记录删了 / 回源规则断了」对源站是**零新增负载**：探针只会
  静止，每分钟失败的定时任务发生在 Cloudflare 侧，源站这边连一次重试都不会发。
  所有出站调用都带超时（stats 4s、xray 5s、代发 15s），所有循环都有 sleep，没有自旋。
- 反过来「探针挂了」影响是全局的：它是 hysteria 的 HTTP 认证后端，新连接会全部认证失败
  （已在线的会话不受影响）。因此 `hy2dash-probe.service` 必须 `Restart=always`。
- Cloudflare 长期不可达时的行为：认证继续用磁盘上最后一份 `quota-users.json`；Worker 的
  Cron 拿不到用量，**限额执行会停摆**（不误封，也不解封、不封禁），恢复后自动续上。
  要避免这种情况，`ORIGIN_API_BASE` / `PROBE_TOKEN` 的可用性本身就是被监控项。

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
| `GET /api/quota/usage` | `{month, users:{uuid:{tx,rx}}}` —— 当月按用户的累计用量 |
| `PUT /api/quota/users` | `{ok, count}` —— 接收 Worker 推来的完整用户快照 |
| `POST /auth/hy2` | `{ok, id}` —— Hysteria 2 的 HTTP 认证后端（仅回环） |

### 每用户凭证与限额执行

Worker 是策略方（持有 KV 里的 `hy2_pass`、`vless_uuid`、`monthly_gb`），探针只执行：

- `POST /auth/hy2`：只认快照里的 `hy2_pass`（`PASS_INDEX`），blocked / 停用一律 `ok:false`，
  客户端表现为连不上（超时）。只接受 `127.0.0.1` / `::1`，hysteria 从本机回环调用。
- `PUT /api/quota/users`：body 是**完整快照**（`uuid`、`hy2_pass`、`vless_uuid`、`blocked`、
  `unlimited`、`enabled`、`monthly_gb`）。落盘 `quota-users.json`（0600）后：新变 blocked 的
  用户 `/kick` 断线；随后 `xray api adu/rmu` 让 VLESS 用户表与快照一致（blocked 的 UUID 被移除）。
- `GET /api/quota/usage`：当月累计，来源是 `/traffic`（hy2，按 auth id）与
  `xray api statsquery -reset`（按 `email=UUID`）的增量，`quota-usage.json` 落盘。
- 启动时若没有 `quota-users.json`（`SNAPSHOT_READY=false`），**不做 xray 对账**，避免把
  现有用户当成「多余」删掉。

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
- 边缘到源站是明文回源，token 会经过这一段，务必保持回源 IP 段与共享令牌校验。

## 访问控制（三层，缺一不可，无降级模式）

0. **accept 层**：`ProbeServer.process_request` 在建立线程之前就判断对端 IP，
   不是 Cloudflare 回源段、也不是本机回环的连接**直接 close**（不解析请求、不写日志）。
   端口 2096 只能对公网监听（Cloudflare 没法回源到内网地址），所以这一层是挡扫描器的第一道。
1. **回源 IP 段**：TCP 对端必须落在 `hy2dash_probe.py` 内置的 Cloudflare 官方 v4/v6 回源段内。
2. **共享令牌**：请求必须带 `X-Probe-Token`，值与 `PROBE_TOKEN` 完全一致（`hmac.compare_digest`）。

**并发与日志上限**：`MAX_CONNECTIONS = 256`（信号量，超出直接关连接），连接空闲 10 秒
`Handler.timeout` 断开；被拒日志按来源每 10 秒最多一条，压制的条数在下一条里带出来。
1 vCPU 的机器上，这三项决定「被扫」时是掉几个连接还是整机卡死。

**回源段漂移**：accept 层用的就是代码里这份静态列表，Cloudflare 新增地址段而这里没跟上的话，
来自新段的回源会被直接关掉（症状是偶发失败，日志 `closed <ip>: 不是 Cloudflare 回源地址`）。
官方列表 2017 年以来只变过 5 次（最近一次 2023-09-28 给 ips-v6 加 `2405:b500::/32`），
但仍建议定期比对：

```sh
python3 scripts/check-cf-ranges.py     # 有差异退出码 1，并打印缺哪段
```


**为什么不用 `CF-Worker` / `CF-Ray` 做门禁**：Cloudflare 只在经边缘转发的子请求上注入这两个头。
Cron Trigger 发起的子请求不一定带（实测有整分钟只到 IP 段、两个头都没有的情况），
带的时候 `CF-Worker` 的值是 `<script>.<subdomain>.workers.dev` 而不是自定义域。
用它做严格比对会让定时任务永远 403，且失败点在源站侧、Worker 侧只看到 403，很难定位。
这两个头现在只写进日志当旁证。令牌由 Worker 自己加进请求头，与调用来源无关。

`PROBE_TOKEN` 未配置时 `main()` 直接 `SystemExit`，**拒绝以弱校验模式启动**；
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
   # 填入 PROBE_TOKEN：同一份值再 `wrangler secret put PROBE_TOKEN`（Worker 侧）
   ```

2. 在源站 clone 本仓库，以 root 执行：

   ```sh
   sh probe/install.sh
   ```

   脚本会安装 `hy2dash_probe.py` 与 systemd 单元、备份并幂等写入 Hysteria 2 的
   `trafficStats` 段、`daemon-reload`、启用探针，并**重启一次 hysteria-server**。

3. 平台侧：建一个橙云 proxied 域名指向源站，配 Origin Rule 把该域名回源端口改为 2096；
   Worker 注入 `ORIGIN_API_BASE=https://<PROXIED_HOSTNAME>`。

4. `PROBE_TOKEN` **必须在启动前配好**，且与 Worker 侧 Secret 同值；
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
