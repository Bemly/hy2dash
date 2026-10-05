package main

// 用量记账与配额：默认 10GB/天、100GB/月（可按人覆盖）。
// 每天首个 10G 自动到账；用完点「续额」再加 10G，直到月封顶。
// 记账不依赖 hysteria 计数器不重置：采样器按 tick 差分累加进按天桶，
// 计数器归零（hysteria 重启）时按归零后值计，不会算出负数。

import (
	"log"
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

// runKickWatchdog 每分钟把超限用户踢下线（所有上游）。
// kick 只断现有会话：续额/解禁后自动停止踢，用户重连即恢复，无需重启 hysteria。
func runKickWatchdog(users *UserStore, cfg *Config) {
	kicked := map[string]bool{}
	lastLog := map[string]time.Time{}
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for range t.C {
		now := time.Now()
		today := todayKey()
		users.mu.Lock()
		for _, u := range users.byID {
			if !u.Enabled {
				if kicked[u.HyUser] {
					kicked[u.HyUser] = false
				}
				continue
			}
			blocked := u.quotaState(today, now) != "ok"
			if blocked && !kicked[u.HyUser] {
				log.Printf("kick %s(%s): 配额超限，断开其全部会话", u.Name, u.HyUser)
				lastLog[u.HyUser] = now
			} else if blocked && now.Sub(lastLog[u.HyUser]) >= 10*time.Minute {
				// 重复踢节流留痕，避免静默
				log.Printf("kick %s(%s): 仍超限，继续踢", u.Name, u.HyUser)
				lastLog[u.HyUser] = now
			}
			if !blocked && kicked[u.HyUser] {
				log.Printf("unkick %s(%s): 配额恢复，停止踢出", u.Name, u.HyUser)
			}
			kicked[u.HyUser] = blocked
			if blocked {
				go kickEverywhere(cfg.HysteriaNodes, u.HyUser)
			}
		}
		users.mu.Unlock()
	}
}

// maxToday 当日最多能授到多少：月配额 − 非今日用量（当月已花的不再重授）。
// Granted 永远不得超过它，当日连点刷额与超月配额授额都被挡下。
func (u *User) maxToday(today string, now time.Time) uint64 {
	mq := u.monthlyQuota()
	other := u.monthUsed(now) - u.dayUsed(today)
	if other >= mq {
		return 0
	}
	return mq - other
}

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
	// 用完才能续：当天授额还没花完就拒绝
	if u.dayUsed(today) < u.Granted {
		return 0, errDailyLeft
	}
	chunk := u.dailyQuota()
	maxT := u.maxToday(today, now)
	if u.Granted >= maxT {
		return 0, errMonthlyFull
	}
	if u.Granted+chunk > maxT {
		return 0, errMonthlyFull // 凑不够一整份，视为到月封顶
	}
	u.Granted += chunk
	if err := s.save(); err != nil {
		return 0, err
	}
	return u.dailyQuota(), nil
}

// QuotaStateOf 按 hysteria 用户名查配额状态（快速踢人用）：
// 未知 hy_user 返回 ok=false（不动）；停用返回 "disabled"（照踢）；其余返回 quotaState。
func (s *UserStore) QuotaStateOf(hyUser, today string, now time.Time) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, u := range s.byID {
		if u.HyUser != hyUser {
			continue
		}
		if !u.Enabled {
			return "disabled", true
		}
		return u.quotaState(today, now), true
	}
	return "", false
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
	errNoUser      = strErr("no such user")
	errMonthlyFull = strErr("本月限额已用完")
	errDailyLeft   = strErr("今日额度还没用完，用完再续")
	errBadQuota    = strErr("配额数值非法")
	errRotateSoon  = strErr("换链太频繁，1 小时只能换 1 次")
)

type strErr string

func (e strErr) Error() string { return string(e) }
