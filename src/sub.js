// 订阅渲染：只做占位符替换，绝不解析/重排 YAML。
//
// 模板 sub-template.yaml 直接来自当前线上 yml（以它为准）：
//   - 568 条 rules 逐行原样保留；
//   - 5 处一行式配置（proxies / proxy-groups / proxy-providers / rule-providers）
//     保持单行，不拆成块状 YAML；
//   - 8 个 __XXX__ 占位符是唯一的动态部分：其中 HY2_PASSWORD 与 REALITY_UUID
//     按用户取值（每人独立凭证，超限时整体轮换），其余来自 Worker Secrets。
//
// 用 Text module import，模板不会作为静态资源被公网直接读到。

import SUB_TEMPLATE from "../sub-template.yaml";

const ENV_FIELDS = [
  "HY2_SERVER", "HY2_FINGERPRINT", "HY2_CERT_FP",
  "REALITY_SERVER", "REALITY_PUBLIC_KEY", "EDGETUNNEL_URL",
];

// 模板里 __EDGETUNNEL_URL__ 已经包在双引号内，永不重复加引号；
// 其余标量保持裸写（与线上 yml 逐字节一致），只在值真的含有 YAML 分隔符时才包单引号。
const NEVER_QUOTE = new Set(["EDGETUNNEL_URL"]);
const YAML_UNSAFE = /[:#{}[\],&*!|>'"%@`\s]/;

function scalar(v, placeholder) {
  const s = String(v == null ? "" : v);
  if (NEVER_QUOTE.has(placeholder)) return s;
  return YAML_UNSAFE.test(s) ? "'" + s.replace(/'/g, "''") + "'" : s;
}

export function renderSubscription(env, user) {
  if (!user || !user.hy2_pass || !user.vless_uuid) {
    const err = new Error("用户节点凭证缺失（hy2_pass / vless_uuid）");
    err.configMissing = true;
    throw err;
  }
  const values = {
    HY2_PASSWORD: user.hy2_pass,
    REALITY_UUID: user.vless_uuid,
  };
  for (const placeholder of ENV_FIELDS) values[placeholder] = env[placeholder];

  let out = SUB_TEMPLATE;
  const missing = [];
  for (const placeholder of Object.keys(values)) {
    const v = values[placeholder];
    if (v == null || String(v).trim() === "" || String(v).startsWith("__")) {
      missing.push(placeholder);
      continue;
    }
    out = out.split("__" + placeholder + "__").join(scalar(v, placeholder));
  }
  if (missing.length) {
    const err = new Error("订阅配置不完整，缺少: " + missing.join(", "));
    err.configMissing = true;
    throw err;
  }
  // 兜底：任何未替换的占位符都不允许下发到客户端
  if (/__[A-Z0-9_]+__/.test(out)) {
    const err = new Error("订阅模板存在未知占位符");
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
