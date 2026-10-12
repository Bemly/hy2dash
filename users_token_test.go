package main

// 订阅 token（3 词直连）与自助换链测试。
// “点炒饭”= 同一用户短时连打换链/续额：仅第 1 次成功，其余拒绝且状态不动。

import (
	"testing"
)

var testWords = []string{"aka", "ao", "midori", "yume"}

func mkWordStore(t *testing.T) *UserStore {
	t.Helper()
	s := mkTestStore(t)
	s.SetWords(testWords)
	return s
}

func wordSetOf(words []string) map[string]bool {
	m := map[string]bool{}
	for _, w := range words {
		m[w] = true
	}
	return m
}

// 注册即发词组 token
func TestFindOrCreateIssuesPhrase(t *testing.T) {
	s := mkWordStore(t)
	u, created, err := s.FindOrCreate("steam1", "n", "", []Slot{{User: "u01", Pass: "p"}})
	if err != nil || !created {
		t.Fatalf("注册失败：%v", err)
	}
	if !validPhrase(wordSetOf(testWords), u.Token) {
		t.Fatalf("新 token 非法：%q", u.Token)
	}
	if u.TokenAt == "" {
		t.Fatalf("TokenAt 应记录")
	}
	if s.ByToken(u.Token) == nil {
		t.Fatalf("ByToken 查不到新 token")
	}
}

// 自助换链无冷却：连换都成功，旧链接立即失效
func TestRotateMyTokenNoCooldown(t *testing.T) {
	s := mkWordStore(t)
	u, _, _ := s.FindOrCreate("steam1", "n", "", []Slot{{User: "u01", Pass: "p"}})
	prev := u.Token
	for i := 0; i < 3; i++ {
		nt, err := s.RotateMyToken("steam1", false)
		if err != nil {
			t.Fatalf("第 %d 次换链应成功，got %v", i+1, err)
		}
		if nt == prev || !validPhrase(wordSetOf(testWords), nt) {
			t.Fatalf("新 token 非法：%q", nt)
		}
		if s.ByToken(prev) != nil {
			t.Fatalf("旧 token 应立即失效")
		}
		prev = nt
	}
}

// 词组池耗尽：全部 27 种组合被占后应报错而非死循环
func TestGenExhaustion(t *testing.T) {
	s := mkTestStore(t)
	s.SetWords([]string{"ab", "cd", "ef"})
	i := 0
	for _, a := range []string{"ab", "cd", "ef"} {
		for _, b := range []string{"ab", "cd", "ef"} {
			for _, c := range []string{"ab", "cd", "ef"} {
				name := "u" + string(rune('a'+i))
				tok := a + "-" + b + "-" + c
				u := mkTestUser(10, 1, 0)
				u.Name = name
				u.Token = tok
				s.byID[name] = u
				s.byT[tok] = u
				i++
			}
		}
	}
	if _, err := s.genToken(); err == nil {
		t.Fatalf("池耗尽应报错")
	}
}

// 老 hex token 继续有效（只认库，不认形状）
func TestHexCompat(t *testing.T) {
	s := mkWordStore(t)
	s.byID["h"] = mkTestUser(10, 1, 0)
	s.byID["h"].Name = "h"
	s.byID["h"].Token = "e4d813b2e46caa4438a0c205a98f8344"
	s.byT["e4d813b2e46caa4438a0c205a98f8344"] = s.byID["h"]
	if s.ByToken("e4d813b2e46caa4438a0c205a98f8344") == nil {
		t.Fatalf("老 hex 应继续有效")
	}
}

// 路由取段：base 与根双服，老 login 等保留词永不命中
func TestTokenSegOf(t *testing.T) {
	base := "/iku-iku-o-hohho"
	cases := []struct {
		path string
		seg  string
		ok   bool
	}{
		{"/maid-sakura-zaku", "maid-sakura-zaku", true},
		{base + "/maid-sakura-zaku", "maid-sakura-zaku", true},
		{base + "/e4d813b2e46caa4438a0c205a98f8344", "e4d813b2e46caa4438a0c205a98f8344", true},
		{"/", "", false},
		{base + "/", "", false},
		{base + "/login", "", false},
		{"/login", "", false},
		{"/a/b", "", false},
		{"/AB-CD-EF", "", false},
		{"/ab", "", false},
	}
	for _, c := range cases {
		seg, ok := tokenSegOf(base, c.path)
		if seg != c.seg || ok != c.ok {
			t.Fatalf("%s: got (%q,%v) want (%q,%v)", c.path, seg, ok, c.seg, c.ok)
		}
	}
}

// 点炒饭续额：10 连打恰成功 1 次
func TestRenewBurst(t *testing.T) {
	s := mkTestStore(t)
	s.byID["b"] = mkTestUser(10, 10, 0)
	wins := 0
	for i := 0; i < 10; i++ {
		if _, err := s.Renew("b"); err == nil {
			wins++
		} else if err != errDailyLeft {
			t.Fatalf("意外错误：%v", err)
		}
	}
	if wins != 1 {
		t.Fatalf("10 连打应恰成功 1 次，got %d", wins)
	}
}
