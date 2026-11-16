#!/usr/bin/env python3
"""比对 Cloudflare 官方回源段与 probe/hy2dash_probe.py 里内置的 CF_V4 / CF_V6。

探针在 accept 层就用这份列表挡掉非 Cloudflare 连接（2096 对公网监听，没有防火墙
白名单）。Cloudflare 极少新增地址段，但一旦新增而代码没跟上，来自新段的回源会被
直接关闭——表现为「部分请求偶发失败」，日志特征是
`closed <ip>: 不是 Cloudflare 回源地址`。

用法：
    python3 scripts/check-cf-ranges.py          # 有差异时退出码 1
    python3 scripts/check-cf-ranges.py -q       # 无差异时不打印

建议每月或每次动 probe 前跑一次；不放进探针本身，避免给源站引入新的出站依赖。
"""

import re
import sys
import urllib.request
from pathlib import Path

URLS = {
    4: "https://www.cloudflare.com/ips-v4",
    6: "https://www.cloudflare.com/ips-v6",
}
SOURCE = Path(__file__).resolve().parent.parent / "probe" / "hy2dash_probe.py"
# 官方站会对没有 UA 的请求直接 403。
UA = "hy2dash-cf-range-check/1.0 (+https://github.com/Bemly/hy2dash)"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        text = r.read().decode("utf-8")
    return [line.strip() for line in text.splitlines() if line.strip()]


def local():
    src = SOURCE.read_text(encoding="utf-8")
    m = re.search(r"CF_V4 = \[(.*?)\]\nCF_V6 = \[(.*?)\]", src, re.S)
    if not m:
        raise SystemExit("在 %s 里找不到 CF_V4 / CF_V6 定义" % SOURCE)
    return re.findall(r'"([^"]+)"', m.group(1)), re.findall(r'"([^"]+)"', m.group(2))


def main():
    quiet = "-q" in sys.argv[1:]
    try:
        live4, live6 = fetch(URLS[4]), fetch(URLS[6])
    except Exception as e:
        print("拉取官方列表失败：%s: %s" % (type(e).__name__, e))
        return 2

    have4, have6 = local()
    drift = False
    for label, live, have in (("IPv4", live4, have4), ("IPv6", live6, have6)):
        added = [n for n in live if n not in have]
        removed = [n for n in have if n not in live]
        if added or removed:
            drift = True
            print("%s 有差异：" % label)
            for n in added:
                print("  + %s  （官方有，代码缺 → 该段回源会被 accept 层关掉）" % n)
            for n in removed:
                print("  - %s  （代码有，官方已移除）" % n)

    if not drift:
        if not quiet:
            print("OK：%d 个 IPv4 + %d 个 IPv6 段与官方一致" % (len(live4), len(live6)))
        return 0

    print("\n更新 probe/hy2dash_probe.py 的 CF_V4 / CF_V6 后重传探针并重启：")
    print("  scp probe/hy2dash_probe.py root@<origin>:/usr/local/bin/hy2dash-probe.py")
    print("  ssh root@<origin> systemctl restart hy2dash-probe")
    return 1


if __name__ == "__main__":
    sys.exit(main())
