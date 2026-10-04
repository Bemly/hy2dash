package main

// Steam 登录（Sign in through Steam，本质 OpenID 2.0）：用户侧唯一入口。
// 首次登录自动注册（认领空闲通道）。管理端不受影响，仍走独立密码。
//
// 流程：/api/steam/login 置一次性 state cookie → 302 到 Steam → 回
// /api/steam/callback → 服务端拿全部 openid.* 参数回 Steam 做
// check_authentication → 验 claimed_id 提取 SteamID64 → 找或建用户。

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/xml"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const steamOpenID = "https://steamcommunity.com/openid/login"

var steamIDRe = regexp.MustCompile(`^https?://steamcommunity\.com/openid/id/([0-9]+)$`)

// baseURL 推导浏览器侧的真实地址（CF Flexible 下看 X-Forwarded-Proto）
func baseURL(r *http.Request, base string) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if xfp := r.Header.Get("X-Forwarded-Proto"); xfp != "" {
		if i := strings.IndexByte(xfp, ','); i > 0 {
			xfp = xfp[:i]
		}
		xfp = strings.TrimSpace(strings.ToLower(xfp))
		if xfp == "https" || xfp == "http" {
			scheme = xfp
		}
	}
	host := r.Host
	if h := strings.TrimSuffix(host, ":80"); scheme == "https" && strings.HasSuffix(host, ":80") {
		host = h
	}
	return scheme + "://" + host + base
}

func steamState() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// steamLoginURL 拼 Steam 跳转地址
func steamLoginURL(r *http.Request, base string) string {
	self := baseURL(r, base)
	q := url.Values{}
	q.Set("openid.ns", "http://specs.openid.net/auth/2.0")
	q.Set("openid.mode", "checkid_setup")
	q.Set("openid.return_to", self+"/api/steam/callback")
	q.Set("openid.realm", self+"/")
	q.Set("openid.identity", "http://specs.openid.net/auth/2.0/identifier_select")
	q.Set("openid.claimed_id", "http://specs.openid.net/auth/2.0/identifier_select")
	return steamOpenID + "?" + q.Encode()
}

// steamVerify 拿回调参数回 Steam 验签名，返回 SteamID64
func steamVerify(v url.Values) (string, bool) {
	m := reRegValues(v)
	m.Set("openid.mode", "check_authentication")
	resp, err := http.PostForm(steamOpenID, m)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return "", false
	}
	ok := false
	for _, line := range strings.Split(string(b), "\n") {
		if k, val, found := strings.Cut(strings.TrimSpace(line), ":"); found {
			if k == "is_valid" && val == "true" {
				ok = true
			}
		}
	}
	if !ok {
		return "", false
	}
	mt := steamIDRe.FindStringSubmatch(v.Get("openid.claimed_id"))
	if mt == nil {
		return "", false
	}
	return mt[1], true
}

func reRegValues(v url.Values) url.Values {
	m := url.Values{}
	for k, vs := range v {
		for _, x := range vs {
			m.Add(k, x)
		}
	}
	return m
}

type steamProfile struct {
	Persona string `xml:"steamID"`
	Avatar  string `xml:"avatarMedium"`
}

// steamPersona 取昵称与头像（公开资料，无需 key；失败不阻塞登录）
func steamPersona(id string) (nick, avatar string) {
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Get("https://steamcommunity.com/profiles/" + id + "/?xml=1")
	if err != nil {
		return "", ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", ""
	}
	var p steamProfile
	if err := xml.NewDecoder(io.LimitReader(resp.Body, 256<<10)).Decode(&p); err != nil {
		return "", ""
	}
	return strings.TrimSpace(p.Persona), strings.TrimSpace(p.Avatar)
}
