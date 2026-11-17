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

import hashlib
import hmac
import ipaddress
import json
import os
import re
import ssl
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

# 并发上限与拒绝日志节流。
# 2096 必须对公网监听（Cloudflare 只能回源到公网地址），因此任何扫描器都能连上来。
# 每个连接一个线程：没有上限时几千个慢速连接就能把线程和内存堆爆，
# 而每请求两行日志在 1 vCPU 上也会把 journald 和 CPU 一起拖住。
MAX_CONNECTIONS = 256
DENY_LOG_TTL = 10
DENY_LOG_MAX = 1024

# ---- 面板长连接（/sse/live、/sse/fleet）----
# 浏览器经 Cloudflare 直连本服务的 2096，用 Worker 签发的短期 HMAC 票据鉴权。
# 票据格式 HMAC(secret, `channel|uuid|exp`)，不绑定来源 IP（浏览器取票走 443、
# SSE 走 2096，可能分别走 IPv4/IPv6）；120 秒过期；探针不保存任何会话状态。
WS_TICKET_SECRET = os.environ.get("WS_TICKET_SECRET", "")
WS_ORIGIN = os.environ.get("WS_ORIGIN", "https://www.bemly.moe")
MAX_WS = int(os.environ.get("MAX_WS", "32"))
MAX_WS_PER_IP = int(os.environ.get("MAX_WS_PER_IP", "6"))
LIVE_PUSH_SECONDS = 1.0
AUTH_PORT = int(os.environ.get("PROBE_AUTH_PORT", "2095"))

# 2096 走 TLS；证书直接复用 hysteria 的 Let's Encrypt 证书。
TLS_CERT = os.environ.get("PROBE_TLS_CERT", "/etc/hysteria/server.crt")
TLS_KEY = os.environ.get("PROBE_TLS_KEY", "/etc/hysteria/server.key")

LIVE_TOTAL = 0
LIVE_BY_IP = {}
FLEET_REV = 0          # 用户档案快照版本号；变化时 SSE 重发全量 pax

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
# 每用户约 200 字节（uuid + 两个凭证 + 标记），2 MiB 可容纳约一万用户；
# 快照是「完整替换」，被 413 掉等于整轮不生效，所以留足余量。
QUOTA_MAX_BODY = 2 * 1024 * 1024

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
# xray 侧没有「用户在线」这种指标，用「最近一次采样观测到流量」近似在线。
# 键是 MC UUID（xray client 的 email），值是最后观测到流量的时间戳。
VLESS_SEEN = {}
STATE = {
    "started": time.time(),
    "last_ok": 0,
    "last_error": "not polled yet",
    "count": 0,
}
os.makedirs(DATA_DIR, exist_ok=True)


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


DENY_LOCK = threading.Lock()
DENY_LOG = {}      # peer -> {"t": 上次记录时间, "n": 期间被压制的条数}
THROTTLE = {}      # 通用节流键 -> 上次打印时间


def log_throttled(key, msg, every=60):
    """周期性失败的日志节流：同一 key 每 every 秒最多一条。"""
    now = time.time()
    with DENY_LOCK:
        if now - THROTTLE.get(key, 0) < every:
            return
        THROTTLE[key] = now
    log(msg)


def log_deny(peer, msg):
    """同一来源的拒绝日志每 10 秒最多一条，被压制的条数在下一条里带出来。"""
    now = time.time()
    with DENY_LOCK:
        rec = DENY_LOG.get(peer)
        if rec and now - rec["t"] < DENY_LOG_TTL:
            rec["n"] += 1
            return
        suppressed = rec["n"] if rec else 0
        if len(DENY_LOG) >= DENY_LOG_MAX:
            for k in [k for k, v in DENY_LOG.items() if now - v["t"] >= 60]:
                DENY_LOG.pop(k, None)
            if len(DENY_LOG) >= DENY_LOG_MAX:
                DENY_LOG.clear()
        DENY_LOG[peer] = {"t": now, "n": 0}
    log(msg + (f"（此前 {DENY_LOG_TTL}s 内压制 {suppressed} 条同类）" if suppressed else ""))


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
                "name": u.get("name") or "",
                "nick": u.get("nick") or "",
                "avatar": u.get("avatar") or "",
                "game": u.get("game") or "",
                "summary": u.get("summary") or "",
                "gate": int(u.get("gate") or 0),
                "role": u.get("role") or "user",
                "hy_user": u.get("hy_user") or "",
            })
        return {"users": users}


def _fleet_profile(u):
    """/sse/fleet 全量帧依赖的展示字段；凭证类字段（hy2_pass 等）变化不应触发全量重发。"""
    return (
        u.get("hy_user") or "", u.get("name") or "", u.get("nick") or "",
        u.get("avatar") or "", u.get("game") or "", u.get("summary") or "",
        int(u.get("gate") or 0), u.get("enabled", True) is not False,
        u.get("role") or "user", bool(u.get("blocked")), bool(u.get("unlimited")),
    )


def apply_users_snapshot(payload):
    """Worker 推送的完整用户快照：替换内存/磁盘状态，踢掉新封禁的 hy2，并对账 xray。"""
    global SNAPSHOT_READY, FLEET_REV
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
            "name": str(u.get("name") or ""),
            "nick": str(u.get("nick") or ""),
            "avatar": str(u.get("avatar") or ""),
            "game": str(u.get("game") or ""),
            "summary": str(u.get("summary") or ""),
            "gate": int(u.get("gate") or 0),
            "role": str(u.get("role") or "user"),
            "hy_user": str(u.get("hy_user") or ""),
        }

    newly_blocked = []
    rotated = []      # 凭证被轮换的用户：旧 hy2 会话仍持旧密码在跑，必须踢线
    with LOCK:
        # cron 每分钟都会整表推送一次，但展示字段多数时候没变：
        # 只有 fleet 全量帧依赖的档案真的变了才 FLEET_REV += 1，避免全量重发。
        profiles_changed = FLEET_REV == 0 or \
            {uid: _fleet_profile(u) for uid, u in USERS.items()} != \
            {uid: _fleet_profile(u) for uid, u in users.items()}
        for uid, u in users.items():
            old = USERS.get(uid)
            if u["blocked"] and not (old and old.get("blocked")):
                newly_blocked.append(uid)
            # 凭证被轮换（订阅吊销联动）：旧 hy2 会话仍持旧密码在跑，必须踢线
            if old and old.get("hy2_pass") and u["hy2_pass"] != old["hy2_pass"]:
                rotated.append(uid)
        USERS.clear()
        USERS.update(users)
        PASS_INDEX.clear()
        PASS_INDEX.update({u["hy2_pass"]: uid for uid, u in users.items()})
        save_json(USERS_PATH, quota_snapshot())
        SNAPSHOT_READY = True
        if profiles_changed:
            FLEET_REV += 1
    for uid in dict.fromkeys(newly_blocked + rotated):
        try:
            stats_post("/kick", [uid])
            log(f"kicked user {uid} (blocked={uid in newly_blocked}, rotated={uid in rotated})")
        except Exception as e:
            log(f"kick {uid} failed: {type(e).__name__}: {e}")
    xray_reconcile()


def xray_run(command, *args, timeout=5):
    # --server 必须排在位置参数之前，否则 Go flag 解析会把它当成文件名/邮箱。
    return subprocess.run(
        [XRAY_BIN, "api", command, "--server=" + XRAY_API, *args],
        capture_output=True, text=True, timeout=timeout,
    )


def xray_current_users():
    p = xray_run("inbounduser", "-tag=" + VLESS_TAG)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or "inbounduser failed").strip()[:200])
    data = json.loads(p.stdout or "{}")
    out = []
    for u in data.get("users", []):
        acc = u.get("account") or {}
        out.append({"email": u.get("email") or "", "id": acc.get("id") or ""})
    return out


def xray_reconcile():
    """让 xray 的 clients 与快照一致。

    顺序必须是「先 rmu，再 adu」，两个坑都是实测踩出来的：
      - 2026-11-16：adu 遇到已注册的 UUID 会跳过 validator 注册——先加
        「同 UUID、新 email」再 rmu 旧 email，会把 UUID 从 validator 里
        彻底删掉（每条连接都报 invalid request user id）；
      - 2026-11-17：adu 对「email 已存在、uuid 换代」的添加是静默 no-op
        （rc=0、无日志）——凭证轮换后旧条目必须先 rmu，否则新 uuid 永远
        进不了 validator（pro 全灭）。
    因此本轮策略：凡 email 不该在、或 email 该在但 id 已过时的条目，一律
    先 rmu；重新查询后再补缺；adu 结束后终检，缺了明确报出来。
    """
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
        current = xray_current_users()
    except Exception as e:
        log(f"xray reconcile skipped: {type(e).__name__}: {e}")
        return

    # 删除：email 不该在的（吊销/停用/遗留），以及 email 该在但 uuid 已过时的（凭证轮换）。
    stale = {
        u["email"]
        for u in current
        if u["email"] and (
            u["email"] not in desired
            or (u["id"] or "").lower() != (desired[u["email"]] or "").lower()
        )
    }
    if stale:
        try:
            p = xray_run("rmu", "-tag=" + VLESS_TAG, *stale)
            if p.returncode != 0:
                log(f"xray rmu failed: {(p.stderr or p.stdout).strip()[:200]}")
            current = xray_current_users()
        except Exception as e:
            log(f"xray rmu error: {type(e).__name__}: {e}")
            return  # 删除失败就不再 add，避免又撞上「同 UUID 不同 email」

    current_ids = {(u.get("id") or "").lower() for u in current if u.get("id")}
    add = [uid for uid, uuid in desired.items() if uuid.lower() not in current_ids]

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

    # 终检：adu 可能对 email 冲突等场景静默 no-op，缺了必须明确报出来。
    try:
        after_ids = {(u.get("id") or "").lower()
                     for u in xray_current_users() if u.get("id")}
        missing = [uid for uid, uuid in desired.items() if uuid.lower() not in after_ids]
        if missing:
            log_throttled("xray-incomplete",
                          f"xray reconcile incomplete: validator missing users={missing}", 60)
    except Exception as e:
        log(f"xray post-check error: {type(e).__name__}: {e}")


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
        now = time.time()
        for uid, d in delta.items():
            add_usage(uid, d["tx"], d["rx"])
            VLESS_SEEN[uid] = now
        # 只保留 10 分钟内的记录，避免长期运行后字典无限增长
        for stale in [k for k, t in VLESS_SEEN.items() if now - t > 600]:
            VLESS_SEEN.pop(stale, None)
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
    was_failing = False
    while True:
        try:
            poll_streams()
            if was_failing:
                was_failing = False
                log("采集已恢复（hysteria stats 重新可用）")
        except Exception as e:
            with LOCK:
                STATE["last_error"] = f"dump/streams: {type(e).__name__}: {e}"
            # hysteria stats 挂掉时每 2 秒都会失败一次，不节流会把 journald 刷满。
            log_throttled("poll-streams", STATE["last_error"], 60)
            was_failing = True
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


def user_live(uid):
    """单个用户的实时连接与累计（/api/my/live 用）：别人的数据不出源站。"""
    with LOCK:
        live = [dict(c) for c in LIVE.values() if c.get("u") == uid]
        total = dict(USER_TOTAL.get(uid) or {})
        online = int(ONLINE.get(uid) or 0)
    live.sort(key=lambda c: c.get("tx", 0) + c.get("rx", 0), reverse=True)
    return {
        "live": live, "count": len(live),
        "online": {uid: online}, "user_total": {uid: total},
    }


def fleet_snapshot(viewer_uid):
    """3D 空港数据：只含展示字段，不含 live 明细（目标域名、连接 IP 等）。

    name / hy_user 只对管理员和本人可见，其余人只拿昵称与展示信息。
    """
    with LOCK:
        users = list(USERS.items())
        online = dict(ONLINE)
        totals = dict(USER_TOTAL)
        vless_seen = dict(VLESS_SEEN)
        viewer = USERS.get(viewer_uid) or {}
        is_admin = viewer.get("role") == "admin"
    # xray 每 30 秒采样一次，90 秒内有流量即视为 VLESS 在线（容错两个采样周期）
    vless_now = time.time()
    pax = []
    for uid, u in users:
        hy = str(u.get("hy_user") or "")
        m = re.match(r"u(\d+)$", hy)
        t = totals.get(uid) or totals.get(hy) or {}
        pax.append({
            "uuid": uid,
            "n": int(m.group(1)) if m else 1,
            "gate": int(u.get("gate") or 0),
            "nick": u.get("nick") or u.get("name") or "",
            "name": (u.get("name") or "") if is_admin else "",
            "avatar": u.get("avatar") or "",
            "game": u.get("game") or "",
            "summary": u.get("summary") or "",
            "enabled": u.get("enabled", True) is not False,
            "blocked": bool(u.get("blocked")),
            "unlimited": bool(u.get("unlimited")),
            "role": u.get("role") or "user",
            "full": bool(is_admin or uid == viewer_uid),
            "me": bool(uid == viewer_uid),
            "guest": False,
            "vless": (vless_now - vless_seen.get(uid, 0)) < 90,
            "online": int(online.get(uid) or online.get(hy) or 0),
            "hy_user": hy if (is_admin or uid == viewer_uid) else "",
            "tx": int(t.get("tx") or 0),
            "rx": int(t.get("rx") or 0),
        })
    return {"pax": pax, "online": sum(1 for v in online.values() if v), "role": "admin" if is_admin else "user"}


_FLEET_DELTA = {"sec": 0, "data": None}


def _fleet_delta_compute():
    with LOCK:
        online = dict(ONLINE)
        totals = dict(USER_TOTAL)
        users = list(USERS.items())
    live = []
    for uid, u in users:
        hy = str(u.get("hy_user") or "")
        t = totals.get(uid) or totals.get(hy) or {}
        live.append({
            "uuid": uid,
            "online": int(online.get(uid) or online.get(hy) or 0),
            "tx": int(t.get("tx") or 0),
            "rx": int(t.get("rx") or 0),
        })
    return {"live": live, "online": sum(1 for v in online.values() if v)}


def fleet_delta():
    """每帧只推实时字段，档案变化由 FLEET_REV 触发全量重发。

    同一秒内所有 SSE 连接共享一次计算结果：不缓存时开销是
    O(连接数 x 用户数)/秒，缓存后降为 O(用户数)/秒。dict 赋值是原子
    操作，跨秒边界偶发重复计算无碍。
    """
    sec = int(time.time())
    if _FLEET_DELTA["sec"] == sec and _FLEET_DELTA["data"] is not None:
        return _FLEET_DELTA["data"]
    data = _fleet_delta_compute()
    _FLEET_DELTA["sec"] = sec
    _FLEET_DELTA["data"] = data
    return data


def live_acquire(ip):
    global LIVE_TOTAL
    with LOCK:
        total = LIVE_TOTAL
        mine = LIVE_BY_IP.get(ip, 0)
        if total < MAX_WS and mine < MAX_WS_PER_IP:
            LIVE_TOTAL += 1
            LIVE_BY_IP[ip] = mine + 1
            return True
    # 名额耗尽：前端会按退避重试，日志按 ip 节流，便于区分全局打满还是单 IP 打满。
    # 注意经代理访问时 CF-Connecting-IP 是代理出口（如源站自己），per-IP 名额
    # 会被同一出口的多个会话共同占用——这是把上限放宽到 6 的原因。
    log_throttled(f"live-429:{ip}",
                  f"sse 429 ({'global' if total >= MAX_WS else 'per-ip'}) "
                  f"ip={ip} total={total} by_ip={mine}", 60)
    return False


def live_release(ip):
    global LIVE_TOTAL
    with LOCK:
        LIVE_TOTAL = max(0, LIVE_TOTAL - 1)
        n = LIVE_BY_IP.get(ip, 0) - 1
        if n > 0:
            LIVE_BY_IP[ip] = n
        else:
            LIVE_BY_IP.pop(ip, None)


class Handler(BaseHTTPRequestHandler):
    server_version = "hy2dash-probe/1.0"
    # 连接上不送数据就超时断开：否则慢速连接会一直占着一个线程。
    timeout = 10
    _denied = False

    def log_message(self, fmt, *args):
        # 被拒的请求已经在 client_ok 里记过一条，这里不再重复写 journald。
        if self._denied:
            return
        log(f"{self.client_address[0]} {fmt % args}")

    def client_ok(self):
        peer = self.client_address[0]
        if peer in ("127.0.0.1", "::1"):
            if not ALLOW_LOOPBACK:
                self._denied = True
                log_throttled("deny-loopback", "rejected loopback: PROBE_ALLOW_LOOPBACK not enabled")
            return ALLOW_LOOPBACK
        try:
            addr = ipaddress.ip_address(peer)
        except ValueError:
            self._denied = True
            return False
        if not any(addr in net for net in CF_NETS):
            self._denied = True
            log_deny(peer, f"rejected peer={peer} (not a Cloudflare egress address)")
            return False
        got = self.headers.get("X-Probe-Token", "")
        if not PROBE_TOKEN or not got or not hmac.compare_digest(PROBE_TOKEN, got):
            self._denied = True
            log_deny(peer, f"rejected peer={peer} cf-worker={self.headers.get('CF-Worker')!r} "
                           f"cf-ray={bool(self.headers.get('CF-Ray'))} token=bad")
            return False
        log_throttled("peer-accepted", f"accepted peer={peer} cf-worker={self.headers.get('CF-Worker')!r} "
                                      f"cf-ray={bool(self.headers.get('CF-Ray'))}", 300)
        return True

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        # 面板在 443、探针在 2096，属跨源请求；缺这个头时浏览器只会报 CORS 错误，
        # 真实状态码和响应体都读不到。
        self.send_header("Access-Control-Allow-Origin", WS_ORIGIN)
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
        if not ok:
            # 密码对不上/被停用：只记摘要不记密码本体，60s 节流。
            log_throttled("auth-reject", f"hy2 auth rejected uid={uid or 'unknown'} "
                                        f"pass_len={len(password or '')}", 60)
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

    def _live_ticket(self, channel):
        """校验长连接票据。成功返回 (uid, exp, ip)；失败已写响应并返回 None。"""
        if not WS_TICKET_SECRET:
            self.send_json({"error": "ticket secret not configured"}, 503)
            return None
        q = parse_qs(urlparse(self.path).query)
        uid = (q.get("u") or [""])[0]
        try:
            exp = int((q.get("exp") or ["0"])[0])
        except ValueError:
            self.send_json({"error": "bad exp"}, 400)
            return None
        sig = (q.get("sig") or [""])[0]
        ip = self.headers.get("CF-Connecting-IP") or self.client_address[0]
        now = int(time.time())
        if exp < now - 30 or exp > now + 300:
            # 固定 reason key 节流：票据被持续拒时（密钥不同步 / 重放 / 用户被封），
            # 浏览器会按 30s 封顶退避无限重试，不节流会把 journald 刷满。
            log_throttled("ticket-exp", f"live reject: ticket expired uid={uid} ip={ip}", 60)
            self.send_json({"error": "ticket expired"}, 403)
            return None
        expect = hmac.new(
            WS_TICKET_SECRET.encode("utf-8"),
            f"{channel}|{uid}|{exp}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        if not sig or not hmac.compare_digest(sig, expect):
            log_throttled("ticket-sig", f"live reject: sig mismatch uid={uid} ip={ip}", 60)
            self.send_json({"error": "forbidden"}, 403)
            return None
        origin = self.headers.get("Origin") or ""
        if origin != WS_ORIGIN:
            log_throttled("ticket-origin", f"live reject: origin={origin!r} ip={ip}", 60)
            self.send_json({"error": "forbidden"}, 403)
            return None
        with LOCK:
            u = USERS.get(uid)
            allowed = bool(u and u.get("enabled", True) is not False and not u.get("blocked"))
        if not allowed:
            log_throttled("ticket-user", f"live reject: user={uid} missing/blocked ip={ip}", 60)
            self.send_json({"error": "forbidden"}, 403)
            return None
        return uid, exp, ip

    def _sse_write(self, payload):
        self.wfile.write(("%x\r\n" % len(payload)).encode("ascii") + payload + b"\r\n")
        self.wfile.flush()

    def handle_sse_live(self):
        """面板长连接（SSE）：普通 HTTP 流，Cloudflare 的 h2 可以直接转发。

        WebSocket 需要 101，而 CF 对 2096 只协商 h2（h2 不允许 101），
        所以用 SSE 做同样的单向推送。
        """
        if self.command != "GET":
            return self.send_json({"error": "method not allowed"}, 405)
        auth = self._live_ticket("live")
        if not auth:
            return
        uid, exp, ip = auth
        if not live_acquire(ip):
            return self.send_json({"error": "too many connections"}, 429)

        try:
            self.protocol_version = "HTTP/1.1"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Access-Control-Allow-Origin", WS_ORIGIN)
            self.end_headers()
            self.close_connection = True
            log(f"sse open uid={uid} ip={ip} total={LIVE_TOTAL}")
            # 槽位释放的三条路径（P2 加固）：
            #   1. exp-10 发 reauth 后正常断开；
            #   2. exp 硬上限兜底（防止异常路径跳过 reauth 分支）；
            #   3. 写失败时 Handler.timeout=10 的 socket 超时抛 OSError，
            #      finally 里 live_release 必执行——半开连接最多占槽 10s。
            while True:
                now = int(time.time())
                if now >= exp:
                    break
                if now >= exp - 10:
                    self._sse_write(b"event: reauth\ndata: {}\n\n")
                    break
                with LOCK:
                    u = USERS.get(uid)
                    if not u or u.get("enabled", True) is False or u.get("blocked"):
                        self._sse_write(b"event: revoke\ndata: {}\n\n")
                        break
                payload = b"data: " + json.dumps(snapshot(), ensure_ascii=False).encode("utf-8") + b"\n\n"
                self._sse_write(payload)
                time.sleep(LIVE_PUSH_SECONDS)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            live_release(ip)
            log(f"sse close uid={uid} ip={ip} total={LIVE_TOTAL}")

    def handle_sse_fleet(self):
        """3D 空港：所有登录用户可连，只推展示字段，不含 live 明细。"""
        if self.command != "GET":
            return self.send_json({"error": "method not allowed"}, 405)
        auth = self._live_ticket("fleet")
        if not auth:
            return
        uid, exp, ip = auth
        if not live_acquire(ip):
            return self.send_json({"error": "too many connections"}, 429)

        try:
            self.protocol_version = "HTTP/1.1"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Access-Control-Allow-Origin", WS_ORIGIN)
            self.end_headers()
            self.close_connection = True
            log(f"fleet sse open uid={uid} ip={ip} total={LIVE_TOTAL}")
            seen_rev = -1
            # 与 /sse/live 相同的三条槽位释放路径：reauth、exp 硬上限、写失败超时。
            while True:
                now = int(time.time())
                if now >= exp:
                    break
                if now >= exp - 10:
                    self._sse_write(b"event: reauth\ndata: {}\n\n")
                    break
                with LOCK:
                    u = USERS.get(uid)
                    revoked = not u or u.get("enabled", True) is False or u.get("blocked")
                    rev = FLEET_REV
                if revoked:
                    self._sse_write(b"event: revoke\ndata: {}\n\n")
                    break
                data = fleet_snapshot(uid) if rev != seen_rev else fleet_delta()
                seen_rev = rev
                self._sse_write(b"data: " + json.dumps(data, ensure_ascii=False).encode("utf-8") + b"\n\n")
                time.sleep(LIVE_PUSH_SECONDS)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            live_release(ip)
            log(f"fleet sse close uid={uid} ip={ip} total={LIVE_TOTAL}")

    def dispatch(self):
        p = urlparse(self.path).path.rstrip("/") or "/"
        if p == "/auth/hy2":
            return self.handle_auth_hy2()
        if p == "/api/quota/users":
            return self.handle_quota_users()
        if p == "/api/relay/mc":
            return self.handle_relay()
        if p == "/sse/live":
            return self.handle_sse_live()
        if p == "/sse/fleet":
            return self.handle_sse_fleet()
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
                uid = (q.get("uid") or "").strip()
                if uid:
                    return self.send_json(user_live(uid))
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


class AuthOnlyHandler(Handler):
    """仅绑定 127.0.0.1 的明文通道，专为 hysteria 的 HTTP auth 后端服务。

    背景：探针 2096 改为 TLS 后，hysteria 的 auth url（明文 http://127.0.0.1:2096）
    无法再进入 2096（TLS 握手失败且被静默吞掉），全部 hy2 认证失败。
    这里单独开一个 loopback HTTP 端口（PROBE_AUTH_PORT，默认 2095），
    只接受 /auth/hy2，不暴露任何其他路径，也不走 TLS 与 Cloudflare 访问控制。
    """

    def dispatch(self):
        p = urlparse(self.path).path.rstrip("/") or "/"
        if p == "/auth/hy2":
            return self.handle_auth_hy2()
        return self.send_json({"error": "forbidden"}, 403)

    def log_message(self, fmt, *args):
        # auth 请求量随客户端重连放大，不逐条写 journald；拒绝已有 log_throttled。
        return


class ProbeServer(ThreadingHTTPServer):
    """在 accept 层就把「不是 Cloudflare、也不是本机」的连接关掉。

    Handler 里的 client_ok 仍然保留（鉴权在第一行请求头之后才做得了），但扫描器
    连 TCP 都不该被接纳：不建线程、不解析请求、不写日志。并发槽位保证即使
    Cloudflare 侧异常重连，线程数也有上限。
    """

    request_queue_size = 128
    daemon_threads = True

    def __init__(self, addr, handler, ssl_context=None):
        super().__init__(addr, handler)
        self._slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        self.ssl_context = ssl_context

    def get_request(self):
        sock, addr = super().get_request()
        if not self.ssl_context:
            return sock, addr
        try:
            return self.ssl_context.wrap_socket(sock, server_side=True), addr
        except (ssl.SSLError, OSError):
            try:
                sock.close()
            except OSError:
                pass
            raise

    def handle_error(self, request, client_address):
        # 扫描器直接对 2096 发明文时 TLS 握手必失败，不写 traceback 刷 journald。
        import sys
        exc = sys.exc_info()[1]
        if isinstance(exc, (ssl.SSLError, ConnectionError, TimeoutError, OSError)):
            return
        super().handle_error(request, client_address)

    @staticmethod
    def _is_allowed_peer(peer):
        if peer in ("127.0.0.1", "::1"):
            return True          # hysteria 的 /auth/hy2 走回环，必须放行
        try:
            addr = ipaddress.ip_address(peer)
        except ValueError:
            return False
        return any(addr in net for net in CF_NETS)

    def process_request(self, request, client_address):
        peer = client_address[0]
        if not self._is_allowed_peer(peer):
            log_deny(peer, f"closed {peer}: 不是 Cloudflare 回源地址")
            self.close_request(request)
            return
        if not self._slots.acquire(blocking=False):
            log_deny(peer, f"closed {peer}: 并发连接已达上限 {MAX_CONNECTIONS}")
            self.close_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._slots.release()
            raise

    def shutdown_request(self, request):
        try:
            super().shutdown_request(request)
        finally:
            self._slots.release()


def main():
    if not PROBE_TOKEN:
        raise SystemExit("PROBE_TOKEN 未配置：拒绝以弱校验模式启动")
    if not WS_TICKET_SECRET:
        raise SystemExit("WS_TICKET_SECRET 未配置：/sse/live 无法鉴权")
    if not (os.path.exists(TLS_CERT) and os.path.exists(TLS_KEY)):
        raise SystemExit(f"TLS 证书缺失：{TLS_CERT} / {TLS_KEY}（2096 必须走 TLS）")
    if ALLOW_LOOPBACK:
        log("WARNING: PROBE_ALLOW_LOOPBACK=1，本机请求跳过访问控制")
    load_quota_state()
    threading.Thread(target=collector, daemon=True, name="collector").start()
    # 启动对账：按磁盘快照补齐/移除 xray 用户，避免重启后凭证状态漂移。
    threading.Thread(target=xray_reconcile, daemon=True, name="xray-reconcile").start()
    ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ssl_ctx.load_cert_chain(TLS_CERT, TLS_KEY)
    srv = ProbeServer(("0.0.0.0", PORT), Handler, ssl_ctx)
    auth_srv = ThreadingHTTPServer(("127.0.0.1", AUTH_PORT), AuthOnlyHandler)
    auth_srv.daemon_threads = True
    threading.Thread(target=auth_srv.serve_forever, daemon=True, name="auth-http").start()
    log(f"probe listening on 0.0.0.0:{PORT} (TLS); auth-http on 127.0.0.1:{AUTH_PORT}; "
        f"stats={STATS_URL}; token strict={bool(PROBE_TOKEN)}; "
        f"max_conns={MAX_CONNECTIONS}; max_live={MAX_WS}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
