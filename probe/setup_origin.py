#!/usr/bin/env python3
"""在源站把 trafficStats 段加入 Hysteria 2 配置（幂等）。"""
import pathlib

env = {}
for line in open("/etc/hysteria/probe.env", encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k] = v
secret = env["HY2_STATS_SECRET"]
assert secret, "missing HY2_STATS_SECRET"

p = pathlib.Path("/etc/hysteria/config.yaml")
s = p.read_text(encoding="utf-8")
if "trafficStats:" in s:
    print("trafficStats already present; unchanged")
else:
    s = s.rstrip() + (
        "\n\ntrafficStats:\n"
        "  listen: 127.0.0.1:9999\n"
        f"  secret: {secret}\n"
    )
    p.write_text(s, encoding="utf-8")
    print("trafficStats block appended")
