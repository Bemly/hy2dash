package main

// 配额与踢人逻辑的永久测试：改配额/续额/踢人必须全绿才算完工。
// （UserStore 落盘路径一律用 t.TempDir，避免污染仓库。）

import (
	"path/filepath"
	"testing"
	"time"
)

const testGB = uint64(1024 * 1024 * 1024)

func mkTestUser(grantedGB, dayUsedGB, monOtherGB float64) *User {
	today := todayKey()
	u := &User{
		Name:     "test_steam",
		HyUser:   "u01",
		Enabled:  true,
		Buckets:  map[string]DayUse{},
		Granted:  uint64(grantedGB * float64(testGB)),
		GrantDay: today,
	}
	u.Buckets[today] = DayUse{Rx: uint64(dayUsedGB * float64(testGB))}
	y := time.Now().AddDate(0, 0, -1).Format("2006-01-02")
	u.Buckets[y] = DayUse{Rx: uint64(monOtherGB * float64(testGB))}
	return u
}

func mkTestStore(t *testing.T) *UserStore {
	t.Helper()
	return &UserStore{
		path: filepath.Join(t.TempDir(), "users.json"),
		byID: map[string]*User{},
		byT:  map[string]*User{},
	}
}

// 没用完不能续
func TestRenewRejectsWhenDailyRemains(t *testing.T) {
	s := mkTestStore(t)
	s.byID["a"] = mkTestUser(10, 1, 0)
	before := s.byID["a"].Granted
	if _, err := s.Renew("a"); err != errDailyLeft {
		t.Fatalf("没用完应拒续，got %v", err)
	}
	if s.byID["a"].Granted != before {
		t.Fatalf("拒续不应动授额")
	}
}

// 用完可续一份
func TestRenewAddsChunkWhenUsedUp(t *testing.T) {
	s := mkTestStore(t)
	s.byID["b"] = mkTestUser(10, 10, 0)
	got, err := s.Renew("b")
	if err != nil {
		t.Fatalf("用完应可续，got %v", err)
	}
	if got != 10*testGB || s.byID["b"].Granted != 20*testGB {
		t.Fatalf("应 +10G，got granted=%d", s.byID["b"].Granted)
	}
}

// 连点刷不大：顶到月封顶必须停，授额永不超月配额
func TestRenewCapsAtMonthly(t *testing.T) {
	s := mkTestStore(t)
	s.byID["c"] = mkTestUser(10, 10, 0)
	u := s.byID["c"]
	today := todayKey()
	n := 0
	for {
		u.Buckets[today] = DayUse{Rx: u.Granted} // 每轮先花光
		if _, err := s.Renew("c"); err != nil {
			break
		}
		n++
		if n > 30 {
			t.Fatalf("续额停不下来，已续 %d 次", n)
		}
		if u.Granted > u.monthlyQuota() {
			t.Fatalf("授额超出月配额")
		}
	}
	if n != 9 {
		t.Fatalf("默认配额应恰续 9 次到 100G，got %d", n)
	}
	if u.Granted != 100*testGB {
		t.Fatalf("应顶到 100G，got %d", u.Granted)
	}
}

// 月满直接拒（即使当天没用完也先判月满）
func TestRenewRejectsWhenMonthlyFull(t *testing.T) {
	s := mkTestStore(t)
	s.byID["d"] = mkTestUser(10, 0, 100)
	if _, err := s.Renew("d"); err != errMonthlyFull {
		t.Fatalf("月满应拒续，got %v", err)
	}
}

func TestMaxToday(t *testing.T) {
	now := time.Now()
	today := todayKey()
	u := mkTestUser(10, 1, 0.5) // 非今日用了 0.5G
	if got := u.maxToday(today, now); got != 100*testGB-uint64(0.5*float64(testGB)) {
		t.Fatalf("maxToday 应为月配额-非今日用量，got %d", got)
	}
	full := mkTestUser(10, 0, 100) // 非今日已花光月配额
	if got := full.maxToday(today, now); got != 0 {
		t.Fatalf("月余为 0 时 maxToday 应为 0，got %d", got)
	}
}

func TestQuotaStateTransitions(t *testing.T) {
	now := time.Now()
	today := todayKey()
	if st := mkTestUser(10, 1, 0).quotaState(today, now); st != "ok" {
		t.Fatalf("有余量应 ok，got %s", st)
	}
	if st := mkTestUser(10, 10, 0).quotaState(today, now); st != "daily" {
		t.Fatalf("用完当天应 daily，got %s", st)
	}
	if st := mkTestUser(10, 0, 100).quotaState(today, now); st != "monthly" {
		t.Fatalf("月满应 monthly，got %s", st)
	}
}

func TestEnsureDayResetsGrant(t *testing.T) {
	u := mkTestUser(50, 50, 0)
	y := time.Now().AddDate(0, 0, -1).Format("2006-01-02")
	u.GrantDay = y
	if !u.ensureDay(todayKey()) {
		t.Fatalf("跨天应重置")
	}
	if u.Granted != 10*testGB {
		t.Fatalf("重置后应为首份 10G，got %d", u.Granted)
	}
	if u.ensureDay(todayKey()) {
		t.Fatalf("同日不应重复重置")
	}
}

func TestQuotaStateOf(t *testing.T) {
	s := mkTestStore(t)
	now := time.Now()
	today := todayKey()
	s.byID["ok1"] = mkTestUser(10, 1, 0)
	s.byID["ok1"].HyUser = "u01"
	off := mkTestUser(10, 1, 0)
	off.HyUser = "u02"
	off.Enabled = false
	s.byID["off1"] = off
	over := mkTestUser(10, 10, 0)
	over.HyUser = "u03"
	s.byID["over1"] = over

	if st, ok := s.QuotaStateOf("u01", today, now); !ok || st != "ok" {
		t.Fatalf("有额度应 (ok,true)，got (%s,%v)", st, ok)
	}
	if st, ok := s.QuotaStateOf("u02", today, now); !ok || st != "disabled" {
		t.Fatalf("停用应 (disabled,true)，got (%s,%v)", st, ok)
	}
	if st, ok := s.QuotaStateOf("u03", today, now); !ok || st != "daily" {
		t.Fatalf("超限应 (daily,true)，got (%s,%v)", st, ok)
	}
	if _, ok := s.QuotaStateOf("u99", today, now); ok {
		t.Fatalf("未知用户应 ok=false")
	}
}

func TestKickThrottle(t *testing.T) {
	k := newKickThrottle(10 * time.Second)
	t0 := time.Now()
	if !k.allow("u01", t0) {
		t.Fatalf("首次应放行")
	}
	if k.allow("u01", t0.Add(5*time.Second)) {
		t.Fatalf("冷却内应拦截")
	}
	if !k.allow("u02", t0.Add(5*time.Second)) {
		t.Fatalf("不同用户应互不影响")
	}
	if !k.allow("u01", t0.Add(11*time.Second)) {
		t.Fatalf("冷却过后应放行")
	}
}
