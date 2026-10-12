package main

// xray 用户同步测试：合并规则、空集保护、只在变更时重启、失败不重启。
// （传输层全 fake，不碰网络；UserStore 落盘路径一律用 t.TempDir。）

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
)

var errTestBoom = errors.New("boom")

func TestMergeAddMissing(t *testing.T) {
	cur := []xrayClient{{ID: "uuid-1", Email: "u01"}}
	want := map[string]string{"uuid-1": "u01", "uuid-2": "u02"}
	got, changed := mergeXrayClients(cur, want)
	if !changed {
		t.Fatalf("缺人应变更")
	}
	wantList := []xrayClient{{ID: "uuid-1", Email: "u01"}, {ID: "uuid-2", Email: "u02"}}
	if !reflect.DeepEqual(got, wantList) {
		t.Fatalf("got %+v", got)
	}
}

func TestMergeRemoveDisabled(t *testing.T) {
	cur := []xrayClient{{ID: "uuid-1", Email: "u01"}, {ID: "uuid-9", Email: "u03"}}
	want := map[string]string{"uuid-1": "u01"}
	got, changed := mergeXrayClients(cur, want)
	if !changed || len(got) != 1 || got[0].Email != "u01" {
		t.Fatalf("停用应移除，got %+v changed=%v", got, changed)
	}
}

func TestMergeKeepForeignAndOrder(t *testing.T) {
	cur := []xrayClient{{ID: "x", Email: "friend"}, {ID: "uuid-1", Email: "u01"}}
	want := map[string]string{"uuid-1": "u01"}
	got, changed := mergeXrayClients(cur, want)
	if changed {
		t.Fatalf("无变化不应报变更")
	}
	if len(got) != 2 || got[0].Email != "friend" || got[1].Email != "u01" {
		t.Fatalf("外来保留且保序，got %+v", got)
	}
}

func TestMergeUpdateChangedUUID(t *testing.T) {
	cur := []xrayClient{{ID: "old", Email: "u02"}}
	want := map[string]string{"new": "u02"}
	got, changed := mergeXrayClients(cur, want)
	if !changed || got[0].ID != "new" {
		t.Fatalf("UUID 变化应更新，got %+v", got)
	}
}

func TestMergeEmptyExisting(t *testing.T) {
	want := map[string]string{"b": "u02", "a": "u01"}
	got, changed := mergeXrayClients(nil, want)
	if !changed || len(got) != 2 || got[0].Email != "u01" || got[1].Email != "u02" {
		t.Fatalf("新增按 email 排序，got %+v", got)
	}
}

// fakeOps 记录调用，供 runner 逻辑断言
type fakeOps struct {
	fetched   int
	pushed    []xrayClient
	restarts  int
	pushErr   error
	cur       []xrayClient
	fetchErr  error
}

func (f *fakeOps) ops() xrayOps {
	return xrayOps{
		fetch: func(n XrayNode) ([]xrayClient, error) {
			f.fetched++
			if f.fetchErr != nil {
				return nil, f.fetchErr
			}
			out := append([]xrayClient{}, f.cur...)
			return out, nil
		},
		push: func(n XrayNode, cls []xrayClient) error {
			if f.pushErr != nil {
				return f.pushErr
			}
			f.pushed = append([]xrayClient{}, cls...)
			f.cur = append([]xrayClient{}, cls...)
			return nil
		},
		restart: func(n XrayNode) error {
			f.restarts++
			return nil
		},
	}
}

func testNode() XrayNode {
	return XrayNode{Name: "us", SyncSSH: "root@x.test", SyncPort: 443}
}

func storeWith(uid, hy, uuid string, on bool) *UserStore {
	s := &UserStore{byID: map[string]*User{}, byT: map[string]*User{}}
	s.byID[uid] = &User{Name: uid, HyUser: hy, UUID: uuid, Enabled: on}
	return s
}

// 无变化：不 push 不 restart
func TestSyncNoop(t *testing.T) {
	s := storeWith("a", "u01", "uuid-1", true)
	f := &fakeOps{cur: []xrayClient{{ID: "uuid-1", Email: "u01"}}}
	syncXrayOnce([]XrayNode{testNode()}, s, f.ops(), map[string]bool{}, "")
	if len(f.pushed) != 0 || f.restarts != 0 || f.fetched != 1 {
		t.Fatalf("noop: pushed=%d restarts=%d fetched=%d", len(f.pushed), f.restarts, f.fetched)
	}
}

// 缺人：push 一次 + restart 一次，且 push 内容正确
func TestSyncAddsAndRestarts(t *testing.T) {
	s := storeWith("a", "u01", "uuid-1", true)
	s.byID["b"] = &User{Name: "b", HyUser: "u02", UUID: "uuid-2", Enabled: true}
	f := &fakeOps{cur: []xrayClient{{ID: "uuid-1", Email: "u01"}}}
	syncXrayOnce([]XrayNode{testNode()}, s, f.ops(), map[string]bool{}, "")
	if f.restarts != 1 {
		t.Fatalf("应重启 1 次，got %d", f.restarts)
	}
	b, _ := json.Marshal(f.pushed)
	var got []xrayClient
	if err := json.Unmarshal(b, &got); err != nil || len(got) != 2 {
		t.Fatalf("push 内容错误：%v %+v", err, got)
	}
}

// push 失败：不 restart
func TestSyncPushFailureNoRestart(t *testing.T) {
	s := storeWith("a", "u01", "uuid-1", true)
	s.byID["b"] = &User{Name: "b", HyUser: "u02", UUID: "uuid-2", Enabled: true}
	f := &fakeOps{cur: []xrayClient{}, pushErr: errTestBoom}
	pending := map[string]bool{}
	syncXrayOnce([]XrayNode{testNode()}, s, f.ops(), pending, "")
	if f.restarts != 0 {
		t.Fatalf("push 失败不应重启")
	}
}

// 无启用用户：连 fetch 都不做（防清空）
func TestSyncEmptyDesiredSkips(t *testing.T) {
	s := storeWith("a", "u01", "uuid-1", false)
	f := &fakeOps{cur: []xrayClient{{ID: "z", Email: "friend"}}}
	syncXrayOnce([]XrayNode{testNode()}, s, f.ops(), map[string]bool{}, "")
	if f.fetched != 0 || f.restarts != 0 {
		t.Fatalf("空期望应跳过，fetched=%d restarts=%d", f.fetched, f.restarts)
	}
}

// 停用用户被移出并重启
func TestSyncRemovesDisabled(t *testing.T) {
	s := storeWith("a", "u01", "uuid-1", true)
	s.byID["b"] = &User{Name: "b", HyUser: "u03", UUID: "uuid-9", Enabled: false}
	f := &fakeOps{cur: []xrayClient{{ID: "uuid-1", Email: "u01"}, {ID: "uuid-9", Email: "u03"}}}
	syncXrayOnce([]XrayNode{testNode()}, s, f.ops(), map[string]bool{}, "")
	if f.restarts != 1 || len(f.pushed) != 1 || f.pushed[0].Email != "u01" {
		t.Fatalf("停用应移除并重启，got %+v restarts=%d", f.pushed, f.restarts)
	}
}

// 无 SyncSSH 的节点直接跳过
func TestSyncSkipsUnconfigured(t *testing.T) {
	s := storeWith("a", "u01", "uuid-1", true)
	f := &fakeOps{}
	syncXrayOnce([]XrayNode{{Name: "us"}}, s, f.ops(), map[string]bool{}, "")
	if f.fetched != 0 {
		t.Fatalf("未配置同步的节点不应碰")
	}
}

// 注册新用户触发 poke（只 nick 变化不触发）
func TestFindOrCreatePokes(t *testing.T) {
	s := mkTestStore(t)
	pokes := 0
	s.OnChange(func() { pokes++ })
	_, created, err := s.FindOrCreate("steam-new", "n", "", []Slot{{User: "u09", Pass: "p"}})
	if err != nil || !created || pokes != 1 {
		t.Fatalf("新注册应 poke 1 次，got created=%v err=%v pokes=%d", created, err, pokes)
	}
	if _, _, err := s.FindOrCreate("steam-new", "n2", "", []Slot{{User: "u09", Pass: "p"}}); err != nil {
		t.Fatalf("昵称同步失败：%v", err)
	}
	if pokes != 1 {
		t.Fatalf("昵称同步不应 poke，got %d", pokes)
	}
}

func TestHostOfTarget(t *testing.T) {
	if hostOfTarget("root@h.test") != "h.test" {
		t.Fatalf("应剥掉用户名")
	}
	if hostOfTarget("h.test") != "h.test" {
		t.Fatalf("无用户名原样返回")
	}
	if hostOfTarget("") != "" {
		t.Fatalf("空返回空")
	}
}

// ensureHostKey：缺文件时调 scan 写入；已有跳过不再调；杂行过滤
func TestEnsureHostKey(t *testing.T) {
	dir := t.TempDir()
	p := dir + "/.ssh/known_hosts"
	calls := 0
	scan := func(host string) (string, error) {
		calls++
		if host != "h.test" {
			t.Fatalf("scan host 错误：%s", host)
		}
		return "# comment\nh.test ssh-ed25519 AAAA\nnoise line\n", nil
	}
	if err := ensureHostKey(p, "root@h.test", scan); err != nil {
		t.Fatalf("首次应写入：%v", err)
	}
	if calls != 1 {
		t.Fatalf("应调 scan 1 次")
	}
	b, _ := os.ReadFile(p)
	if !strings.Contains(string(b), "h.test ssh-ed25519 AAAA") || strings.Contains(string(b), "noise") {
		t.Fatalf("只收目标行，got %q", b)
	}
	if err := ensureHostKey(p, "root@h.test", scan); err != nil {
		t.Fatalf("已有应直接过：%v", err)
	}
	if calls != 1 {
		t.Fatalf("已有不应再调 scan")
	}
	if err := ensureHostKey(p, "", scan); err == nil {
		t.Fatalf("空 target 应报错")
	}
}
