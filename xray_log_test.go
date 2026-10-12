package main

// vless 日志跟读测试：成功记账、启动失败报错、异常退出带 stderr，杜绝静默。
// （只测单次 tailOnce，不测无限循环的 runVlessLog。）

import (
	"strings"
	"testing"
	"time"
)

func mkLogStore(t *testing.T) (*Store, *VlessMon) {
	t.Helper()
	st, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("建库失败：%v", err)
	}
	return st, NewVlessMon()
}

// 正常：两行 accepted 进账，两行垃圾跳过，返回 nil
func TestTailOnceOK(t *testing.T) {
	st, mon := mkLogStore(t)
	n := XrayNode{Name: "us", LogCmd: []string{"sh", "-c",
		`printf '%s\n%s\n%s\n%s\n' '2026-10-12T00:00:01 from 203.0.113.4:1 accepted tcp:example.com:443 [in >> direct] email: u01' 'garbage line' '2026-10-12T00:00:02 from 198.51.100.33:2 accepted tcp:example.com:80 [tcp >> out] email: u02' 'no email here accepted'`}}
	if err := tailOnce(n, st, mon); err != nil {
		t.Fatalf("正常退出应 nil，got %v", err)
	}
	rs := mon.Recent("", time.Now())
	if len(rs) != 2 {
		t.Fatalf("应记 2 条，got %d", len(rs))
	}
	if rs[0].User != "u02" || rs[0].Addr != "example.com:80" || rs[1].User != "u01" {
		t.Fatalf("用户/地址错：%+v", rs)
	}
}

// 启动失败：命令不存在必须报错（以前只打一行启动日志，退出码吞掉）
func TestTailOnceStartFail(t *testing.T) {
	st, mon := mkLogStore(t)
	n := XrayNode{Name: "us", LogCmd: []string{"/nonexistent-bin-xyz", "x"}}
	if err := tailOnce(n, st, mon); err == nil {
		t.Fatalf("启动失败必须报错")
	}
}

// 异常退出：带上 stderr 尾巴，调用方能定位（ssh 连不上最常见）
func TestTailOnceExitStderr(t *testing.T) {
	st, mon := mkLogStore(t)
	n := XrayNode{Name: "us", LogCmd: []string{"sh", "-c", `echo 'ssh: connect to host x port 22: Connection timed out' >&2; exit 255`}}
	err := tailOnce(n, st, mon)
	if err == nil {
		t.Fatalf("非零退出必须报错")
	}
	if !strings.Contains(err.Error(), "Connection timed out") {
		t.Fatalf("应带 stderr 尾巴，got %v", err)
	}
	if !strings.Contains(err.Error(), "255") {
		t.Fatalf("应带退出码，got %v", err)
	}
}
