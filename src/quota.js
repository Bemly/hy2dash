// 限额执行：Worker 侧只做「策略判定 + 凭证轮换」，计量与网络动作由源站探针完成。
//
// 判定周期由 Cron Trigger 驱动（默认每分钟）：
//   1. 从探针取本自然月按用户（面板 UUID）的累计流量；
//   2. 非 admin 且用量 >= monthly_gb → 记 blocked_month、轮换 hy2_pass / vless_uuid；
//   3. 跨月 → 解除 blocked_month 并再次轮换（旧订阅里的节点保持失效，用户需重新拉订阅）；
//   4. 把完整用户快照推给探针，由它执行认证拒绝与 xray 用户增删。
//
// 轮换而不是踢线：kick 只是会话级动作，客户端内建重连会继续跑流量；
// 吊销凭证后旧配置里的所有节点同时失效，重连也认证不过。

import {
  allUsers, putUser, monthKey, newCredentials, isAdminUser,
} from "./store.js";

const GB = 1024 * 1024 * 1024;

// attachUsage 的失败提示节流：同一 isolate 内 60 秒最多一条
let usageWarnAt = 0;

function originBase(env) {
  const b = env.ORIGIN_API_BASE;
  if (!b) throw new Error("数据回源未配置（ORIGIN_API_BASE）");
  return b.replace(/\/$/, "");
}

async function originJson(env, path, init = {}) {
  const token = env.PROBE_TOKEN;
  if (!token) throw new Error("回源凭证未配置（PROBE_TOKEN）");
  const headers = { Accept: "application/json", "X-Probe-Token": token };
  if (init.body) headers["Content-Type"] = "application/json";
  const res = await fetch(originBase(env) + path, {
    ...init, headers, signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error("源站 " + path + " HTTP " + res.status);
  return res.json();
}

// 探针内存里的当月用量：{ month, users: { uuid: { tx, rx } } }
export function probeUsage(env) {
  return originJson(env, "/api/quota/usage");
}

export function pushUsers(env, list) {
  const month = monthKey();
  const payload = {
    users: list.map((u) => ({
      uuid: u.uuid,
      hy2_pass: u.hy2_pass || "",
      vless_uuid: u.vless_uuid || "",
      blocked: u.blocked_month === month,
      unlimited: isAdminUser(u),
      enabled: u.enabled !== false,
      monthly_gb: u.monthly_gb == null ? null : Number(u.monthly_gb),
      // 3D 空港（/sse/fleet）展示用，随快照一起下发，探针不访问 KV。
      name: u.name || "",
      nick: u.nick || u.name || "",
      avatar: u.avatar || "",
      game: u.game || "",
      summary: u.summary || "",
      gate: Number(u.gate) || 0,
      role: isAdminUser(u) ? "admin" : "user",
      hy_user: u.hy_user || "",
    })),
  };
  return originJson(env, "/api/quota/users", { method: "PUT", body: JSON.stringify(payload) });
}

// 纯 KV：月份翻页、补齐缺失凭证。不碰网络，必须在 probeUsage 之前执行。
// 探针不可达时这一步仍要完成，否则月初被封的用户会一直卡在 403。
export async function rolloverMonth(env) {
  const month = monthKey();
  const list = await allUsers(env);
  let changed = 0;

  for (const u of list) {
    let dirty = false;
    if (!u.hy2_pass || !u.vless_uuid) {
      Object.assign(u, newCredentials());
      dirty = true;
    }
    if (isAdminUser(u)) {
      if (u.blocked_month) { u.blocked_month = null; dirty = true; }
    } else if (u.blocked_month && u.blocked_month !== month) {
      // 新月份：解除封禁 + 换新凭证（旧订阅仍失效，必须重新拉取）
      u.blocked_month = null;
      Object.assign(u, newCredentials());
      dirty = true;
    }
    if (dirty) { await putUser(env, u); changed++; }
  }

  if (changed) await env.USERS.delete("cache:users");
  return { month, list, changed };
}

// 证书指纹的唯一来源是探针：它就在读 /etc/hysteria/server.crt，续签落盘后 mtime 一变
// 就能算出新指纹。Worker 每分钟取一次，只在**指纹变化时**写 KV —— KV 免费额度
// 1000 写/天，每分钟无条件写会直接超；指纹一般 60~90 天才变一次。
// secret HY2_FINGERPRINT / HY2_CERT_FP 只是首次部署的引导值，之后订阅一律以 KV 为准。
let certWarnAt = 0;

export async function syncCertFp(env) {
  let info;
  try {
    info = await originJson(env, "/api/cert");
  } catch (e) {
    const now = Date.now();
    if (now - certWarnAt > 600000) {
      certWarnAt = now;
      console.warn("[cert] 指纹同步跳过：" + (e.message || e));
    }
    return;
  }
  const fp = String((info && info.sha256) || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fp)) {
    console.warn("[cert] 探针返回的指纹非法：" + JSON.stringify(info).slice(0, 160));
    return;
  }
  const cur = await env.USERS.get("cfg:cert_fp");
  if (cur === fp) return;
  await env.USERS.put("cfg:cert_fp", fp);
  console.log("[cert] 证书指纹更新 " + (cur ? cur.slice(0, 8) : "(无)") + " -> " + fp.slice(0, 8)
    + (info.not_after_text ? "，到期 " + info.not_after_text : ""));
}

export async function enforceQuotas(env) {
  const { month, list, changed: rolled } = await rolloverMonth(env);
  await syncCertFp(env);

  let usage;
  try {
    usage = await probeUsage(env);
  } catch {
    // 探针不可达：跳过限额判定，但仍要把最新用户档案推过去。
    // 探针重启后从磁盘读的是旧快照，停机期间 Worker 侧的停用/轮换/封禁
    // 必须在恢复后第一时间同步，否则旧凭证在同步完成前仍能通过认证。
    try {
      await pushUsers(env, list);
      return { month, users: list.length, changed: rolled, probe: "unreachable", pushed: true };
    } catch (e) {
      return { month, users: list.length, changed: rolled, probe: "unreachable", pushed: false, error: e.message || String(e) };
    }
  }

  // 只认当月计量：源站的月份还没翻页时（月初第一次采样前）它仍会返回上月累计，
  // 若直接拿来判定，月初会把刚解封的用户又封一遍并二次轮换凭证。
  const used = usage && usage.month === month ? (usage.users || {}) : {};
  let changed = 0;

  for (const u of list) {
    if (isAdminUser(u)) continue; // admin 的不限与解封已在 rolloverMonth 处理
    const limitGB = Number(u.monthly_gb);
    const t = used[u.uuid];
    const bytes = t ? (Number(t.tx) || 0) + (Number(t.rx) || 0) : 0;
    const over = limitGB > 0 && bytes >= limitGB * GB;
    const blocked = u.blocked_month === month;

    if (over && !blocked) {
      // 本月超限：记封禁月份并轮换双凭证，旧配置里的节点全部失效
      u.blocked_month = month;
      Object.assign(u, newCredentials());
    } else if (!over && blocked) {
      // 管理员提高限额或清零：解除封禁（凭证沿用封禁时轮换后的新值）
      u.blocked_month = null;
    } else {
      continue;
    }
    await putUser(env, u);
    changed++;
  }

  if (changed) await env.USERS.delete("cache:users");
  try {
    await pushUsers(env, list);
  } catch (e) {
    return { month, users: list.length, changed: rolled + changed, probe: "push_failed", error: e.message || String(e) };
  }
  return { month, users: list.length, changed: rolled + changed };
}

// 面板展示用：把探针的月度用量并进用户对象。
export async function attachUsage(env, users) {
  let usage;
  try { usage = await probeUsage(env); }
  catch (e) {
    // 探针不可达时列表照常返回（用量列留空），但必须留痕：否则「用量全是 —」
    // 时无从判断是探针挂了还是没有计量。60 秒节流，避免每个请求刷一行。
    const now = Date.now();
    if (now - usageWarnAt > 60000) {
      usageWarnAt = now;
      console.warn("[quota] 用量回源失败（用量列将为空白）：" + (e && e.message ? e.message : e));
    }
    return users;
  }
  const month = monthKey();
  const used = usage && usage.month === month ? (usage.users || {}) : {};
  for (const u of users) {
    const t = used[u.uuid];
    if (t) {
      u.month_tx = Number(t.tx) || 0;
      u.month_rx = Number(t.rx) || 0;
      u.month_used = u.month_tx + u.month_rx;
    }
    u.blocked = u.blocked_month === month;
  }
  return users;
}
