// 订阅渲染：只做占位符替换，绝不解析/重排 YAML。
//
// 模板 sub-template.yaml 直接来自当前线上 yml（以它为准）：
//   - 566 条 rules 逐行原样保留；
//   - 5 处一行式配置（proxies / proxy-groups / proxy-providers / rule-providers）
//     保持单行，不拆成块状 YAML；
//   - 13 个标量占位符是唯一的动态部分：其中 HY2_PASSWORD 与 REALITY_UUID
//     按用户取值（每人独立凭证，超限时整体轮换），其余来自 Worker 配置
//     （server / 证书指纹 / 端口 / SNI / 面板域名 / 边缘订阅）；
//     另有一个派生占位符 __SERVER_DIRECT_RULES__，由 HY2_SERVER / REALITY_SERVER
//     拼成「节点自身直连」的 rules 行（见 serverDirectRules）。
//
// 用 Text module import，模板不会作为静态资源被公网直接读到。

import SUB_TEMPLATE from "../sub-template.yaml";

const ENV_FIELDS = [
  "HY2_SERVER", "HY2_FINGERPRINT", "HY2_CERT_FP",
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
// overrides：运行时来源的值（HY2_FINGERPRINT / HY2_CERT_FP，同一个探针 /api/cert 指纹）。
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
    } else if (key === "HY2_CERT_FP" || key === "HY2_FINGERPRINT") {
      // 证书 SHA-256 pin，允许带冒号；mihomo 会忽略冒号与大小写
      if (!/^[0-9a-f]{64}$/.test(s.toLowerCase().replace(/:/g, ""))) invalid.push(`${key}=${s}`);
    }
  }
  return { missing, invalid };
}

export function renderSubscription(env, user, overrides = {}) {
  if (!user || !user.hy2_pass || !user.vless_uuid) {
    const err = new Error("用户节点凭证缺失（hy2_pass / vless_uuid）");
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

// 没有计量执行点，就不下发 Subscription-Userinfo。
// 之前恒为 upload=0; download=0; total=0 属于假数据，已移除。
export function subscriptionHeaders() {
  return {
    "Content-Type": "text/yaml; charset=utf-8",
    "Cache-Control": "no-store",
  };
}
