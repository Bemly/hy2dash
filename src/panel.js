// 面板 API：保持旧 Go 服务的全部前端契约。
//
// 原则：不降级、不放假数据、不返回没有实际执行的 ok。
//   - 采集类接口一律回源；未配置 / 不可达 / 非 JSON / 上游报错 → 502 明确错误。
//   - 尚未实现的能力 → 501，而不是 {ok:true} 或结构完整的空数据。
//   - 配额只设月限额（默认 100G），不设日限额；admin 账号与 monthly_gb=0 均视为不限。
//   - 口令登录已下线，管理权限由用户记录上的 admin 标记决定。
//
// 身份、订阅链接、机位、启停、换链由 Worker + KV 真实实现。
// 回源链路：ORIGIN_API_BASE（橙云 proxied 域名，不带端口）→ Origin Rule → 源站 2096。

import {
  getUser, putUser, allUsers, rotateToken, isAdminUser,
  open, seal, clearCookies,
} from "./store.js";
import { refreshProfile, resolveClientId } from "./mc.js";
import { attachUsage, enforceQuotas } from "./quota.js";

const GB = 1024 * 1024 * 1024;

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
});

const fail = (msg, status = 400) => json({ error: msg }, status);
const notImplemented = (what) => json({ error: what + " 尚未实现" }, 501);

// 面板长连接的短期票据：HMAC-SHA256(secret, `live|uuid|exp|ip`)。
// 探针用同一密钥验签，票据 120 秒过期，且绑定 CF-Connecting-IP。
async function hmacHex(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

class PanelError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function nowSec() { return Math.floor(Date.now() / 1000); }

// 月限额：admin 账号与 monthly_gb<=0 一律不限；缺字段按不限处理（不是数据异常）。
function quotaOf(u) {
  if (isAdminUser(u)) return { unlimited: true, monthlyGB: null, monthly: null };
  const m = Number(u.monthly_gb);
  if (!(m > 0)) return { unlimited: true, monthlyGB: null, monthly: null };
  return { unlimited: false, monthlyGB: m, monthly: m * GB };
}

// usage / online 来自源站 /api/live 的真实累计与在线数据。
// 计量维度不存在时不填该字段，绝不写 0 冒充真实值。
function paxOf(u, sess, usage, online) {
  const mine = !!(sess.uuid && sess.uuid === u.uuid);
  const full = sess.role === "admin" || mine;
  const n = parseInt(String(u.hy_user || "u01").replace(/^u/, ""), 10) || 1;
  const q = quotaOf(u);
  return {
    n,
    gate: u.gate || 0,
    hy_user: full ? u.hy_user : undefined,
    name: sess.role === "admin" ? u.name : undefined,
    nick: u.nick || u.name,
    avatar: u.avatar || "",
    steam_state: u.steam_state || "",
    game: u.game || "",
    summary: u.summary || "",
    me: mine || undefined,
    guest: false,
    enabled: u.enabled !== false,
    state: u.enabled === false ? "disabled" : "ok",
    full,
    vless: false,
    monthly_quota: q.monthly,
    unlimited: q.unlimited,
    online: online && u.hy_user ? Number(online[u.hy_user]) || 0 : 0,
    tx: usage ? usage.tx : undefined,
    rx: usage ? usage.rx : undefined,
  };
}

async function usersCached(env) {
  const hit = await env.USERS.get("cache:users", "json");
  if (hit && hit.at > nowSec() - 30) return hit.list;
  const list = await allUsers(env);
  await env.USERS.put("cache:users", JSON.stringify({ at: nowSec(), list }), { expirationTtl: 60 });
  return list;
}

async function invalidateUsers(env) {
  await env.USERS.delete("cache:users");
}

// 回源：任何失败都抛 PanelError，由 handlePanel 转成明确的 502/503 响应。
async function originJson(ctx, path) {
  const base = ctx.env.ORIGIN_API_BASE;
  if (!base) throw new PanelError("数据回源未配置（ORIGIN_API_BASE）", 503);
  const token = ctx.env.PROBE_TOKEN;
  if (!token) throw new PanelError("回源凭证未配置（PROBE_TOKEN）", 503);
  const target = base.replace(/\/$/, "") + path;
  let res;
  try {
    res = await fetch(target, {
      method: "GET",
      headers: { Accept: "application/json", "X-Probe-Token": token },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    throw new PanelError("源站数据接口不可达：" + (e.message || String(e)), 502);
  }
  if (!res.ok) throw new PanelError("源站数据接口 HTTP " + res.status, 502);
  let data;
  try { data = await res.json(); }
  catch { throw new PanelError("源站数据接口返回非 JSON", 502); }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new PanelError("源站数据接口返回格式异常", 502);
  }
  return data;
}

async function dataEndpoint(ctx) {
  return json(await originJson(ctx, ctx.path + (ctx.url.search || "")));
}

function requireAdmin(ctx) {
  return ctx.sess && ctx.sess.role === "admin";
}

export async function handlePanel(ctx) {
  try {
    return await panel(ctx);
  } catch (e) {
    if (e instanceof PanelError) return json({ error: e.message }, e.status);
    throw e;
  }
}

async function panel(ctx) {
  const { request, env, path, method } = ctx;
  const body = async () => {
    let v;
    try { v = await request.json(); }
    catch { throw new PanelError("请求体不是合法 JSON", 400); }
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      throw new PanelError("请求体必须是 JSON 对象", 400);
    }
    return v;
  };

  switch (path) {
    // ---------------- 身份 ----------------
    case "/api/me": {
      // 管理身份也来自 MC 用户记录（admin 标记），不再有口令会话。
      const u = ctx.user || (ctx.sess.uuid && ctx.sess.uuid !== "admin" ? await getUser(env, ctx.sess.uuid) : null);
      if (!u) return fail("账号不存在", 401);
      if (u.enabled === false) return fail("账号已停用", 403);
      const q = quotaOf(u);
      await attachUsage(env, [u]);
      return json({
        role: isAdminUser(u) ? "admin" : "user",
        user: u.uuid, nick: u.nick || u.name,
        hy_user: u.hy_user, sub_token: u.sub_token,
        avatar: u.avatar || "", steam_state: u.steam_state || "", game: u.game || "",
        monthly_gb: q.monthlyGB, unlimited: q.unlimited,
        month_used: u.month_used, blocked: u.blocked === true,
      });
    }

    case "/api/logout":
      if (method !== "POST") return fail("method not allowed", 405);
      return logoutResponse();

    // 口令登录/改密已下线：管理权限只通过 MC 正版登录获得的账号生效。
    case "/api/login":
    case "/api/password":
      return json({ error: "口令登录已停用，请使用 Microsoft 登录" }, 410);

    // ---------------- 3D 空港 ----------------
    case "/api/fleet": {
      const list = await usersCached(env);
      const live = await originJson(ctx, "/api/live");
      const totals = live.user_total || {};
      const online = live.online || {};
      const pax = list.map((u) => paxOf(u, ctx.sess, totals[u.hy_user] || null, online));
      return json({ role: ctx.sess.role, pax, online: live.count || 0 });
    }

    case "/api/my/gate":
    case "/api/admin/gate": {
      if (path === "/api/admin/gate" && !requireAdmin(ctx)) return fail("需要管理员", 403);
      if (method !== "POST") return fail("method not allowed", 405);
      const inb = await body();
      const gate = Number(inb.gate);
      if (!Number.isInteger(gate) || gate < 1 || gate > 9) return fail("机位需在 1..9");
      const list = await usersCached(env);
      let target = null;
      if (path === "/api/admin/gate") {
        target = list.find((u) => u.name === inb.user || u.hy_user === inb.user || u.uuid === inb.user);
        if (!target) return fail("用户不存在");
      } else {
        target = ctx.user || await getUser(env, ctx.sess.uuid);
      }
      if (!target) return fail("用户不存在", 404);
      const swapped = list.find((u) => u.gate === gate && u.uuid !== target.uuid);
      if (swapped) { swapped.gate = target.gate || 0; await putUser(env, swapped); }
      target.gate = gate;
      await putUser(env, target);
      await invalidateUsers(env);
      return json({ ok: true, gate, swapped: swapped ? (swapped.nick || swapped.name) : "" });
    }

    // ---------------- 用户侧 ----------------
    // 用户身份是 Minecraft UUID，与 Hysteria 2 的 auth 用户没有映射，
    // 因此按用户维度计量/续额无法真实实现：明确 501，不返回 0 用量。
    // 长连接票据：只有 admin 能取；票据绑定 uuid + exp + CF-Connecting-IP。
    case "/api/live/ticket": {
      if (method !== "POST") return fail("method not allowed", 405);
      if (!requireAdmin(ctx)) return fail("需要管理员", 403);
      const secret = ctx.env.WS_TICKET_SECRET;
      if (!secret) return fail("票据密钥未配置（WS_TICKET_SECRET）", 503);
      const host = ctx.env.WS_HOST;
      if (!host) return fail("探针地址未配置（WS_HOST）", 503);
      const exp = nowSec() + 120;
      // 不绑定 IP：浏览器对 443（取票）和 2096（SSE）可能分别走 IPv4 / IPv6，
      // CF-Connecting-IP 会不同，绑定后验签必然失败。票据 120s 过期 + Origin 校验。
      const sig = await hmacHex(secret, `live|${ctx.sess.uuid}|${exp}`);
      const qs = new URLSearchParams({ u: ctx.sess.uuid, exp: String(exp), sig });
      return json({ url: `https://${host}/sse/live?${qs}`, exp });
    }

    case "/api/my/summary":
      return notImplemented("用户级用量计量（MC UUID 与 hy2 auth 无映射）");

    case "/api/my/rotate": {
      if (method !== "POST") return fail("method not allowed", 405);
      const u = ctx.user || await getUser(env, ctx.sess.uuid);
      if (!u) return fail("用户不存在", 404);
      const tok = await rotateToken(env, u);
      await invalidateUsers(env);
      return json({ sub_token: tok, nodes_reset: false });
    }

    case "/api/my/renew":
      if (method !== "POST") return fail("method not allowed", 405);
      return notImplemented("续额（无计量与配额执行点）");

    // ---------------- 管理侧 ----------------
    case "/api/users": {
      if (!requireAdmin(ctx)) return fail("需要管理员", 403);
      const list = await usersCached(env);
      await attachUsage(env, list);
      const users = list.map((u) => {
        const q = quotaOf(u);
        return {
          name: u.name, nick: u.nick || u.name, avatar: u.avatar || "",
          hy_user: u.hy_user, enabled: u.enabled !== false,
          state: u.enabled === false ? "disabled" : "ok",
          admin: isAdminUser(u),
          monthly_gb: q.monthlyGB, monthly_quota: q.monthly, unlimited: q.unlimited,
          month_used: u.month_used, blocked: u.blocked === true,
          summary: u.summary || "", steam_state: "", game: "",
        };
      });
      return json({ users, slots_total: Math.max(9, list.length) });
    }

    case "/api/user/quota": {
      if (!requireAdmin(ctx)) return fail("需要管理员", 403);
      if (method !== "POST") return fail("method not allowed", 405);
      const inb = await body();
      const list = await usersCached(env);
      const u = list.find((x) => x.name === inb.user || x.hy_user === inb.user || x.uuid === inb.user);
      if (!u) return fail("用户不存在", 404);
      if (isAdminUser(u)) return fail("管理账号不限额，无需设置", 400);
      const m = Number(inb.monthly_gb);
      if (!Number.isFinite(m) || m < 0) return fail("monthly_gb 必须是非负数（0 = 不限）");
      if (m === 0) delete u.monthly_gb;
      else u.monthly_gb = m;
      await putUser(env, u);
      await invalidateUsers(env);
      return json({ ok: true, monthly_gb: m === 0 ? null : m, unlimited: m === 0 });
    }

    // 手动触发一次限额判定与快照推送（Cron 之外的运维入口）。
    case "/api/quota/sync": {
      if (!requireAdmin(ctx)) return fail("需要管理员", 403);
      if (method !== "POST") return fail("method not allowed", 405);
      await invalidateUsers(env);
      return json(await enforceQuotas(env));
    }

    case "/api/user/enable":
    case "/api/user/rotate":
    case "/api/user/delete": {
      if (!requireAdmin(ctx)) return fail("需要管理员", 403);
      if (method !== "POST") return fail("method not allowed", 405);
      const inb = await body();
      const list = await usersCached(env);
      const u = list.find((x) => x.name === inb.user || x.hy_user === inb.user || x.uuid === inb.user);
      if (!u) return fail("用户不存在", 404);
      if (path === "/api/user/enable") {
        if (typeof inb.on !== "boolean") return fail("on 必须是布尔值");
        u.enabled = inb.on;
        await putUser(env, u);
      } else if (path === "/api/user/rotate") {
        await rotateToken(env, u);
      } else {
        await env.USERS.delete("t:" + u.sub_token);
        await env.USERS.delete("u:" + u.uuid);
      }
      await invalidateUsers(env);
      return json({ ok: true });
    }

    case "/api/settings":
      return json({ base_path: env.BASE_PATH || "", serverless: true });

    case "/api/base_path":
      if (!requireAdmin(ctx)) return fail("需要管理员", 403);
      return notImplemented("运行时修改基础路径（serverless 版需改 BASE_PATH 并重新部署）");

    case "/api/restart":
      if (!requireAdmin(ctx)) return fail("需要管理员", 403);
      return notImplemented("服务重启（serverless 版请重新部署 Worker）");

    case "/api/hostker/refresh":
      if (!requireAdmin(ctx)) return fail("需要管理员", 403);
      return notImplemented("Hostker 同步（serverless 版未接入 DNS 服务商）");

    // ---------------- 采集数据：一律回源，失败即错误 ----------------
    case "/api/live":
      if (!requireAdmin(ctx)) return fail("需要管理员", 403);
      return dataEndpoint(ctx);
    case "/api/summary":
    case "/api/history":
      if (!requireAdmin(ctx)) return fail("需要管理员", 403);
      return dataEndpoint(ctx);
    case "/api/overview":
      if (!requireAdmin(ctx)) return fail("需要管理员", 403);
      return dataEndpoint(ctx);
    case "/api/my/live":
    case "/api/my/domains":
      return notImplemented("用户维度流量明细（MC UUID 与 hy2 auth 无映射）");

    default:
      return fail("not found", 404);
  }
}

// logout 需要清 cookie，单独导出供主入口使用。
export function logoutResponse() {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  for (const c of clearCookies()) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

// profile_stale 时用 refresh_token 刷新档案（后台执行，不阻塞响应）。
// 失败写入控制台并重新抛出，让 waitUntil 记录失败，不再静默吞掉。
export async function refreshProfileInBackground(env, secret, user) {
  const rt = await open(secret, user.rt || "");
  if (!rt) return;
  try {
    const { msa, profile } = await refreshProfile(resolveClientId(env), rt, env);
    const fresh = await getUser(env, user.uuid);
    if (!fresh) return;
    fresh.name = profile.name;
    fresh.nick = profile.name;
    fresh.avatar = "https://mc-heads.net/avatar/" + profile.uuid + "/64";
    fresh.rt = await seal(secret, msa.refresh_token);
    fresh.rt_at = nowSec();
    fresh.profile_at = nowSec();
    await putUser(env, fresh);
    await invalidateUsers(env);
  } catch (e) {
    console.error("[profile-refresh] " + user.uuid + ": " + (e.message || String(e)));
    throw e;
  }
}
