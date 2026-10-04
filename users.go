package main

// 多用户（机场 lite）：注册 / 登录共用一套 PBKDF2 凭据。
// 每个用户绑定一个预置的 hysteria 通道名（见 Config.Slots）与一条订阅 token。
// 通道口令是静态的（hysteria 配置里写死）：删除用户只吊销 token 链接，
// 要彻底吊销连接权需轮换该通道口令（两台 hysteria 配置 + 本文件 Slots，三处同改并重启）。

import (
	"crypto/hmac"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

type User struct {
	Name      string `json:"name"`
	PassSalt  string `json:"pass_salt"`
	PassHash  string `json:"pass_hash"`
	PassIter  int    `json:"pass_iter"`
	HyUser    string `json:"hy_user"` // hysteria 侧用户名（u01..）
	Token     string `json:"token"`   // 订阅链接凭证
	Enabled   bool   `json:"enabled"`
	CreatedAt string `json:"created_at"`
}

type UserStore struct {
	path string
	mu   sync.Mutex
	byID map[string]*User // name -> user
	byT  map[string]*User // token -> user
}

var validUserName = regexp.MustCompile(`^[a-z0-9_-]{3,20}$`)

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

func (s *UserStore) Register(name, pass string, slots []Slot, iter int) (*User, string, error) {
	if !validUserName.MatchString(name) {
		return nil, "", errors.New("用户名仅允许小写字母/数字/_/-，3~20 位")
	}
	if len(pass) < 8 {
		return nil, "", errors.New("密码至少 8 位")
	}
	if iter <= 0 {
		iter = defaultIter
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.byID[name]; ok {
		return nil, "", errors.New("用户名已存在")
	}
	hy := s.freeSlot(slots)
	if hy == "" {
		return nil, "", errors.New("名额已满，请联系管理员加通道")
	}
	salt := randBytes(saltLen)
	u := &User{
		Name:      name,
		PassSalt:  base64.StdEncoding.EncodeToString(salt),
		PassHash:  base64.StdEncoding.EncodeToString(hashPassword(pass, salt, iter)),
		PassIter:  iter,
		HyUser:    hy,
		Token:     randToken(16),
		Enabled:   true,
		CreatedAt: time.Now().Format(time.RFC3339),
	}
	s.byID[name] = u
	s.byT[u.Token] = u
	if err := s.save(); err != nil {
		delete(s.byID, name)
		delete(s.byT, u.Token)
		return nil, "", err
	}
	return u, hy, nil
}

func (s *UserStore) checkLocked(u *User, pass string) bool {
	salt, err1 := base64.StdEncoding.DecodeString(u.PassSalt)
	want, err2 := base64.StdEncoding.DecodeString(u.PassHash)
	if err1 != nil || err2 != nil {
		return false
	}
	iter := u.PassIter
	if iter <= 0 {
		iter = defaultIter
	}
	return hmac.Equal(hashPassword(pass, salt, iter), want)
}

func (s *UserStore) Auth(name, pass string) *User {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.byID[name]
	if !ok || !u.Enabled {
		return nil
	}
	if !s.checkLocked(u, pass) {
		return nil
	}
	return u
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
		c.PassSalt, c.PassHash = "***", "***"
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

func (s *UserStore) SetPassword(name, pass string) error {
	if len(pass) < 8 {
		return errors.New("新密码至少 8 位")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.byID[name]
	if !ok {
		return errors.New("no such user")
	}
	salt := randBytes(saltLen)
	iter := u.PassIter
	if iter <= 0 {
		iter = defaultIter
	}
	u.PassSalt = base64.StdEncoding.EncodeToString(salt)
	u.PassHash = base64.StdEncoding.EncodeToString(hashPassword(pass, salt, iter))
	return s.save()
}
