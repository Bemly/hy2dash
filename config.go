package main

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Config struct {
	Listen         string      `json:"listen"`
	BasePath       string      `json:"base_path"`
	PublicListen   string      `json:"public_listen"`
	PublicTLSListen string     `json:"public_tls_listen"`
	TLSCert        string      `json:"tls_cert"`
	TLSKey         string      `json:"tls_key"`
	PollMS         int         `json:"poll_ms"`
	RetentionDays  int         `json:"retention_days"`
	DataDir        string      `json:"data_dir"`
	AdminUser      string      `json:"admin_user"`
	PassSalt       string      `json:"pass_salt"`
	PassHash       string      `json:"pass_hash"`
	PassIter       int         `json:"pass_iter"`
	SessionKey     string      `json:"session_key"`
	HysteriaStats  string      `json:"hysteria_stats_url"`
	HysteriaSecret string      `json:"hysteria_stats_secret"`
	CreatedAt      string      `json:"created_at"`
	PassChangedAt  string      `json:"pass_changed_at"`
}

const (
	defaultIter = 150000
	saltLen     = 16
	keyLen      = 32
)

func randBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

func randHex(n int) string { return hex.EncodeToString(randBytes(n)) }

// 生成易读但不含歧义字符的随机密码
func randPassword(n int) string {
	const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := randBytes(n)
	out := make([]byte, n)
	for i, v := range b {
		out[i] = alphabet[int(v)%len(alphabet)]
	}
	return string(out)
}

func hashPassword(pw string, salt []byte, iter int) []byte {
	k, err := pbkdf2.Key(sha256.New, pw, salt, iter, keyLen)
	if err != nil {
		panic(err)
	}
	return k
}

func (c *Config) SetPassword(pw string) {
	salt := randBytes(saltLen)
	iter := c.PassIter
	if iter <= 0 {
		iter = defaultIter
	}
	c.PassSalt = base64.StdEncoding.EncodeToString(salt)
	c.PassHash = base64.StdEncoding.EncodeToString(hashPassword(pw, salt, iter))
	c.PassIter = iter
	c.PassChangedAt = time.Now().Format(time.RFC3339)
}

func (c *Config) CheckPassword(user, pw string) bool {
	if user != c.AdminUser {
		// 用户名也走一次比较，避免时序泄漏
		hmac.Equal([]byte(pw), []byte(pw))
		return false
	}
	salt, err1 := base64.StdEncoding.DecodeString(c.PassSalt)
	want, err2 := base64.StdEncoding.DecodeString(c.PassHash)
	if err1 != nil || err2 != nil {
		return false
	}
	iter := c.PassIter
	if iter <= 0 {
		iter = defaultIter
	}
	got := hashPassword(pw, salt, iter)
	return hmac.Equal(got, want)
}

func (c *Config) sessionKey() []byte {
	k, err := base64.StdEncoding.DecodeString(c.SessionKey)
	if err != nil || len(k) < 16 {
		k = randBytes(32)
		c.SessionKey = base64.StdEncoding.EncodeToString(k)
	}
	return k
}

// SignSession 生成无状态会话令牌：base64(payload).base64(hmac)
func (c *Config) SignSession(ttl time.Duration) string {
	exp := time.Now().Add(ttl).Unix()
	payload := fmt.Sprintf("%s|%d", c.AdminUser, exp)
	mac := hmac.New(sha256.New, c.sessionKey())
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." +
		base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (c *Config) VerifySession(tok string) bool {
	i := strings.LastIndex(tok, ".")
	if i <= 0 {
		return false
	}
	rawPayload, err := base64.RawURLEncoding.DecodeString(tok[:i])
	if err != nil {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(tok[i+1:])
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, c.sessionKey())
	mac.Write(rawPayload)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return false
	}
	parts := strings.SplitN(string(rawPayload), "|", 2)
	if len(parts) != 2 || parts[0] != c.AdminUser {
		return false
	}
	var exp int64
	if _, err := fmt.Sscanf(parts[1], "%d", &exp); err != nil {
		return false
	}
	return time.Now().Unix() < exp
}

// LoadConfig 读取配置；不存在则生成（并在首次运行时返回明文凭据）
func LoadConfig(path string) (cfg *Config, firstRun bool, genUser, genPass string, err error) {
	b, err := os.ReadFile(path)
	if err == nil {
		cfg = &Config{}
		if err := json.Unmarshal(b, cfg); err != nil {
			return nil, false, "", "", fmt.Errorf("配置解析失败: %w", err)
		}
		if cfg.PollMS <= 0 {
			cfg.PollMS = 1000
		}
		if cfg.RetentionDays <= 0 {
			cfg.RetentionDays = 90
		}
		if cfg.PassIter <= 0 {
			cfg.PassIter = defaultIter
		}
		if cfg.DataDir == "" {
			cfg.DataDir = filepath.Dir(path) + "/data"
		}
		return cfg, false, "", "", nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, false, "", "", err
	}

	// 首次运行：随机生成管理员用户名与密码
	genUser = "admin_" + randHex(3)
	genPass = randPassword(18)
	cfg = &Config{
		Listen:         "127.0.0.1:8787",
		BasePath:       "",
		PollMS:         1000,
		RetentionDays:  90,
		DataDir:        filepath.Dir(path) + "/data",
		AdminUser:      genUser,
		PassIter:       defaultIter,
		SessionKey:     base64.StdEncoding.EncodeToString(randBytes(32)),
		HysteriaStats:  "http://127.0.0.1:9999",
		HysteriaSecret: "",
		CreatedAt:      time.Now().Format(time.RFC3339),
	}
	cfg.SetPassword(genPass)
	if err := cfg.Save(path); err != nil {
		return nil, false, "", "", err
	}
	return cfg, true, genUser, genPass, nil
}

func (c *Config) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
