package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Conn 是一条「连接明细」（hysteria2 的一个 stream）
type Conn struct {
	Key     string  `json:"k"`
	User    string  `json:"u"`
	Addr    string  `json:"a"`
	Sniffed string  `json:"s,omitempty"`
	State   string  `json:"st"`
	Tx      uint64  `json:"tx"`
	Rx      uint64  `json:"rx"`
	Start   int64   `json:"t0"`
	Last    int64   `json:"t1"`
	End     int64   `json:"t2,omitempty"`
	Dur     float64 `json:"d,omitempty"`
}

type Store struct {
	dir     string
	mu      sync.Mutex
	ring    []Conn // 最近关闭的连接（环形，容量固定）
	ringPos int
	ringLen int
	f       *os.File
	fDate   string
	w       *bufio.Writer
}

const ringCap = 400

func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Store{dir: dir, ring: make([]Conn, ringCap)}, nil
}

func (s *Store) dayFile(day string) string {
	return filepath.Join(s.dir, "conn-"+day+".jsonl")
}

// Append 落盘一条已关闭的连接，并放进内存环形缓冲
func (s *Store) Append(c Conn) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.ring[s.ringPos] = c
	s.ringPos = (s.ringPos + 1) % ringCap
	if s.ringLen < ringCap {
		s.ringLen++
	}

	day := time.Unix(c.End, 0).Format("2006-01-02")
	if s.f == nil || s.fDate != day {
		if s.w != nil {
			s.w.Flush()
		}
		if s.f != nil {
			s.f.Close()
		}
		f, err := os.OpenFile(s.dayFile(day), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			s.f, s.w, s.fDate = nil, nil, ""
			return
		}
		s.f, s.w, s.fDate = f, bufio.NewWriterSize(f, 16*1024), day
	}
	b, err := json.Marshal(c)
	if err == nil {
		s.w.Write(b)
		s.w.WriteByte('\n')
		// 每 20 条刷一次，兼顾性能与丢数据风险
		if s.w.Buffered() > 8*1024 {
			s.w.Flush()
		}
	}
}

func (s *Store) Flush() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.w != nil {
		s.w.Flush()
	}
}

// Recent 返回最近关闭的 N 条（新→旧）
func (s *Store) Recent(n int) []Conn {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n > s.ringLen {
		n = s.ringLen
	}
	out := make([]Conn, 0, n)
	for i := 0; i < n; i++ {
		idx := (s.ringPos - 1 - i + ringCap*2) % ringCap
		out = append(out, s.ring[idx])
	}
	return out
}

// History 扫描某天的文件，按关键字过滤（目标/用户），返回新→旧
func (s *Store) History(day, q string, limit, offset int) ([]Conn, int, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	f, err := os.Open(s.dayFile(day))
	if err != nil {
		if os.IsNotExist(err) {
			return []Conn{}, 0, nil
		}
		return nil, 0, err
	}
	defer f.Close()

	q = strings.ToLower(strings.TrimSpace(q))
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 512*1024)

	matched := make([]Conn, 0, limit)
	total := 0
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var c Conn
		if json.Unmarshal(line, &c) != nil {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(c.Addr), q) && !strings.Contains(strings.ToLower(c.User), q) {
			continue
		}
		total++
		if total <= offset {
			continue
		}
		if len(matched) < limit {
			matched = append(matched, c)
		}
	}
	// 文件是追加写的（旧→新），这里反转为新→旧
	for i, j := 0, len(matched)-1; i < j; i, j = i+1, j-1 {
		matched[i], matched[j] = matched[j], matched[i]
	}
	return matched, total, nil
}

type DayStat struct {
	Day   string `json:"day"`
	Count int    `json:"count"`
	Tx    uint64 `json:"tx"`
	Rx    uint64 `json:"rx"`
}

type DomainStat struct {
	Addr  string `json:"addr"`
	Count int    `json:"count"`
	Tx    uint64 `json:"tx"`
	Rx    uint64 `json:"rx"`
}

type Summary struct {
	Days      []DayStat    `json:"days"`
	TopDomain []DomainStat `json:"top_domains"`
	TotalTx   uint64       `json:"total_tx"`
	TotalRx   uint64       `json:"total_rx"`
	TotalConn int          `json:"total_conn"`
	TodayTx   uint64       `json:"today_tx"`
	TodayRx   uint64       `json:"today_rx"`
	TodayConn int          `json:"today_conn"`
}

// Summary 聚合最近 days 天（含今天）的按天流量与 Top 域名
func (s *Store) Summary(days int) Summary {
	if days <= 0 || days > 90 {
		days = 7
	}
	now := time.Now()
	res := Summary{Days: make([]DayStat, 0, days)}
	dom := make(map[string]*DomainStat, 256)

	for i := days - 1; i >= 0; i-- {
		day := now.AddDate(0, 0, -i).Format("2006-01-02")
		ds := DayStat{Day: day}
		f, err := os.Open(s.dayFile(day))
		if err != nil {
			res.Days = append(res.Days, ds)
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 0, 64*1024), 512*1024)
		for sc.Scan() {
			var c Conn
			if json.Unmarshal(sc.Bytes(), &c) != nil {
				continue
			}
			ds.Count++
			ds.Tx += c.Tx
			ds.Rx += c.Rx
			key := c.Addr
			if key == "" {
				key = "-"
			}
			d := dom[key]
			if d == nil {
				if len(dom) < 5000 {
					d = &DomainStat{Addr: key}
					dom[key] = d
				} else {
					d = &DomainStat{Addr: key}
				}
			}
			d.Count++
			d.Tx += c.Tx
			d.Rx += c.Rx
		}
		f.Close()
		res.Days = append(res.Days, ds)
		res.TotalConn += ds.Count
		res.TotalTx += ds.Tx
		res.TotalRx += ds.Rx
		if i == 0 {
			res.TodayConn, res.TodayTx, res.TodayRx = ds.Count, ds.Tx, ds.Rx
		}
	}

	all := make([]DomainStat, 0, len(dom))
	for _, v := range dom {
		all = append(all, *v)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].Tx+all[i].Rx > all[j].Tx+all[j].Rx })
	if len(all) > 20 {
		all = all[:20]
	}
	res.TopDomain = all
	return res
}

// Cleanup 删除超过保留期的文件
func (s *Store) Cleanup(retentionDays int) int {
	if retentionDays <= 0 {
		return 0
	}
	cutoff := time.Now().AddDate(0, 0, -retentionDays)
	ents, err := os.ReadDir(s.dir)
	if err != nil {
		return 0
	}
	removed := 0
	for _, e := range ents {
		name := e.Name()
		if !strings.HasPrefix(name, "conn-") || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		day := strings.TrimSuffix(strings.TrimPrefix(name, "conn-"), ".jsonl")
		t, err := time.Parse("2006-01-02", day)
		if err != nil {
			continue
		}
		if t.Before(cutoff) {
			if os.Remove(filepath.Join(s.dir, name)) == nil {
				removed++
			}
		}
	}
	return removed
}

func humanBytes(v uint64) string {
	f := float64(v)
	units := []string{"B", "KB", "MB", "GB", "TB"}
	i := 0
	for f >= 1024 && i < len(units)-1 {
		f /= 1024
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%d B", v)
	}
	return fmt.Sprintf("%.2f %s", f, units[i])
}
