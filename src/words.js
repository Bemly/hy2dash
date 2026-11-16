// 好记订阅 token 词表：3 词直连、可重复、有序（与 archive/steam-host 的 words.go 等价）。
//
// words.enc 是 4736 行词表的 ROT47 入库。ROT47 只防 casual 明文，不是加密；
// 安全性来自随机采样 + 猜链限流，词表本身不含任何凭据。
// 词本身允许含连字符，所以校验时用 DP 把 token 切成恰好 3 个词表词。
// 词表损坏 / 熵不足一律拒绝启动，不存在 hex 之类的降级格式。

import WORDS_ENC from "../words.enc";

const RESERVED = new Set([
  "login", "register", "api", "static", "health", "logout", "me",
  "admin", "user", "root", "sub", "token", "www", "favicon", "robots",
]);
const MIN_WORDS = 64;

function rot47(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 33 && c <= 126
      ? String.fromCharCode(((c - 33 + 47) % 94) + 33)
      : s[i];
  }
  return out;
}

function parseWordLines(s) {
  const seen = new Set();
  const out = [];
  for (const line of s.split("\n")) {
    const w = line.trim().toLowerCase();
    if (!w || w.startsWith("#") || w.length > 30) continue;
    if (!/^[a-z0-9-]+$/.test(w) || w.startsWith("-") || w.endsWith("-")) continue;
    if (RESERVED.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

const WORDS = parseWordLines(rot47(WORDS_ENC));
const WORD_SET = new Set(WORDS);
if (WORDS.length < MIN_WORDS) {
  throw new Error("订阅词表有效词不足 " + MIN_WORDS + "（实际 " + WORDS.length + "），拒绝启动");
}

// 拒绝采样，避免 Uint32 取模带来的偏差。
function randIndex(n) {
  const b = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / n) * n;
  let v;
  do { crypto.getRandomValues(b); v = b[0]; } while (v >= limit);
  return v % n;
}

export function genPhrase() {
  const pick = () => WORDS[randIndex(WORDS.length)];
  return pick() + "-" + pick() + "-" + pick();
}

// 校验 token 能否恰好切成 3 个词表词（词本身可含连字符）。
export function validPhrase(tok) {
  if (!tok || tok.length > 96) return false;
  const parts = tok.split("-");
  const n = parts.length;
  if (n < 3) return false;
  const dp = Array.from({ length: 4 }, () => new Array(n + 1).fill(false));
  dp[0][0] = true;
  for (let i = 1; i <= n; i++) {
    for (let k = 1; k <= 3; k++) {
      for (let j = 0; j < i; j++) {
        if (dp[k - 1][j] && WORD_SET.has(parts.slice(j, i).join("-"))) {
          dp[k][i] = true;
          break;
        }
      }
    }
  }
  return dp[3][n];
}

// 订阅路由只接受词表 3 词；旧 32 位 hex 已废弃，不再兼容。
export function isSubToken(tok) {
  return validPhrase(tok);
}

export function wordCount() { return WORDS.length; }
