package main

// Steam 登录（Sign in through Steam，本质 OpenID 2.0）：用户侧唯一入口。
// 首次登录自动注册（认领空闲通道）。管理端不受影响，仍走独立密码。
//
// 流程：/api/steam/login 置一次性 state cookie → 302 到 Steam → 回
// /api/steam/callback → 服务端拿全部 openid.* 参数回 Steam 做
// check_authentication → 验 claimed_id 提取 SteamID64 → 找或建用户。

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/xml"
	"html"
	"io"
	"net"
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

// steamLoginURL 拼 Steam 跳转地址。state 放进 return_to：Steam 会对 return_to 签名并
// 原样带回，回调时与 cookie 比对，把这次断言绑定到发起登录的浏览器（防登录 CSRF）。
func steamLoginURL(r *http.Request, base, state string) string {
	self := baseURL(r, base)
	q := url.Values{}
	q.Set("openid.ns", "http://specs.openid.net/auth/2.0")
	q.Set("openid.mode", "checkid_setup")
	q.Set("openid.return_to", self+"/api/steam/callback?state="+url.QueryEscape(state))
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

// steamStateOK 校验回调属于本浏览器发起的那次登录：
// 回调参数里的 state、Steam 签过名的 return_to 里的 state，都必须等于 cookie；
// return_to 还必须指向本站的回调地址（别处签发的断言不能拿来这里用）。
func steamStateOK(r *http.Request, base, cookie string) bool {
	if len(cookie) < 16 {
		return false
	}
	eq := func(a string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(cookie)) == 1 }
	q := r.URL.Query()
	if !eq(q.Get("state")) {
		return false
	}
	rt, err := url.Parse(q.Get("openid.return_to"))
	if err != nil || rt.Path != base+"/api/steam/callback" || !eq(rt.Query().Get("state")) {
		return false
	}
	return strings.EqualFold(rt.Hostname(), hostOnly(r.Host))
}

func hostOnly(hostport string) string {
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		return h
	}
	return strings.Trim(hostport, "[]")
}

// reRegValues 只回传 openid.* 参数（state 等自有参数不属于断言）
func reRegValues(v url.Values) url.Values {
	m := url.Values{}
	for k, vs := range v {
		if !strings.HasPrefix(k, "openid.") {
			continue
		}
		for _, x := range vs {
			m.Add(k, x)
		}
	}
	return m
}

type steamProfile struct {
	Persona string `xml:"steamID"`
	Avatar  string `xml:"avatarMedium"`
	Online  string `xml:"onlineState"` // online | offline | in-game
	Privacy string `xml:"privacyState"`
	Summary string `xml:"summary"`
	InGame  struct {
		Name string `xml:"gameName"`
	} `xml:"inGameInfo"`
}

// SteamInfo 是从公开资料页取到的身份信息（无需 API key；资料不公开时只有昵称头像）
type SteamInfo struct {
	Nick    string
	Avatar  string
	State   string // online | offline | in-game | ""（未知/不公开）
	Game    string
	Summary string
}

var (
	tagRe   = regexp.MustCompile(`<[^>]*>`)
	spaceRe = regexp.MustCompile(`\s+`)
)

// plainText 把资料页的 HTML 简介压成一段纯文本并截断
func plainText(s string, max int) string {
	s = strings.NewReplacer("<br>", " ", "<br/>", " ", "<br />", " ").Replace(s)
	s = html.UnescapeString(tagRe.ReplaceAllString(s, ""))
	s = strings.TrimSpace(spaceRe.ReplaceAllString(s, " "))
	if s == "No information given." {
		return ""
	}
	if r := []rune(s); len(r) > max {
		s = string(r[:max]) + "…"
	}
	return s
}

// steamFetch 取公开资料（失败返回 ok=false，不阻塞登录）
func steamFetch(id string) (SteamInfo, bool) {
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Get("https://steamcommunity.com/profiles/" + id + "/?xml=1")
	if err != nil {
		return SteamInfo{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return SteamInfo{}, false
	}
	var p steamProfile
	if err := xml.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&p); err != nil {
		return SteamInfo{}, false
	}
	in := SteamInfo{
		Nick:    plainText(p.Persona, 64),
		Avatar:  strings.TrimSpace(p.Avatar),
		Summary: plainText(p.Summary, 280),
	}
	switch st := strings.TrimSpace(p.Online); st {
	case "online", "offline", "in-game":
		in.State = st
	}
	if in.State == "in-game" {
		in.Game = plainText(p.InGame.Name, 80)
	}
	if !strings.HasPrefix(in.Avatar, "https://") {
		in.Avatar = ""
	}
	return in, in.Nick != ""
}

// steamRefresher 周期刷新所有用户的 Steam 身份（在线状态/正在玩会变）
func steamRefresher(users *UserStore, every time.Duration) {
	for {
		for _, id := range users.IDs() {
			if in, ok := steamFetch(id); ok {
				users.UpdateSteam(id, in)
			}
			time.Sleep(2 * time.Second)
		}
		time.Sleep(every)
	}
}
