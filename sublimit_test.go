package main

// 订阅猜测限流测试。now 可注入；“点炒饭”= 同一瞬间连打，逐条断言放行/拦截数。

import (
	"testing"
	"time"
)

func newManualLimiter(start time.Time) (*subLimiter, *time.Time) {
	cur := start
	l := newSubLimiter()
	l.now = func() time.Time { return cur }
	return l, &cur
}

// 单 IP 错误 1 次/秒
func TestSubFast(t *testing.T) {
	l, cur := newManualLimiter(time.Now())
	if ok, _ := l.noteFail("192.0.2.11"); !ok {
		t.Fatalf("首次应放行")
	}
	if ok, r := l.noteFail("192.0.2.11"); ok || r != "fast" {
		t.Fatalf("500ms 内连打应 fast 拦截，got %v %q", ok, r)
	}
	*cur = cur.Add(1100 * time.Millisecond)
	if ok, _ := l.noteFail("192.0.2.11"); !ok {
		t.Fatalf("间隔 1.1s 后应放行")
	}
}

// 累计 100 次后指数退避
func TestSubBackoff(t *testing.T) {
	if backoffFor(99) != 0 || backoffFor(100) != time.Second || backoffFor(101) != 2*time.Second {
		t.Fatalf("退避阶梯错误")
	}
	if backoffFor(9999) != time.Hour {
		t.Fatalf("退避应封顶 1 小时")
	}
	l, cur := newManualLimiter(time.Now())
	for i := 0; i < 100; i++ {
		l.noteFail("192.0.2.22")
		*cur = cur.Add(1100 * time.Millisecond)
	}
	// 第 101 次（退避 1s 已过期、间隔 1.1s）：放行计数，同时立起 2s 封禁
	if ok, _ := l.noteFail("192.0.2.22"); !ok {
		t.Fatalf("第 101 次应放行计数")
	}
	b1 := l.perIP["192.0.2.22"].blockedUntil
	*cur = cur.Add(1100 * time.Millisecond)
	ok, r := l.noteFail("192.0.2.22")
	if ok {
		t.Fatalf("封禁期内应拦截")
	}
	if r != "backoff" {
		t.Fatalf("应为 backoff，got %q", r)
	}
	if !l.perIP["192.0.2.22"].blockedUntil.After(b1) {
		t.Fatalf("退避期内连打应延长封禁")
	}
	*cur = cur.Add(2 * time.Hour) // 退避过期 + 衰减
	if ok, _ := l.noteFail("192.0.2.22"); !ok {
		t.Fatalf("退避过期后应放行")
	}
}

// 全网 1s 内超 5 个 IP 来源一律 429（无退避）
func TestSubGlobal(t *testing.T) {
	l, cur := newManualLimiter(time.Now())
	for i := 0; i < 5; i++ {
		ip := string(rune('a'+i)) + ".0.0.1"
		if ok, _ := l.noteFail(ip); !ok {
			t.Fatalf("前 5 个 IP 应放行")
		}
	}
	if ok, r := l.noteFail("f.0.0.1"); ok || r != "global" {
		t.Fatalf("第 6 个 IP 应 global 拦截，got %v %q", ok, r)
	}
	*cur = cur.Add(1100 * time.Millisecond)
	if ok, _ := l.noteFail("f.0.0.1"); !ok {
		t.Fatalf("窗口滑过后应放行")
	}
}

// 点炒饭：同一瞬间 50 连打，只有第 1 次放行（计数），其余 fast 拦截
func TestSubBurst(t *testing.T) {
	l, _ := newManualLimiter(time.Now())
	allowed := 0
	for i := 0; i < 50; i++ {
		if ok, _ := l.noteFail("203.0.113.99"); ok {
			allowed++
		}
	}
	if allowed != 1 {
		t.Fatalf("50 连打应恰放行 1 次，got %d", allowed)
	}
}

// 消停 1 小时衰减清零
func TestSubDecay(t *testing.T) {
	l, cur := newManualLimiter(time.Now())
	for i := 0; i < 50; i++ {
		l.noteFail("198.51.100.33")
		*cur = cur.Add(1100 * time.Millisecond)
	}
	*cur = cur.Add(2 * time.Hour)
	if ok, _ := l.noteFail("198.51.100.33"); !ok {
		t.Fatalf("衰减后应放行")
	}
	if l.perIP["198.51.100.33"].fails != 1 {
		t.Fatalf("衰减后计数应从 1 起，got %d", l.perIP["198.51.100.33"].fails)
	}
}
