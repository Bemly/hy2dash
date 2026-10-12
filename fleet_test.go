package main

import (
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// 登录 CSRF：回调的 state 必须和 cookie、和 Steam 签名的 return_to 三者一致
func TestSteamStateOK(t *testing.T) {
	const base, st = "/dash", "0123456789abcdef0123456789abcdef"
	mk := func(state, returnTo string) bool {
		q := url.Values{}
		q.Set("state", state)
		q.Set("openid.return_to", returnTo)
		r := httptest.NewRequest("GET", "http://panel.test"+base+"/api/steam/callback?"+q.Encode(), nil)
		return steamStateOK(r, base, st)
	}
	good := "https://panel.test" + base + "/api/steam/callback?state=" + st
	if !mk(st, good) {
		t.Fatalf("合法回调应通过")
	}
	for name, c := range map[string][2]string{
		"state 不符":             {"ffffffffffffffffffffffffffffffff", good},
		"return_to 里 state 不符": {st, "https://panel.test" + base + "/api/steam/callback?state=other"},
		"return_to 指向别的站":      {st, "https://evil.test" + base + "/api/steam/callback?state=" + st},
		"return_to 路径不对":       {st, "https://panel.test/other?state=" + st},
		"没有 return_to":         {st, ""},
	} {
		if mk(c[0], c[1]) {
			t.Fatalf("%s：应拒绝", name)
		}
	}
	// 没种 cookie（攻击者直接把回调链接丢给受害者）
	r := httptest.NewRequest("GET", "http://panel.test"+base+"/api/steam/callback?state=&openid.return_to="+url.QueryEscape(good), nil)
	if steamStateOK(r, base, "") {
		t.Fatalf("空 cookie 应拒绝")
	}
	// check_authentication 只回传 openid.*
	if v := reRegValues(url.Values{"state": {"x"}, "openid.sig": {"y"}}); v.Get("state") != "" || v.Get("openid.sig") != "y" {
		t.Fatalf("reRegValues 应只保留 openid.*：%v", v)
	}
}

// 域名统计只算指定用户，端口折叠，嗅探域名优先
func TestDomainStatsPerUser(t *testing.T) {
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	s.Append(Conn{User: "u01", Addr: "a.example:443", Tx: 10, Rx: 100, End: now})
	s.Append(Conn{User: "u01", Addr: "a.example:80", Tx: 1, Rx: 1, End: now})
	s.Append(Conn{User: "u01", Addr: "203.0.113.4:443", Sniffed: "b.example:443", Tx: 5, Rx: 5, End: now})
	s.Append(Conn{User: "u02", Addr: "secret.example:443", Tx: 999, Rx: 999, End: now})
	// 用户名是别人前缀/出现在地址里都不能串
	s.Append(Conn{User: "u011", Addr: "u01.example:443", Tx: 7, Rx: 7, End: now})

	st := s.DomainStats("u01", 7, 100, []Conn{{User: "u01", Addr: "live.example:443", Tx: 2, Rx: 2}})
	if st.Conns != 4 || st.TotalTx != 18 || st.TotalRx != 108 {
		t.Fatalf("u01 汇总不对：%+v", st)
	}
	got := map[string]DomainStat{}
	for _, d := range st.Domains {
		got[d.Addr] = d
	}
	if got["a.example"].Count != 2 || got["b.example"].Count != 1 || got["live.example"].Count != 1 {
		t.Fatalf("域名聚合不对：%+v", st.Domains)
	}
	if _, leak := got["secret.example"]; leak || len(got) != 3 {
		t.Fatalf("混入了别人的记录：%+v", st.Domains)
	}
	if all := s.DomainStats("", 7, 100, nil); all.Conns != 5 {
		t.Fatalf("全量应 5 条，got %d", all.Conns)
	}
}

// HTTP 鉴权 + 换链轮换口令：旧口令失效、VLESS 的 UUID 不变、订阅里是新口令
func TestHyAuthRotate(t *testing.T) {
	s := mkWordStore(t)
	slots := []Slot{{User: "u01", Pass: "static1"}, {User: "u02", Pass: "static2"}}
	u, _, _ := s.FindOrCreate("steam1", "n", "", slots)
	uuid := u.UUID
	if !s.HyAuth("u01", "static1", slots) || s.HyAuth("u01", "wrong", slots) || s.HyAuth("u09", "x", slots) || s.HyAuth("u01", "", slots) {
		t.Fatalf("初始应只认通道静态口令")
	}
	if !s.HyAuth("u02", "static2", slots) {
		t.Fatalf("未注册通道沿用静态口令")
	}
	// 不开 HTTP 鉴权时换链不动口令
	if _, err := s.RotateMyToken("steam1", false); err != nil || u.HyPass != "" {
		t.Fatalf("rotatePass=false 不应生成口令：%v %q", err, u.HyPass)
	}
	if _, err := s.RotateMyToken("steam1", true); err != nil || u.HyPass == "" {
		t.Fatalf("应生成新口令：%v", err)
	}
	p1 := u.HyPass
	if s.HyAuth("u01", "static1", slots) || !s.HyAuth("u01", p1, slots) {
		t.Fatalf("旧口令应失效、新口令应生效")
	}
	if _, err := s.RotateToken("steam1", true); err != nil || u.HyPass == p1 || s.HyAuth("u01", p1, slots) {
		t.Fatalf("管理员换链也应轮换口令")
	}
	if u.UUID != uuid {
		t.Fatalf("VLESS UUID 不应变化")
	}
	y := buildUserYAML("\n__NODES__\n[ __NODE_NAMES__ ]", u, slots, []ServerMeta{{Name: "h", Host: "h.test", Port: 1}, {Name: "v", Host: "v.test", Port: 2, Proto: "vless"}})
	if !strings.Contains(y, "password: u01:"+u.HyPass+",") || strings.Contains(y, "static1") || !strings.Contains(y, "uuid: "+uuid) {
		t.Fatalf("订阅口令不对：%s", y)
	}
	u.Enabled = false
	if s.HyAuth("u01", u.HyPass, slots) {
		t.Fatalf("停用用户应拒绝")
	}
}

func TestPlainText(t *testing.T) {
	if got := plainText(`Hi<br>there &amp; <a href="x">link</a>`, 280); got != "Hi there & link" {
		t.Fatalf("got %q", got)
	}
	if plainText("No information given.", 280) != "" {
		t.Fatalf("默认简介应视为空")
	}
}
