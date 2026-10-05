#!/bin/sh
# 提交前明文扫描：只用通用模式 + 精确公开白名单，不内置任何真实密钥/IP/域名
# （2026-10-05 教训：脚本里硬编码过真实 VPS IP 与订阅域名，全网可见；
#  此后真实值永不进脚本。分支各自独立 grep，避免巨型 alternation 在 BSD grep 下哑火）
# 用法： ./scripts/scan-secrets.sh [--staged]
set -eu
if [ "${1:-}" = "--staged" ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACM || true)
  if [ -z "$FILES" ]; then echo "scan: 无 staged 文件"; exit 0; fi
  echo "$FILES" | grep -v '^$' > /tmp/hy2dash_scan_list || true
else
  git ls-files > /tmp/hy2dash_scan_list
fi
# 精确公开白名单（整行精确匹配 grep -xF；全部已审计，新增先确认非自家资产再追加）
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
# 非 rules 段的域名白名单（infra/文档/健康检查/Steam CDN/个人 CDN 例外；
# 模板 rules 段是第三方路由数据，整段排除在域名检查之外）
DOMOKF=/tmp/hy2dash_domok
cat > "$DOMOKF" <<'EOF'
adns.rsesot.cn
captive.apple.com
cdn1711451667.ppgnginx.com
cdn.jsdelivr.net
cm.steampowered.com
console.hostker.net
dl.steam.clngaa.com
dns.alidns.com
doh.pub
example.com
github.com
raw.githubusercontent.com
smartdnsonly-Bemly-can.com
specs.openid.net
steamcdn-a.akamaihd.net
steamcommunity.com
steamserver.net
EOF
HIT=0
while IFS= read -r f; do
  case "$f" in .git/*|scripts/scan-secrets.sh) continue;; esac
  [ -f "$f" ] || continue
  # 二进制跳过
  if grep -Iq . "$f" 2>/dev/null; then :; else continue; fi
  # 分支各自独立 grep（BSD grep 兼容，POSIX 字符类）
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
  # 域名候选：模板 rules 段（第三方路由数据）整段排除，其余 TLD 收敛 + 精确白名单
  baddom=$(sed '/^rules:/,$d' "$f" 2>/dev/null | grep -oE '[A-Za-z0-9][A-Za-z0-9.-]*\.(com|net|org|io|moe|cn|me|tv|dev|app|pub|cc|uk|ai|ru|de|fr|jp|us|hk|sg|club|top|xyz|su|to|in|co|info|biz|cloud|site|store|tech|pro|name|mobi|asia|email|space|fun|vip|shop|link|work|news|media|be|gl|es|ph|cr|im|ly|gd|ms|tt|pw|fm)([/:,]|$)' | tr -d '/:,' | sort -u | grep -vxF -f "$DOMOKF" || true)
  if [ -n "$baddom" ]; then
    echo "  ^-- 非白名单域名 ($f):"
    echo "$baddom" | sed 's/^/      /'
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
