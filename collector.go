package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

type StreamEntry struct {
	State         string `json:"state"`
	Auth          string `json:"auth"`
	Connection    uint32 `json:"connection"`
	Stream        uint64 `json:"stream"`
	ReqAddr       string `json:"req_addr"`
	HookedReqAddr string `json:"hooked_req_addr"`
	Tx            uint64 `json:"tx"`
	Rx            uint64 `json:"rx"`
	InitialAt     string `json:"initial_at"`
	LastActiveAt  string `json:"last_active_at"`
}

type dumpResp struct {
	Streams []StreamEntry `json:"streams"`
}

type trafficEntry struct {
	Tx uint64 `json:"tx"`
	Rx uint64 `json:"rx"`
}

// Collector 轮询各 hysteria 的 trafficStats API，做连接级差分
type Collector struct {
	cfg    *Config
	store  *Store
	client *http.Client

	mu        sync.RWMutex
	live      map[string]*Conn
	userTotal map[string]trafficEntry
	online    map[string]bool
	lastErr   string
	lastOK    time.Time
	lastCount int

	started time.Time
}

func NewCollector(cfg *Config, store *Store) *Collector {
	return &Collector{
		cfg:       cfg,
		store:     store,
		client:    &http.Client{Timeout: 8 * time.Second},
		live:      make(map[string]*Conn, 64),
		userTotal: make(map[string]trafficEntry, 8),
		online:    make(map[string]bool, 8),
		started:   time.Now(),
	}
}

func (c *Collector) nodes() []HysteriaNode {
	if len(c.cfg.HysteriaNodes) > 0 {
		return c.cfg.HysteriaNodes
	}
	return []HysteriaNode{{Name: "local", URL: c.cfg.HysteriaStats, Secret: c.cfg.HysteriaSecret}}
}

func (c *Collector) get(node HysteriaNode, path string, out any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, node.URL+path, nil)
	if err != nil {
		return err
	}
	if node.Secret != "" {
		req.Header.Set("Authorization", node.Secret)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	// 限制读取体积，避免异常响应把内存吃满
	return json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out)
}

func keyOf(e StreamEntry) string {
	return fmt.Sprintf("%s/%08X/%d", e.Auth, e.Connection, e.Stream)
}

func parseTS(s string) int64 {
	if s == "" {
		return 0
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.Unix()
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.Unix()
	}
	return 0
}

// Run 主循环：快轮询连接明细，慢轮询用户总量
func (c *Collector) Run() {
	fast := time.NewTicker(time.Duration(max(c.cfg.PollMS, 300)) * time.Millisecond)
	slow := time.NewTicker(30 * time.Second)
	house := time.NewTicker(6 * time.Hour)
	defer fast.Stop()
	defer slow.Stop()
	defer house.Stop()

	c.pollStreams()
	c.pollTotals()
	c.store.Cleanup(c.cfg.RetentionDays)

	for {
		select {
		case <-fast.C:
			c.pollStreams()
		case <-slow.C:
			c.pollTotals()
		case <-house.C:
			c.store.Flush()
			c.store.Cleanup(c.cfg.RetentionDays)
		}
	}
}

func (c *Collector) pollStreams() {
	now := time.Now().Unix()

	c.mu.Lock()
	defer c.mu.Unlock()

	seen := map[string]bool{}
	errs := 0
	count := 0
	for _, n := range c.nodes() {
		var d dumpResp
		if err := c.get(n, "/dump/streams", &d); err != nil {
			errs++
			continue
		}
		count += len(d.Streams)
		for _, e := range d.Streams {
			k := n.Name + "/" + keyOf(e)
			seen[k] = true
			if cur, ok := c.live[k]; ok {
				cur.Tx, cur.Rx = e.Tx, e.Rx
				cur.State = e.State
				if e.ReqAddr != "" {
					cur.Addr = e.ReqAddr
				}
				cur.Sniffed = e.HookedReqAddr
				if ts := parseTS(e.LastActiveAt); ts > 0 {
					cur.Last = ts
				}
			} else {
				start := parseTS(e.InitialAt)
				if start == 0 {
					start = now
				}
				c.live[k] = &Conn{
					Key: k, Srv: n.Name, User: e.Auth, Addr: e.ReqAddr, Sniffed: e.HookedReqAddr,
					State: e.State, Tx: e.Tx, Rx: e.Rx, Start: start, Last: now,
				}
			}
		}
	}

	if errs == len(c.nodes()) && len(c.nodes()) > 0 {
		c.lastErr = "all upstreams unreachable"
		return
	}
	if errs > 0 {
		c.lastErr = fmt.Sprintf("%d/%d upstreams unreachable", errs, len(c.nodes()))
	} else {
		c.lastErr = ""
	}
	c.lastOK = time.Now()
	c.lastCount = count

	// 消失的流 = 连接关闭，落盘
	for k, cur := range c.live {
		if seen[k] {
			continue
		}
		cur.End = now
		if cur.Last == 0 {
			cur.Last = now
		}
		cur.Dur = float64(cur.End-cur.Start) + 0.001
		if cur.Start == 0 {
			cur.Dur = 0
		}
		c.store.Append(*cur)
		delete(c.live, k)
	}
}

func (c *Collector) pollTotals() {
	tot := map[string]trafficEntry{}
	on := map[string]bool{}
	for _, n := range c.nodes() {
		var t map[string]trafficEntry
		if err := c.get(n, "/traffic", &t); err == nil {
			for u, e := range t {
				acc := tot[u]
				acc.Tx += e.Tx
				acc.Rx += e.Rx
				tot[u] = acc
			}
		}
		var o map[string]bool
		if err := c.get(n, "/online", &o); err == nil {
			for u, v := range o {
				if v {
					on[u] = true
				} else if _, ok := on[u]; !ok {
					on[u] = false
				}
			}
		}
	}
	c.mu.Lock()
	c.userTotal = tot
	c.online = on
	c.mu.Unlock()
}

type LiveView struct {
	Live      []Conn                  `json:"live"`
	Online    map[string]bool         `json:"online"`
	UserTotal map[string]trafficEntry `json:"user_total"`
	LastErr   string                  `json:"last_error"`
	LastOK    int64                   `json:"last_ok"`
	Uptime    float64                 `json:"uptime"`
	Count     int                     `json:"count"`
}

func (c *Collector) Snapshot() LiveView {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := LiveView{
		Live:      make([]Conn, 0, len(c.live)),
		Online:    c.online,
		UserTotal: c.userTotal,
		LastErr:   c.lastErr,
		LastOK:    c.lastOK.Unix(),
		Uptime:    time.Since(c.started).Seconds(),
		Count:     len(c.live),
	}
	for _, v := range c.live {
		out.Live = append(out.Live, *v)
	}
	// 流量大的排前面
	for i := 1; i < len(out.Live); i++ {
		for j := i; j > 0 && out.Live[j].Tx+out.Live[j].Rx > out.Live[j-1].Tx+out.Live[j-1].Rx; j-- {
			out.Live[j], out.Live[j-1] = out.Live[j-1], out.Live[j]
		}
	}
	return out
}

// UserTotals 聚合各上游的按用户累计（订阅流量头用，失败的上游直接跳过）
func (c *Collector) UserTotals() map[string]trafficEntry {
	tot := map[string]trafficEntry{}
	for _, n := range c.nodes() {
		var t map[string]trafficEntry
		if err := c.get(n, "/traffic", &t); err != nil {
			continue
		}
		for u, e := range t {
			acc := tot[u]
			acc.Tx += e.Tx
			acc.Rx += e.Rx
			tot[u] = acc
		}
	}
	return tot
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
