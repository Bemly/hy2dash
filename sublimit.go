package main

// 订阅猜测限流：单 IP 错误 1 次/秒；累计 100 次后指数退避
// （2^(n-100) 秒，上限 1 小时）；全网 1 秒窗口内失败超 5 个 IP 来源
// 则多余的一律 429（无退避）。
// 只在 token 未命中时计数；命中（哪怕配额锁 403）不计数。
// now 可注入，专供测试（含点炒饭式连打）。

import (
	"sync"
	"time"
)

type subIPState struct {
	last         time.Time
	fails        int
	blockedUntil time.Time
}

type subLimiter struct {
	mu     sync.Mutex
	now    func() time.Time
	perIP  map[string]*subIPState
	recent []time.Time // 全网失败时间戳（1s 滑动窗口）
}

func newSubLimiter() *subLimiter {
	return &subLimiter{now: time.Now, perIP: map[string]*subIPState{}}
}

// backoffFor 累计 fails 次失败后的退避时长（<100 时为 0）
func backoffFor(fails int) time.Duration {
	k := fails - 100
	if k < 0 {
		return 0
	}
	if k > 12 {
		k = 12
	}
	d := time.Duration(1<<uint(k)) * time.Second
	if d > time.Hour {
		d = time.Hour
	}
	return d
}

// noteFail 该 IP 一次未命中：true=计数并允许返回 404，false=限流返回 429
func (l *subLimiter) noteFail(ip string) (bool, string) {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	// 全网 1s 窗口
	cut := now.Add(-time.Second)
	kept := l.recent[:0]
	for _, t := range l.recent {
		if t.After(cut) {
			kept = append(kept, t)
		}
	}
	l.recent = kept
	if len(l.recent) >= 5 {
		l.recent = append(l.recent, now)
		if len(l.recent) > 64 {
			l.recent = l.recent[len(l.recent)-64:]
		}
		return false, "global"
	}
	st, ok := l.perIP[ip]
	if !ok {
		st = &subIPState{}
		l.perIP[ip] = st
	}
	if now.Sub(st.last) > time.Hour {
		st.fails = 0 // 衰减：消停 1 小时清零
	}
	if now.Before(st.blockedUntil) {
		st.last = now
		st.fails++
		// 退避期内还打：延长封禁（指数增长，专治点炒饭）
		if d := backoffFor(st.fails); now.Add(d).After(st.blockedUntil) {
			st.blockedUntil = now.Add(d)
		}
		l.recent = append(l.recent, now)
		return false, "backoff"
	}
	if !st.last.IsZero() && now.Sub(st.last) < time.Second {
		st.last = now
		st.fails++
		if st.fails >= 100 {
			st.blockedUntil = now.Add(backoffFor(st.fails))
		}
		l.recent = append(l.recent, now)
		return false, "fast"
	}
	st.last = now
	st.fails++
	if st.fails >= 100 {
		st.blockedUntil = now.Add(backoffFor(st.fails))
	}
	l.recent = append(l.recent, now)
	if len(l.recent) > 64 {
		l.recent = l.recent[len(l.recent)-64:]
	}
	if len(l.perIP) > 4096 { // 防内存膨胀：清最旧一半
		oldest := now
		for _, s := range l.perIP {
			if s.last.Before(oldest) {
				oldest = s.last
			}
		}
		for ip, s := range l.perIP {
			if len(l.perIP) <= 2048 {
				break
			}
			if !s.last.After(oldest.Add(time.Minute)) {
				delete(l.perIP, ip)
			}
		}
	}
	return true, ""
}
