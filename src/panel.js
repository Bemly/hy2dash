// 面板 API：保持旧 Go 服务的全部前端契约，web/ 里的 app.js / sky.js 一个字都不用改。
//
// 身份、订阅链接、机位、启停、换链、配额展示都由 Worker + KV 真实实现；
// 需要读服务器侧采集数据的接口（live/history/summary/domains…）走可选回源：
//   env.ORIGIN_API_BASE（例如橙云回源域名，经 Origin Rule 指向源站 2096）
//   -> Worker 用 fetch() 发子请求，CF 自动注入 CF-Worker 等官方头
//   -> 源站自行校验官方头 + 回源 IP 段
// 未配置或回源不可用时返回结构完整的空数据，前端不会报错、界面保持原样。

import {
  getUser, putUser, allUsers, rotateToken, checkAdminPassword,
  setAdminPassword, adminExists, open, seal, clearCookies, issueCookies,
} from "./store.js";
import { refreshProfile, resolveClientId } from "./mc.js";

const GB = 1024 * 1024 * 1024;
const DEFAULT_DAILY = 10 * GB;
const DEFAULT_MONTHLY = 100 * GB;

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
});

const fail = (msg, status = 400) => json({ error: msg }, status);

function nowSec() { return Math.floor(Date.now() / 1000); }

function paxOf(u, sess) {
  const mine = sess.role === "user" && sess.uuid === u.uuid;
  const full = sess.role === "admin" || mine;
  const n = parseInt(String(u.hy_user || "u01").replace(/^u/, ""), 10) || 1;
  const p = {
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
    online: 0,
    full,
    vless: false,
    day_used: 0,
    mon_used: 0,
    daily_quota: Number(u.daily_gb) > 0 ? Number(u.daily_gb) * GB : DEFAULT_DAILY,
    mon_quota: Number(u.monthly_gb) > 0 ? Number(u.monthly_gb) * GB : DEFAULT_MONTHLY,
    state: "ok",
    tx: 0,
    rx: 0,
  };
  return p;
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

// 回源：只透传 GET 数据类接口，任何异常都降级为空数据。
async function fromOrigin(ctx) {
  const base = ctx.env.ORIGIN_API_BASE;
  if (!base) return null;
  try {
    const target = base.replace(/\/$/, "") + ctx.path + (ctx.url.search || "");
    const res = await fetch(target, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

const EMPTY = {
  "/api/live": () => ({ live: [], count: 0, online: {}, last_ok: nowSec(), uptime: 0 }),
  "/api/summary": (c) => {
    const days = Math.min(30, Math.max(1, Number(c.url.searchParams.get("days")) || 7));
    return {
      today_tx: 0, today_rx: 0, total_tx: 0, total_rx: 0, total_conn: 0,
      days: Array.from({ length: days }, (_, i) => ({
        day: new Date(Date.now() - (days - 1 - i) * 86400000).toISOString().slice(0, 10),
        tx: 0, rx: 0,
      })),
      top_domains: [],
    };
  },
  "/api/history": (c) => ({ rows: [], total: 0, date: c.url.searchParams.get("date") || "" }),
  "/api/my/live": () => ({ live: [], vless: [], count: 0 }),
  "/api/my/domains": () => ({ domains: [], vless_domains: [], hosts: 0, conns: 0, total_tx: 0, total_rx: 0, vless_hosts: 0, vless_conns: 0 }),
  "/api/overview": () => ({ users_tx: 0, users_rx: 0, device: null }),
};

async function dataEndpoint(ctx) {
  const d = await fromOrigin(ctx);
  if (d) return json(d);
  const build = EMPTY[ctx.path];
  return json(build ? build(ctx) : {});
}

function requireAdmin(ctx) {
  return ctx.sess && ctx.sess.role === "admin";
}

export async function handlePanel(ctx) {
  const { request, env, path, method } = ctx;
  const body = async () => {
    try { return await request.json(); } catch { return {}; }
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
      if (!(await adminExists(env))) {
        await setAdminPassword(env, String(inb.new || ""));
      } else {
        if (!(await checkAdminPassword(env, String(inb.old || "")))) return fail("原密码错误", 401);
        if (String(inb.new || "").length < 8) return fail("新密码至少 8 位");
        await setAdminPassword(env, String(inb.new));
      }
      return json({ ok: true });
    }

    // ---------------- 3D 空港 ----------------
    case "/api/fleet": {
      const list = await usersCached(env);
      const pax = list.map((u) => paxOf(u, ctx.sess));
      return json({ role: ctx.sess.role, pax, online: 0 });
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
    case "/api/my/summary": {
      const u = ctx.user || await getUser(env, ctx.sess.uuid);
      if (!u) return fail("用户不存在", 404);
      const daily = Number(u.daily_gb) > 0 ? Number(u.daily_gb) * GB : DEFAULT_DAILY;
      const monthly = Number(u.monthly_gb) > 0 ? Number(u.monthly_gb) * GB : DEFAULT_MONTHLY;
      return json({
        day_used: 0, day_granted: daily, daily_quota: daily,
        mon_used: 0, monthly_quota: monthly, state: "ok",
        vless_day: 0, vless_mon: 0,
      });
    }

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
      return json({ ok: true });

    // ---------------- 管理侧 ----------------
    case "/api/users": {
      if (!requireAdmin(ctx)) return fail("需要管理员", 403);
      const list = await usersCached(env);
      const users = list.map((u) => ({
        name: u.name, nick: u.nick || u.name, avatar: u.avatar || "",
        hy_user: u.hy_user, enabled: u.enabled !== false,
        state: "ok", day_used: 0, mon_used: 0,
        daily_quota: Number(u.daily_gb) > 0 ? Number(u.daily_gb) * GB : DEFAULT_DAILY,
        mon_quota: Number(u.monthly_gb) > 0 ? Number(u.monthly_gb) * GB : DEFAULT_MONTHLY,
        vless_day: 0, vless_mon: 0, vless_mon_flag: false,
        summary: u.summary || "", steam_state: "", game: "",
      }));
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
        u.daily_gb = Math.max(0, Number(inb.daily_gb) || 0);
        u.monthly_gb = Math.max(0, Number(inb.monthly_gb) || 0);
        await putUser(env, u);
      } else if (path === "/api/user/enable") {
        u.enabled = !!inb.on;
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
      return json({ base_path: "", serverless: true });

    case "/api/base_path":
      if (!requireAdmin(ctx)) return fail("需要管理员", 403);
      return json({ ok: true, changed: false, base_path: "" });

    case "/api/restart":
      if (!requireAdmin(ctx)) return fail("需要管理员", 403);
      return json({ ok: true, note: "serverless 无需重启" });

    case "/api/hostker/refresh":
      if (!requireAdmin(ctx)) return fail("需要管理员", 403);
      return json({ ok: true });

    // ---------------- 采集数据（可回源 / 空数据降级） ----------------
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
      return dataEndpoint(ctx);

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

// profile_stale 时用 refresh_token 静默刷新档案（后台执行，不阻塞响应）。
export async function refreshProfileInBackground(env, secret, user) {
  const rt = await open(secret, user.rt || "");
  if (!rt) return;
  try {
    const { msa, profile } = await refreshProfile(resolveClientId(env), rt);
    const fresh = await getUser(env, user.uuid);
    if (!fresh) return;
    fresh.name = profile.name;
    fresh.nick = profile.name;
    fresh.avatar = "https://mc-heads.net/avatar/" + profile.uuid + "/64";
    fresh.rt = await seal(secret, msa.refresh_token || rt);
    fresh.rt_at = nowSec();
    fresh.profile_at = nowSec();
    await putUser(env, fresh);
    await invalidateUsers(env);
  } catch {
    // 刷新失败不影响已登录状态：保留旧档案，等下次再试。
  }
}
