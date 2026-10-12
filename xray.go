package main

// VLESS (xray) 流量监控：只读。轮询 xray 的 metrics 接口（expvar，/debug/vars 里的
// stats.user.<email>.{uplink,downlink}；email 约定为通道名 u0x），差分记进各用户的
// VLESS 按天桶。只做展示：不计入配额、不踢人、不改 xray 的任何用户。

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os/exec"
	"regexp"
	"sync"
	"sync/atomic"
	"time"
)

// XrayNode 是一台 xray 的 metrics 接口（远端经 SSH 隧道转到本机）
type XrayNode struct {
	Name string `json:"name"`
	URL  string `json:"metrics_url"`
	// LogCmd 持续输出 xray 访问日志的命令（如 ssh … tail -n0 -F access.log）。
	// 配了才有 VLESS 的"连了哪些域名"；只读日志，不碰 xray。
	LogCmd []string `json:"log_cmd,omitempty"`
	// SyncSSH 配了才启用「用户 UUID 自动同步」：形如 "root@host"，面板直连 xray 主机，
	// 把启用用户的 UUID 写进其 clients（email=通道名），变更才重启 xray。
	// 停用/删除的用户会被移出；未知 email 原样保留；无启用用户时跳过（防清空）。
	SyncSSH     string `json:"sync_ssh,omitempty"`
	SyncKey     string `json:"sync_key,omitempty"`     // ssh 密钥路径（空 = ssh 默认）
	SyncPath    string `json:"sync_path,omitempty"`    // 远端 xray 配置路径（默认 /etc/xray/config.json）
	SyncRestart string `json:"sync_restart,omitempty"` // 变更后的重启命令（默认 systemctl restart xray）
	SyncPort    int    `json:"sync_port,omitempty"`    // 目标 inbound 端口（默认 443，须为 vless 协议）
}

// vlessState 是落盘记录里标记 VLESS 连接的 State（没有字节数/时长）
const vlessState = "vless"

// VRecent 是一条最近新开的 VLESS 连接
type VRecent struct {
	User string `json:"u"`
	Srv  string `json:"srv,omitempty"`
	Addr string `json:"a"`
	At   int64  `json:"t"`
}

const (
	vlessRecentKeep = 60 * time.Second
	vlessRecentCap  = 400
)

const (
	vlessPoll   = 10 * time.Second
	vlessActive = 90 * time.Second // 这段时间内有流量就算在线
)

type VlessMon struct {
	mu     sync.RWMutex
	acc    map[string]trafficEntry // 通道名 -> 本进程启动以来的累计（单调，前端算速率用）
	active map[string]time.Time    // 通道名 -> 最近一次有流量的时间
	prev   map[string]trafficEntry // 节点|通道名 -> 上次读数
	lastOK time.Time
	recent []VRecent // 最近 vlessRecentKeep 内新开的连接（旧→新）
}

func (m *VlessMon) addRecent(r VRecent) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cut := r.At - int64(vlessRecentKeep/time.Second)
	i := 0
	for i < len(m.recent) && m.recent[i].At < cut {
		i++
	}
	m.recent = append(m.recent[i:], r)
	if len(m.recent) > vlessRecentCap {
		m.recent = m.recent[len(m.recent)-vlessRecentCap:]
	}
	m.active[r.User] = time.Unix(r.At, 0)
}

// Recent 返回某通道（空 = 所有人）最近新开的 VLESS 连接，新→旧
func (m *VlessMon) Recent(hy string, now time.Time) []VRecent {
	cut := now.Unix() - int64(vlessRecentKeep/time.Second)
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := []VRecent{}
	for i := len(m.recent) - 1; i >= 0; i-- {
		r := m.recent[i]
		if r.At < cut {
			break
		}
		if hy == "" || r.User == hy {
			out = append(out, r)
		}
	}
	return out
}

// xray 访问日志一行形如：
//
//	<日期 时间> from <来源IP:端口> accepted tcp:example.com:443 [in >> direct] email: u01
var (
	xrayAcceptRe = regexp.MustCompile(` accepted (?:(tcp|udp):)?(\S+?):(\d+)(?:\s|$)`)
	xrayEmailRe  = regexp.MustCompile(` email: (\S+)`)
)

// parseXrayAccess 取出（通道名, 目标 host:port）；不是 accepted 行或没有 email 返回 ok=false
func parseXrayAccess(line string) (user, addr string, ok bool) {
	a := xrayAcceptRe.FindStringSubmatch(line)
	e := xrayEmailRe.FindStringSubmatch(line)
	if a == nil || e == nil {
		return "", "", false
	}
	return e[1], a[2] + ":" + a[3], true
}

var vlessSeq atomic.Uint64

// runVlessLog 跟读一台 xray 的访问日志：每条连接记一条落盘记录（State=vless，无字节数），
// 并放进"最近连接"。命令退出就 10 秒后重连。
func runVlessLog(n XrayNode, store *Store, mon *VlessMon) {
	if len(n.LogCmd) == 0 {
		return
	}
	for {
		cmd := exec.Command(n.LogCmd[0], n.LogCmd[1:]...)
		out, err := cmd.StdoutPipe()
		if err == nil {
			err = cmd.Start()
		}
		if err != nil {
			log.Printf("vless 日志 @%s 启动失败: %v", n.Name, err)
		} else {
			sc := bufio.NewScanner(out)
			sc.Buffer(make([]byte, 0, 16*1024), 256*1024)
			for sc.Scan() {
				user, addr, ok := parseXrayAccess(sc.Text())
				if !ok {
					continue
				}
				now := time.Now().Unix()
				mon.addRecent(VRecent{User: user, Srv: n.Name, Addr: addr, At: now})
				store.Append(Conn{
					Key: fmt.Sprintf("v/%s/%d", user, vlessSeq.Add(1)), Srv: n.Name, User: user,
					Addr: addr, State: vlessState, Start: now, Last: now, End: now,
				})
			}
			cmd.Wait()
		}
		time.Sleep(10 * time.Second)
	}
}

func NewVlessMon() *VlessMon {
	return &VlessMon{acc: map[string]trafficEntry{}, active: map[string]time.Time{}, prev: map[string]trafficEntry{}}
}

// Active 该通道最近是否在走 VLESS
func (m *VlessMon) Active(hy string, now time.Time) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	t, ok := m.active[hy]
	return ok && now.Sub(t) < vlessActive
}

func (m *VlessMon) Total(hy string) trafficEntry {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.acc[hy]
}

type xrayVars struct {
	Stats struct {
		User map[string]struct {
			Up   uint64 `json:"uplink"`
			Down uint64 `json:"downlink"`
		} `json:"user"`
	} `json:"stats"`
}

func xrayFetch(client *http.Client, url string) (map[string]trafficEntry, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url+"/debug/vars", nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var v xrayVars
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&v); err != nil {
		return nil, err
	}
	out := make(map[string]trafficEntry, len(v.Stats.User))
	for email, s := range v.Stats.User {
		out[email] = trafficEntry{Tx: s.Up, Rx: s.Down}
	}
	return out, nil
}

// apply 把一台节点的一次读数差分进累计，返回各通道的增量。
// 计数器变小（xray 重启）时按归零后的值计；首次见到的读数只当基线。
func (m *VlessMon) apply(node string, cur map[string]trafficEntry, now time.Time) map[string]trafficEntry {
	delta := map[string]trafficEntry{}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lastOK = now
	for hy, e := range cur {
		k := node + "|" + hy
		p, seen := m.prev[k]
		m.prev[k] = e
		if !seen {
			continue
		}
		var d trafficEntry
		if e.Tx >= p.Tx {
			d.Tx = e.Tx - p.Tx
		} else {
			d.Tx = e.Tx
		}
		if e.Rx >= p.Rx {
			d.Rx = e.Rx - p.Rx
		} else {
			d.Rx = e.Rx
		}
		if d.Tx+d.Rx == 0 {
			continue
		}
		a := m.acc[hy]
		a.Tx += d.Tx
		a.Rx += d.Rx
		m.acc[hy] = a
		m.active[hy] = now
		dd := delta[hy]
		dd.Tx += d.Tx
		dd.Rx += d.Rx
		delta[hy] = dd
	}
	return delta
}

// runVlessMonitor 轮询并把增量记进用户的 VLESS 按天桶（5 分钟落盘一次）
func runVlessMonitor(nodes []XrayNode, users *UserStore, mon *VlessMon) {
	if len(nodes) == 0 {
		return
	}
	client := &http.Client{Timeout: 8 * time.Second}
	dirty := false
	lastSave := time.Now()
	t := time.NewTicker(vlessPoll)
	defer t.Stop()
	for ; ; <-t.C {
		now := time.Now()
		for _, n := range nodes {
			cur, err := xrayFetch(client, n.URL)
			if err != nil {
				continue
			}
			delta := mon.apply(n.Name, cur, now)
			if len(delta) == 0 {
				continue
			}
			today := todayKey()
			users.mu.Lock()
			for _, u := range users.byID {
				d, ok := delta[u.HyUser]
				if !ok {
					continue
				}
				if u.VBuckets == nil {
					u.VBuckets = map[string]DayUse{}
				}
				b := u.VBuckets[today]
				b.Tx += d.Tx
				b.Rx += d.Rx
				u.VBuckets[today] = b
				dirty = true
			}
			users.mu.Unlock()
		}
		if dirty && now.Sub(lastSave) >= 5*time.Minute {
			users.mu.Lock()
			users.save()
			users.mu.Unlock()
			dirty, lastSave = false, now
		}
	}
}

func (u *User) vlessDay(today string) uint64 {
	b := u.VBuckets[today]
	return b.Tx + b.Rx
}

func (u *User) vlessMonth(now time.Time) uint64 {
	var sum uint64
	for i := 0; i < 30; i++ {
		b := u.VBuckets[now.AddDate(0, 0, -i).Format("2006-01-02")]
		sum += b.Tx + b.Rx
	}
	return sum
}
