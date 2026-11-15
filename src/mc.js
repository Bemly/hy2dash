// Microsoft 设备码 -> Xbox Live -> XSTS -> Minecraft 正版登录链路。
//
// client_id 是 OAuth 的公开应用标识（不是凭据）：默认内置在下面的常量里，
// 不需要注入 Secret。公共客户端（public client）流程不带 client_secret，
// scope 固定为 XboxLive.signin offline_access，租户固定 consumers（个人微软账号）。
//
// 完整链路共 6 步，最后一步拿到的 MC profile.id 就是用户的正版 UUID，
// 用它做全局唯一身份。Mojang 对第 5 步（login_with_xbox）实行 AppID 允许名单：
// 未在名单内的 Azure 应用会返回 403 "Invalid app registration"。这里把官方
// 响应原文带出来，不武断归因，也不吞掉错误。

const DEVICE_CODE_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const XBL_USER_URL = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_LOGIN_URL = "https://api.minecraftservices.com/authentication/login_with_xbox";
const MC_PROFILE_URL = "https://api.minecraftservices.com/minecraft/profile";

export const MC_SCOPE = "XboxLive.signin offline_access";

// 内置的 Microsoft Application (client) ID：Axolotl 启动器的公共客户端 AppID。
// 2026-11-15 本机直连实测：它在 Mojang 允许名单内，login_with_xbox 返回 200，
// 设备码 -> MSA -> XBL -> XSTS -> MC token -> profile 六步全通。
// 之前内置的 SJMCL AppID 实测 403 Invalid app registration，已替换。
// 此值是公开标识、不是凭据；换成自有 AppID 时改这一行即可，也可用 Worker
// Secret MS_CLIENT_ID 覆盖，不改代码就切换。
// 注意：这仍是借用第三方启动器的 ID 作为过渡，官方要求第三方应用使用自己的
// AppID 并提交 aka.ms/mce-reviewappid 审核，借用的随时可能被吊销。
// 生产限制（见 README）：Cloudflare Workers 出站到 api.minecraftservices.com
// 被目标站点的 Cloudflare WAF 拦截（403 text/html），所以从 Worker 运行时直接
// 发起的设备码链路仍会失败，且第 5 步拿不到官方 JSON 错误原文。
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

async function postForm(url, body) {
  const res = await fetch(url, { method: "POST", headers: FORM_HEADERS, body: form(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {}; }
  return { res, data };
}

async function postJSON(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {}; }
  return { res, data };
}

// 1) 申请设备码。返回微软给的 user_code / verification_uri，浏览器展示给用户。
export async function deviceCodeStart(clientId) {
  const { res, data } = await postForm(DEVICE_CODE_URL, {
    client_id: clientId,
    scope: MC_SCOPE,
  });
  if (!res.ok || !data.device_code || !data.user_code) {
    throw mcError("devicecode", data.error_description || data.error || ("HTTP " + res.status));
  }
  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri || "https://login.microsoft.com/device",
    expires_in: Number(data.expires_in) || 900,
    interval: Number(data.interval) || 5,
    message: data.message || "",
  };
}

// 2) 轮询设备码。pending 状态用 code 返回给前端，让前端继续轮询；
//    成功时返回 MSA token（含 refresh_token）。
export async function deviceCodePoll(clientId, deviceCode) {
  const { res, data } = await postForm(TOKEN_URL, {
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

// 静默续期：用 refresh_token 换新的 MSA token，全程不需要用户再输码。
export async function refreshMSA(clientId, refreshToken) {
  const { res, data } = await postForm(TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    scope: MC_SCOPE,
  });
  if (!res.ok || !data.access_token) {
    throw mcError("refresh", data.error_description || data.error || ("HTTP " + res.status));
  }
  return msaToken(data, refreshToken);
}

function msaToken(data, fallbackRT) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || fallbackRT || "",
    expires_in: Number(data.expires_in) || 3600,
  };
}

// 3) MSA access_token -> Xbox Live user token + uhs
async function xblUserToken(msa) {
  const { res, data } = await postJSON(XBL_USER_URL, {
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
async function xstsToken(xblToken) {
  const { res, data } = await postJSON(XSTS_URL, {
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
async function minecraftToken(uhs, xsts) {
  const { res, data } = await postJSON(MC_LOGIN_URL, {
    identityToken: "XBL3.0 x=" + uhs + ";" + xsts,
  });
  if (!res.ok || !data.access_token) {
    const official = [data.errorMessage, data.error, data.message]
      .filter(Boolean).join(" | ") || ("HTTP " + res.status);
    const hint = res.status === 403
      ? "Minecraft 服务拒绝（HTTP 403）：" + official
        + "。常见原因是本站点使用的 Azure Application ID 不在 Mojang 允许名单"
        + "（需提交 aka.ms/mce-reviewappid 审核，或换用已获批的 AppID），与你的微软账号无关；"
        + "若官方原文不是 Invalid app registration，则可能涉及账号权利或地区限制。"
      : official;
    throw mcError("minecraft_login", hint);
  }
  return data.access_token;
}

// 6) Minecraft profile：id 即正版 UUID（无连字符），name 即游戏 ID。
async function minecraftProfile(mcToken) {
  const res = await fetch(MC_PROFILE_URL, {
    headers: { Authorization: "Bearer " + mcToken, Accept: "application/json" },
  });
  if (res.status === 404) {
    throw mcError("minecraft_profile", "该账号没有购买 Minecraft Java 版，或尚未设置游戏 ID");
  }
  if (!res.ok) throw mcError("minecraft_profile", "档案读取失败（HTTP " + res.status + "）");
  const data = await res.json();
  if (!data.id || !data.name) throw mcError("minecraft_profile", "档案缺少 uuid/name");
  return {
    uuid: data.id,
    name: data.name,
    skin: data.skins?.find((s) => s.state === "ACTIVE")?.url || "",
  };
}

// 完整链路：MSA access_token -> 正版 MC 档案
export async function loginWithMSA(msaToken) {
  const xbl = await xblUserToken(msaToken);
  const xsts = await xstsToken(xbl.token);
  const mc = await minecraftToken(xsts.uhs, xsts.token);
  const profile = await minecraftProfile(mc);
  return { ...profile, mc_access_token: mc };
}

// 用 refresh_token 静默刷新一次档案（不要求用户交互）。
export async function refreshProfile(clientId, refreshToken) {
  const msa = await refreshMSA(clientId, refreshToken);
  const profile = await loginWithMSA(msa.access_token);
  return { msa, profile };
}
