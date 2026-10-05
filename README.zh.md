# hy2dash

**极轻量的 Hysteria2 机场 lite 面板** —— Go 单静态二进制，纯标准库，无运行时依赖，
常驻内存约 **12MB**。

> Steam 一键登录；每人一条私有订阅链接、独立 hysteria 身份。管理员看实时连接、
> 历史记录和每人用量。数据来自 Hysteria2 自带的 Traffic Stats API，
> **不需要更换代理内核、客户端零改动**。

[English](README.md) · [中文](README.zh.md)

---

## 角色

| 端 | 谁 | 能看到什么 |
|---|---|---|
| **管理端**（仅一个账号） | 站长 | 全部 hysteria 上游的实时/历史/概览、用户列表与用量、启用/删除/换链接 |
| **用户端**（Steam 登录） | 其他人 | 自己的流量、自己的订阅链接（复制 + 一键导入 Clash） |

会话为 HMAC 签名且带角色（`v1|role|user|exp`）；旧格式会话一律失效，升级后所有人重新登录一次。

## 用户与 hysteria 的对应

Hysteria2 用 `auth.type: userpass`，每条连接都带 `用户名:口令`，面板据此区分用户。
用户名来自**预置通道池**（默认 `u01…u08`）：首次 Steam 登录按顺序认领空闲通道，通道口令写死在
各 hysteria 配置**和** hy2dash 配置里（拼节点用）。结论：

- 用户注册永远不需要重启 hysteria。
- 通道用完后，管理员加通道（三处同改口令：两台 hysteria 配置 + hy2dash 配置，重启 hysteria）。
- 删除/停用用户会立刻吊销其面板会话和订阅链接；要彻底吊销其**连接权**，需轮换该通道口令（三处同改）。

## 订阅（取代 Cloudflare Worker）

`GET /<词-词-词>` —— 公开，token 鉴权，无需登录。token 为 3 个好记词
`-` 直连（可重复、有序；老 `{base}/` 下 32 位 hex 链接继续有效）。返回**只含该用户节点**的
Clash YAML（`servers` 里每台机器一条），外加按天口径的
`Subscription-Userinfo` 头（已用=今日，总量=今日已授）：

```
upload=<今日上行>; download=<今日下行>; total=<今日已授>
```

默认 `total` 为 10GiB；面板每续额一次加一份当天额度
（10G→20G……直到月封顶，需先用完当天额度），刷新订阅即生效。
Reality（VLESS/TCP）节点按人分配 UUID，但其流量暂未计量——配额目前只管 hysteria 用量。

YAML 正文来自 `sub-template.yaml`（`__NODES__` / `__NODE_NAMES__` 占位）。
配置文件同目录下如有 `sub-template.yaml`，优先用它覆盖内嵌默认——服务商相关的
规则放那里（永远不要提交真实密码）。

词组链接来自 `words.enc`（全量 4737 行的 ROT47 入库）；配置文件同目录下如有
`tag.txt`（明文）或 `tag.enc`（ROT47）则优先覆盖（永远不要提交该文件）。
用户自助换链 1 小时限 1 次（`POST /api/my/rotate`）。猜链限流：同 IP 错误
1 次/秒，累计 100 次后指数退避，全网 1 秒内超 5 个失败 IP 一律 429。

老共享链接（`/iku-iku-o-hohho`，原来走 Worker）返回 `410 Gone`：切 userpass 后旧单密码
全部失效，所有客户端必须换按人链接。

## 功能

| 能力 | 说明 |
|---|---|
| **实时连接表**（管理） | 节点、目标地址（域名/IP:端口）、用户、状态、上/下行、已持续、最后活跃；1 秒刷新、可搜索、可暂停 |
| **历史查询**（管理） | 按天落盘（含节点标记），日期 + 关键字检索、分页 |
| **概览**（管理） | 今日流量、7/14/30 天曲线（Canvas 手绘）、Top 20 目标 |
| **用户**（管理） | 列表与实时用量、启用/停用、删除、重置订阅 token |
| **访问控制** | Steam 登录（首次自动注册并认领通道）；单管理员独立密码；登录 12 次 / 5 分钟 / IP 限速 |
| **部署友好** | 内嵌前端（`go:embed`）、只监听 127.0.0.1、可挂子路径（`base_path`）、多监听地址 |

## 架构

```
Hysteria2 trafficStats API × N  (/dump/streams, /traffic, /online)
        │  1s 轮询 + 差分（实时，按节点合并）
        │  30s 缓存累计（用户列表、订阅流量头共用）
        ▼
   hy2dash  (Go / 纯 stdlib / CGO_ENABLED=0 / 单静态二进制)
     ├─ 采集器：连接建立→关闭差分，内存环形缓冲(400) + 按天 JSONL 落盘
     ├─ 用户库：users.json (0600)——PBKDF2 凭据、通道绑定、订阅 token
     └─ HTTP：登录/注册/按角色控制台/JSON API/按人订阅
        ▼
   浏览器 / Clash 客户端
```

**为什么不用 SQLite**：省掉 CGO 与驱动依赖，改用按天 JSONL + 固定环形缓冲 + 一个小 JSON
用户库；个人量级下足够快。

## 快速开始

### 1. Hysteria2：userpass 鉴权 + 统计接口

```yaml
# /etc/hysteria/config.yaml（每台机器同一套 user/pass 表）
auth:
  type: userpass
  userpass:
    u01: "<通道口令-1>"
trafficStats:
  listen: 127.0.0.1:9999
  secret: "<统计口令>"
```

### 2. 编译安装

```bash
git clone https://github.com/Bemly/hy2dash && cd hy2dash
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /usr/local/bin/hy2dash .

sudo mkdir -p /etc/hy2dash /var/lib/hy2dash
sudo cp hy2dash.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now hy2dash
```

首次启动打印随机管理员凭据：

```bash
journalctl -u hy2dash --no-pager | grep -A3 首次启动
```

### 3. 配置（`/etc/hy2dash/config.json`，0600）

```json
{
  "listen": "127.0.0.1:8787",
  "public_listen": "0.0.0.0:80",
  "base_path": "/dash",
  "quota_gb": 1200,
  "hysteria_nodes": [
    {"name": "us", "stats_url": "http://127.0.0.1:9999", "stats_secret": "***"},
    {"name": "jp", "stats_url": "http://127.0.0.1:19999", "stats_secret": "***"}
  ],
  "slots": [{"user": "u01", "pass": "***"}],
  "servers": [
    {"name": "node-us", "host": "203.0.113.4", "port": 36598, "ports": "36599-55555",
     "sni": "example.com", "cert_fp": "***"}
  ]
}
```

`"proto": "vless"` 的机器下发为 VLESS+REALITY（TCP）节点（`"port"`、
`"reality_pubkey"`、`"reality_shortid"`、`"reality_sni"`）；每人首次登录自动分配
UUID（存量用户自动回填）。

（老 `hysteria_stats_url/secret` 单字段会自动迁移。）

## API

均带 `base_path` 前缀（下表以 `/dash` 为例）。

| 方法 | 路径 | 谁 | 说明 |
|---|---|---|---|
| GET | `/dash/api/steam/login` | 公开 | 跳 Steam 登录（首次自动注册认领通道） |
| POST | `/dash/api/login` | 公开 | 管理员密码登录 |
| GET | `/dash/api/steam/login` | 公开 | Steam 登录（首次自动注册） |
| POST | `/dash/api/logout` | 登录 | 退出 |
| GET | `/dash/api/me` | 登录 | `{user, role}`（用户另有 `hy_user`、`sub_token`） |
| POST | `/dash/api/password` | 登录 | 改自己密码 |
| GET | `/dash/api/users` | 管理 | 用户列表 + 实时用量 + 通道占用 |
| POST | `/dash/api/user/enable` | 管理 | 启用/停用 |
| POST | `/dash/api/user/delete` | 管理 | 删除（释放通道） |
| POST | `/dash/api/user/rotate` | 管理 | 新订阅 token |
| POST | `/dash/api/user/quota` | 管理 | 按人配额 `{user, daily_gb, monthly_gb}`（0=默认） |
| POST | `/dash/api/my/renew` | 登录 | 再续一份当天额度（直到月封顶） |
| GET | `/dash/api/overview` | 管理 | 设备总额（HostKer 日同步）vs 用户合计 |
| POST | `/dash/api/hostker/refresh` | 管理 | 强制同步 HostKer |
| GET | `/dash/api/my/summary` | 登录 | 自己的用量 + 配额 |
| GET | `/dash/api/live` | 管理 | 实时 + 在线 + 每用户累计 |
| GET | `/dash/api/recent?limit=` | 管理 | 最近关闭 |
| GET | `/dash/api/history?date=&q=&limit=&offset=` | 管理 | 历史查询 |
| GET | `/dash/api/summary?days=` | 管理 | 聚合 + Top20 |
| GET | `/dash/api/health` | 公开 | RSS / 堆 / 协程数 |
| GET | `/dash/<token>` | token | 按人 Clash YAML + 用量头 |

## 内存

常驻 **12MB** 量级（堆 <1MB）。`CGO_ENABLED=0` + `-trimpath -ldflags="-s -w"`
（二进制约 7.5MB）、`SetGCPercent(25)` + `SetMemoryLimit(24MiB)`、每 90s
`FreeOSMemory()`、systemd `MemoryHigh=64M`/`MemoryMax=96M` 兜底。
无 SQLite / ORM / Web 框架 / Node 链；前端是零依赖原生 JS+CSS（之前的 RhineLabUI
构建归档在 `archive/rhinelab-ui` 分支）。

## 说明

- 连接明细来自 Hysteria2 的 TCP stream 列表；**UDP 会话不在其中**。
- 管理端内容等价于完整访问记录：只监听本机或限制来源，不要公开部署。
- 历史默认保留 90 天，每条约 200 字节。

## License

NASA-1.3（见 [LICENSE](LICENSE)）
