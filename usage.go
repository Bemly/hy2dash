package main

// 用量记账与配额：默认 10GB/天、100GB/月（可按人覆盖）。
// 每天首个 10G 自动到账；用完点「续额」再加 10G，直到月封顶。
// 记账不依赖 hysteria 计数器不重置：采样器按 tick 差分累加进按天桶，
// 计数器归零（hysteria 重启）时按归零后值计，不会算出负数。

import (
	"time"
)

const (
	defaultDailyGB   = 10.0
	defaultMonthlyGB = 100.0
	sampleEvery      = 10 * time.Minute
	bucketKeepDays   = 35
)

type DayUse struct {
	Tx uint64 `json:"tx"`
	Rx uint64 `json:"rx"`
}

func gb(b uint64) float64 { return float64(b) / 1024 / 1024 / 1024 }

func (u *User) dailyQuota() uint64 {
	g := u.DailyGB
	if g <= 0 {
		g = defaultDailyGB
	}
	return uint64(g * 1024 * 1024 * 1024)
}

func (u *User) monthlyQuota() uint64 {
	g := u.MonthlyGB
	if g <= 0 {
		g = defaultMonthlyGB
	}
	return uint64(g * 1024 * 1024 * 1024)
}

func todayKey() string { return time.Now().Format("2006-01-02") }

// ensureDay 跨天时重置当天已授额度（首个 dailyQuota 自动到账），返回是否发生了重置
func (u *User) ensureDay(today string) bool {
	if u.GrantDay != today {
		u.GrantDay = today
		u.Granted = u.dailyQuota()
		return true
	}
	return false
}

func (u *User) dayUsed(today string) uint64 {
	b := u.Buckets[today]
	return b.Tx + b.Rx
}

// monthUsed 最近 30 天（含今天）累计
func (u *User) monthUsed(now time.Time) uint64 {
	var sum uint64
	for i := 0; i < 30; i++ {
		b := u.Buckets[now.AddDate(0, 0, -i).Format("2006-01-02")]
		sum += b.Tx + b.Rx
	}
	return sum
}

func (u *User) monthUpDown(now time.Time) (uint64, uint64) {
	var tx, rx uint64
	for i := 0; i < 30; i++ {
		b := u.Buckets[now.AddDate(0, 0, -i).Format("2006-01-02")]
		tx += b.Tx
		rx += b.Rx
	}
	return tx, rx
}

// quotaState: monthly = 月封顶硬锁；daily = 当天额度用完待续；ok = 正常
func (u *User) quotaState(today string, now time.Time) string {
	if u.monthUsed(now) >= u.monthlyQuota() {
		return "monthly"
	}
	if u.dayUsed(today) >= u.Granted {
		return "daily"
	}
	return "ok"
}

func pruneBuckets(u *User, now time.Time) {
	cut := now.AddDate(0, 0, -bucketKeepDays).Format("2006-01-02")
	for day := range u.Buckets {
		if day < cut {
			delete(u.Buckets, day)
		}
	}
}

// runUsageSampler 每 sampleEvery 把各用户计数器差分记进当天桶；
// 启动时先跑一轮（补跨天授额 + 基线），之后按 tick 跑。
func runUsageSampler(users *UserStore, col *Collector) {
	prev := map[string]trafficEntry{}
	doSample := func() {
		live := col.UserTotals()
		users.mu.Lock()
		today := todayKey()
		now := time.Now()
		changed := false
		for _, u := range users.byID {
			if u.ensureDay(today) {
				changed = true
			}
			e := live[u.HyUser]
			if p, ok := prev[u.HyUser]; ok {
				var dx, dr uint64
				if e.Tx >= p.Tx {
					dx = e.Tx - p.Tx
				} else {
					dx = e.Tx // 计数器重置，从 0 起计
				}
				if e.Rx >= p.Rx {
					dr = e.Rx - p.Rx
				} else {
					dr = e.Rx
				}
				if dx+dr > 0 {
					if u.Buckets == nil {
						u.Buckets = map[string]DayUse{}
					}
					b := u.Buckets[today]
					b.Tx += dx
					b.Rx += dr
					u.Buckets[today] = b
					changed = true
				}
			}
			prev[u.HyUser] = e
			pruneBuckets(u, now)
		}
		if changed {
			users.save()
		}
		users.mu.Unlock()
	}
	doSample()
	t := time.NewTicker(sampleEvery)
	defer t.Stop()
	for range t.C {
		doSample()
	}
}

// Renew 续额：再加一份 dailyQuota；月满拒绝
func (s *UserStore) Renew(name string) (uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.byID[name]
	if !ok || !u.Enabled {
		return 0, errNoUser
	}
	now := time.Now()
	today := todayKey()
	u.ensureDay(today)
	if u.monthUsed(now) >= u.monthlyQuota() {
		return 0, errMonthlyFull
	}
	u.Granted += u.dailyQuota()
	if err := s.save(); err != nil {
		return 0, err
	}
	return u.dailyQuota(), nil
}

// SetQuota 管理员改某人配额（GB；<=0 表示恢复默认）
func (s *UserStore) SetQuota(name string, dailyGB, monthlyGB float64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.byID[name]
	if !ok {
		return errNoUser
	}
	if dailyGB < 0 || monthlyGB < 0 || dailyGB > 10000 || monthlyGB > 100000 {
		return errBadQuota
	}
	u.DailyGB = dailyGB
	u.MonthlyGB = monthlyGB
	return s.save()
}

var (
	errNoUser     = strErr("no such user")
	errMonthlyFull = strErr("本月限额已用完")
	errBadQuota   = strErr("配额数值非法")
)

type strErr string

func (e strErr) Error() string { return string(e) }
