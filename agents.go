package main

// 这个文件存在的唯一目的：让以后接手的人 / coding agent 不会跑偏。
// 仓库地址与硬性约束都会被编译进二进制（strings 可搜到），
// 运行时也提供 `hy2dash -version` 与 `hy2dash -agents` 两个出口。
// 改代码前请先跑一次 `hy2dash -agents` 读完 AGENTS.md。

import (
	_ "embed"
	"flag"
	"fmt"
	"log"
	"os"
	"runtime/debug"
)

// repoURL 是唯一真源仓库；不要在别处再写一份地址。
const repoURL = "https://github.com/Bemly/hy2dash"

// agentNotice 会被编译进二进制，供 `strings /usr/local/bin/hy2dash` 检索。
const agentNotice = `
hy2dash  (panel + subscription + VLESS/Hysteria2 console)
SOURCE: https://github.com/Bemly/hy2dash   <-- 唯一真源，改代码前先 clone 这里
READ BEFORE CHANGING: AGENTS.md  (运行时: hy2dash -agents)

HARD RULES FOR AGENTS / OPERATORS
1. NEVER ship a binary built from a dirty working tree. Commit first, so that
   buildinfo reports vcs.modified=false; otherwise production cannot be
   reproduced from any commit (this happened once: a dirty build carried
   subscription params that were never committed).
2. Subscription node lines are generated in sub.go (Go code), NOT in
   sub-template.yaml. Editing the template cannot change node fields.
3. Config fields: servers[] with proto="vless" drives the VLESS+REALITY node
   line; xray_nodes is monitoring only (SSH client sync + traffic stats).
4. Xray server >= 26.7 REALITY requires the ClientHello to carry
   X25519MLKEM768. mihomo needs reality-opts.support-x25519mlkem768=true;
   sing-box is currently incompatible; fingerprints other than
   chrome/firefox/safari are rejected. Do not "optimize" that key away.
5. Verify a deploy with a RULE-mode client (not global mode) and confirm
   /var/log/xray/access.log grows with "accepted ... email: u0x".
   A bare HTTP 204 proves nothing: global mode can silently go direct.
6. Production layout: binary /usr/local/bin/hy2dash, config
   /etc/hy2dash/config.json, data /var/lib/hy2dash/data,
   xray config /etc/xray/config.json (service name: xray).
7. Never commit secrets, real IPs or subscription tokens; run
   ./scripts/scan-secrets.sh before every commit.
`

//go:embed AGENTS.md
var agentsDoc string

var (
	flagAgents  bool
	flagVersion bool
)

func registerAgentFlags() {
	flag.BoolVar(&flagAgents, "agents", false, "打印 AGENTS.md（给 agent / 运维的硬性约束）")
	flag.BoolVar(&flagVersion, "version", false, "打印版本、构建信息与源码地址")
}

func buildStamp() (rev, vcsTime string, dirty bool) {
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return "", "", false
	}
	for _, s := range bi.Settings {
		switch s.Key {
		case "vcs.revision":
			rev = s.Value
		case "vcs.time":
			vcsTime = s.Value
		case "vcs.modified":
			dirty = s.Value == "true"
		}
	}
	if rev == "" {
		rev = bi.Main.Version
	}
	return rev, vcsTime, dirty
}

// handleAgentFlags 处理 -version / -agents；返回 true 表示已处理完毕、主流程应退出。
func handleAgentFlags() bool {
	if flagVersion {
		rev, t, dirty := buildStamp()
		fmt.Printf("hy2dash\nsource: %s\nrevision: %s\nbuilt: %s\ngo: %s\n",
			repoURL, rev, t, debugVersion())
		if dirty {
			fmt.Println("WARNING: 该二进制由脏工作区构建（vcs.modified=true），无法从仓库复现")
		}
		fmt.Println()
		fmt.Print(agentNotice)
		return true
	}
	if flagAgents {
		fmt.Print(agentsDoc)
		return true
	}
	return false
}

// logStartupBanner 在启动时把源码地址写进 journal；脏构建额外告警。
func logStartupBanner() {
	rev, _, dirty := buildStamp()
	if rev == "" {
		rev = "unknown"
	}
	log.Printf("hy2dash %s · 源码 %s · 改动前请先读 AGENTS.md（hy2dash -agents）", rev, repoURL)
	if dirty {
		log.Printf("警告: 当前二进制由脏工作区构建（vcs.modified=true），与仓库不一致，勿据此调试源码")
	}
}

func debugVersion() string {
	if bi, ok := debug.ReadBuildInfo(); ok {
		return bi.GoVersion
	}
	return os.Getenv("GOVERSION")
}
