#!/bin/sh
# 提交前明文扫描：只用通用模式，不内置任何真实密钥
# 用法： ./scripts/scan-secrets.sh [--staged]
set -eu
TARGET="."
if [ "${1:-}" = "--staged" ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACM || true)
  if [ -z "$FILES" ]; then echo "scan: 无 staged 文件"; exit 0; fi
  echo "$FILES" | grep -v '^$' > /tmp/hy2dash_scan_list || true
else
  git ls-files > /tmp/hy2dash_scan_list
fi
# 通用高危模式（不含本项目真实值）
PAT='cfut_|ghp_|gho_|github_pat_|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|xox[bap]-|sk-live-|passwd|password\s*=\s*["'\''][^"'\'']+["'\'']|Authorization:\s*Bearer\s+[A-Za-z0-9_\-]{16,}|203.0.113.7|subscribe.example.invalid/(iku-iku-o-hohho|zaku-zaku))'
HIT=0
while IFS= read -r f; do
  case "$f" in .git/*|scripts/scan-secrets.sh) continue;; esac
  [ -f "$f" ] || continue
  # 二进制跳过
  if grep -Iq . "$f" 2>/dev/null; then :; else continue; fi
  if grep -nE -i "$PAT" "$f" 2>/dev/null; then
    echo "  ^-- 上面命中: $f"
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
