#!/bin/sh
# hy2dash (Cloudflare Worker 版) 提交前明文扫描。
#
# 用法：
#   ./scripts/scan-secrets.sh            # 工作区全部 tracked 文件
#   ./scripts/scan-secrets.sh --staged  # 只查即将提交的内容
#
# 所有真实凭据都在 Worker Secrets / 本地 .dev.vars 里，仓库里只允许出现变量名、
# 占位符、第三方公开服务域名，以及 src/mc.js 里内置的公开 Microsoft client_id。
# probe/ 里的源站采集模块会引用平台公开的官方回源 IP 段，已按精确值放行；
# 源站自身地址、探针 secret、CF_WORKER_VALUE 实测值均不得入库。
# 自家精确值（IP/域名/token）放 ~/.config/hy2dash/scan-deny
# （0600，一行一个），缺失时只跑通用形状检查。
set -eu

if [ "${1:-}" = "--staged" ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACM || true)
else
  FILES=$(git ls-files || true)
fi
if [ -z "$FILES" ]; then echo "scan: 无待查文件"; exit 0; fi

DENY="$HOME/.config/hy2dash/scan-deny"
if [ ! -f "$DENY" ]; then
  echo "scan: 警告——缺 ${DENY}，只跑形状检查"
  DENY=/dev/null
fi

# 公开的第三方域名（认证服务、CDN、规则源、示例域）。
# sub-template.yaml 整份是用户给定的线上配置，其 rules 段与节点域名属于既有
# 路由数据，只跑密钥形状检查，不做 IP/域名白名单比对。
DOMOK=$(cat <<'EOF'
adns.rsesot.cn
aka.ms
api.minecraftservices.com
auth.xboxlive.com
captive.apple.com
cdn.jsdelivr.net
cloudflare.com
console.hostker.net
developers.cloudflare.com
dns.alidns.com
docs.hostker.net
doh.pub
example.com
pdns.example.com
github.com
img.shields.io
login.microsoft.com
login.microsoftonline.com
p.me
mc-heads.net
microsoft.com
minecraftservices.com
raw.githubusercontent.com
specs.openid.net
steam.granbluefantasy.com
steamcommunity.com
user.auth.xboxlive.com
www.bemly.moe
www.cloudflare.com
www.w3.org
xbox.com
xsts.auth.xboxlive.com
EOF
)
IPOK=$(cat <<'EOF'
0.0.0.0
1.1.1.1
8.8.8.8
10.0.0.0
17.0.0.0
100.64.0.0
114.114.114.114
127.0.0.0
127.0.0.1
131.0.0.0
172.16.0.0
192.0.2.11
192.0.2.22
192.168.0.0
198.18.0.0
198.51.100.33
203.0.113.4
203.0.113.99
223.5.5.5
224.0.0.0
# 平台公开的官方回源 IPv4 段（probe/hy2dash_probe.py 的 CF_V4 快照）
103.21.244.0
103.22.200.0
103.31.4.0
104.16.0.0
104.24.0.0
108.162.192.0
131.0.72.0
141.101.64.0
162.158.0.0
172.64.0.0
173.245.48.0
188.114.96.0
190.93.240.0
197.234.240.0
198.41.128.0
EOF
)

# 唯一的 GUID 白名单来自 src/mc.js 内置的公开 client_id。
# 从源码读取，换 AppID 时只改那一行，不必同步维护本脚本；脚本自身不存明文。
PUBLIC_CLIENT_ID=$(sed -n 's/^export const MS_CLIENT_ID = "\([0-9a-fA-F-]\{36\}\)";.*/\1/p' src/mc.js 2>/dev/null | head -n 1)
if [ -z "$PUBLIC_CLIENT_ID" ]; then
  echo "scan: FAIL —— 无法从 src/mc.js 读取内置 client_id 白名单"
  exit 1
fi

LIST=$(mktemp); TMP=$(mktemp); HITF=$(mktemp); IPOKF=$(mktemp); DOMOKF=$(mktemp)
trap 'rm -f "$LIST" "$TMP" "$HITF" "$IPOKF" "$DOMOKF"' EXIT
printf '%s\n' "$IPOK" > "$IPOKF"
printf '%s\n' "$DOMOK" > "$DOMOKF"
printf '%s\n' "$FILES" | grep -v '^$' > "$LIST" || true

while IFS= read -r f; do
  case "$f" in
    .git/*|scripts/scan-secrets.sh|web/vendor/*|*.enc|*.png|*.jpg|*.jpeg|*.woff*) continue;;
  esac
  [ -f "$f" ] || continue
  # 二进制跳过
  if grep -Iq . "$f" 2>/dev/null; then :; else continue; fi

  mark() { printf '  ^-- %s (%s)\n' "$1" "$f" >> "$HITF"; }

  # 1) 已知令牌前缀 / 私钥 / 硬编码 Bearer
  if grep -nEi 'cfut_|ghp_|gho_|github_pat_|glpat-|AKIA[0-9A-Z]{16}|xox[bap]-|sk-live-|sk-ant-' "$f" 2>/dev/null; then mark "令牌前缀命中"; fi
  if grep -nE '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' "$f" 2>/dev/null; then mark "私钥命中"; fi
  if grep -nEi 'Authorization:[[:space:]]*Bearer[[:space:]]+[A-Za-z0-9_-]{16,}' "$f" 2>/dev/null; then mark "硬编码 Bearer 命中"; fi

  # 2) 凭据赋值（值至少 8 字符才算，空值与变量引用放行）
  if grep -nEi '(password|passwd|secret|api[_-]?key|api[_-]?token|client[_-]?secret)[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']{8,}["'"'"']' "$f" 2>/dev/null; then mark "凭据赋值命中"; fi

  # 3) Cloudflare 凭据（Global API Key / API Token / X-Auth-Key / 邮箱+Key 组合）
  if grep -nEi '(CLOUDFLARE|CF)[A-Z_]*(KEY|TOKEN)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_-]{12,}' "$f" 2>/dev/null; then mark "CF 凭据命中"; fi
  if grep -nEi 'X-Auth-Key|X-Auth-Email|Global API Key|API_TOKEN[[:space:]]*=' "$f" >/dev/null 2>&1; then mark "平台凭据头/全局密钥命中"; fi

  # 4) GUID/UUID 硬编码。唯一例外：src/mc.js 内置的公开 Microsoft client_id。
  #    它只是 OAuth 公开标识（公共客户端无 secret），不是凭据；订阅节点 UUID、
  #    租户 ID 等其它任何 GUID 仍一律拒绝。
  GUID_RE='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
  if [ "$f" = "src/mc.js" ]; then
    bad=$(grep -oE "$GUID_RE" "$f" 2>/dev/null | grep -vxF "$PUBLIC_CLIENT_ID" || true)
    if [ -n "$bad" ]; then
      printf '  ^-- 非白名单 GUID/UUID (%s):\n' "$f" >> "$HITF"
      printf '%s\n' "$bad" | sed 's/^/      /' >> "$HITF"
    fi
  elif grep -nE "$GUID_RE" "$f" 2>/dev/null; then
    mark "GUID/UUID 硬编码命中"
  fi

  # 5) 本地密钥文件绝不允许进仓库（.dev.vars.example 是纯变量名清单，允许）
  case "$f" in
    .dev.vars.example|probe/probe.env.example) : ;;
    .dev.vars*|probe/probe.env|*.env|config.json|data/*|*.jsonl) mark "运行期密钥/数据文件" ;;
  esac

  # 6) 网络形状检查（模板整份跳过，理由见文件头注释）
  if [ "$f" != "sub-template.yaml" ]; then
    bad=$(grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}' "$f" 2>/dev/null | sort -u || true)
    if [ -n "$bad" ]; then
      bad=$(printf '%s\n' "$bad" | grep -vxF -f "$IPOKF" || true)
    fi
    if [ -n "$bad" ]; then
      printf '  ^-- 非白名单 IPv4 (%s):\n' "$f" >> "$HITF"
      printf '%s\n' "$bad" | sed 's/^/      /' >> "$HITF"
    fi

    # 只看 rules: 之前（避免第三方规则数据），并按 TLD 收敛
    sed '/^rules:/,$d' "$f" > "$TMP" 2>/dev/null || true
    baddom=$(grep -oE '[A-Za-z0-9][A-Za-z0-9.-]*\.(com|net|org|io|moe|cn|me|tv|dev|app|pub|cc|ai|jp|us|hk|sg|cloud|site|tech|pro|link|work|news|media|space|fun|vip|shop|xyz)([/:,[:space:]]|$)' "$TMP" 2>/dev/null | tr -d '/:, ' | sort -u || true)
    if [ -n "$baddom" ]; then
      baddom=$(printf '%s\n' "$baddom" | grep -vxF -f "$DOMOKF" || true)
    fi
    if [ -n "$baddom" ]; then
      printf '  ^-- 非白名单域名 (%s):\n' "$f" >> "$HITF"
      printf '%s\n' "$baddom" | sed 's/^/      /' >> "$HITF"
    fi
  fi

  # 7) 自家精确值（IP/域名/token），固定字符串整行匹配
  if grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}|[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}' "$f" 2>/dev/null | sort -u | grep -xF -f "$DENY" | grep . >/dev/null 2>&1; then
    mark "自家资产命中"
  fi
done < "$LIST"

if [ -s "$HITF" ]; then
  cat "$HITF"
  echo "scan: FAIL —— 请去敏后再提交"
  exit 1
fi
echo "scan: OK —— 未发现明文密钥模式"
