// hy2dash —— Cloudflare Worker (serverless) 入口。
//
// 旧 Go 单体的全部前端契约保留：web/ 下的 UI 与 3D 场景文件字节不变，
// 由 Workers Static Assets 原样托管；身份、订阅、用户管理改在 Worker + KV 里完成。
//
// 路由：
//   GET  /                     index.html（未登录跳 /login）
//   GET  /login                login.html
//   GET  /static/<file>        assets 里的同名文件（含 vendor/ 子目录）
//   POST /api/mc/device/start  Microsoft 设备码
//   POST /api/mc/device/poll   设备码轮询 + 完整正版登录
//   *    /api/*                面板 API（见 panel.js）
//   GET  /<token>              订阅 YAML（见 sub.js）
//   GET  /<file>               规则集 / geo 数据镜像（见 assets.js，14 个白名单文件）

import { deviceCodeStart, deviceCodePoll, loginWithMSA, resolveClientId } from "./mc.js";
import {
  sessionOf, issueCookies, getUser, putDevice, getDevice, delDevice,
  upsertUser, newSid, profileStale, isAdminUser, monthKey,
} from "./store.js";
import { handlePanel, refreshProfileInBackground } from "./panel.js";
import { renderSubscription, subscriptionHeaders, checkSubConfig } from "./sub.js";
import { userByToken } from "./store.js";
import { isSubToken } from "./words.js";
import { enforceQuotas } from "./quota.js";
import { mirrorName, serveMirror } from "./assets.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

function withCookies(resp, cookies) {
  if (!cookies || !cookies.length) return resp;
  const h = new Headers(resp.headers);
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

function configError(env) {
  const missing = [];
  if (!env.SESSION_SECRET) missing.push("SESSION_SECRET");
  if (!env.USERS) missing.push("KV namespace USERS");
  return missing;
}

// 静态资源：/static/xxx -> assets /xxx。run_worker_first=true 时由 Worker 决定是否放行。
async function serveAsset(env, request, url, pathname) {
  let assetPath = pathname;
  if (assetPath.startsWith("/static/")) assetPath = "/" + assetPath.slice("/static/".length);
  if (!/^\/[A-Za-z0-9_.\-/]+$/.test(assetPath) || assetPath.includes("..")) {
    return new Response("not found", { status: 404 });
  }
  const target = new URL(assetPath, url.origin);
  const res = await env.ASSETS.fetch(new Request(target.toString(), { method: "GET" }));
  const h = new Headers(res.headers);
  // 3D 模块与样式可缓存；html 一律不缓存，避免登录状态被 CDN 串味。
  if (/\.(js|css)$/.test(assetPath) || assetPath.includes("/vendor/")) {
    h.set("Cache-Control", "public, max-age=3600");
  } else {
    h.set("Cache-Control", "no-store");
  }
  return new Response(res.body, { status: res.status, headers: h });
}

async function deviceStart(ctx) {
  const { env, request } = ctx;
  const clientId = resolveClientId(env);
  // 轻量限流：同一 IP 每小时最多 12 次设备码申请
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return json({ error: "无法识别客户端来源，拒绝设备码申请" }, 400);
  const key = "rl:dev:" + ip;
  // 限流存储故障时 fail-closed：拒绝申请，而不是当成计数 0 放行。
  let hit;
  try {
    const raw = await env.USERS.get(key);
    hit = raw === null ? 0 : Number(raw);
    if (!Number.isFinite(hit) || hit < 0) throw new Error("bad counter");
  } catch {
    return json({ error: "限流存储不可用，拒绝设备码申请" }, 503);
  }
  if (hit >= 12) return json({ error: "设备码申请过于频繁，请稍后再试" }, 429);
  try {
    await env.USERS.put(key, String(hit + 1), { expirationTtl: 3600 });
  } catch {
    return json({ error: "限流存储写入失败，拒绝设备码申请" }, 503);
  }

  let d;
  try { d = await deviceCodeStart(clientId, env); }
  catch (e) { return json({ error: "设备码申请失败：" + e.message }, 502); }
  const sid = newSid();
  await putDevice(env, env.SESSION_SECRET, sid, { ...d, client_id: clientId });
  return json({
    sid,
    user_code: d.user_code,
    verification_uri: d.verification_uri,
    interval: d.interval,
    expires_in: d.expires_in,
    message: d.message,
  });
}

async function devicePoll(ctx) {
  const { env, request } = ctx;
  let inb;
  try { inb = await request.json(); } catch { return json({ error: "bad request" }, 400); }
  const sid = String(inb.sid || "");
  if (!/^[a-f0-9]{32}$/.test(sid)) return json({ error: "会话无效，请重新开始" }, 400);
  const d = await getDevice(env, env.SESSION_SECRET, sid);
  if (!d) return json({ status: "error", code: "expired", detail: "登录会话已过期，请重新开始" });

  if (!d.client_id) {
    return json({ status: "error", code: "expired", detail: "登录会话缺少 client_id，请重新开始" });
  }

  let r;
  try { r = await deviceCodePoll(d.client_id, d.device_code, env); }
  catch (e) { return json({ status: "error", code: "poll", detail: e.message }, 502); }
  if (r.status !== "ok") return json(r);

  let profile;
  try { profile = await loginWithMSA(r.token.access_token, env); }
  catch (e) {
    // 保留设备码会话让用户能重试；Mojang 白名单等错误给出可读原因。
    return json({ status: "error", stage: e.stage || "minecraft", code: e.stage, detail: e.message });
  }
  const user = await upsertUser(env, env.SESSION_SECRET, profile, r.token.refresh_token);
  await delDevice(env, sid);
  // 管理身份来自用户记录的 admin 标记（口令登录已下线）。
  const cookies = await issueCookies(env.SESSION_SECRET, isAdminUser(user) ? "admin" : "user", user.uuid);
  ctx.cookies.push(...cookies);
  return json({ status: "ok", name: profile.name });
}

async function serveSub(ctx, token) {
  const { env } = ctx;
  if (!isSubToken(token)) return new Response("not found", { status: 404 });
  const u = await userByToken(env, token);
  if (!u || u.enabled === false) return new Response("not found", { status: 404 });
  // 本月超限：凭证已轮换、服务器侧已移除该用户，订阅也不再下发可用节点。
  if (u.blocked_month && u.blocked_month === monthKey()) {
    return new Response("本月流量已用尽，下月自动恢复；届时请重新拉取订阅", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  let yml;
  try {
    // 证书指纹以探针为准（cron 每分钟同步进 KV）：续签落盘后 ≤60s 订阅就会发新指纹，
    // 不再依赖人工更新 secret；KV 还没同步过时才落回 secret 的引导值。
    const syncedFp = await env.USERS.get("cfg:cert_fp");
    const over = syncedFp ? { HY2_CERT_FP: syncedFp, HY2_FINGERPRINT: syncedFp } : {};
    yml = renderSubscription(env, u, over);
  }
  catch (e) {
    // 配置类失败必须留下可查的痕迹：以前这里只回一句常量，缺哪个字段无处可查。
    if (e.configMissing) {
      console.error("[sub] " + (e.message || e));
      return new Response(e.message || "subscription not configured", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    console.error("[sub] render failed: " + (e && e.message ? e.message : e));
    return new Response("internal error", { status: 500 });
  }
  return new Response(yml, { status: 200, headers: subscriptionHeaders() });
}

export default {
  async fetch(request, env, execCtx) {
    const url = new URL(request.url);
    const missing = configError(env);
    if (missing.length) {
      return json({ error: "Worker 未配置：" + missing.join(", ") }, 503);
    }

    // 可选子路径部署：BASE_PATH="/dash" 时剥掉前缀，前端 BASE 变量无需改动。
    const base = (env.BASE_PATH || "").replace(/\/$/, "");
    // 无尾斜杠时前端 BASE（location.pathname.replace(/\/[^/]*$/, "")）会算成空串，
    // 导致 API 请求落到根路径、Route 不匹配。统一补斜杠。
    if (base && url.pathname === base) {
      return new Response(null, {
        status: 301,
        headers: { Location: base + "/", "Cache-Control": "no-store" },
      });
    }
    let path = url.pathname;
    if (base && (path === base || path.startsWith(base + "/"))) path = path.slice(base.length) || "/";
    const loginTo = base + "/login";

    const ctx = {
      request, env, url, path, method: request.method,
      cookies: [], sess: null, user: null, base,
      wait: (p) => execCtx.waitUntil(p),
    };

    // ---- 登录相关（无需会话） ----
    if (path === "/api/mc/device/start" || path === "/api/mc/device/poll") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      const res = path.endsWith("start") ? await deviceStart(ctx) : await devicePoll(ctx);
      return withCookies(res, ctx.cookies);
    }
    if (path === "/api/login" || path === "/api/health") {
      if (path === "/api/health") {
        // ok 表示 Worker 本身活着；sub_config 单独报告订阅模板的配置完整性，
        // 部署后 curl 一次就能确认 13 个占位符是否全部填好。
        // 证书指纹以探针同步进 KV 的值为准（续签后自动跟随），KV 为空才看 secret。
        const syncedFp = await env.USERS.get("cfg:cert_fp");
        // 两个字段吃同一个证书 SHA-256：mihomo 读 fingerprint（证书 pin），
        // Stash 读 server-cert-fingerprint。任一客户端拿到旧值都会连不上，必须同源。
        const over = syncedFp ? { HY2_CERT_FP: syncedFp, HY2_FINGERPRINT: syncedFp } : {};
        const cfg = checkSubConfig(env, over);
        const ready = !cfg.missing.length && !cfg.invalid.length;
        return json({
          ok: true,
          serverless: true,
          sub_config: ready ? "ok" : { missing: cfg.missing, invalid: cfg.invalid },
          cert_fp: syncedFp ? "probe" : "secret",
        });
      }
      // /api/login 由 panel 返回 410：口令登录已停用，只剩 Microsoft 设备码登录。
      const res = await handlePanel(ctx);
      return withCookies(res, ctx.cookies);
    }
    if (path === "/login") {
      return serveAsset(env, request, url, "/static/login.html");
    }
    // 静态资源允许匿名：login.html 自身的样式与脚本必须先能加载，
    // 否则未登录页面会拿不到 CSS/JS，形成登录死循环。
    if (path.startsWith("/static/")) {
      return serveAsset(env, request, url, path);
    }
    // 规则集 / geo 数据镜像：mihomo 拉取时没有 cookie，必须匿名可取。
    const mirror = mirrorName(path);
    if (mirror) return serveMirror(ctx, mirror);

    // ---- 会话 ----
    const sess = await sessionOf(request, env.SESSION_SECRET);
    if (!sess) {
      // 订阅链接是公开可取的（token 即凭证），其余一律要登录
      const seg = path.replace(/^\//, "");
      if (isSubToken(seg)) return serveSub(ctx, seg);
      if (path.startsWith("/api/")) return json({ error: "unauthorized" }, 401);
      return new Response(null, { status: 302, headers: { Location: loginTo, "Cache-Control": "no-store" } });
    }
    ctx.sess = sess;
    // 身份一律来自 KV 用户记录；遗留的口令会话（uuid=admin）不再接受。
    ctx.user = sess.uuid && sess.uuid !== "admin" ? await getUser(env, sess.uuid) : null;
    if (!ctx.user) {
      return withCookies(json({ error: "账号不存在，请重新登录" }, 401), ctx.cookies);
    }
    // 管理权限由用户记录上的 admin 标记决定，cookie 里的角色只是缓存。
    if (isAdminUser(ctx.user)) ctx.sess.role = "admin";
    if (sess.silent) {
      ctx.cookies.push(...await issueCookies(env.SESSION_SECRET, isAdminUser(ctx.user) ? "admin" : "user", sess.uuid));
    }

    // 档案缓存：超过 7 天时用 refresh_token 后台静默刷新，不打扰用户。
    if (ctx.user && profileStale(ctx.user)) {
      ctx.wait(refreshProfileInBackground(env, env.SESSION_SECRET, ctx.user));
    }

    let res;
    if (path === "/") {
      res = await serveAsset(env, request, url, "/static/index.html");
    } else if (path.startsWith("/static/")) {
      res = await serveAsset(env, request, url, path);
    } else if (path.startsWith("/api/")) {
      res = await handlePanel(ctx);
    } else {
      const seg = path.replace(/^\//, "");
      if (isSubToken(seg)) res = await serveSub(ctx, seg);
      else res = new Response("not found", { status: 404 });
    }
    return withCookies(res, ctx.cookies);
  },

  // 限额判定：Cron Trigger 每分钟一次（见 wrangler [triggers]）。
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      enforceQuotas(env).catch((e) => console.error("[quota] " + (e && e.message ? e.message : e)))
    );
  },
};
