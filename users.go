package main

// 多用户（机场 lite）：唯一入口是 Steam 登录，Name 即 SteamID64。
// 首次登录自动注册（认领空闲通道）；昵称/头像取自公开资料，仅展示用。
// 通道口令静态（见 Config.Slots）：删除用户只吊销 token，要彻底吊销连接权
// 需轮换该通道口令（两台 hysteria 配置 + hydash 配置，三处同改并重启）。

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
	HyUser    string `json:"hy_user"` // hysteria 侧用户名（u01..）
	Token     string `json:"token"`   // 订阅链接凭证
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
}

func randToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
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
		Token:     randToken(16),
		Enabled:   true,
		CreatedAt: time.Now().Format(time.RFC3339),
	}
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
	delete(s.byT, u.Token)
	u.Token = randToken(16)
	s.byT[u.Token] = u
	if err := s.save(); err != nil {
		return "", err
	}
	return u.Token, nil
}
