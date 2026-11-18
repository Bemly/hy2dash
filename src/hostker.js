// Hostker 面板流量读取：给订阅响应头 Subscription-Userinfo 提供数据。
//
// 协议来自 gist 14e081e7506fa8fd1c607f9adcf758f9（hy2dash 同作者的独立订阅 Worker）：
//   POST https://console.hostker.net/Client/
//   header sign = md5(body + UA) —— 面板把 UA 参与 sign，必须用正常浏览器 UA；
//   Account.login -> KERSESSID cookie；
//   Cloud.getList -> result.servers[]（元素含 uuid，IP 字段名未逐字段确认）；
//   Cloud.get(uuid) -> result.up_traffic / result.down_traffic，单位 MiB。
//
// 凭据：HOSTKER_EMAIL / HOSTKER_PASSWORD（Secret，不落库不入仓）。
// 目标机：HOSTKER_UUID 优先；否则按 HOSTKER_SERVER_IP 在实例列表里匹配
// 在 servers 里匹配。配额：面板返回里探测已知命名的配额字段，探不到就用
// HOSTKER_TOTAL_GB；两者都没有则不下发 total（客户端只显示已用量）。
//
// 降级约定（与 gist 一致）：任何一步失败都返回 null —— 订阅照常下发，
// 只是不带流量头，不影响上网。结果缓存 10 分钟，避免每次订阅更新都登录面板。

import { createHash } from "node:crypto";

const HOSTKER_URL = "https://console.hostker.net/Client/";
const HOSTKER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TRAFFIC_TTL_MS = 10 * 60 * 1000;
const API_TIMEOUT_MS = 8000;

// 配额字段（2026-11-18 面板实测确认）：getList / Cloud.get 都带 plan_traffic，
// 语义是 GB（注意与 up/down_traffic 的 MiB 语义不同）。探不到就退 HOSTKER_TOTAL_GB。
function probeQuotaGB(result) {
  const n = Number(result && result.plan_traffic);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function md5hex(s) {
  return createHash("md5").update(s, "utf8").digest("hex");
}

// 单次面板调用：body 参与 sign，KERSESSID 从响应 Set-Cookie 里滚动更新。
async function hostkerCall(payload, sessid) {
  const body = JSON.stringify(payload);
  const headers = {
    "User-Agent": HOSTKER_UA,
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    sign: md5hex(body + HOSTKER_UA),
  };
  if (sessid) headers["Cookie"] = "KERSESSID=" + sessid;
  const res = await fetch(HOSTKER_URL, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  let sess = sessid;
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of setCookies) {
    const m = /(?:^|;\s*)KERSESSID=([^;]+)/.exec(c);
    if (m) sess = m[1];
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { data, sess };
}

// 在 servers 里定位目标实例：HOSTKER_UUID 精确匹配；否则按 IP 在元素的
// 序列化文本里找（字段名不确定，全文匹配比猜字段名可靠）。
function pickServer(servers, uuid, ip) {
  if (uuid) return servers.find((s) => s && s.uuid === uuid) || null;
  if (!ip) return null;
  return servers.find((s) => s && JSON.stringify(s).includes(ip)) || null;
}

let _cache = { at: 0, value: null };

// 返回 { upload, download, total? }（字节）或 null。永不 throw。
export async function hostkerTraffic(env) {
  const now = Date.now();
  if (_cache.value !== null && now - _cache.at < TRAFFIC_TTL_MS) return _cache.value;

  const email = env && env.HOSTKER_EMAIL;
  const password = env && env.HOSTKER_PASSWORD;
  if (!email || !password) return null; // 未配置凭据：静默跳过，不算错误

  try {
    const t = String(Math.floor(now / 1000));
    const login = await hostkerCall(
      { account: email, password, step2: "", action: "Account.login", time: t },
      ""
    );
    if (!login.data || login.data.success !== true || !login.sess) return null;

    let server = null;
    if (env.HOSTKER_UUID) {
      // 直接指定实例：跳过 getList，Cloud.get 用配置里的 uuid
      server = { uuid: String(env.HOSTKER_UUID).trim() };
    } else {
      const lst = await hostkerCall({ action: "Cloud.getList", time: t }, login.sess);
      const servers = (lst.data && lst.data.result && lst.data.result.servers) || [];
      server = pickServer(servers, "", String(env.HOSTKER_SERVER_IP || "").trim());
    }
    if (!server || !server.uuid) return null;

    const get = await hostkerCall({ uuid: server.uuid, action: "Cloud.get", time: t }, login.sess);
    const r = get.data && get.data.result;
    if (!r) return null;
    const upMiB = Number(r.up_traffic);
    const downMiB = Number(r.down_traffic);
    if (!Number.isFinite(upMiB) || !Number.isFinite(downMiB)) return null;

    // 面板单位 MiB → 字节，不做取整截断：客户端显示由客户端格式化
    const out = {
      upload: upMiB * 1024 * 1024,
      download: downMiB * 1024 * 1024,
    };
    const quotaGB = probeQuotaGB(r);
    if (quotaGB != null) {
      out.total = quotaGB * 1024 * 1024 * 1024;   // plan_traffic 是 GB
    } else {
      const gb = Number(env.HOSTKER_TOTAL_GB);
      if (Number.isFinite(gb) && gb > 0) out.total = gb * 1024 * 1024 * 1024;
    }

    _cache = { at: now, value: out };
    return out;
  } catch (e) {
    return null; // 面板不可达/协议变化：静默降级，不打断订阅
  }
}
