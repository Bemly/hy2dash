package main

// 多用户（机场 lite）：唯一入口是 Steam 登录，Name 即 SteamID64。
// 首次登录自动注册（认领空闲通道）；昵称/头像取自公开资料，仅展示用。
// 通道口令静态（见 Config.Slots）：删除用户只吊销 token，要彻底吊销连接权
// 需轮换该通道口令（两台 hysteria 配置 + hy2dash 配置，三处同改并重启）。

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type User struct {
	Name      string `json:"name"` // SteamID64
	Nick      string `json:"nick,omitempty"`
	Avatar    string `json:"avatar,omitempty"`
	HyUser    string `json:"hy_user"`            // hysteria 侧用户名（u01..）
	UUID      string `json:"uuid,omitempty"`     // REALITY (VLESS/TCP) 侧身份，首次出现自动分配
	Token     string `json:"token"`              // 订阅链接凭证（3 词直连；老用户 32 位 hex 继续有效）
	TokenAt   string `json:"token_at,omitempty"` // 上次换链时间（1 小时只能换 1 次）
	Enabled   bool   `json:"enabled"`
	CreatedAt string `json:"created_at"`
	// 配额与记账（见 usage.go）
	Buckets   map[string]DayUse `json:"buckets,omitempty"`
	GrantDay  string            `json:"grant_day,omitempty"`
	Granted   uint64            `json:"granted,omitempty"`
	DailyGB   float64           `json:"daily_gb,omitempty"`
	MonthlyGB float64           `json:"monthly_gb,omitempty"`
}

type UserStore struct {
	path string
	mu   sync.Mutex
	byID map[string]*User // steamID -> user
	byT  map[string]*User // token -> user
	// 订阅词表（启动时 SetWords 注入，不落盘）
	words   []string
	wordSet map[string]bool
}

// SetWords 注入订阅词表（words.go loadWords 结果）
func (s *UserStore) SetWords(words []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.words = words
	s.wordSet = map[string]bool{}
	for _, w := range words {
		s.wordSet[w] = true
	}
}

// genToken 生成订阅 token：3 词直连（可重复、有序），撞库重试；词表缺失时回退 hex
func (s *UserStore) genToken() (string, error) {
	if len(s.words) >= 3 {
		for i := 0; i < 32; i++ {
			t := genPhrase(s.words)
			if reservedSub[t] {
				continue
			}
			if _, dup := s.byT[t]; !dup {
				return t, nil
			}
		}
		return "", errors.New("词组池耗尽，请稍后再试")
	}
	return randToken(16), nil
}

func randToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// randUUID 生成 UUIDv4（REALITY 每人一个，与 hysteria 通道相互独立）
func randUUID() string {
	b := randBytes(16)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func NewUserStore(path string) (*UserStore, error) {
	s := &UserStore{path: path, byID: map[string]*User{}, byT: map[string]*User{}}
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return s, nil
		}
		return nil, err
	}
	var list []User
	if err := json.Unmarshal(b, &list); err != nil {
		return nil, err
	}
	for i := range list {
		u := list[i]
		if u.Name == "" || u.Token == "" {
			continue
		}
		uc := u
		s.byID[u.Name] = &uc
		s.byT[u.Token] = &uc
	}
	// 存量用户回填 UUID（新字段兼容老数据）
	needSave := false
	for _, u := range s.byID {
		if u.UUID == "" {
			u.UUID = randUUID()
			needSave = true
		}
	}
	if needSave {
		if err := s.save(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func (s *UserStore) save() error {
	list := make([]User, 0, len(s.byID))
	for _, u := range s.byID {
		list = append(list, *u)
	}
	b, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// freeSlot 返回第一个未被占用的通道名
func (s *UserStore) freeSlot(slots []Slot) string {
	used := map[string]bool{}
	for _, u := range s.byID {
		used[u.HyUser] = true
	}
	for _, sl := range slots {
		if !used[sl.User] {
			return sl.User
		}
	}
	return ""
}

// FindOrCreate 按 SteamID 找人，没有则注册（认领通道 + 发 token）
func (s *UserStore) FindOrCreate(steamID, nick, avatar string, slots []Slot) (*User, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if u, ok := s.byID[steamID]; ok {
		changed := false
		if nick != "" && u.Nick != nick {
			u.Nick = nick
			changed = true
		}
		if avatar != "" && u.Avatar != avatar {
			u.Avatar = avatar
			changed = true
		}
		if u.UUID == "" {
			u.UUID = randUUID()
			changed = true
		}
		if changed {
			if err := s.save(); err != nil {
				return nil, false, err
			}
		}
		return u, false, nil
	}
	hy := s.freeSlot(slots)
	if hy == "" {
		return nil, false, errors.New("名额已满，请联系管理员加通道")
	}
	u := &User{
		Name:      steamID,
		Nick:      nick,
		Avatar:    avatar,
		HyUser:    hy,
		UUID:      randUUID(),
		Enabled:   true,
		CreatedAt: time.Now().Format(time.RFC3339),
		TokenAt:   time.Now().Format(time.RFC3339),
	}
	tok, err := s.genToken()
	if err != nil {
		return nil, false, err
	}
	u.Token = tok
	u.GrantDay = todayKey()
	u.Granted = u.dailyQuota() // 首日额度注册即到账
	s.byID[steamID] = u
	s.byT[u.Token] = u
	if err := s.save(); err != nil {
		delete(s.byID, steamID)
		delete(s.byT, u.Token)
		return nil, false, err
	}
	return u, true, nil
}

func (s *UserStore) ByToken(tok string) *User {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.byT[tok]
	if !ok || !u.Enabled {
		return nil
	}
	return u
}

func (s *UserStore) List() []User {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]User, 0, len(s.byID))
	for _, u := range s.byID {
		c := *u
		c.Token = "" // token 只属于用户本人，列表不下发
		out = append(out, c)
	}
	return out
}

func (s *UserStore) SetEnabled(name string, on bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.byID[name]
	if !ok {
		return errors.New("no such user")
	}
	u.Enabled = on
	return s.save()
}

func (s *UserStore) Delete(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.byID[name]
	if !ok {
		return errors.New("no such user")
	}
	delete(s.byID, name)
	delete(s.byT, u.Token)
	return s.save()
}

func (s *UserStore) RotateToken(name string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.byID[name]
	if !ok {
		return "", errors.New("no such user")
	}
	tok, err := s.genToken()
	if err != nil {
		return "", err
	}
	delete(s.byT, u.Token)
	u.Token = tok
	u.TokenAt = time.Now().Format(time.RFC3339)
	s.byT[u.Token] = u
	if err := s.save(); err != nil {
		return "", err
	}
	return u.Token, nil
}

// RotateMyToken 用户自助换链：1 小时只能换 1 次（防点炒饭刷爆）
func (s *UserStore) RotateMyToken(name string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.byID[name]
	if !ok || !u.Enabled {
		return "", errNoUser
	}
	if u.TokenAt != "" {
		if t, err := time.Parse(time.RFC3339, u.TokenAt); err == nil && time.Since(t) < time.Hour {
			return "", errRotateSoon
		}
	}
	tok, err := s.genToken()
	if err != nil {
		return "", err
	}
	delete(s.byT, u.Token)
	u.Token = tok
	u.TokenAt = time.Now().Format(time.RFC3339)
	s.byT[u.Token] = u
	if err := s.save(); err != nil {
		return "", err
	}
	return u.Token, nil
}
