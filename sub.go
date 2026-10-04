package main

// 订阅下发（取代 Cloudflare Worker）：按 token 认人，只下发自己的节点。
// 节点身份在密码里：hysteria userpass 要求 auth 串为 "用户名:口令"。
// 用量头 Subscription-Userinfo 按天口径：已用=今日用量，总量=今日已授额度
// （默认 10G，面板续额后刷新订阅即涨 10G→20G…，直到月封顶）。

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

//go:embed sub-template.yaml
var defaultSubTemplate string

func loadSubTemplate(confPath string) string {
	if confPath != "" {
		if b, err := os.ReadFile(filepath.Join(filepath.Dir(confPath), "sub-template.yaml")); err == nil && len(b) > 0 {
			return string(b)
		}
	}
	return defaultSubTemplate
}

func slotPass(slots []Slot, hyUser string) string {
	for _, s := range slots {
		if s.User == hyUser {
			return s.Pass
		}
	}
	return ""
}

// buildUserYAML 生成某用户的完整订阅
func buildUserYAML(tpl string, u *User, slots []Slot, servers []ServerMeta) string {
	pass := slotPass(slots, u.HyUser)
	var nodes, names []string
	for _, s := range servers {
		nodes = append(nodes, fmt.Sprintf(
			"  - { name: '%s', type: hysteria2, server: %s, ports: %s, port: %d, password: %s:%s, sni: %s, fingerprint: %s, server-cert-fingerprint: %s }",
			s.Name, s.Host, s.Ports, s.Port, u.HyUser, pass, s.SNI, s.CertFP, s.CertFP))
		names = append(names, "'"+s.Name+"'")
	}
	out := strings.Replace(tpl, "__NODES__", strings.Join(nodes, "\n"), 1)
	out = strings.Replace(out, "__NODE_NAMES__", strings.Join(names, ", "), 1)
	return out
}

func quotaBytes(gb int) uint64 {
	if gb <= 0 {
		gb = 700
	}
	return uint64(gb) * 1024 * 1024 * 1024
}
