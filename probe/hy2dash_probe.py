#!/usr/bin/env python3
"""hy2dash 源站数据探针（默认监听 2096）。

这是从 Go 单体 collector.go 拆出来的独立后端采集模块：跑在 Hysteria 2 源站上，
不依赖 Worker 运行时。除采集外，还承担一项受控代发：把 Worker 无法直连的
Microsoft / Mojang 认证请求由源站出口发出（见 RELAY_OPS）。它不保管密钥、
不落盘令牌、不参与订阅下发。

数据来源：Hysteria 2 Traffic Stats API（默认 127.0.0.1:9999，Authorization 传裸 secret）。
对 Cloudflare 回源提供旧面板的 /api/* 数据契约；Worker 侧 src/panel.js 的
fromOrigin() 直接透传这些 JSON，前端 web/app.js 无需任何改动。

链路：Worker 子请求 -> 橙云 proxied 域名（不带端口）-> Origin Rule 改写回源端口
-> 本服务。边缘终止 TLS 后明文回源，故本服务只监听 HTTP，不监听公网 TLS。

访问控制（两层，缺一不可，无降级模式）：
  1. TCP 对端 IP 必须在 Cloudflare 回源 IP 段内；
  2. 请求必须带 CF 官方注入的 CF-Worker（必须与 CF_WORKER_VALUE 精确相等）与 CF-Ray。
CF_WORKER_VALUE 未配置时拒绝启动；本机 127.0.0.1 默认同样拒绝，
仅在显式设置 PROBE_ALLOW_LOOPBACK=1 时放行（供本机运维自测）。
仅靠请求头授权是不够的，因此同时校验回源 IP 段。
"""

import ipaddress
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

STATS_URL = os.environ.get("HY2_STATS_URL", "http://127.0.0.1:9999").rstrip("/")
STATS_SECRET = os.environ.get("HY2_STATS_SECRET", "")
PORT = int(os.environ.get("PROBE_PORT", "2096"))
DATA_DIR = os.environ.get("PROBE_DATA_DIR", "/var/lib/hy2dash-probe")
CF_WORKER_VALUE = os.environ.get("CF_WORKER_VALUE", "")
# 本机运维放行必须显式开启，默认关闭；不再无条件信任 127.0.0.1。
ALLOW_LOOPBACK = os.environ.get("PROBE_ALLOW_LOOPBACK", "") == "1"
POLL_SECONDS = 2
SLOW_SECONDS = 30
MAX_HISTORY_LINES = 200000

# 认证代发：Worker -> /api/relay/mc -> 本服务 -> 固定的微软/Mojang 端点。
# 只接受 op 名，绝不接受调用方提供的 URL，因此不是开放代理。
# Cloudflare Workers 的出站 IP 被 api.minecraftservices.com 前置 WAF 拦截
# （403 text/html），而源站出口正常，故由本服务代发。
RELAY_OPS = {
    "devicecode": ("POST", "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode"),
    "token":      ("POST", "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"),
    "xbl":        ("POST", "https://user.auth.xboxlive.com/user/authenticate"),
    "xsts":       ("POST", "https://xsts.auth.xboxlive.com/xsts/authorize"),
    "mc_login":   ("POST", "https://api.minecraftservices.com/authentication/login_with_xbox"),
    "profile":    ("GET",  "https://api.minecraftservices.com/minecraft/profile"),
}
RELAY_HEADER_ALLOW = ("Content-Type", "Accept", "Authorization")
RELAY_TIMEOUT = 15
RELAY_MAX_BODY = 64 * 1024

# Cloudflare 官方回源 IPv4 段快照（https://www.cloudflare.com/ips-v4）。
CF_V4 = [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
    "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
    "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
    "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
]
CF_V6 = [
    "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
    "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
]
CF_NETS = [ipaddress.ip_network(x) for x in CF_V4 + CF_V6]

LOCK = threading.RLock()
LIVE = {}
ONLINE = {}
USER_TOTAL = {}
STATE = {
    "started": time.time(),
    "last_ok": 0,
    "last_error": "not polled yet",
    "count": 0,
}
os.makedirs(DATA_DIR, exist_ok=True)


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def stats_get(path, timeout=4):
    req = urllib.request.Request(STATS_URL + path, headers={
        "Authorization": STATS_SECRET,
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def relay_call(op, supplied_headers, body):
    """按 op 映射表代发一次 HTTP 请求；响应状态与正文原样回传，不落盘、不记日志。"""
    method, url = RELAY_OPS[op]
    headers = {"User-Agent": "hy2dash-relay/1.0"}
    if isinstance(supplied_headers, dict):
        for k in RELAY_HEADER_ALLOW:
            v = supplied_headers.get(k)
            if isinstance(v, str) and 0 < len(v) <= 2048 and "\r" not in v and "\n" not in v:
                headers[k] = v
    data = body.encode("utf-8") if method == "POST" and body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=RELAY_TIMEOUT) as r:
            text = r.read(RELAY_MAX_BODY * 4).decode("utf-8", "replace")
            return {"status": r.status, "body": text}
    except urllib.error.HTTPError as e:
        # 非 2xx 的响应体必须原样回传：authorization_pending、Mojang 的
        # errorMessage 等都在错误响应里，Worker 侧要靠它给出准确诊断。
        text = e.read(RELAY_MAX_BODY * 4).decode("utf-8", "replace")
        return {"status": e.code, "body": text}
    except Exception as e:
        log(f"relay {op} upstream error: {type(e).__name__}")
        return {"error": f"upstream {type(e).__name__}"}


def ts(value):
    if not value:
        return 0
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except Exception:
        return 0


def host_of(conn):
    raw = conn.get("s") or conn.get("a") or ""
    if not raw:
        return ""
    if raw.startswith("[") and "]" in raw:          # IPv6:port
        return raw[1:raw.index("]")]
    return raw.rsplit(":", 1)[0] if ":" in raw else raw


def history_path(day):
    return os.path.join(DATA_DIR, f"history-{day}.jsonl")


def append_history(conn):
    day = datetime.fromtimestamp(conn.get("t2") or time.time(), timezone.utc).strftime("%Y-%m-%d")
    try:
        with open(history_path(day), "a", encoding="utf-8") as f:
            f.write(json.dumps(conn, ensure_ascii=False) + "\n")
    except OSError as e:
        log(f"history write failed: {e}")


def read_history(day):
    p = history_path(day)
    if not os.path.exists(p):
        return []
    out = []
    try:
        with open(p, encoding="utf-8") as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    continue
                if len(out) >= MAX_HISTORY_LINES:
                    break
    except OSError:
        return []
    return out


def poll_streams():
    now = int(time.time())
    data = stats_get("/dump/streams")
    streams = data.get("streams", []) if isinstance(data, dict) else []
    seen = set()
    with LOCK:
        for e in streams:
            key = f"local/{e.get('auth', '')}/{e.get('connection', 0):08X}/{e.get('stream', 0)}"
            seen.add(key)
            cur = LIVE.get(key)
            start = ts(e.get("initial_at")) or now
            last = ts(e.get("last_active_at")) or now
            if cur:
                cur.update({
                    "a": e.get("req_addr") or cur.get("a", ""),
                    "s": e.get("hooked_req_addr") or cur.get("s", ""),
                    "st": e.get("state", ""), "tx": e.get("tx", 0),
                    "rx": e.get("rx", 0), "t1": last,
                })
            else:
                LIVE[key] = {
                    "k": key, "srv": "local", "u": e.get("auth", ""),
                    "a": e.get("req_addr", ""), "s": e.get("hooked_req_addr", ""),
                    "st": e.get("state", ""), "tx": e.get("tx", 0),
                    "rx": e.get("rx", 0), "t0": start, "t1": last,
                }
        for key in [k for k in LIVE if k not in seen]:
            done = dict(LIVE.pop(key))
            done["t2"] = now
            done["d"] = max(0.0, float(now - done.get("t0", now))) + 0.001
            append_history(done)
        STATE.update(last_ok=now, last_error="", count=len(streams))


def poll_slow():
    traffic = stats_get("/traffic")
    online = stats_get("/online")
    with LOCK:
        if isinstance(traffic, dict):
            for u, v in traffic.items():
                if isinstance(v, dict):
                    USER_TOTAL[u] = {"tx": int(v.get("tx", 0)), "rx": int(v.get("rx", 0))}
        if isinstance(online, dict):
            ONLINE.clear()
            ONLINE.update({k: int(v) for k, v in online.items()})


def collector():
    last_slow = 0
    while True:
        try:
            poll_streams()
        except Exception as e:
            with LOCK:
                STATE["last_error"] = f"dump/streams: {type(e).__name__}: {e}"
            log(STATE["last_error"])
        if time.time() - last_slow >= SLOW_SECONDS:
            try:
                poll_slow()
                last_slow = time.time()
            except Exception as e:
                log(f"slow poll: {type(e).__name__}: {e}")
        time.sleep(POLL_SECONDS)


def summary(days):
    days = max(1, min(90, days))
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    buckets = {}
    domains = {}
    total_tx = total_rx = 0
    total_conn = 0
    for i in range(days):
        day = datetime.fromtimestamp(
            time.time() - (days - 1 - i) * 86400, timezone.utc
        ).strftime("%Y-%m-%d")
        buckets[day] = {"day": day, "tx": 0, "rx": 0}
    for day in buckets:
        for c in read_history(day):
            tx, rx = int(c.get("tx", 0)), int(c.get("rx", 0))
            buckets[day]["tx"] += tx
            buckets[day]["rx"] += rx
            total_tx += tx
            total_rx += rx
            total_conn += 1
            h = host_of(c)
            if h:
                d = domains.setdefault(h, {"addr": h, "count": 0, "tx": 0, "rx": 0})
                d["count"] += 1
                d["tx"] += tx
                d["rx"] += rx
    t = buckets.get(today, {"tx": 0, "rx": 0})
    return {
        "today_tx": t["tx"], "today_rx": t["rx"],
        "total_tx": total_tx, "total_rx": total_rx, "total_conn": total_conn,
        "days": [buckets[d] for d in sorted(buckets)],
        "top_domains": sorted(domains.values(), key=lambda x: x["tx"] + x["rx"], reverse=True)[:20],
    }


def history(day, q, limit, offset):
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day or ""):
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    rows = read_history(day)
    if q:
        needle = q.lower()
        rows = [c for c in rows if needle in json.dumps(c, ensure_ascii=False).lower()]
    rows.sort(key=lambda c: c.get("t2", 0), reverse=True)
    return {"date": day, "total": len(rows), "rows": rows[offset:offset + limit]}


def snapshot():
    with LOCK:
        live = sorted(LIVE.values(), key=lambda c: c.get("tx", 0) + c.get("rx", 0), reverse=True)
        return {
            "live": live, "count": len(live),
            "online": dict(ONLINE), "user_total": dict(USER_TOTAL),
            "last_error": STATE["last_error"], "last_ok": STATE["last_ok"],
            "uptime": round(time.time() - STATE["started"], 1),
        }


class Handler(BaseHTTPRequestHandler):
    server_version = "hy2dash-probe/1.0"

    def log_message(self, fmt, *args):
        log(f"{self.client_address[0]} {fmt % args}")

    def client_ok(self):
        peer = self.client_address[0]
        if peer in ("127.0.0.1", "::1"):
            if not ALLOW_LOOPBACK:
                log("rejected loopback: PROBE_ALLOW_LOOPBACK not enabled")
            return ALLOW_LOOPBACK
        try:
            addr = ipaddress.ip_address(peer)
        except ValueError:
            return False
        if not any(addr in net for net in CF_NETS):
            return False
        cw = self.headers.get("CF-Worker", "")
        if not cw or not self.headers.get("CF-Ray"):
            return False
        if not CF_WORKER_VALUE or cw != CF_WORKER_VALUE:
            log(f"rejected peer={peer} cf-worker={cw!r} (strict value check)")
            return False
        log(f"accepted peer={peer} cf-worker={cw!r} cf-ray={bool(self.headers.get('CF-Ray'))}")
        return True

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_relay(self):
        """POST /api/relay/mc：只接受 op 名的受控代发，不接收任意 URL。"""
        if self.command != "POST":
            return self.send_json({"error": "method not allowed"}, 405)
        if not self.client_ok():
            return self.send_json({"error": "forbidden"}, 403)
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.send_json({"error": "bad content length"}, 400)
        if not 0 < n <= RELAY_MAX_BODY:
            return self.send_json({"error": "bad body size"}, 413)
        try:
            req = json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self.send_json({"error": "bad json"}, 400)
        if not isinstance(req, dict) or req.get("op") not in RELAY_OPS:
            return self.send_json({"error": "unknown op"}, 400)
        body = req.get("body", "")
        if not isinstance(body, str) or len(body) > RELAY_MAX_BODY:
            return self.send_json({"error": "bad body"}, 413)
        out = relay_call(req["op"], req.get("headers"), body)
        return self.send_json(out, 502 if "error" in out else 200)

    def dispatch(self):
        p = urlparse(self.path).path.rstrip("/") or "/"
        if p == "/api/relay/mc":
            return self.handle_relay()
        return self.handle_api()

    def handle_api(self):
        if self.command != "GET":
            return self.send_json({"error": "method not allowed"}, 405)
        if not self.client_ok():
            return self.send_json({"error": "forbidden"}, 403)
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        p = u.path.rstrip("/") or "/"
        try:
            if p == "/api/health":
                s = snapshot()
                return self.send_json({
                    "ok": True, "upstream_ok": not s["last_error"],
                    "last_error": s["last_error"], "last_ok": s["last_ok"],
                    "uptime": s["uptime"], "live": s["count"],
                })
            if p == "/api/live":
                return self.send_json(snapshot())
            if p == "/api/summary":
                return self.send_json(summary(int(q.get("days", 7))))
            if p == "/api/history":
                limit = max(1, min(500, int(q.get("limit", 200))))
                offset = max(0, int(q.get("offset", 0)))
                return self.send_json(history(q.get("date", ""), q.get("q", ""), limit, offset))
            if p == "/api/overview":
                with LOCK:
                    tx = sum(v["tx"] for v in USER_TOTAL.values())
                    rx = sum(v["rx"] for v in USER_TOTAL.values())
                return self.send_json({"users_tx": tx, "users_rx": rx, "device": None})
            # Worker 用户身份是 MC UUID，与 hy2 auth 用户不是同一套，
            # 没有真实数据可给：明确 501，不返回结构完整的空数据冒充正常响应。
            if p in ("/api/my/live", "/api/my/domains"):
                return self.send_json({
                    "error": "用户维度流量明细未实现：MC UUID 与 hy2 auth 无映射",
                }, 501)
            return self.send_json({"error": "not found"}, 404)
        except Exception as e:
            return self.send_json({"error": f"{type(e).__name__}: {e}"}, 500)

    do_GET = do_POST = do_PUT = do_HEAD = dispatch


def main():
    if not CF_WORKER_VALUE:
        raise SystemExit("CF_WORKER_VALUE 未配置：拒绝以弱校验模式启动")
    if ALLOW_LOOPBACK:
        log("WARNING: PROBE_ALLOW_LOOPBACK=1，本机请求跳过访问控制")
    threading.Thread(target=collector, daemon=True, name="collector").start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    log(f"probe listening on 0.0.0.0:{PORT}; stats={STATS_URL}; CF-Worker strict={bool(CF_WORKER_VALUE)}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
