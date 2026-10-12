package main

// VLESS (xray) 流量监控：只读。轮询 xray 的 metrics 接口（expvar，/debug/vars 里的
// stats.user.<email>.{uplink,downlink}；email 约定为通道名 u0x），差分记进各用户的
// VLESS 按天桶。只做展示：不计入配额、不踢人、不改 xray 的任何用户。

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"
)

// XrayNode 是一台 xray 的 metrics 接口（远端经 SSH 隧道转到本机）
type XrayNode struct {
	Name string `json:"name"`
	URL  string `json:"metrics_url"`
}

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
