package main

// 好记订阅 token 词表（3 词直连、可重复、有序，无小尾巴）。
// words.enc 为 tag.txt 全量（4737 行）的 ROT47 入库，组句用全部有效词；
// 服务端 <config-dir>/tag.txt（明文一行一词）或 tag.enc（ROT47）存在则覆盖，绝不进仓库。
// 解码：python3 -c "import sys;print(''.join(chr((ord(c)-33+47)%94+33) if 33<=ord(c)<=126 else c for c in open('words.enc').read()))"
// ROT47 只是防 casual 明文，不是加密；安全来自随机采样 + 服务端限流（见 sublimit.go）。

import (
	"bytes"
	"crypto/rand"
	_ "embed"
	"errors"
	"log"
	"math/big"
	"os"
	"path/filepath"
	"strings"
)

//go:embed words.enc
var embeddedWordsEnc string

// reservedSub token 整串禁用词（避免与面板路由撞名）
var reservedSub = map[string]bool{
	"login": true, "register": true, "api": true, "static": true,
	"health": true, "logout": true, "me": true, "admin": true,
	"user": true, "root": true, "sub": true, "token": true,
	"www": true, "favicon": true, "robots": true,
}

func rot47(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 33 && c <= 126 {
			b[i] = byte((int(c)-33+47)%94 + 33)
		}
	}
	return string(b)
}

// parseWordLines 清洗词表：一行一词，全小写 [a-z0-9-]，去重，去保留词
func parseWordLines(s string) []string {
	seen := map[string]bool{}
	var out []string
	for _, line := range strings.Split(s, "\n") {
		w := strings.ToLower(strings.TrimSpace(line))
		if w == "" || strings.HasPrefix(w, "#") {
			continue
		}
		if len(w) > 30 {
			continue
		}
		ok := true
		for i := 0; i < len(w); i++ {
			c := w[i]
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				ok = false
				break
			}
		}
		if !ok || w[0] == '-' || w[len(w)-1] == '-' {
			continue
		}
		if reservedSub[w] {
			continue
		}
		if !seen[w] {
			seen[w] = true
			out = append(out, w)
		}
	}
	return out
}

const minWords = 64 // 词表太小直接拒绝启动（熵不够）

// loadWords 词表来源：tag.txt（明文）> tag.enc（ROT47）> 内嵌 words.enc
func loadWords(confPath string) ([]string, error) {
	if confPath != "" {
		dir := filepath.Dir(confPath)
		if b, err := os.ReadFile(filepath.Join(dir, "tag.txt")); err == nil && len(bytes.TrimSpace(b)) > 0 {
			if w := parseWordLines(string(b)); len(w) >= minWords {
				log.Printf("词表：服务端 tag.txt（%d 词）", len(w))
				return w, nil
			}
			return nil, errors.New("服务端 tag.txt 有效词不足")
		}
		if b, err := os.ReadFile(filepath.Join(dir, "tag.enc")); err == nil && len(b) > 0 {
			if w := parseWordLines(rot47(string(b))); len(w) >= minWords {
				log.Printf("词表：服务端 tag.enc（%d 词）", len(w))
				return w, nil
			}
			return nil, errors.New("服务端 tag.enc 有效词不足")
		}
	}
	w := parseWordLines(rot47(embeddedWordsEnc))
	if len(w) < minWords {
		return nil, errors.New("内嵌词表损坏")
	}
	log.Printf("词表：内嵌默认（%d 词）", len(w))
	return w, nil
}

func randWord(words []string) string {
	n, err := rand.Int(rand.Reader, big.NewInt(int64(len(words))))
	if err != nil {
		panic(err)
	}
	return words[n.Int64()]
}

// genPhrase 3 词直连（可重复、有序）
func genPhrase(words []string) string {
	return randWord(words) + "-" + randWord(words) + "-" + randWord(words)
}

// validPhrase 校验 token 是否恰为 3 个词表词直连（词本身可含连字符，用 DP 切分）
func validPhrase(set map[string]bool, tok string) bool {
	if tok == "" || len(tok) > 96 {
		return false
	}
	parts := strings.Split(tok, "-")
	n := len(parts)
	if n < 3 {
		return false
	}
	dp := make([][]bool, n+1)
	for i := range dp {
		dp[i] = make([]bool, 4)
	}
	dp[0][0] = true
	for i := 1; i <= n; i++ {
		for k := 1; k <= 3; k++ {
			for j := 0; j < i; j++ {
				if dp[j][k-1] && set[strings.Join(parts[j:i], "-")] {
					dp[i][k] = true
					break
				}
			}
		}
	}
	return dp[n][3]
}
