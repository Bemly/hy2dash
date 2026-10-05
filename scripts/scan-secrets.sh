#!/bin/sh
# 提交前明文扫描：通用形状 + 自家精确值（精确值放仓库外的本地文件，永不进 git）
# 精确值文件：~/.config/hy2dash/scan-deny（0600，一行一个：自家 IP/域名/token，
#   开新机器先追加；缺失时只跑形状检查并警告）
# 用法： ./scripts/scan-secrets.sh [--staged]
set -eu
if [ "${1:-}" = "--staged" ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACM || true)
  if [ -z "$FILES" ]; then echo "scan: 无 staged 文件"; exit 0; fi
  echo "$FILES" | grep -v '^$' > /tmp/hy2dash_scan_list || true
else
  git ls-files > /tmp/hy2dash_scan_list
fi
DENY="$HOME/.config/hy2dash/scan-deny"
if [ ! -f "$DENY" ]; then
  echo "scan: 警告——缺 $DENY，只跑形状检查"
  DENY=/dev/null
fi
HIT=0
while IFS= read -r f; do
  case "$f" in .git/*|scripts/scan-secrets.sh) continue;; esac
  [ -f "$f" ] || continue
  # 二进制跳过
  if grep -Iq . "$f" 2>/dev/null; then :; else continue; fi
  # 通用形状（各自分支独立 grep，BSD grep 兼容）
  if grep -nE -i 'cfut_|ghp_|gho_|github_pat_|AKIA[0-9A-Z]{16}|xox[bap]-|sk-live-' "$f" 2>/dev/null; then
    echo "  ^-- token 命中: $f"; HIT=1
  fi
  if grep -nE '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' "$f" 2>/dev/null; then
    echo "  ^-- 私钥命中: $f"; HIT=1
  fi
  if grep -nE '[Aa]uthorization:[[:space:]]+Bearer[[:space:]]+[A-Za-z0-9_-]{16,}' "$f" 2>/dev/null; then
    echo "  ^-- Bearer 命中: $f"; HIT=1
  fi
  if grep -nE -i 'passwd|password[[:space:]]*=[[:space:]]*["'\''][^"'\'']+["'\'']' "$f" 2>/dev/null; then
    echo "  ^-- 口令赋值命中: $f"; HIT=1
  fi
  if grep -nE 'subscribe\.[A-Za-z0-9.-]+\.[A-Za-z]{2,}/[A-Za-z0-9_/\.-]{3,}' "$f" 2>/dev/null; then
    echo "  ^-- 订阅形 URL 命中: $f"; HIT=1
  fi
  # 自家精确值（IP/域名/token 全拼，固定字符串整行匹配）
  if grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}|([0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F:.]+|[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}' "$f" 2>/dev/null | sort -u | grep -xF -f "$DENY" | grep .; then
    echo "  ^-- 自家资产命中: $f"
    HIT=1
  fi
done < /tmp/hy2dash_scan_list
# 额外：禁止把运行期配置/数据加进来
if git status --short | grep -E '^(A|M|M |A ).*(config\.json|conn-.*\.jsonl|/data/)' >/dev/null 2>&1; then
  echo "scan: 拒绝提交运行期配置/数据 (config.json / data / jsonl)，已在 .gitignore 中"
  HIT=1
fi
if [ "$HIT" = "1" ]; then echo "scan: FAIL —— 请去敏后再提交"; exit 1; fi
echo "scan: OK —— 未发现明文密钥模式"
