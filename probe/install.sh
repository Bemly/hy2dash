#!/bin/sh
# Install the hy2dash origin probe on the Hysteria 2 host.
#
# Run as root ON THE ORIGIN HOST, from the repo root:
#   sh probe/install.sh
#
# No credentials live in this repo. Provision /etc/hysteria/probe.env (0600) from
# probe.env.example first, then run this script. It restarts hysteria-server once.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE=/etc/hysteria/probe.env
BIN=/usr/local/bin/hy2dash-probe.py
UNIT=/etc/systemd/system/hy2dash-probe.service
DATA_DIR=/var/lib/hy2dash-probe

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 missing" >&2; exit 1; }
[ -f "$ENV_FILE" ] || {
  echo "missing $ENV_FILE - copy probe/probe.env.example and fill it" >&2
  exit 1
}

install -d -m 755 "$DATA_DIR"
install -m 755 "$ROOT/probe/hy2dash_probe.py" "$BIN"
install -m 644 "$ROOT/probe/hy2dash-probe.service" "$UNIT"

# trafficStats is appended idempotently; keep a timestamped config backup.
cp /etc/hysteria/config.yaml "/etc/hysteria/config.yaml.bak-probe-$(date +%s)"
python3 "$ROOT/probe/setup_origin.py"

systemctl daemon-reload
systemctl enable --now hy2dash-probe
systemctl restart hysteria-server
sleep 2
systemctl is-active hysteria-server hy2dash-probe
curl -fsS --max-time 5 http://127.0.0.1:2096/api/health || true
echo "probe installed"
