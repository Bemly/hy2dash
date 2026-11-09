package main

// 订阅下发（取代 Cloudflare Worker）：按 token 认人，只下发自己的节点。
// 节点身份在密码里：hysteria userpass 要求 auth 串为 "用户名:口令"。
// 用量头 Subscription-Userinfo 按天口径：已用=今日用量，总量=今日已授额度
// （默认 10G，面板续额后刷新订阅即涨 10G→20G…，直到月封顶）。
//
// 节点行格式：块状（block）YAML，每个字段一行，只有嵌套的 reality-opts 保持行内，
// 便于人直接读订阅；对 Clash/mihomo 解析结果与单行 flow 写法完全等价。
// 改这里之前请先读 AGENTS.md（`hy2dash -agents`）。

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

// yamlQuote 给标量加单引号：节点名含 emoji、口令含冒号，裸写会破坏 YAML。
func yamlQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// vlessNode 生成 VLESS + REALITY 节点（块状 YAML）。
// support-x25519mlkem768 不可删：Xray 服务端 >= 26.7 要求 ClientHello 带
// X25519MLKEM768，缺了会被判 authentication failed（mihomo 必须显式开启）。
func vlessNode(s ServerMeta, u *User) string {
	sni := s.RealitySNI
	if sni == "" {
		sni = s.SNI
	}
	fp := s.RealityFP
	if fp == "" {
		fp = "chrome"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "  - name: %s\n", yamlQuote(s.Name))
	b.WriteString("    type: vless\n")
	fmt.Fprintf(&b, "    server: %s\n", s.Host)
	fmt.Fprintf(&b, "    port: %d\n", s.Port)
	fmt.Fprintf(&b, "    uuid: %s\n", u.UUID)
	b.WriteString("    network: tcp\n")
	b.WriteString("    tls: true\n")
	b.WriteString("    udp: true\n")
	b.WriteString("    flow: xtls-rprx-vision\n")
	fmt.Fprintf(&b, "    servername: %s\n", sni)
	fmt.Fprintf(&b, "    client-fingerprint: %s\n", fp)
	fmt.Fprintf(&b, "    reality-opts: { public-key: %s, short-id: %s, support-x25519mlkem768: true }\n",
		s.RealityPubkey, yamlQuote(s.RealityShortID))
	return b.String()
}

// hysteriaNode 生成 hysteria2 节点（块状 YAML）。
func hysteriaNode(s ServerMeta, hyUser, pass string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "  - name: %s\n", yamlQuote(s.Name))
	b.WriteString("    type: hysteria2\n")
	fmt.Fprintf(&b, "    server: %s\n", s.Host)
	fmt.Fprintf(&b, "    port: %d\n", s.Port)
	if s.Ports != "" {
		fmt.Fprintf(&b, "    ports: %s\n", s.Ports)
	}
	fmt.Fprintf(&b, "    password: %s\n", yamlQuote(hyUser+":"+pass))
	fmt.Fprintf(&b, "    sni: %s\n", s.SNI)
	if s.CertFP != "" {
		fmt.Fprintf(&b, "    fingerprint: %s\n", s.CertFP)
		fmt.Fprintf(&b, "    server-cert-fingerprint: %s\n", s.CertFP)
	}
	return b.String()
}

// buildUserYAML 生成某用户的完整订阅
func buildUserYAML(tpl string, u *User, slots []Slot, servers []ServerMeta) string {
	pass := u.HyPass // HTTP 鉴权模式下的个人口令；没有则是通道静态口令
	if pass == "" {
		pass = slotPass(slots, u.HyUser)
	}
	var nodes, names []string
	for _, s := range servers {
		if s.Proto == "vless" && u.UUID != "" {
			nodes = append(nodes, vlessNode(s, u))
		} else {
			nodes = append(nodes, hysteriaNode(s, u.HyUser, pass))
		}
		names = append(names, yamlQuote(s.Name))
	}
	out := strings.Replace(tpl, "\n__NODES__", "\n"+strings.Join(nodes, ""), 1)
	out = strings.Replace(out, "[ __NODE_NAMES__ ]", "[ "+strings.Join(names, ", ")+" ]", 1)
	return out
}

func quotaBytes(gb int) uint64 {
	if gb <= 0 {
		gb = 700
	}
	return uint64(gb) * 1024 * 1024 * 1024
}
