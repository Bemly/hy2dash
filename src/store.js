// Worker 侧持久化：Cloudflare KV 存用户/令牌/设备码会话，Web Crypto 做签名与加密。
//
// 三层缓存，避免用户二次走设备码：
//   1. hy2dash_session —— HttpOnly 签名会话 cookie（默认 30 天）；
//   2. hy2dash_id —— 更长期的识别 cookie（默认 180 天），会话过期时静默重签；
//   3. KV 里的用户档案 + 加密 refresh_token，用于静默刷新档案而不打扰用户。
//
// refresh_token 与 device_code 一律 AES-GCM 加密后落 KV，密钥由 SESSION_SECRET 派生，
// 该 secret 只存在于 Worker Secrets，仓库里没有任何真实值。

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const SESSION_TTL = 30 * 24 * 3600;
const ID_TTL = 180 * 24 * 3600;
const DEVICE_TTL = 15 * 60;
const PROFILE_REFRESH = 7 * 24 * 3600;

function b64url(bytes) {
  let s = "";
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s) {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

async function rawKey(secret, label) {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(secret + "|hy2dash|" + label));
  return material;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", await rawKey(secret, "sig"), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function aesKey(secret) {
  return crypto.subtle.importKey("raw", await rawKey(secret, "enc"), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function seal(secret, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(secret);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plain));
  const all = new Uint8Array(iv.length + ct.byteLength);
  all.set(iv, 0);
  all.set(new Uint8Array(ct), iv.length);
  return b64url(all);
}

export async function open(secret, blob) {
  try {
    const all = unb64url(blob);
    const iv = all.slice(0, 12);
    const ct = all.slice(12);
    const key = await aesKey(secret);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return decoder.decode(pt);
  } catch {
    return null;
  }
}

async function signPayload(secret, obj) {
  const body = b64url(encoder.encode(JSON.stringify(obj)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return body + "." + b64url(sig);
}

async function verifyPayload(secret, token) {
  if (!token || token.indexOf(".") < 0) return null;
  const [body, sig] = token.split(".");
  const key = await hmacKey(secret);
  let ok = false;
  try { ok = await crypto.subtle.verify("HMAC", key, unb64url(sig), encoder.encode(body)); } catch { return null; }
  if (!ok) return null;
  let obj;
  try { obj = JSON.parse(decoder.decode(unb64url(body))); } catch { return null; }
  if (!obj || obj.e < Math.floor(Date.now() / 1000)) return null;
  return obj;
}

function cookie(name, value, ttl) {
  return name + "=" + value + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + ttl;
}

export async function issueCookies(secret, role, uuid) {
  const now = Math.floor(Date.now() / 1000);
  const session = await signPayload(secret, { r: role, u: uuid, e: now + SESSION_TTL });
  const id = await signPayload(secret, { u: uuid, e: now + ID_TTL });
  return [cookie("hy2dash_session", session, SESSION_TTL), cookie("hy2dash_id", id, ID_TTL)];
}

export function clearCookies() {
  return [
    "hy2dash_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    "hy2dash_id=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
  ];
}

function cookieMap(request) {
  const out = {};
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// 返回 { role, uuid, silent }；silent=true 表示会话已过期但识别 cookie 仍有效，
// 调用方应重新签发会话 cookie（用户无感知，不用再输设备码）。
export async function sessionOf(request, secret) {
  const c = cookieMap(request);
  const s = await verifyPayload(secret, c.hy2dash_session);
  if (s && s.r && s.u) return { role: s.r, uuid: s.u, silent: false };
  const id = await verifyPayload(secret, c.hy2dash_id);
  if (id && id.u) return { role: "user", uuid: id.u, silent: true };
  return null;
}

// ---------------- KV ----------------

export const KV = {
  user: (uuid) => "u:" + uuid,
  token: (tok) => "t:" + tok,
  device: (sid) => "d:" + sid,
  admin: () => "cfg:admin",
  seq: () => "cfg:seq",
  profileCache: (uuid) => "cache:profile:" + uuid,
};

export async function getUser(env, uuid) {
  if (!uuid) return null;
  return env.USERS.get(KV.user(uuid), "json");
}

export async function putUser(env, user) {
  await env.USERS.put(KV.user(user.uuid), JSON.stringify(user));
}

export async function userByToken(env, token) {
  const uuid = await env.USERS.get(KV.token(token));
  return uuid ? getUser(env, uuid) : null;
}

export async function allUsers(env) {
  const out = [];
  let cursor = null;
  do {
    const page = await env.USERS.list({ prefix: "u:", cursor: cursor || undefined });
    for (const k of page.keys) {
      const u = await env.USERS.get(k.name, "json");
      if (u) out.push(u);
    }
    cursor = page.cursor || null;
  } while (cursor && out.length < 500);
  return out;
}

function randHex(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function nextSlot(env) {
  const cur = Number(await env.USERS.get(KV.seq())) || 0;
  const n = cur + 1;
  await env.USERS.put(KV.seq(), String(n));
  return "u" + String(n).padStart(2, "0");
}

// 首次正版登录：建立用户档案。UUID 是身份主键，重复登录只更新档案/refresh_token。
export async function upsertUser(env, secret, profile, msaRefreshToken) {
  const existing = await getUser(env, profile.uuid);
  const now = Math.floor(Date.now() / 1000);
  const rt = msaRefreshToken ? await seal(secret, msaRefreshToken) : (existing?.rt || "");
  const user = existing || {
    uuid: profile.uuid,
    sub_token: randHex(16),
    hy_user: await nextSlot(env),
    enabled: true,
    gate: 0,
    created_at: now,
    nick: "",
    avatar: "",
    summary: "",
    steam_state: "",
    game: "",
    buckets: {},
  };
  user.name = profile.name;
  user.nick = profile.name;
  user.avatar = "https://mc-heads.net/avatar/" + profile.uuid + "/64";
  user.rt = rt;
  user.rt_at = now;
  user.profile_at = now;
  await env.USERS.put(KV.token(user.sub_token), user.uuid);
  await putUser(env, user);
  return user;
}

export async function rotateToken(env, user) {
  if (user.sub_token) await env.USERS.delete(KV.token(user.sub_token));
  user.sub_token = randHex(16);
  await env.USERS.put(KV.token(user.sub_token), user.uuid);
  await putUser(env, user);
  return user.sub_token;
}

export function profileStale(user) {
  const now = Math.floor(Date.now() / 1000);
  return !!user.rt && now - (user.profile_at || 0) > PROFILE_REFRESH;
}

// ---------------- 设备码会话 ----------------

export async function putDevice(env, secret, sid, info) {
  const payload = {
    device_code: await seal(secret, info.device_code),
    interval: info.interval,
    expires_at: Math.floor(Date.now() / 1000) + info.expires_in,
    client_id: info.client_id,
  };
  await env.USERS.put(KV.device(sid), JSON.stringify(payload), { expirationTtl: DEVICE_TTL });
}

export async function getDevice(env, secret, sid) {
  const d = await env.USERS.get(KV.device(sid), "json");
  if (!d) return null;
  const dc = await open(secret, d.device_code);
  if (!dc || d.expires_at < Math.floor(Date.now() / 1000)) return null;
  return { device_code: dc, interval: d.interval, client_id: d.client_id, expires_at: d.expires_at };
}

export async function delDevice(env, sid) {
  await env.USERS.delete(KV.device(sid));
}

// ---------------- 管理员口令 ----------------

async function pbkdf2(pass, saltB64, iter) {
  const salt = new Uint8Array(unb64url(saltB64));
  const base = await crypto.subtle.importKey("raw", encoder.encode(pass), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base, 256);
  return b64url(bits);
}

// 管理员初始口令是 Worker Secret 里的随机强密钥（不是用户自选的弱口令），
// 用一次 HMAC-SHA256 加随机盐派生即可。Workers 运行时对高迭代 PBKDF2 有
// CPU 时间约束，150000 轮会在首次初始化时抛异常（线上表现 1101）。
async function passHash(pass, saltB64) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(pass), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, unb64url(saltB64));
  return b64url(sig);
}

export async function setAdminPassword(env, pass) {
  const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await passHash(pass, salt);
  await env.USERS.put(KV.admin(), JSON.stringify({ v: 2, salt, hash }));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 首次部署时 ADMIN_PASSWORD（Worker Secret）只用来在 KV 里初始化一份 PBKDF2 记录；
// 之后一律以 KV 记录为准，管理员可在面板里改密码，无需重新部署。
export async function checkAdminPassword(env, pass) {
  let rec = await env.USERS.get(KV.admin(), "json");
  if (!rec) {
    if (!env.ADMIN_PASSWORD) return false;
    await setAdminPassword(env, env.ADMIN_PASSWORD);
    rec = await env.USERS.get(KV.admin(), "json");
  }
  if (!rec) return false;
  // v:2 = HMAC 派生（当前）；旧记录仍按 PBKDF2 校验，便于平滑升级。
  const got = rec.v === 2 ? await passHash(pass, rec.salt) : await pbkdf2(pass, rec.salt, rec.iter);
  return constantTimeEqual(got, rec.hash);
}

export async function adminExists(env) {
  if (env.ADMIN_PASSWORD) return true;
  return !!(await env.USERS.get(KV.admin(), "json"));
}

export function newSid() { return randHex(16); }
