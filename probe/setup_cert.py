#!/usr/bin/env python3
"""首次签发证书并装给 hysteria2（DNS-01 / Hostker PowerDNS）。

只跑一次。**日常续签不在这个脚本里**：探针的 cert_guard 线程每 6 小时看一次
剩余天数，低于 CERT_RENEW_DAYS（默认 30）就调用 acme.sh --renew —— 也就是
probe.env 里的 CERT_RENEW_CMD。所以：

    本脚本   = 冷启动（新机器 / 换域名 / 换 ACME 客户端）
    cert_guard = 运行期调度（续签 + 热重载，不需要重启探针）

凭据只从 ~/.config/hy2dash/cert.env（0600）读，字段见 probe/cert.env.example：
    ACME_DOMAIN / ACME_EMAIL / PDNS_URL / PDNS_SERVER_ID / PDNS_TOKEN

用法：
    python3 probe/setup_cert.py           # 已签发则只做安装
    python3 probe/setup_cert.py --force   # 强制重签
"""
import os
import pathlib
import subprocess
import sys

ENV_PATH = pathlib.Path(os.environ.get("CERT_ENV", "~/.config/hy2dash/cert.env")).expanduser()
ACME = pathlib.Path(os.environ.get("ACME_SH", "~/.acme.sh/acme.sh")).expanduser()
FULLCHAIN = os.environ.get("CERT_FULLCHAIN", "/etc/hysteria/server.crt")
KEYFILE = os.environ.get("CERT_KEY", "/etc/hysteria/server.key")
# 只重启 hysteria；探针自己会热重载证书，重启它反而会断掉正在跑的 SSE。
RELOAD = os.environ.get("CERT_RELOAD_CMD", "systemctl restart hysteria-server")


def load_env(path):
    if not path.exists():
        raise SystemExit(f"缺少凭据文件：{path}（参考 probe/cert.env.example）")
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def run(cmd, env=None, check=True):
    print("+", " ".join(cmd) if isinstance(cmd, list) else cmd)
    p = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=False,
                       text=True, env=env)
    if check and p.returncode != 0:
        raise SystemExit(f"命令失败：rc={p.returncode}")
    return p.returncode


def main():
    cfg = load_env(ENV_PATH)
    for key in ("ACME_DOMAIN", "ACME_EMAIL", "PDNS_URL", "PDNS_SERVER_ID", "PDNS_TOKEN"):
        if not cfg.get(key):
            raise SystemExit(f"cert.env 缺少 {key}")

    if not ACME.exists():
        raise SystemExit(f"未找到 acme.sh：{ACME}（先装：curl -fsSL https://get.acme.sh | sh -s email=你@邮箱）")

    domain = cfg["ACME_DOMAIN"]
    env = os.environ.copy()
    # acme.sh 的 dns_pdns 插件从环境变量取凭据
    env.update({
        "PDNS_Url": cfg["PDNS_URL"],
        "PDNS_ServerId": cfg["PDNS_SERVER_ID"],
        "PDNS_Token": cfg["PDNS_TOKEN"],
        "PDNS_Ttl": cfg.get("PDNS_TTL", "60"),
    })

    if (pathlib.Path.home() / ".acme.sh" / f"{domain}_ecc").is_dir() and "--force" not in sys.argv:
        print(f"已有证书目录，跳过签发（需要重签加 --force）")
    else:
        run([str(ACME), "--issue", "-d", domain, "--dns", "dns_pdns",
             "--keylength", "ec-256", "--server", "letsencrypt"], env=env)

    run([str(ACME), "--install-cert", "-d", domain, "--ecc",
         "--key-file", KEYFILE, "--fullchain-file", FULLCHAIN,
         "--reloadcmd", RELOAD], env=env)

    print()
    run([str(ACME), "--list"], check=False)
    print()
    fp = subprocess.run(["openssl", "x509", "-in", FULLCHAIN, "-noout", "-fingerprint", "-sha256"],
                        capture_output=True, text=True)
    print("已安装证书指纹:", (fp.stdout or fp.stderr).strip().split("=")[-1])
    print("Worker 侧不用手工改：cron 会从探针 /api/cert 取这个值写 KV（≤60s）。")


if __name__ == "__main__":
    main()
