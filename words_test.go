package main

import (
	"strings"
	"testing"
)

func TestRot47Roundtrip(t *testing.T) {
	if got := rot47("Hello"); got != "w6==@" {
		t.Fatalf("ROT47 向量错误，got %q", got)
	}
	for _, s := range []string{"sakura", "cat-girl", "a-b-c", "123", "UPPER lower 012"} {
		if rot47(rot47(s)) != s {
			t.Fatalf("ROT47 非对合：%q", s)
		}
	}
}

func TestParseWordLines(t *testing.T) {
	in := "# comment\n\nSakura\n  \ncat-girl\nbad word\nUPPER\nlogin\nsakura\n-in-\ntoolongtoolongtoolongtoolongtoolong\nok9\n"
	got := parseWordLines(in)
	want := []string{"sakura", "cat-girl", "upper", "ok9"}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
}

func miniSet() map[string]bool {
	return map[string]bool{"cat-girl": true, "maid": true, "elf": true}
}

func TestValidPhrase(t *testing.T) {
	set := miniSet()
	valid := []string{
		"cat-girl-maid-elf", // 含连字符词
		"maid-cat-girl-elf", // 顺序不同也是合法 3 词
		"maid-maid-maid",    // 可重复
		"elf-elf-cat-girl",
	}
	for _, v := range valid {
		if !validPhrase(set, v) {
			t.Fatalf("%q 应合法", v)
		}
	}
	invalid := []string{
		"", "cat-girl-maid", // 只有 2 词
		"cat-girl-maid-elf-elf", // 4 词
		"unknown-maid-elf",
		"maid maid elf",
		"MAID-MAID-MAID", // 大写不接受（生成只出小写）
		strings.Repeat("a", 97),
	}
	for _, v := range invalid {
		if validPhrase(set, v) {
			t.Fatalf("%q 应非法", v)
		}
	}
}

func TestGenPhraseShape(t *testing.T) {
	words := []string{"aka", "ao", "midori", "yume"}
	set := map[string]bool{}
	for _, w := range words {
		set[w] = true
	}
	sawRepeat := false
	for i := 0; i < 300; i++ {
		p := genPhrase(words)
		if !validPhrase(set, p) {
			t.Fatalf("生成非法：%q", p)
		}
		parts := strings.Split(p, "-")
		if len(parts) != 3 {
			t.Fatalf("内嵌词无连字符时应恰 3 段：%q", p)
		}
		if parts[0] == parts[1] || parts[1] == parts[2] || parts[0] == parts[2] {
			sawRepeat = true
		}
	}
	if !sawRepeat {
		t.Fatalf("300 次应出现重复词（可重复性）")
	}
}
