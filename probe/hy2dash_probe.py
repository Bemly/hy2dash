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
  2. 请求必须带 Worker 显式携带的 X-Probe-Token，且与 PROBE_TOKEN 完全一致。

为什么不再校验 CF-Worker：Cloudflare 只在「用户请求经边缘转发」的子请求上注入
CF-Worker / CF-Ray；Cron Trigger 发起的子请求不带这两个头，用它做门禁会让定时
任务永远 403。令牌由 Worker 自己加到请求头里，与调用来源无关，因此可靠。
CF-Worker / CF-Ray 仍会记录在日志里作为旁证，但不参与放行判定。

PROBE_TOKEN 未配置时拒绝启动；本机 127.0.0.1 默认同样拒绝，
仅在显式设置 PROBE_ALLOW_LOOPBACK=1 时放行（供本机运维自测）。
"""

import hmac
import ipaddress
import json
import os
import re
import subprocess
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
PROBE_TOKEN = os.environ.get("PROBE_TOKEN", "")
# 本机运维放行必须显式开启，默认关闭；不再无条件信任 127.0.0.1。
ALLOW_LOOPBACK = os.environ.get("PROBE_ALLOW_LOOPBACK", "") == "1"
POLL_SECONDS = 2
SLOW_SECONDS = 30
MAX_HISTORY_LINES = 200000

# ---- 每用户凭证 / 月度计量 / xray 用户编排 ----
# 限额策略由 Worker 判定（它持有 KV 与 monthly_gb），探针只负责：
#   1. hysteria HTTP 认证（按快照里的 hy2_pass 映射到面板 UUID，blocked 直接拒绝）；
#   2. 按 UUID 累计当月流量（/traffic 与 xray stats 的增量，持久化防重启丢账）；
#   3. 按快照增删 xray 用户（adu / rmu），保证被吊销的 UUID 立即不可用。
XRAY_API = os.environ.get("XRAY_API", "127.0.0.1:10085")
XRAY_BIN = os.environ.get("XRAY_BIN", "/usr/local/bin/xray")
VLESS_TAG = os.environ.get("XRAY_INBOUND_TAG", "vless-reality-in")
VLESS_PORT = int(os.environ.get("XRAY_INBOUND_PORT", "443"))
VLESS_FLOW = os.environ.get("XRAY_FLOW", "xtls-rprx-vision")

USERS_PATH = os.path.join(DATA_DIR, "quota-users.json")
USAGE_PATH = os.path.join(DATA_DIR, "quota-usage.json")
AUTH_MAX_BODY = 8 * 1024
QUOTA_MAX_BODY = 256 * 1024

USERS = {}          # uuid -> {pass, vless_uuid, blocked, unlimited, enabled, monthly_gb}
PASS_INDEX = {}     # hy2_pass -> uuid
USAGE = {"month": "", "users": {}, "last_hy2": {}}
# 没有可信快照时不得对账 xray：否则启动瞬间会把现有用户当成「多余」删掉。
SNAPSHOT_READY = False

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


def stats_post(path, payload, timeout=4):
    req = urllib.request.Request(
        STATS_URL + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": STATS_SECRET, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        r.read()
    return True


# ---------------- 每用户凭证 / 计量 / xray 编排 ----------------

def month_key(d=None):
    """自然月（Asia/Shanghai），与 Worker src/store.js 的 monthKey 保持一致。"""
    t = time.gmtime((d or time.time()) + 8 * 3600)
    return time.strftime("%Y-%m", t)


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, obj):
    """原子写入：临时文件 + os.replace，避免半截文件。"""
    tmp = path + ".tmp"
    # 快照里含每用户 hy2 密码，必须 0600。
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def load_quota_state():
    """启动时恢复用户快照与当月用量，重启不丢账、不误解封。"""
    global USERS, PASS_INDEX, USAGE, SNAPSHOT_READY
    snap = load_json(USERS_PATH, {"users": []})
    users = {}
    for u in snap.get("users", []) if isinstance(snap, dict) else []:
        if isinstance(u, dict) and u.get("uuid"):
            users[u["uuid"]] = u
    with LOCK:
        USERS = users
        PASS_INDEX = {u["hy2_pass"]: uid for uid, u in users.items() if u.get("hy2_pass")}
        saved = load_json(USAGE_PATH, {})
        USAGE = {
            "month": saved.get("month") or month_key(),
            "users": saved.get("users") or {},
            "last_hy2": saved.get("last_hy2") or {},
        }
        SNAPSHOT_READY = os.path.exists(USERS_PATH)
    log(f"quota state loaded: users={len(users)} month={USAGE['month']} ready={SNAPSHOT_READY}")


def save_usage_locked():
    """调用方必须已持有 LOCK。"""
    save_json(USAGE_PATH, USAGE)


def quota_snapshot():
    with LOCK:
        users = []
        for uid, u in USERS.items():
            users.append({
                "uuid": uid,
                "hy2_pass": u.get("hy2_pass") or u.get("pass") or "",
                "vless_uuid": u.get("vless_uuid") or "",
                "blocked": bool(u.get("blocked")),
                "unlimited": bool(u.get("unlimited")),
                "enabled": u.get("enabled", True) is not False,
                "monthly_gb": u.get("monthly_gb"),
            })
        return {"users": users}


def apply_users_snapshot(payload):
    """Worker 推送的完整用户快照：替换内存/磁盘状态，踢掉新封禁的 hy2，并对账 xray。"""
    global SNAPSHOT_READY
    incoming = payload.get("users") if isinstance(payload, dict) else None
    if not isinstance(incoming, list):
        raise ValueError("users must be a list")
    users = {}
    for u in incoming:
        if not isinstance(u, dict):
            continue
        uid = str(u.get("uuid") or "").strip()
        pwd = str(u.get("hy2_pass") or "").strip()
        if not uid or not pwd:
            continue
        users[uid] = {
            "hy2_pass": pwd,
            "vless_uuid": str(u.get("vless_uuid") or "").strip(),
            "blocked": bool(u.get("blocked")),
            "unlimited": bool(u.get("unlimited")),
            "enabled": u.get("enabled", True) is not False,
            "monthly_gb": u.get("monthly_gb"),
        }

    newly_blocked = []
    with LOCK:
        for uid, u in users.items():
            old = USERS.get(uid)
            if u["blocked"] and not (old and old.get("blocked")):
                newly_blocked.append(uid)
        USERS.clear()
        USERS.update(users)
        PASS_INDEX.clear()
        PASS_INDEX.update({u["hy2_pass"]: uid for uid, u in users.items()})
        save_json(USERS_PATH, quota_snapshot())
        SNAPSHOT_READY = True
    for uid in newly_blocked:
        try:
            stats_post("/kick", [uid])
            log(f"kicked blocked user {uid}")
        except Exception as e:
            log(f"kick {uid} failed: {type(e).__name__}: {e}")
    xray_reconcile()


def xray_run(command, *args, timeout=5):
    # --server 必须排在位置参数之前，否则 Go flag 解析会把它当成文件名/邮箱。
    return subprocess.run(
        [XRAY_BIN, "api", command, "--server=" + XRAY_API, *args],
        capture_output=True, text=True, timeout=timeout,
    )


def xray_current_emails():
    p = xray_run("inbounduser", "-tag=" + VLESS_TAG)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or "inbounduser failed").strip()[:200])
    data = json.loads(p.stdout or "{}")
    return {u.get("email") for u in data.get("users", []) if u.get("email")}


def xray_reconcile():
    """让 xray 的 clients 与快照一致：缺的 adu，多的 rmu。失败只记录，不影响采集。"""
    if not SNAPSHOT_READY:
        log("xray reconcile skipped: no trusted snapshot yet")
        return
    with LOCK:
        desired = {
            uid: u["vless_uuid"]
            for uid, u in USERS.items()
            if not u.get("blocked") and u.get("enabled", True) is not False and u.get("vless_uuid")
        }
    try:
        current = xray_current_emails()
    except Exception as e:
        log(f"xray reconcile skipped: {type(e).__name__}: {e}")
        return
    add = [uid for uid in desired if uid not in current]
    remove = [email for email in current if email not in desired]

    if add:
        snippet = {"inbounds": [{
            "tag": VLESS_TAG, "listen": "0.0.0.0", "port": VLESS_PORT,
            "protocol": "vless",
            "settings": {
                "decryption": "none",
                "clients": [{"id": desired[uid], "flow": VLESS_FLOW, "email": uid} for uid in add],
            },
        }]}
        tmp = os.path.join(DATA_DIR, "xray-adu.json")
        try:
            save_json(tmp, snippet)
            p = xray_run("adu", tmp)
            if p.returncode != 0:
                log(f"xray adu failed: {(p.stderr or p.stdout).strip()[:200]}")
        except Exception as e:
            log(f"xray adu error: {type(e).__name__}: {e}")
        finally:
            try: os.unlink(tmp)
            except OSError: pass

    if remove:
        try:
            p = xray_run("rmu", "-tag=" + VLESS_TAG, *remove)
            if p.returncode != 0:
                log(f"xray rmu failed: {(p.stderr or p.stdout).strip()[:200]}")
        except Exception as e:
            log(f"xray rmu error: {type(e).__name__}: {e}")


def add_usage(uid, tx, rx):
    """调用方必须已持有 LOCK。"""
    cur = USAGE["users"].setdefault(uid, {"tx": 0, "rx": 0})
    cur["tx"] += int(tx)
    cur["rx"] += int(rx)


def sample_usage_hy2(traffic=None):
    """把 /traffic 的累计值转成增量；计数归零（hysteria 重启）时按当前值全额计入。"""
    if traffic is None:
        traffic = stats_get("/traffic")
    if not isinstance(traffic, dict):
        return
    changed = False
    with LOCK:
        if USAGE["month"] != month_key():
            USAGE["month"] = month_key()
            USAGE["users"] = {}
            changed = True
        last = USAGE["last_hy2"]
        for uid, v in traffic.items():
            if not isinstance(v, dict):
                continue
            cur = {"tx": int(v.get("tx", 0)), "rx": int(v.get("rx", 0))}
            prev = last.get(uid)
            if prev and cur["tx"] >= prev.get("tx", 0) and cur["rx"] >= prev.get("rx", 0):
                dtx = cur["tx"] - prev.get("tx", 0)
                drx = cur["rx"] - prev.get("rx", 0)
            else:
                dtx, drx = cur["tx"], cur["rx"]
            last[uid] = cur
            if dtx or drx:
                add_usage(uid, dtx, drx)
                changed = True
        if changed:
            save_usage_locked()


def sample_usage_xray():
    """用 -reset 读取自上次读取以来的每用户流量，直接累加进当月。"""
    try:
        p = xray_run("statsquery", "-pattern", "user>>>", "-reset")
    except Exception as e:
        log(f"xray statsquery error: {type(e).__name__}: {e}")
        return
    if p.returncode != 0:
        return
    try:
        data = json.loads(p.stdout or "{}")
    except ValueError:
        return
    delta = {}
    for s in data.get("stat", []):
        name = s.get("name") or ""
        parts = name.split(">>>")
        if len(parts) != 4 or parts[0] != "user" or parts[2] != "traffic":
            continue
        uid, direction, value = parts[1], parts[3], int(s.get("value") or 0)
        if not value:
            continue
        d = delta.setdefault(uid, {"tx": 0, "rx": 0})
        if direction == "uplink":
            d["tx"] += value
        elif direction == "downlink":
            d["rx"] += value
    if not delta:
        return
    with LOCK:
        if USAGE["month"] != month_key():
            USAGE["month"] = month_key()
            USAGE["users"] = {}
        for uid, d in delta.items():
            add_usage(uid, d["tx"], d["rx"])
        save_usage_locked()


def usage_snapshot():
    with LOCK:
        return {
            "month": USAGE["month"],
            "users": {uid: {"tx": v["tx"], "rx": v["rx"]} for uid, v in USAGE["users"].items()},
        }


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
    # 月度计量：hy2 用同一次 /traffic 结果，xray 用 statsquery -reset 的增量。
    try:
        sample_usage_hy2(traffic)
    except Exception as e:
        log(f"usage(hy2): {type(e).__name__}: {e}")
    try:
        sample_usage_xray()
    except Exception as e:
        log(f"usage(xray): {type(e).__name__}: {e}")


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
            log(f"rejected peer={peer} (not a Cloudflare egress address)")
            return False
        got = self.headers.get("X-Probe-Token", "")
        if not PROBE_TOKEN or not got or not hmac.compare_digest(PROBE_TOKEN, got):
            log(f"rejected peer={peer} cf-worker={self.headers.get('CF-Worker')!r} "
                f"cf-ray={bool(self.headers.get('CF-Ray'))} token=bad")
            return False
        log(f"accepted peer={peer} cf-worker={self.headers.get('CF-Worker')!r} "
            f"cf-ray={bool(self.headers.get('CF-Ray'))}")
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

    def handle_auth_hy2(self):
        """hysteria 的 HTTP 认证后端：只接受本机回环，返回 {ok, id}。

        只认快照里的 hy2_pass；用户被 blocked（超限）或停用即返回 ok=false，
        客户端重连会被拒。已在线的会话由 Worker 推送快照时触发的 /kick 断开。
        """
        if self.command != "POST":
            return self.send_json({"ok": False, "error": "method not allowed"}, 405)
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            return self.send_json({"ok": False, "error": "loopback only"}, 403)
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = 0
        if not 0 < n <= AUTH_MAX_BODY:
            return self.send_json({"ok": False}, 413)
        try:
            payload = json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self.send_json({"ok": False}, 400)
        password = payload.get("auth") if isinstance(payload, dict) else None
        uid = PASS_INDEX.get(password) if isinstance(password, str) else None
        with LOCK:
            u = USERS.get(uid) if uid else None
            ok = bool(u and u.get("enabled", True) is not False and not u.get("blocked"))
        return self.send_json({"ok": ok, "id": uid if ok else ""})

    def handle_quota_users(self):
        """Worker 推送的完整用户快照（含凭证与 blocked 标记）。"""
        if self.command not in ("PUT", "POST"):
            return self.send_json({"error": "method not allowed"}, 405)
        if not self.client_ok():
            return self.send_json({"error": "forbidden"}, 403)
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = 0
        if not 0 < n <= QUOTA_MAX_BODY:
            return self.send_json({"error": "bad body size"}, 413)
        try:
            payload = json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self.send_json({"error": "bad json"}, 400)
        try:
            apply_users_snapshot(payload)
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        return self.send_json({"ok": True, "count": len(USERS)})

    def dispatch(self):
        p = urlparse(self.path).path.rstrip("/") or "/"
        if p == "/auth/hy2":
            return self.handle_auth_hy2()
        if p == "/api/quota/users":
            return self.handle_quota_users()
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
            if p == "/api/quota/usage":
                return self.send_json(usage_snapshot())
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
    if not PROBE_TOKEN:
        raise SystemExit("PROBE_TOKEN 未配置：拒绝以弱校验模式启动")
    if ALLOW_LOOPBACK:
        log("WARNING: PROBE_ALLOW_LOOPBACK=1，本机请求跳过访问控制")
    load_quota_state()
    threading.Thread(target=collector, daemon=True, name="collector").start()
    # 启动对账：按磁盘快照补齐/移除 xray 用户，避免重启后凭证状态漂移。
    threading.Thread(target=xray_reconcile, daemon=True, name="xray-reconcile").start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    log(f"probe listening on 0.0.0.0:{PORT}; stats={STATS_URL}; token strict={bool(PROBE_TOKEN)}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
