package main

// HostKer 设备总额：每天同步一次（TTL 24h），掉线/失败时沿用上次结果。
// 逻辑与已退役 Worker 一致：Account.login → Cloud.getList → 逐机 Cloud.get。

import (
	"bytes"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const hostkerURL = "https://console.hostker.net/Client/"
const hostkerUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const hostkerTTL = 24 * time.Hour

type HostkerServer struct {
	IP      string  `json:"ip"`
	Name    string  `json:"name"`
	UpMiB   float64 `json:"up_mib"`
	DownMiB float64 `json:"down_mib"`
}

type HostkerStats struct {
	At      int64           `json:"at"`
	Servers []HostkerServer `json:"servers"`
}

var hostkerCache = struct {
	mu   sync.Mutex
	data *HostkerStats
}{}

func hostkerFile() string { return filepath.Join(cfg.DataDir, "hostker.json") }

func hostkerPost(payload map[string]any, cookie string) (map[string]any, string, error) {
	body, _ := json.Marshal(payload)
	sum := md5.Sum(append(body, []byte(hostkerUA)...))
	req, err := http.NewRequest(http.MethodPost, hostkerURL, bytes.NewReader(body))
	if err != nil {
		return nil, cookie, err
	}
	req.Header.Set("User-Agent", hostkerUA)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("sign", hex.EncodeToString(sum[:]))
	if cookie != "" {
		req.Header.Set("Cookie", "KERSESSID="+cookie)
	}
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, cookie, err
	}
	defer resp.Body.Close()
	for _, c := range resp.Cookies() {
		if c.Name == "KERSESSID" {
			cookie = c.Value
		}
	}
	var data map[string]any
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&data); err != nil {
		return nil, cookie, err
	}
	return data, cookie, nil
}

func numOf(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}

// fetchHostker 拉全量设备用量（ MiB 浮点，与面板口径一致）
func fetchHostker(email, pass string) (*HostkerStats, error) {
	ts := fmt.Sprint(time.Now().Unix())
	login, sess, err := hostkerPost(map[string]any{
		"account": email, "password": pass, "step2": "",
		"action": "Account.login", "time": ts}, "")
	if err != nil {
		return nil, err
	}
	if login["success"] != true {
		return nil, fmt.Errorf("hostker login failed")
	}
	lst, sess, err := hostkerPost(map[string]any{"action": "Cloud.getList", "time": ts}, sess)
	if err != nil {
		return nil, err
	}
	res, _ := lst["result"].(map[string]any)
	arr, _ := res["servers"].([]any)
	out := &HostkerStats{At: time.Now().Unix()}
	for _, s := range arr {
		m, _ := s.(map[string]any)
		uuid, _ := m["uuid"].(string)
		if uuid == "" {
			continue
		}
		cloud, _, err := hostkerPost(map[string]any{"uuid": uuid, "action": "Cloud.get", "time": ts}, sess)
		if err != nil {
			continue
		}
		r, _ := cloud["result"].(map[string]any)
		up, _ := numOf(r["up_traffic"])
		down, _ := numOf(r["down_traffic"])
		ip, _ := m["main_ip"].(string)
		name, _ := m["name"].(string)
		out.Servers = append(out.Servers, HostkerServer{IP: ip, Name: name, UpMiB: up, DownMiB: down})
	}
	if len(out.Servers) == 0 {
		return nil, fmt.Errorf("no servers")
	}
	return out, nil
}

// hostkerStats 缓存读取：24h 内直接用；过期则拉新，失败沿用旧值
func hostkerStats(force bool) *HostkerStats {
	hostkerCache.mu.Lock()
	defer hostkerCache.mu.Unlock()
	if hostkerCache.data == nil {
		if b, err := os.ReadFile(hostkerFile()); err == nil {
			var st HostkerStats
			if json.Unmarshal(b, &st) == nil && len(st.Servers) > 0 {
				hostkerCache.data = &st
			}
		}
	}
	cur := hostkerCache.data
	if !force && cur != nil && time.Since(time.Unix(cur.At, 0)) < hostkerTTL {
		return cur
	}
	if cfg.HostkerEmail == "" || cfg.HostkerPass == "" {
		return cur
	}
	if fresh, err := fetchHostker(cfg.HostkerEmail, cfg.HostkerPass); err == nil {
		hostkerCache.data = fresh
		os.MkdirAll(cfg.DataDir, 0o700)
		if b, err := json.Marshal(fresh); err == nil {
			os.WriteFile(hostkerFile(), b, 0o600)
		}
		return fresh
	}
	return cur
}
