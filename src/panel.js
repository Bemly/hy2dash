// 面板 API：保持旧 Go 服务的全部前端契约。
//
// 原则：不降级、不放假数据、不返回没有实际执行的 ok。
//   - 采集类接口一律回源；未配置 / 不可达 / 非 JSON / 上游报错 → 502 明确错误。
//   - 尚未实现的能力 → 501，而不是 {ok:true} 或结构完整的空数据。
//   - 配额必须显式存在于用户记录；缺字段是数据异常 → 503，不补默认值。
//
// 身份、订阅链接、机位、启停、换链由 Worker + KV 真实实现。
// 回源链路：ORIGIN_API_BASE（橙云 proxied 域名，不带端口）→ Origin Rule → 源站 2096。

import {
  getUser, putUser, allUsers, rotateToken, checkAdminPassword,
  setAdminPassword, adminExists, open, seal, clearCookies, issueCookies,
} from "./store.js";
import { refreshProfile, resolveClientId } from "./mc.js";

const GB = 1024 * 1024 * 1024;

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
});

const fail = (msg, status = 400) => json({ error: msg }, status);
const notImplemented = (what) => json({ error: what + " 尚未实现" }, 501);

class PanelError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function nowSec() { return Math.floor(Date.now() / 1000); }

// 配额必须显式存在于用户记录里（新建用户时写入）。缺字段视为数据异常。
function quotaOf(u) {
  const daily = Number(u.daily_gb);
  const monthly = Number(u.monthly_gb);
  if (!(daily > 0) || !(monthly > 0)) {
    throw new PanelError("用户配额未配置（daily_gb / monthly_gb 缺失或非正数）", 503);
  }
  return { daily: daily * GB, monthly: monthly * GB, dailyGB: daily, monthlyGB: monthly };
}

// usage / online 来自源站 /api/live 的真实累计与在线数据。
// 计量维度不存在时不填该字段，绝不写 0 冒充真实值。
function paxOf(u, sess, usage, online) {
  const mine = sess.role === "user" && sess.uuid === u.uuid;
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
    daily_quota: q.daily,
    mon_quota: q.monthly,
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
  const target = base.replace(/\/$/, "") + path;
  let res;
  try {
    res = await fetch(target, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
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
      if (ctx.sess.role === "admin") {
        return json({ role: "admin", user: "admin", nick: "admin", hy_user: "", sub_token: "", avatar: "" });
      }
      const u = ctx.user || await getUser(env, ctx.sess.uuid);
      if (!u || u.enabled === false) return fail("账号已停用", 403);
      return json({
        role: "user", user: u.uuid, nick: u.nick || u.name,
        hy_user: u.hy_user, sub_token: u.sub_token,
        avatar: u.avatar || "", steam_state: u.steam_state || "", game: u.game || "",
      });
    }

    case "/api/logout":
      if (method !== "POST") return fail("method not allowed", 405);
      return logoutResponse();

    case "/api/login": {
      if (method !== "POST") return fail("method not allowed", 405);
      const inb = await body();
      if (!(await adminExists(env))) return fail("管理员口令未初始化，请先在 Worker Secrets 配置 ADMIN_PASSWORD", 503);
      if (!(await checkAdminPassword(env, String(inb.pass || "")))) return fail("密码错误", 401);
      const cookies = await issueCookies(env.SESSION_SECRET, "admin", "admin");
      ctx.cookies.push(...cookies);
      return json({ ok: true });
    }

    case "/api/password": {
      if (!requireAdmin(ctx)) return fail("需要管理员", 403);
      if (method !== "POST") return fail("method not allowed", 405);
      const inb = await body();
      const next = String(inb.new || "");
      if (!(await adminExists(env))) {
        if (next.length < 8) return fail("新密码至少 8 位");
        await setAdminPassword(env, next);
      } else {
        if (!(await checkAdminPassword(env, String(inb.old || "")))) return fail("原密码错误", 401);
        if (next.length < 8) return fail("新密码至少 8 位");
        await setAdminPassword(env, next);
      }
      return json({ ok: true });
    }

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
      const live = await originJson(ctx, "/api/live");
      const totals = live.user_total || {};
      const users = list.map((u) => {
        const q = quotaOf(u);
        const t = totals[u.hy_user];
        return {
          name: u.name, nick: u.nick || u.name, avatar: u.avatar || "",
          hy_user: u.hy_user, enabled: u.enabled !== false,
          state: u.enabled === false ? "disabled" : "ok",
          daily_gb: q.dailyGB, monthly_gb: q.monthlyGB,
          daily_quota: q.daily, mon_quota: q.monthly,
          tx: t ? t.tx : undefined,
          rx: t ? t.rx : undefined,
          summary: u.summary || "", steam_state: "", game: "",
        };
      });
      return json({ users, slots_total: Math.max(9, list.length) });
    }

    case "/api/user/quota":
    case "/api/user/enable":
    case "/api/user/rotate":
    case "/api/user/delete": {
      if (!requireAdmin(ctx)) return fail("需要管理员", 403);
      if (method !== "POST") return fail("method not allowed", 405);
      const inb = await body();
      const list = await usersCached(env);
      const u = list.find((x) => x.name === inb.user || x.hy_user === inb.user || x.uuid === inb.user);
      if (!u) return fail("用户不存在", 404);
      if (path === "/api/user/quota") {
        const d = Number(inb.daily_gb);
        const m = Number(inb.monthly_gb);
        if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(m) || m <= 0) {
          return fail("配额必须是正数（daily_gb / monthly_gb）");
        }
        u.daily_gb = d;
        u.monthly_gb = m;
        await putUser(env, u);
      } else if (path === "/api/user/enable") {
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
