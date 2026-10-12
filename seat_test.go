package main

import "testing"

func TestSeatAllOnlineFirst(t *testing.T) {
	// 3 个机位：离线的 a 占着 1 号，在线的 b 没座、c 想坐 1 号
	got := seatAll([]seatEnt{
		{Key: "a", Slot: 1, On: false, Pref: 1},
		{Key: "b", Slot: 2, On: true},
		{Key: "c", Slot: 3, On: true, Pref: 1},
		{Key: "d", Slot: 4, On: false, Pref: 2},
		{Key: "e", Slot: 5, On: false},
	}, 3)
	if got["c"] != 1 {
		t.Fatalf("在线的 c 应拿到自选的 1 号：%v", got)
	}
	if got["b"] != 2 {
		t.Fatalf("在线的 b 应补到第一个空位 2 号：%v", got)
	}
	// 离线的人只能捡剩下的 3 号，其余候机
	if got["a"] != 3 || got["d"] != 0 || got["e"] != 0 {
		t.Fatalf("离线排座不对：%v", got)
	}
}

func TestSeatAllStableAndOverflow(t *testing.T) {
	ents := []seatEnt{}
	for i := 1; i <= 11; i++ {
		ents = append(ents, seatEnt{Key: string(rune('a' + i)), Slot: i, On: true})
	}
	first := seatAll(ents, 9)
	seated, used := 0, map[int]bool{}
	for _, g := range first {
		if g > 0 {
			if used[g] {
				t.Fatalf("机位重复：%v", first)
			}
			used[g] = true
			seated++
		}
	}
	if seated != 9 {
		t.Fatalf("11 人在线应坐满 9 艘，got %d", seated)
	}
	// 把结果当作下一轮的 Pref：没人被挪动
	for i := range ents {
		ents[i].Pref = first[ents[i].Key]
	}
	second := seatAll(ents, 9)
	for k, g := range first {
		if g > 0 && second[k] != g {
			t.Fatalf("%s 被挪动：%d -> %d", k, g, second[k])
		}
	}
}
