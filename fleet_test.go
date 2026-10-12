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

// VLESS 计数差分：首读只做基线，重置按归零后计，无增量不算活跃
func TestVlessMonApply(t *testing.T) {
	m := NewVlessMon()
	t0 := time.Now()
	if d := m.apply("us", map[string]trafficEntry{"u01": {Tx: 100, Rx: 1000}}, t0); len(d) != 0 || m.Active("u01", t0) {
		t.Fatalf("首读应只是基线：%v", d)
	}
	d := m.apply("us", map[string]trafficEntry{"u01": {Tx: 150, Rx: 1600}, "u02": {Tx: 5, Rx: 5}}, t0)
	if d["u01"] != (trafficEntry{Tx: 50, Rx: 600}) || len(d) != 1 || !m.Active("u01", t0) || m.Active("u02", t0) {
		t.Fatalf("增量不对：%v", d)
	}
	if d := m.apply("us", map[string]trafficEntry{"u01": {Tx: 150, Rx: 1600}}, t0); len(d) != 0 {
		t.Fatalf("无变化不应有增量：%v", d)
	}
	// xray 重启，计数器归零后又走了一点
	if d := m.apply("us", map[string]trafficEntry{"u01": {Tx: 7, Rx: 9}}, t0); d["u01"] != (trafficEntry{Tx: 7, Rx: 9}) {
		t.Fatalf("重置后应按新值计：%v", d)
	}
	if m.Total("u01") != (trafficEntry{Tx: 57, Rx: 609}) {
		t.Fatalf("累计应单调：%v", m.Total("u01"))
	}
	if m.Active("u01", t0.Add(vlessActive+time.Second)) {
		t.Fatalf("超时后不应算在线")
	}
}

func TestParseXrayAccess(t *testing.T) {
	for line, want := range map[string][2]string{
		"2026/10/12 100000.1 from 127.0.0.1:5123 accepted tcp:example.com:443 [in >> direct] email: u01": {"u01", "example.com:443"},
		"2026/10/12 100000 from tcp:127.0.0.1:5123 accepted udp:203.0.113.4:53 [in -> direct] email: u02":     {"u02", "203.0.113.4:53"},
	} {
		u, a, ok := parseXrayAccess(line)
		if !ok || u != want[0] || a != want[1] {
			t.Fatalf("%q -> %q %q %v", line, u, a, ok)
		}
	}
	for _, line := range []string{
		"2026/10/12 100000 from 127.0.0.1:5123 rejected  proxy/vless: invalid request",
		"2026/10/12 100000 from 127.0.0.1:5123 accepted tcp:example.com:443 [in >> direct]",
		"",
	} {
		if _, _, ok := parseXrayAccess(line); ok {
			t.Fatalf("不该解析成功：%q", line)
		}
	}
}

// VLESS 记录只进 vless_domains（按次数），不混进 hy2 的流量统计；别人的看不到
func TestDomainStatsVless(t *testing.T) {
	s, _ := NewStore(t.TempDir())
	now := time.Now().Unix()
	s.Append(Conn{User: "u01", Addr: "a.example:443", Tx: 10, Rx: 100, End: now})
	for i := 0; i < 3; i++ {
		s.Append(Conn{User: "u01", Addr: "v.example:443", State: vlessState, End: now})
	}
	s.Append(Conn{User: "u01", Addr: "w.example:443", State: vlessState, End: now})
	s.Append(Conn{User: "u02", Addr: "other.example:443", State: vlessState, End: now})
	st := s.DomainStats("u01", 1, 100, nil)
	if st.Conns != 1 || len(st.Domains) != 1 || st.Domains[0].Addr != "a.example" {
		t.Fatalf("hy2 统计被污染：%+v", st)
	}
	if st.VConns != 4 || st.VHosts != 2 || st.VDomains[0].Addr != "v.example" || st.VDomains[0].Count != 3 {
		t.Fatalf("vless 统计不对：%+v", st.VDomains)
	}
	m := NewVlessMon()
	t0 := time.Now()
	m.addRecent(VRecent{User: "u01", Addr: "old.example:443", At: t0.Add(-2 * time.Minute).Unix()})
	m.addRecent(VRecent{User: "u01", Addr: "v.example:443", At: t0.Unix()})
	m.addRecent(VRecent{User: "u02", Addr: "other.example:443", At: t0.Unix()})
	if r := m.Recent("u01", t0); len(r) != 1 || r[0].Addr != "v.example:443" {
		t.Fatalf("最近连接不对：%+v", r)
	}
	if !m.Active("u01", t0) || len(m.Recent("", t0)) != 2 {
		t.Fatalf("活跃/全量不对")
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
