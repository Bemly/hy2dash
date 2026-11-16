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

export async function enforceQuotas(env) {
  const { month, list, changed: rolled } = await rolloverMonth(env);

  let usage;
  try {
    usage = await probeUsage(env);
  } catch (e) {
    return { month, users: list.length, changed: rolled, probe: "unreachable", error: e.message || String(e) };
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
  catch { return users; }
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
