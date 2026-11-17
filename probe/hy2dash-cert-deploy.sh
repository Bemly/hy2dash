#!/bin/sh
# certbot deploy hook：把 live 目录里的证书装到 hysteria 的固定路径，并重启 hysteria。
#
# 放进 /etc/letsencrypt/renewal-hooks/deploy/ 后由 certbot 在每次签发/续签后执行，
# 不需要 --deploy-hook 参数（那个只在首次注册时写进 renewal conf）。
# certbot 会传入 RENEWED_LINEAGE（本次成功签发的 live 目录）。
#
# 探针不用重启：它的 cert_guard 盯 /etc/hysteria/server.crt 的 mtime，文件一变就重建
# SSLContext，只影响新连接——正在跑的 SSE 不会被打断。
set -eu

LINEAGE=${RENEWED_LINEAGE:-/etc/letsencrypt/live/www.bemly.moe}
CERT=${CERT_FULLCHAIN:-/etc/hysteria/server.crt}
KEY=${CERT_KEY:-/etc/hysteria/server.key}

[ -f "$LINEAGE/fullchain.pem" ] || { echo "deploy-hook: missing $LINEAGE/fullchain.pem" >&2; exit 1; }

install -m 644 "$LINEAGE/fullchain.pem" "$CERT"
install -m 600 "$LINEAGE/privkey.pem" "$KEY"

# hysteria 只在启动时读证书；restart 由 systemd 负责拉起，失败要让 certbot 看到。
systemctl restart hysteria-server

echo "deploy-hook: installed $LINEAGE -> $CERT, hysteria-server restarted"
