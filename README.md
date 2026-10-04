# hy2dash

**极轻量的 Hysteria2 连接监控面板** —— Go 单静态二进制，纯标准库，无运行时依赖，常驻内存约 **12MB**。

> 实时 / 历史查看客户端通过 Hysteria2 访问了哪些地址、每条连接上下行多少流量、持续多久。
> 数据来自 Hysteria2 自带的 Traffic Stats API，**不需要更换代理内核、客户端零改动**。

---

## 功能

| 能力 | 说明 |
|---|---|
| **实时连接表** | 目标地址（域名/IP:端口）、用户、状态、上/下行字节、已持续时长、最后活跃；1 秒刷新、可搜索、可暂停 |
| **历史查询** | 按天落盘，支持日期 + 关键字检索、分页 |
| **概览** | 今日流量、7/14/30 天曲线（Canvas 手绘，无图表库）、Top 20 目标 |
| **访问控制** | 单管理员；首次启动随机生成用户名+密码并打印到终端；PBKDF2-SHA256（15 万轮 + 随机盐）存储；HMAC 签名无状态会话 |
| **部署友好** | 内嵌前端（`go:embed`）、只监听 127.0.0.1、可挂在子路径（`base_path`）、支持多监听地址 |
| **强制 HTTPS** | 基于 `X-Forwarded-Proto` 的 301 跳转，兼容 Cloudflare Flexible（回源为 HTTP）而不产生跳转循环 |

## 架构

```
Hysteria2 trafficStats API  (/dump/streams, /traffic, /online)
        │  1s 轮询 + 差分
        ▼
   hy2dash  (Go / 纯 stdlib / CGO_ENABLED=0 / 单静态二进制)
     ├─ 采集器：连接建立→关闭 差分，内存环形缓冲(400) + 按天 JSONL 落盘
     └─ HTTP：go:embed 内嵌 UI + JSON API，多监听地址 + base_path 前缀
        ▼
   浏览器
```

**为什么不用 SQLite**：省掉 CGO 与驱动依赖（连带减小二进制与内存），改用「按天 JSONL + 固定容量
内存环形缓冲」；历史查询直接流式扫描当天文件，个人使用量级下足够快。

**为什么是 Go**：Python 光解释器就 >10MB、Node >30MB；Go 单二进制、无运行时、
stdlib 自带 HTTP/JSON/PBKDF2，部署零依赖。

## 快速开始

### 1. 让 Hysteria2 暴露统计接口

```yaml
# /etc/hysteria/config.yaml 追加
trafficStats:
  listen: 127.0.0.1:9999
  secret: "换成你自己的随机串"
```

重启 hysteria2 后验证：

```bash
curl -H "Authorization: 你的secret" http://127.0.0.1:9999/dump/streams
```

### 2. 编译安装

```bash
git clone https://github.com/Bemly/hy2dash && cd hy2dash
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /usr/local/bin/hy2dash .

sudo mkdir -p /etc/hy2dash /var/lib/hy2dash
sudo cp hy2dash.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now hy2dash
```

首次启动会随机生成管理员凭据并打印到终端 / journal：

```bash
journalctl -u hy2dash --no-pager | grep -A3 首次启动
```

### 3. 访问

默认只监听 `127.0.0.1:8787`。三种暴露方式任选：

| 方式 | 做法 |
|---|---|
| SSH 隧道（零暴露） | `ssh -N -L 8787:127.0.0.1:8787 you@server` → `http://127.0.0.1:8787/dash/` |
| Cloudflare Tunnel | 出站长连接，不开入站端口（推荐） |
| 反代 / CF 回源 | 配 `public_listen`，并把防火墙限制为回源 IP 段 |

## 配置

`/etc/hy2dash/config.json`（首次启动自动生成，0600）

```json
{
  "listen": "127.0.0.1:8787",          // 本机监听
  "public_listen": "",                  // 例 "0.0.0.0:80"（给反代/CF 回源，务必配防火墙）
  "public_tls_listen": "",              // 例 "0.0.0.0:443"（配合 CF Full 模式）
  "tls_cert": "", "tls_key": "",
  "base_path": "/dash",                 // 面板挂载前缀，可藏路径
  "poll_ms": 1000,                      // 采集间隔
  "retention_days": 90,
  "data_dir": "/var/lib/hy2dash/data",
  "hysteria_stats_url": "http://127.0.0.1:9999",
  "hysteria_stats_secret": "***",
  "admin_user": "admin_xxxxxx",
  "pass_salt": "***", "pass_hash": "***", "pass_iter": 150000,
  "session_key": "***"
}
```

## API

均带 `base_path` 前缀（下表以 `/dash` 为例）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/dash/api/login` | 登录（同 IP 5 分钟 12 次限速） |
| POST | `/dash/api/logout` | 退出 |
| POST | `/dash/api/password` | 修改密码（需原密码，回写加盐哈希） |
| GET | `/dash/api/live` | 实时连接 + 在线用户 + 用户累计 |
| GET | `/dash/api/recent?limit=` | 最近关闭的连接 |
| GET | `/dash/api/history?date=&q=&limit=&offset=` | 历史查询 |
| GET | `/dash/api/summary?days=` | 按天聚合 + Top20 目标 |
| GET | `/dash/api/health` | 真实 RSS / 堆 / 协程数 |

## 内存

实测常驻 **12.0 ~ 13.1MB**（其中堆仅 0.4~1.0MB，其余是 Go 运行时与代码页）。已做的优化：

- `CGO_ENABLED=0` + `-trimpath -ldflags="-s -w"`（二进制约 6.6MB）
- 代码内 `debug.SetGCPercent(25)` + `debug.SetMemoryLimit(24MiB)`
- `HY2DASH_GOMAXPROCS=1`；systemd `MemoryHigh=64M` / `MemoryMax=96M` 硬兜底
- 每 90s `debug.FreeOSMemory()` 把内存还给系统
- 无 SQLite / 无 ORM / 无 Web 框架 / 无 Node 构建链

同机对照：`firewalld 47.7MB`、`hysteria2 33.0MB`、**hy2dash 12.2MB**。

## 说明

- 连接明细来自 Hysteria2 的 TCP stream 列表；**UDP 会话不在其中**（如需覆盖可开启 hysteria debug 日志另做采集）
- 面板内容等价于客户端的完整访问记录，请务必：只监听本机或限制来源、使用强密码、不要公开部署
- 历史默认保留 90 天，每条约 200 字节

## 界面

UI 的设计语言取自 [LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI)（MIT）：
暖纸/墨黑双色面、青铜强调色、1px 细线、HUD 角标。未使用其 Three.js 部分，重写为零构建的静态页面。

## License

MIT
