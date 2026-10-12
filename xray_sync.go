package main

// xray 用户同步：把启用用户的 UUID 自动写进各 xray 的 clients（email=通道名），
// 手工录入正式退役。合并逻辑纯函数可测；传输走 SSH（复用 log_cmd 的密钥惯例）。
// 规则：缺的补上；UUID 变了的更新；已停用/消失用户的条目移除；
// 非 u0x 格式的未知 email 原样保留；无启用用户时整轮跳过（防清空）；
// 只有写入确实变更才重启 xray（重启失败留 pending 标记下轮重试）。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	xraySyncEvery   = 2 * time.Minute
	xraySyncTimeout = 30 * time.Second
	xraySSHTimeout  = 15
)

// xrayClient 是 inbound.settings.clients 的条目子集（只管 id/email，别的不碰）
type xrayClient struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

var slotEmailRe = regexp.MustCompile(`^u[0-9]+$`)

// mergeXrayClients 按期望（uuid->email，仅启用用户）归并现有 clients：
// 顺序保持（旧的按原序，新增按 email 排序追加）；返回归并结果与是否变更。
func mergeXrayClients(existing []xrayClient, desired map[string]string) ([]xrayClient, bool) {
	wantByEmail := map[string]string{} // email -> uuid
	for id, email := range desired {
		if id == "" {
			continue
		}
		wantByEmail[email] = id
	}
	merged := make([]xrayClient, 0, len(existing)+len(wantByEmail))
	changed := false
	seen := map[string]bool{}
	for _, c := range existing {
		if !slotEmailRe.MatchString(c.Email) {
			merged = append(merged, c) // 外来条目：不动
			continue
		}
		want, ok := wantByEmail[c.Email]
		if !ok {
			changed = true // 停用/消失：移除
			continue
		}
		if c.ID != want {
			c.ID = want
			changed = true
		}
		merged = append(merged, c)
		seen[c.Email] = true
	}
	emails := make([]string, 0, len(wantByEmail))
	for email := range wantByEmail {
		emails = append(emails, email)
	}
	sort.Strings(emails)
	for _, email := range emails {
		if seen[email] {
			continue
		}
		merged = append(merged, xrayClient{ID: wantByEmail[email], Email: email})
		changed = true
	}
	return merged, changed
}

// desiredXrayClients 期望的 uuid->email（仅启用且有 UUID 的用户）
func desiredXrayClients(users *UserStore) map[string]string {
	out := map[string]string{}
	users.mu.Lock()
	defer users.mu.Unlock()
	for _, u := range users.byID {
		if !u.Enabled || u.UUID == "" || u.HyUser == "" {
			continue
		}
		out[u.UUID] = u.HyUser
	}
	return out
}

// xrayOps 传输层可注入（生产走 SSH，测试用 fake）
type xrayOps struct {
	fetch   func(n XrayNode) ([]xrayClient, error)
	push    func(n XrayNode, clients []xrayClient) error
	restart func(n XrayNode) error
}

func sshBase(key, target, knownHosts string) []string {
	args := []string{"-o", "BatchMode=yes", "-o", fmt.Sprintf("ConnectTimeout=%d", xraySSHTimeout)}
	if key != "" {
		args = append(args, "-i", key)
	}
	if knownHosts != "" {
		// systemd 加固下 /root 不可写：known_hosts 自维护在数据目录，严格校验不 TOFU
		args = append(args, "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile="+knownHosts)
	} else {
		args = append(args, "-o", "StrictHostKeyChecking=accept-new")
	}
	return append(args, target)
}

// hostOfTarget 取 "user@host" 里的 host（只支持 user@host 形式）
func hostOfTarget(target string) string {
	if i := strings.LastIndexByte(target, '@'); i >= 0 {
		return target[i+1:]
	}
	return target
}

// ensureHostKey 自维护 known_hosts：缺该 host 才调 scan 补（生产用 ssh-keyscan），
// 只收该 host 开头的行；文件 0600。
func ensureHostKey(path, target string, scan func(host string) (string, error)) error {
	host := hostOfTarget(target)
	if host == "" {
		return errors.New("host 为空")
	}
	if b, err := os.ReadFile(path); err == nil {
		for _, ln := range strings.Split(string(b), "\n") {
			if ln == host || strings.HasPrefix(ln, host+" ") || strings.HasPrefix(ln, host+",") {
				return nil
			}
		}
	}
	out, err := scan(host)
	if err != nil {
		return fmt.Errorf("keyscan: %v", err)
	}
	var keep []string
	for _, ln := range strings.Split(out, "\n") {
		ln = strings.TrimSpace(ln)
		if ln == "" || strings.HasPrefix(ln, "#") {
			continue
		}
		if ln == host || strings.HasPrefix(ln, host+" ") || strings.HasPrefix(ln, host+",") {
			keep = append(keep, ln)
		}
	}
	if len(keep) == 0 {
		return errors.New("keyscan 无可用 host key")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.WriteString(strings.Join(keep, "\n") + "\n"); err != nil {
		return err
	}
	log.Printf("xray 同步：已写入 %s 的 host key", host)
	return nil
}

func prodKeyscan(host string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ssh-keyscan", "-t", "ed25519,rsa", "-T", "15", host).CombinedOutput()
	return string(out), err
}

func validRemotePath(p string) bool {
	if p == "" || len(p) > 256 || strings.Contains(p, "..") {
		return false
	}
	for _, c := range p {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '/' || c == '.' || c == '_' || c == '-') {
			return false
		}
	}
	return strings.HasPrefix(p, "/")
}

// shQuote 把单个远端参数包成 sh 安全形式（sshd 经 sh -c 重解析，
 // 不包的话含空格/换行的参数会被拆散）
func shQuote(s string) string {
	if s == "" {
		return "''"
	}
	safe := true
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
			c == '_' || c == '-' || c == '.' || c == '/' || c == '=') {
			safe = false
			break
		}
	}
	if safe {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

// shJoin 把远端 argv 拼成一条远程 shell 命令
func shJoin(args ...string) string {
	q := make([]string, len(args))
	for i, a := range args {
		q[i] = shQuote(a)
	}
	return strings.Join(q, " ")
}

func defaultXrayOps(khPath string) xrayOps {
	run := func(key, target string, stdin string, timeout time.Duration, args ...string) (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		cmd := exec.CommandContext(ctx, "ssh", append(sshBase(key, target, khPath), shJoin(args...))...)
		if stdin != "" {
			cmd.Stdin = strings.NewReader(stdin)
		}
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	cfgPath := func(n XrayNode) string {
		if n.SyncPath != "" {
			return n.SyncPath
		}
		return "/etc/xray/config.json"
	}
	return xrayOps{
		fetch: func(n XrayNode) ([]xrayClient, error) {
			// 只取目标 inbound 的 clients，不把整份配置（含 privateKey）拉回来
			py := `import sys,json
cfg=json.load(open(sys.argv[1]))
port=int(sys.argv[2])
for ib in cfg.get("inbounds",[]):
    if ib.get("port")==port and ib.get("protocol")=="vless":
        print(json.dumps(ib.get("settings",{}).get("clients",[])))
        break
else:
    sys.exit("no vless inbound on port %d" % port)`
			port := n.SyncPort
			if port == 0 {
				port = 443
			}
			out, err := run(n.SyncKey, n.SyncSSH, "", xraySyncTimeout, "python3", "-c", py, cfgPath(n), fmt.Sprint(port))
			if err != nil {
				return nil, fmt.Errorf("fetch: %v: %s", err, firstLine(out))
			}
			var cls []xrayClient
			if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &cls); err != nil {
				return nil, fmt.Errorf("fetch 解析失败: %v", err)
			}
			if cls == nil {
				cls = []xrayClient{}
			}
			return cls, nil
		},
		push: func(n XrayNode, clients []xrayClient) error {
			body, _ := json.Marshal(clients)
			py := `import sys,json
path, want = sys.argv[1], json.loads(sys.stdin.read())
cfg=json.load(open(path))
port=int(sys.argv[2])
for ib in cfg.get("inbounds",[]):
    if ib.get("port")==port and ib.get("protocol")=="vless":
        ib.setdefault("settings",{})["clients"]=want
        break
else:
    sys.exit("no vless inbound on port %d" % port)
tmp=path+".hy2dash.tmp"
json.dump(cfg,open(tmp,"w"),indent=2)
json.load(open(tmp))
import os
os.rename(tmp,path)
print("ok")`
			port := n.SyncPort
			if port == 0 {
				port = 443
			}
			if !validRemotePath(cfgPath(n)) {
				return errors.New("push: 非法远端路径")
			}
			out, err := run(n.SyncKey, n.SyncSSH, string(body), xraySyncTimeout, "python3", "-c", py, cfgPath(n), fmt.Sprint(port))
			if err != nil || !strings.Contains(out, "ok") {
				return fmt.Errorf("push: %v: %s", err, firstLine(out))
			}
			return nil
		},
		restart: func(n XrayNode) error {
			cmd := n.SyncRestart
			if cmd == "" {
				cmd = "systemctl restart xray"
			}
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			args := append(sshBase(n.SyncKey, n.SyncSSH, khPath), shJoin("sh", "-c", cmd))
			if out, err := exec.CommandContext(ctx, "ssh", args...).CombinedOutput(); err != nil {
				return fmt.Errorf("restart: %v: %s", err, firstLine(string(out)))
			}
			return nil
		},
	}
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return strings.TrimSpace(s)
}

// syncXrayOnce 全量对一遍：无启用用户跳过；有 SyncSSH 的节点才处理；
// 写入变更才重启；重启失败留 pending（调用方下轮重试）。
// khPath 为空时跳过 known_hosts 自维护（测试用）。
func syncXrayOnce(nodes []XrayNode, users *UserStore, ops xrayOps, pending map[string]bool, khPath string) {
	desired := desiredXrayClients(users)
	if len(desired) == 0 {
		log.Printf("xray 同步：无启用用户，跳过")
		return
	}
	for _, n := range nodes {
		if n.SyncSSH == "" {
			continue
		}
		if err := syncXrayNode(n, desired, ops, pending, khPath); err != nil {
			log.Printf("xray 同步 @%s 失败: %v", n.Name, err)
		}
	}
}

func syncXrayNode(n XrayNode, desired map[string]string, ops xrayOps, pending map[string]bool, khPath string) error {
	if khPath != "" {
		if err := ensureHostKey(khPath, n.SyncSSH, prodKeyscan); err != nil {
			return err
		}
	}
	cur, err := ops.fetch(n)
	if err != nil {
		return err
	}
	merged, changed := mergeXrayClients(cur, desired)
	if !changed && !pending[n.Name] {
		return nil
	}
	if changed {
		if err := ops.push(n, merged); err != nil {
			return err
		}
	}
	if err := ops.restart(n); err != nil {
		pending[n.Name] = true
		return err
	}
	delete(pending, n.Name)
	added := len(merged) - len(cur)
	log.Printf("xray 同步 @%s: 变更已写入并重启（当前 %d 条）", n.Name, added+len(cur))
	return nil
}

// runXraySync 启动即对一遍，之后每 2 分钟 + 注册事件 poke 时对账
func runXraySync(nodes []XrayNode, users *UserStore, poke <-chan struct{}) {
	any := false
	for _, n := range nodes {
		if n.SyncSSH != "" {
			any = true
			break
		}
	}
	if !any {
		return
	}
	khPath := ""
	if dir := filepath.Dir(users.path); dir != "" && dir != "." {
		khPath = filepath.Join(dir, ".ssh", "known_hosts")
	}
	ops := defaultXrayOps(khPath)
	pending := map[string]bool{}
	syncXrayOnce(nodes, users, ops, pending, khPath)
	t := time.NewTicker(xraySyncEvery)
	defer t.Stop()
	for {
		select {
		case <-poke:
			syncXrayOnce(nodes, users, ops, pending, khPath)
		case <-t.C:
			syncXrayOnce(nodes, users, ops, pending, khPath)
		}
	}
}
