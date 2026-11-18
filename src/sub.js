// 订阅渲染：只做占位符替换，绝不解析/重排 YAML。
//
// 模板 sub-template.yaml 直接来自当前线上 yml（以它为准）：
//   - 566 条 rules 逐行原样保留；
//   - 5 处一行式配置（proxies / proxy-groups / proxy-providers / rule-providers）
//     保持单行，不拆成块状 YAML；
//   - 12 个标量占位符是唯一的动态部分：其中 HY2_PASSWORD 与 REALITY_UUID
//     按用户取值（每人独立凭证，超限时整体轮换），其余来自 Worker 配置
//     （server / 证书指纹 / 端口 / SNI / 面板域名 / 边缘订阅）；
//     另有一个派生占位符 __SERVER_DIRECT_RULES__，由 HY2_SERVER / REALITY_SERVER
//     拼成「节点自身直连」的 rules 行（见 serverDirectRules）。
//
// 用 Text module import，模板不会作为静态资源被公网直接读到。

import SUB_TEMPLATE from "../sub-template.yaml";

const ENV_FIELDS = [
  "HY2_SERVER", "HY2_FINGERPRINT", "HY2_OBFS_PASSWORD",
  "REALITY_SERVER", "REALITY_PUBLIC_KEY", "EDGETUNNEL_URL",
  // 端口与 SNI 由部署配置提供，模板里不留固定值
  "HY2_PORT", "HY2_PORTS", "PANEL_HOST", "VLESS_PORT", "VLESS_SNI",
];

// 模板里 __EDGETUNNEL_URL__ 已经包在双引号内，永不重复加引号；
// 其余标量保持裸写（与线上 yml 逐字节一致），只在值真的含有 YAML 分隔符时才包单引号。
const NEVER_QUOTE = new Set(["EDGETUNNEL_URL"]);

// 节点自身的 server 必须直连：TUN 模式下连代理服务器本身也会命中 MATCH,PROXY，
// 平白多绕一跳（走 pro 连 pro 的 443、走 flash 连 flash 的 UDP），甚至自环。
// 地址来自 secrets，模板里不落真实 IP；同一 IP 只输出一条。
const SERVER_RULES_PLACEHOLDER = "SERVER_DIRECT_RULES";
NEVER_QUOTE.add(SERVER_RULES_PLACEHOLDER);

// hy2 节点只对管理员下发：整行 proxy 与组内引用都由代码按身份注入，
// 普通用户模板里连节点名都不出现（避免组引用悬空导致 mihomo 加载失败）。
// 名字只在 HY2_PROXY_NAME 一处定义，proxy 行和 group 引用共用，防止漂移。
const HY2_PROXY_PLACEHOLDER = "HY2_PROXY_LINE";
const HY2_GROUP_PLACEHOLDER = "HY2_GROUP_PREFIX";
NEVER_QUOTE.add(HY2_PROXY_PLACEHOLDER);
NEVER_QUOTE.add(HY2_GROUP_PLACEHOLDER);

export const HY2_PROXY_NAME = "负责快，网页浏览用我｜但是水龙头只有十兆，大文件下载用我会断掉哦🔞";

// 管理员订阅里的 hy2 行（gecko obfs；min/max 用 mihomo 文档示例值 512/1200）。
// 行内保留占位符，注入后由统一替换流程填充，引号规则与模板保持一致。
const HY2_PROXY_LINE = `- { name: '${HY2_PROXY_NAME}', type: hysteria2, server: __HY2_SERVER__, port: __HY2_PORT__, ports: __HY2_PORTS__, password: __HY2_PASSWORD__, sni: __PANEL_HOST__, fingerprint: __HY2_FINGERPRINT__, server-cert-fingerprint: __HY2_FINGERPRINT__, obfs: gecko, obfs-password: __HY2_OBFS_PASSWORD__, obfs-min-packet-size: 512, obfs-max-packet-size: 1200 }`;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-fA-F:]+:[0-9a-fA-F:]*$/;

function serverDirectRules(servers) {
  const seen = new Set();
  const lines = [];
  for (const raw of servers) {
    const host = String(raw == null ? "" : raw).trim().replace(/^\[|\]$/g, "");
    if (!host || host.startsWith("__") || seen.has(host)) continue;
    seen.add(host);
    if (IPV4.test(host)) lines.push(`  - IP-CIDR,${host}/32,DIRECT,no-resolve`);
    else if (IPV6.test(host)) lines.push(`  - IP-CIDR6,${host}/128,DIRECT,no-resolve`);
    else lines.push(`  - DOMAIN-SUFFIX,${host},DIRECT`);
  }
  return lines.join("\n");
}
const YAML_UNSAFE = /[:#{}[\],&*!|>'"%@`\s]/;

function scalar(v, placeholder) {
  const s = String(v == null ? "" : v);
  if (NEVER_QUOTE.has(placeholder)) return s;
  return YAML_UNSAFE.test(s) ? "'" + s.replace(/'/g, "''") + "'" : s;
}

const PLACEHOLDER_RE = /__[A-Z0-9_]+__/g;

// 订阅配置体检：值缺失、还是未替换的占位符、形态明显不对（端口非数字、host 含非法字符）。
// 只管「渲染前必须存在」的配置字段；用户级凭证在 renderSubscription 里单独判定。
// 返回字段名而不是布尔值，报错时能直接说清是哪一个没配。
// overrides：运行时来源的值（HY2_FINGERPRINT，来自探针 /api/cert 写进 KV 的指纹）。
// 校验的是「实际会被渲染的值」，不是 secret 里的历史值。
export function checkSubConfig(env, overrides = {}) {
  const missing = [];
  const invalid = [];
  for (const key of ENV_FIELDS) {
    const raw = overrides[key] == null || overrides[key] === "" ? env[key] : overrides[key];
    const s = raw == null ? "" : String(raw).trim();
    if (!s || s.startsWith("__")) { missing.push(key); continue; }
    if (key === "HY2_PORT" || key === "VLESS_PORT") {
      const n = Number(s);
      if (!/^\d{1,5}$/.test(s) || n < 1 || n > 65535) invalid.push(`${key}=${s}`);
    } else if (key === "HY2_PORTS") {
      const m = /^(\d{1,5})-(\d{1,5})$/.exec(s);
      if (!m || +m[1] < 1 || +m[2] > 65535 || +m[1] > +m[2]) invalid.push(`${key}=${s}`);
    } else if (key === "PANEL_HOST" || key === "VLESS_SNI") {
      if (!/^[A-Za-z0-9.-]+$/.test(s)) invalid.push(`${key}=${s}`);
    } else if (key === "HY2_FINGERPRINT") {
      // 证书 SHA-256 pin，允许带冒号；mihomo 会忽略冒号与大小写
      if (!/^[0-9a-f]{64}$/.test(s.toLowerCase().replace(/:/g, ""))) invalid.push(`${key}=${s}`);
    }
  }
  return { missing, invalid };
}

export function renderSubscription(env, user, overrides = {}) {
  // 普通用户只下发 vless：hy2_pass 只在管理员订阅里有意义，缺了不该拦住整个订阅。
  const isAdmin = !!(user && user.admin === true);
  if (!user || !user.vless_uuid || (isAdmin && !user.hy2_pass)) {
    const err = new Error(isAdmin && user && user.vless_uuid
      ? "管理员 hy2 凭证缺失（hy2_pass）"
      : "用户节点凭证缺失（vless_uuid）");
    err.configMissing = true;
    throw err;
  }
  const cfg = checkSubConfig(env, overrides);
  if (cfg.missing.length || cfg.invalid.length) {
    const parts = [];
    if (cfg.missing.length) parts.push("缺少 " + cfg.missing.join(", "));
    if (cfg.invalid.length) parts.push("格式非法 " + cfg.invalid.join(", "));
    const err = new Error("订阅配置不完整：" + parts.join("；"));
    err.configMissing = true;
    throw err;
  }
  const values = {
    HY2_PASSWORD: user.hy2_pass,
    REALITY_UUID: user.vless_uuid,
  };
  for (const placeholder of ENV_FIELDS) {
    const o = overrides[placeholder];
    values[placeholder] = o == null || o === "" ? env[placeholder] : o;
  }

  let out = SUB_TEMPLATE;
  // 身份相关片段先注入（片段内仍含占位符，随后统一替换）
  const admin = isAdmin;
  out = out.split("__" + HY2_PROXY_PLACEHOLDER + "__")
    .join(admin ? HY2_PROXY_LINE : "");
  out = out.split("__" + HY2_GROUP_PLACEHOLDER + "__")
    .join(admin ? `'${HY2_PROXY_NAME}', ` : "");
  for (const placeholder of Object.keys(values)) {
    out = out.split("__" + placeholder + "__").join(scalar(values[placeholder], placeholder));
  }
  // 派生规则行（多行注入）：server 缺失已在 checkSubConfig 报错，这里不再判定空值
  out = out.split("__" + SERVER_RULES_PLACEHOLDER + "__")
    .join(serverDirectRules([env.HY2_SERVER, env.REALITY_SERVER]));
  // 兜底：任何未替换的占位符都不允许下发到客户端，且指名道姓
  const leftover = [...new Set(out.match(PLACEHOLDER_RE) || [])];
  if (leftover.length) {
    const err = new Error("订阅模板残留未替换占位符：" + leftover.join(", "));
    err.configMissing = true;
    throw err;
  }
  return out;
}

// 订阅展示名（emoji/中文）：profile-title 走 base64 前缀，filename 走 RFC 5987
// UTF-8 percent-encoding —— 两条规范都见 Mihomo Party / Clash Verge Rev 文档。
export const PROFILE_TITLE = "哦鲸鲸🍆呀咩咯🍚";

const utf8b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

// 没有计量执行点，就不下发 Subscription-Userinfo（info 为 null/undefined）。
// 之前恒为 upload=0; download=0; total=0 属于假数据，已移除。
// info = { upload, download, total? }，单位一律字节（不是整 GB 数）——
// 客户端把字节格式化成 GB 显示，塞整 GB 数字会被当成字节显示成 "700 B"。
// total 缺省时只发 upload/download（合法，客户端只显示已用量）。
export function subscriptionHeaders(env, info) {
  const h = {
    "Content-Type": "text/yaml; charset=utf-8",
    "Cache-Control": "no-store",
    "Profile-Title": "base64:" + utf8b64(PROFILE_TITLE),
    "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(PROFILE_TITLE),
  };
  // 主页：订阅卡片右键「首页」按钮。PROFILE_WEB_PAGE_URL 显式配置优先；
  // 缺省用面板域名 + 部署子路径拼（PANEL_HOST=www.bemly.moe、BASE_PATH=/ochinchin
  // 时正好得到 https://www.bemly.moe/ochinchin/）。
  const bp = String((env && env.BASE_PATH) || "").replace(/\/+$/, "");
  const home = String((env && env.PROFILE_WEB_PAGE_URL) || "").trim()
    || (env && env.PANEL_HOST ? "https://" + env.PANEL_HOST + bp + "/" : "");
  if (home) h["Profile-Web-Page-Url"] = home;
  if (info && Number.isFinite(info.upload) && Number.isFinite(info.download)) {
    const parts = [`upload=${Math.round(info.upload)}`, `download=${Math.round(info.download)}`];
    if (Number.isFinite(info.total) && info.total > 0) parts.push(`total=${Math.round(info.total)}`);
    h["Subscription-Userinfo"] = parts.join("; ");
  }
  return h;
}
