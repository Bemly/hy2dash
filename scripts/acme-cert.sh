#!/usr/bin/env bash
# 用 Hostker 的 PowerDNS API 走 DNS-01 签发/续签证书，并把证书装给 hysteria2 与探针。
#
# 为什么是 DNS-01：源站的 443 是 xray REALITY、80 也不留给 HTTP-01，
# 所以只能用 TXT 记录验证域名归属。acme.sh 自带 dns_pdns 插件，这里只是把它
# 的调用参数固化成脚本，避免下次换机器时又靠记忆重敲一遍。
#
# 凭据不进仓库：默认读 ~/.config/hy2dash/cert.env（0600），字段见
# scripts/cert.env.example。也可以用 CERT_ENV=/path/to/file 覆盖。
#
# 用法：
#   ./scripts/acme-cert.sh              # 首次签发 + 安装；已签发则只做安装
#   ./scripts/acme-cert.sh --force      # 强制重新签发
#
# 续签本身由 acme.sh 自己的 cron 完成（`acme.sh --cron`，默认每天跑），
# 本脚本只负责「装一次」以及换机器时重建。续签后的自动链路是：
#   acme.sh 覆盖 server.crt / server.key → 重启 hysteria-server + hy2dash-probe
#   → 探针 /api/cert 返回新指纹 → Worker cron（≤60s）写 KV cfg:cert_fp
#   → 订阅里的 server-cert-fingerprint 自动跟随，不需要人工改 secret。
set -euo pipefail

CERT_ENV=${CERT_ENV:-$HOME/.config/hy2dash/cert.env}
[ -r "$CERT_ENV" ] || { echo "缺少凭据文件：$CERT_ENV（参考 scripts/cert.env.example）" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CERT_ENV"

: "${ACME_DOMAIN:?cert.env 里需要 ACME_DOMAIN}"
: "${ACME_EMAIL:?cert.env 里需要 ACME_EMAIL}"
: "${PDNS_URL:?cert.env 里需要 PDNS_URL}"
: "${PDNS_SERVER_ID:?cert.env 里需要 PDNS_SERVER_ID}"
: "${PDNS_TOKEN:?cert.env 里需要 PDNS_TOKEN}"

FULLCHAIN=${CERT_FULLCHAIN:-/etc/hysteria/server.crt}
KEYFILE=${CERT_KEY:-/etc/hysteria/server.key}
RELOAD=${CERT_RELOAD_CMD:-systemctl restart hysteria-server && systemctl restart hy2dash-probe}
ACME=${ACME_SH:-$HOME/.acme.sh/acme.sh}

if [ ! -x "$ACME" ]; then
  echo "未找到 acme.sh，先安装到 $HOME/.acme.sh"
  curl -fsSL https://get.acme.sh | sh -s "email=$ACME_EMAIL" >/dev/null
fi

# acme.sh 的 dns_pdns 插件从环境变量读凭据，不落盘（会另外存进 account.conf，0600）
export PDNS_Url="$PDNS_URL"
export PDNS_ServerId="$PDNS_SERVER_ID"
export PDNS_Token="$PDNS_TOKEN"
export PDNS_Ttl="${PDNS_TTL:-60}"

DOMAIN_DIR="$HOME/.acme.sh/${ACME_DOMAIN}_ecc"
if [ -d "$DOMAIN_DIR" ] && [ "${1:-}" != "--force" ]; then
  echo "已有证书目录 $DOMAIN_DIR，跳过签发（需要重签加 --force）"
else
  "$ACME" --issue -d "$ACME_DOMAIN" --dns dns_pdns --keylength ec-256 --server letsencrypt
fi

"$ACME" --install-cert -d "$ACME_DOMAIN" --ecc \
  --key-file "$KEYFILE" \
  --fullchain-file "$FULLCHAIN" \
  --reloadcmd "$RELOAD"

echo
"$ACME" --list
echo
echo -n "已安装证书 SHA-256 指纹: "
openssl x509 -in "$FULLCHAIN" -noout -fingerprint -sha256 | cut -d= -f2
echo "Worker 侧无需手工更新：cron 会从探针 /api/cert 取这个值写进 KV（≤60s）。"
