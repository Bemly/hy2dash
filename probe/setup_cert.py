#!/usr/bin/env python3
"""首次签发证书并装给 hysteria2（certbot + Hostker PowerDNS DNS-01）。

只跑一次。**日常续签不在这个脚本里**：探针的 cert_guard 线程每 6 小时看一次
剩余天数，低于 CERT_RENEW_DAYS（默认 30）就执行 probe.env 里的 CERT_RENEW_CMD
（默认 `certbot renew --quiet --no-random-sleep-on-renew`）。所以：

    本脚本      = 冷启动（新机器 / 换域名 / 换 ACME 客户端）
    cert_guard  = 运行期调度（续签 + 热重载，不需要重启探针）

装包（Debian 13 实测，官方源自带 certbot 4.0.0）：
    apt-get install -y certbot python3-pip python3-zope.interface
    pip install --break-system-packages --no-deps certbot-dns-powerdns
    pip install --break-system-packages dns-lexicon
说明：
  - `certbot` 在 Debian 13 的 trixie/main 里（4.0.0-2+deb13u1），apt 直接装；
  - PowerDNS 的 DNS 插件是第三方包（PyPI `certbot-dns-powerdns`），apt 源里没有；
  - 该插件把依赖写死成 `dns-lexicon<=3.5.6` + `pyyaml<6` + `cryptography<4`，这些老包
    在 Python 3.13 上根本装不上（会尝试从源码编译 PyYAML 5.x 并失败），所以插件必须
    `--no-deps`，现代的 `dns-lexicon` 单独装；
  - 插件还 import `zope.interface`，而 Debian 的 certbot 4.0 已经不带它，得 apt 补。

凭据只从 ~/.config/hy2dash/cert.env（0600）读，字段见 probe/cert.env.example：
    ACME_DOMAIN / ACME_EMAIL / PDNS_URL / PDNS_TOKEN

用法：
    python3 probe/setup_cert.py           # 已签发则只做安装
    python3 probe/setup_cert.py --force   # 强制重签
"""
import os
import pathlib
import shutil
import subprocess
import sys

ENV_PATH = pathlib.Path(os.environ.get("CERT_ENV", "~/.config/hy2dash/cert.env")).expanduser()
LETSENCRYPT = pathlib.Path("/etc/letsencrypt")
CRED_INI = LETSENCRYPT / "powerdns.ini"
HOOK = LETSENCRYPT / "renewal-hooks" / "deploy" / "hy2dash-cert.sh"
HOOK_SRC = pathlib.Path(__file__).with_name("hy2dash-cert-deploy.sh")
# deploy hook 覆盖这两个路径；这里只用于装完打印指纹
FULLCHAIN = os.environ.get("CERT_FULLCHAIN", "/etc/hysteria/server.crt")

PLUGIN = "dns-powerdns"


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


def run(cmd, check=True):
    print("+", " ".join(cmd))
    p = subprocess.run(cmd, text=True)
    if check and p.returncode != 0:
        raise SystemExit(f"命令失败：rc={p.returncode}")
    return p.returncode


def have_plugin():
    p = subprocess.run(["certbot", "plugins", "--text"], capture_output=True, text=True)
    out = p.stdout or ""
    return PLUGIN in out and "errored while loading" not in out


def write_credentials(cfg):
    """certbot 第三方插件的 ini：键名由 certbot 的 dest() 生成（插件名 dns-powerdns
    → dns_powerdns_api_url / dns_powerdns_api_key）。旧版 certbot 的
    `certbot_dns_powerdns:xxx` 前缀在 4.0 已不适用。

    Hostker 的 ServerID 固定 localhost，由 lexicon 的 powerdns provider 默认值兜住，
    所以这里不写 server-id（那是 acme.sh dns_pdns 的字段）。
    """
    CRED_INI.parent.mkdir(parents=True, exist_ok=True)
    CRED_INI.write_text(
        "dns_powerdns_api_url = " + cfg["PDNS_URL"] + "\n"
        "dns_powerdns_api_key = " + cfg["PDNS_TOKEN"] + "\n",
        encoding="utf-8",
    )
    CRED_INI.chmod(0o600)


def install_hook():
    if not HOOK_SRC.exists():
        raise SystemExit(f"缺少 deploy hook 源文件：{HOOK_SRC}")
    HOOK.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(HOOK_SRC, HOOK)
    HOOK.chmod(0o755)


def main():
    cfg = load_env(ENV_PATH)
    for key in ("ACME_DOMAIN", "ACME_EMAIL", "PDNS_URL", "PDNS_TOKEN"):
        if not cfg.get(key):
            raise SystemExit(f"cert.env 缺少 {key}")

    if not shutil.which("certbot"):
        raise SystemExit("未安装 certbot：apt-get install -y certbot python3-pip python3-zope.interface")
    if not have_plugin():
        raise SystemExit(
            "certbot 没加载 dns-powerdns 插件，先装：\n"
            "  python3 -m pip install --break-system-packages --no-deps certbot-dns-powerdns\n"
            "  python3 -m pip install --break-system-packages dns-lexicon\n"
            "再确认：certbot plugins --text | grep -i powerdns"
        )

    domain = cfg["ACME_DOMAIN"]
    write_credentials(cfg)
    install_hook()

    live = LETSENCRYPT / "live" / domain
    if live.is_dir() and "--force" not in sys.argv:
        print(f"已有证书目录 {live}，跳过签发（需要重签加 --force）")
    else:
        run(["certbot", "certonly", "--non-interactive", "--agree-tos",
             "--email", cfg["ACME_EMAIL"],
             "--authenticator", PLUGIN,
             "--dns-powerdns-credentials", str(CRED_INI),
             "--dns-powerdns-propagation-seconds", cfg.get("PROPAGATION_SECONDS", "60"),
             "--cert-name", domain, "-d", domain,
             "--key-type", "ecdsa"])

    # --force 重签后也走一遍 hook，保证 /etc/hysteria 里就是最新那张
    run(["sh", str(HOOK)], check=False)

    print()
    fp = subprocess.run(["openssl", "x509", "-in", FULLCHAIN, "-noout", "-fingerprint", "-sha256"],
                        capture_output=True, text=True)
    print("已安装证书指纹:", (fp.stdout or fp.stderr).strip().split("=")[-1])
    print("Worker 侧不用手工改：cron 会从探针 /api/cert 取这个值写 KV（≤60s）。")
    print("续签调度归探针：CERT_RENEW_CMD 默认 `certbot renew --quiet --no-random-sleep-on-renew`；"
          "certbot.timer 保持停用，避免两个调度器。")


if __name__ == "__main__":
    main()
