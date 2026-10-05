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
# 公开白名单（精确值，已审计；模板 rules 段是第三方路由数据，域名检查整段排除；
# 新增先确认非自家资产再追加）
IPOKF=/tmp/hy2dash_ipok
cat > "$IPOKF" <<'EOF'
0.0.0.0
1.1.1.1
10.0.0.0
100.64.0.0
103.10.124.0
103.28.54.0
114.114.114.114
120.232.181.162
120.241.147.226
120.253.253.226
120.253.255.162
120.253.255.34
120.253.255.98
127.0.0.0
127.0.0.1
131.0.0.0
146.66.152.0
146.66.155.0
149.154.160.0
153.254.86.0
155.133.224.0
155.133.230.0
155.133.232.0
155.133.234.0
155.133.236.0
155.133.240.0
155.133.244.0
155.133.246.0
155.133.248.0
162.254.192.0
17.0.0.0
172.16.0.0
180.163.150.162
180.163.150.34
180.163.151.162
180.163.151.34
185.25.182.0
185.76.151.0
190.217.32.0
192.168.0.0
192.69.96.0
198.18.0.0
203.0.113.4
203.208.39.0
203.208.40.0
203.208.41.0
203.208.43.0
203.208.50.0
205.185.194.0
205.196.6.0
208.64.200.0
208.78.164.0
220.181.174.162
220.181.174.226
220.181.174.34
223.5.5.5
224.0.0.0
45.121.184.0
8.8.8.8
91.105.192.0
91.108.16.0
91.108.4.0
91.108.56.0
91.108.8.0
95.161.64.0
EOF
IP6OKF=/tmp/hy2dash_ip6ok
cat > "$IP6OKF" <<'EOF'
2001:67c:4e8::
2001:b28:f23c::
2001:b28:f23d::
2001:b28:f23f::
2a0a:f280:203::
fe80::
EOF
DOMOKF=/tmp/hy2dash_domok
cat > "$DOMOKF" <<'EOF'
adns.rsesot.cn
captive.apple.com
cdn.jsdelivr.net
console.hostker.net
dns.alidns.com
doh.pub
example.com
github.com
raw.githubusercontent.com
specs.openid.net
steamcommunity.com
EOF
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
  # 全部 IPv4 候选：命中精确白名单才放行
  bad=$(grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}' "$f" 2>/dev/null | sort -u | grep -vxF -f "$IPOKF" || true)
  if [ -n "$bad" ]; then
    echo "  ^-- 非白名单 IPv4 ($f):"
    echo "$bad" | sed 's/^/      /'
    HIT=1
  fi
  # 全部 IPv6 候选（含数字才算，排除 CSS ::before 之类）
  bad6=$(grep -oE '([0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F:.]+' "$f" 2>/dev/null | grep '[0-9]' | sort -u | grep -vxF -f "$IP6OKF" || true)
  if [ -n "$bad6" ]; then
    echo "  ^-- 非白名单 IPv6 ($f):"
    echo "$bad6" | sed 's/^/      /'
    HIT=1
  fi
  # 域名候选：模板 rules 段整段排除，其余 TLD 收敛（撞代码的 live/online/plus 已剔除）
  # 加精确白名单；自家精确值另有下一段兜底
  baddom=$(sed '/^rules:/,$d' "$f" 2>/dev/null | grep -oE '[A-Za-z0-9][A-Za-z0-9.-]*\.(com|net|org|io|moe|cn|me|tv|dev|app|pub|cc|uk|ai|ru|de|fr|jp|us|hk|sg|club|top|xyz|su|to|in|co|info|biz|cloud|site|store|tech|pro|name|mobi|asia|email|space|fun|vip|shop|link|work|news|media|be|gl|es|ph|cr|im|ly|gd|ms|tt|pw|fm)([/:,]|$)' | tr -d '/:,' | sort -u | grep -vxF -f "$DOMOKF" || true)
  if [ -n "$baddom" ]; then
    echo "  ^-- 非白名单域名 ($f):"
    echo "$baddom" | sed 's/^/      /'
    HIT=1
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
