// Microsoft 设备码 -> Xbox Live -> XSTS -> Minecraft 正版登录链路。
//
// 出站方式：6 个认证请求全部不由 Worker 直接发出，而是经 ORIGIN_API_BASE 的
// /api/relay/mc 交给源站探针代发（结构化 op 白名单，映射表见 probe/hy2dash_probe.py）。
// 原因：Cloudflare Workers 的出站 IP 被 api.minecraftservices.com 前置的
// Cloudflare WAF 拦截（403 text/html，连不带 token 的 GET 都被拒），源站出口正常。
// UI、会话、KV、订阅仍留在 Worker；代发端点不保管密钥、不落盘令牌。
//
// client_id 是 OAuth 的公开应用标识（不是凭据）：默认内置在下面的常量里，
// 不需要注入 Secret。公共客户端（public client）流程不带 client_secret，
// scope 固定为 XboxLive.signin offline_access，租户固定 consumers（个人微软账号）。
//
// 完整链路共 6 步，最后一步拿到的 MC profile.id 就是用户的正版 UUID，
// 用它做全局唯一身份。Mojang 对第 5 步（login_with_xbox）实行 AppID 允许名单：
// 未在名单内的 Azure 应用会返回 403 "Invalid app registration"。这里把官方
// 响应原文带出来，不武断归因，也不吞掉错误。

const RELAY_PATH = "/api/relay/mc";
const RELAY_TIMEOUT_MS = 15000;

export const MC_SCOPE = "XboxLive.signin offline_access";

// 内置的 Microsoft Application (client) ID：Axolotl 启动器的公共客户端 AppID。
// 2026-11-15 本机直连实测：它在 Mojang 允许名单内，login_with_xbox 返回 200，
// 设备码 -> MSA -> XBL -> XSTS -> MC token -> profile 六步全通。
// 之前内置的 SJMCL AppID 实测 403 Invalid app registration，已替换。
// 此值是公开标识、不是凭据；换成自有 AppID 时改这一行即可，也可用 Worker
// Secret MS_CLIENT_ID 覆盖，不改代码就切换。
// 注意：这仍是借用第三方启动器的 ID 作为过渡，官方要求第三方应用使用自己的
// AppID 并提交 aka.ms/mce-reviewappid 审核，借用的随时可能被吊销。
export const MS_CLIENT_ID = "c7104738-eff0-4fc9-a4ad-59e2c72ec691";

// 全项目唯一的 client_id 取值入口。默认用内置常量；Secret 存在时优先用 Secret。
export function resolveClientId(env) {
  return (env && env.MS_CLIENT_ID) || MS_CLIENT_ID;
}

const form = (obj) => new URLSearchParams(obj).toString();

const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };
const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json" };

function mcError(stage, detail) {
  const e = new Error(detail || stage);
  e.stage = stage;
  return e;
}

// 认证代发：把 op + 白名单请求头 + 正文交给源站，由源站按固定映射表发出。
// 返回 { res: { ok, status }, data, text }，与原 fetch 的消费方式保持一致。
async function relayCall(env, op, { headers = {}, body = "" } = {}) {
  const base = env && env.ORIGIN_API_BASE;
  if (!base) throw mcError("relay", "未配置认证代发通道 ORIGIN_API_BASE");
  const probeToken = env && env.PROBE_TOKEN;
  if (!probeToken) throw mcError("relay", "未配置回源凭证 PROBE_TOKEN");
  let r;
  try {
    r = await fetch(base.replace(/\/$/, "") + RELAY_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Probe-Token": probeToken,
      },
      body: JSON.stringify({ op, headers, body }),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
  } catch (e) {
    throw mcError("relay", "认证代发服务不可达：" + (e.message || String(e)));
  }
  if (!r.ok) {
    const t = await r.text().catch(() => {
      throw mcError("relay", "读取代发错误响应失败（HTTP " + r.status + "）");
    });
    throw mcError("relay", "认证代发失败（HTTP " + r.status + "）" + (t ? "：" + t.slice(0, 160) : ""));
  }
  let d;
  try { d = await r.json(); } catch { throw mcError("relay", "认证代发返回格式异常"); }
  const status = Number(d.status);
  if (!Number.isFinite(status) || status <= 0) throw mcError("relay", "认证代发响应缺少有效 status");
  if (typeof d.body !== "string") throw mcError("relay", "认证代发响应缺少 body");
  const text = d.body;
  let data = {};
  if (text.trim()) {
    try { data = JSON.parse(text); }
    catch {
      throw mcError("relay", "上游返回非 JSON 响应（HTTP " + status + "）：" + text.slice(0, 120));
    }
  }
  return { res: { ok: status >= 200 && status < 300, status }, data, text };
}

async function postForm(env, op, body) {
  return relayCall(env, op, { headers: FORM_HEADERS, body: form(body) });
}

async function postJSON(env, op, body, headers = {}) {
  return relayCall(env, op, {
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(body),
  });
}

// 1) 申请设备码。返回微软给的 user_code / verification_uri，浏览器展示给用户。
export async function deviceCodeStart(clientId, env) {
  const { res, data } = await postForm(env, "devicecode", {
    client_id: clientId,
    scope: MC_SCOPE,
  });
  if (!res.ok || !data.device_code || !data.user_code) {
    throw mcError("devicecode", data.error_description || data.error || ("HTTP " + res.status));
  }
  const expiresIn = Number(data.expires_in);
  const interval = Number(data.interval);
  if (!data.verification_uri) throw mcError("devicecode", "微软响应缺少 verification_uri");
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw mcError("devicecode", "微软响应缺少有效 expires_in");
  if (!Number.isFinite(interval) || interval <= 0) throw mcError("devicecode", "微软响应缺少有效 interval");
  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    expires_in: expiresIn,
    interval,
    message: typeof data.message === "string" ? data.message : "",
  };
}

// 2) 轮询设备码。pending 状态用 code 返回给前端，让前端继续轮询；
//    成功时返回 MSA token（含 refresh_token）。
export async function deviceCodePoll(clientId, deviceCode, env) {
  const { res, data } = await postForm(env, "token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: clientId,
    device_code: deviceCode,
  });
  if (data.error) {
    const waiting = data.error === "authorization_pending" || data.error === "slow_down";
    const out = {
      status: waiting ? "pending" : "error",
      code: data.error,
      detail: data.error_description || data.error,
      slow: data.error === "slow_down",
    };
    return out;
  }
  if (!res.ok || !data.access_token) {
    return { status: "error", code: "token_http_" + res.status, detail: "MSA token 交换失败" };
  }
  return { status: "ok", token: msaToken(data) };
}

function msaToken(data) {
  if (!data.refresh_token) throw mcError("token", "微软响应缺少 refresh_token");
  const expiresIn = Number(data.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw mcError("token", "微软响应缺少有效 expires_in");
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: expiresIn,
  };
}

// 静默续期：用 refresh_token 换新的 MSA token，全程不需要用户再输码。
export async function refreshMSA(clientId, refreshToken, env) {
  const { res, data } = await postForm(env, "token", {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    scope: MC_SCOPE,
  });
  if (!res.ok || !data.access_token) {
    throw mcError("refresh", data.error_description || data.error || ("HTTP " + res.status));
  }
  return msaToken(data);
}

// 3) MSA access_token -> Xbox Live user token + uhs
async function xblUserToken(msa, env) {
  const { res, data } = await postJSON(env, "xbl", {
    Properties: {
      AuthMethod: "RPS",
      SiteName: "user.auth.xboxlive.com",
      RpsTicket: "d=" + msa,
    },
    RelyingParty: "http://auth.xboxlive.com",
    TokenType: "JWT",
  });
  if (!res.ok || !data.Token) {
    throw mcError("xbl", "Xbox Live 用户令牌获取失败（HTTP " + res.status + "）");
  }
  const uhs = data.DisplayClaims?.xui?.[0]?.uhs || "";
  if (!uhs) throw mcError("xbl", "Xbox Live 响应缺少 uhs");
  return { token: data.Token, uhs };
}

// 4) XBL user token -> XSTS token（RelyingParty 必须是 Minecraft 服务）
async function xstsToken(xblToken, env) {
  const { res, data } = await postJSON(env, "xsts", {
    Properties: { SandboxId: "RETAIL", UserTokens: [xblToken] },
    RelyingParty: "rp://api.minecraftservices.com/",
    TokenType: "JWT",
  });
  if (!res.ok || !data.Token) {
    const xerr = String(data.XErr || "");
    const why = {
      "2148916233": "该微软账号没有 Xbox 档案，请先登录一次 xbox.com 创建档案",
      "2148916235": "该账号所在地区暂不支持 Xbox Live",
      "2148916236": "需要家长同意（未成年账号）",
      "2148916237": "需要家长同意（未成年账号）",
      "2148916238": "未成年账号无法独立完成认证，需加入家庭组",
    }[xerr] || data.Message || ("XSTS 授权失败（HTTP " + res.status + "）");
    throw mcError("xsts", why);
  }
  const uhs = data.DisplayClaims?.xui?.[0]?.uhs || "";
  if (!uhs) throw mcError("xsts", "XSTS 响应缺少 uhs");
  return { token: data.Token, uhs };
}

// 5) XSTS -> Minecraft access token。Mojang 对此端点实行 AppID 允许名单，
//    未过审的应用返回 403 并带 errorMessage；把官方原文透出以便准确诊断。
async function minecraftToken(uhs, xsts, env) {
  const { res, data, text } = await postJSON(env, "mc_login", {
    identityToken: "XBL3.0 x=" + uhs + ";" + xsts,
  });
  if (!res.ok || !data.access_token) {
    const official = [data.errorMessage, data.error, data.message]
      .filter(Boolean).join(" | ")
      || (text.trim() ? "非 JSON 响应（疑似 WAF 拦截页）：" + text.slice(0, 120) : ("HTTP " + res.status));
    const hint = res.status === 403
      ? "Minecraft 服务拒绝（HTTP 403）：" + official
        + "。若原文为 Invalid app registration，说明本站点 Azure Application ID 不在 Mojang 允许名单"
        + "（需提交 aka.ms/mce-reviewappid 审核，或换用已获批的 AppID）；若为 HTML 拦截页，"
        + "则说明认证代发出口被 WAF 拦截。两种情况都与你的微软账号无关。"
      : official;
    throw mcError("minecraft_login", hint);
  }
  return data.access_token;
}

// 6) Minecraft profile：id 即正版 UUID（无连字符），name 即游戏 ID。
async function minecraftProfile(mcToken, env) {
  const { res, data } = await relayCall(env, "profile", {
    headers: { Accept: "application/json", Authorization: "Bearer " + mcToken },
  });
  if (res.status === 404) {
    throw mcError("minecraft_profile", "该账号没有购买 Minecraft Java 版，或尚未设置游戏 ID");
  }
  if (!res.ok) throw mcError("minecraft_profile", "档案读取失败（HTTP " + res.status + "）");
  if (!data.id || !data.name) throw mcError("minecraft_profile", "档案缺少 uuid/name");
  return {
    uuid: data.id,
    name: data.name,
    skin: data.skins?.find((s) => s.state === "ACTIVE")?.url || "",
  };
}

// 完整链路：MSA access_token -> 正版 MC 档案
export async function loginWithMSA(msaToken, env) {
  const xbl = await xblUserToken(msaToken, env);
  const xsts = await xstsToken(xbl.token, env);
  const mc = await minecraftToken(xsts.uhs, xsts.token, env);
  const profile = await minecraftProfile(mc, env);
  return { ...profile, mc_access_token: mc };
}

// 用 refresh_token 静默刷新一次档案（不要求用户交互）。
export async function refreshProfile(clientId, refreshToken, env) {
  const msa = await refreshMSA(clientId, refreshToken, env);
  const profile = await loginWithMSA(msa.access_token, env);
  return { msa, profile };
}
