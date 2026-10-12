package main

import "sort"

// fleetGates 空港机位数（与前端机队 FLEET 的 9 艘飞船一一对应）
const fleetGates = 9

// seatEnt 是参与排座的一位乘客
type seatEnt struct {
	Key  string // 通道名
	Slot int    // 通道序号，仅用于稳定排序
	On   bool   // 在线（在线的人先上船）
	Pref int    // 上次/自选的机位，0=没有
}

// seatAll 在线优先排座：在线的人先按自己的机位入座、其余补空位，然后才轮到离线的人；
// 坐不下的返回 0（候机）。同一批输入结果确定，机位不变的人不会被挪动。
func seatAll(ents []seatEnt, gates int) map[string]int {
	es := append([]seatEnt(nil), ents...)
	sort.Slice(es, func(i, j int) bool {
		if es[i].Slot != es[j].Slot {
			return es[i].Slot < es[j].Slot
		}
		return es[i].Key < es[j].Key
	})
	taken := make([]bool, gates+1)
	res := make(map[string]int, len(es))
	place := func(on bool) {
		for _, e := range es { // 先让有机位的人坐回去
			if e.On == on && e.Pref >= 1 && e.Pref <= gates && !taken[e.Pref] {
				taken[e.Pref] = true
				res[e.Key] = e.Pref
			}
		}
		for _, e := range es { // 再给没座的补空位
			if e.On != on || res[e.Key] != 0 {
				continue
			}
			for g := 1; g <= gates; g++ {
				if !taken[g] {
					taken[g] = true
					res[e.Key] = g
					break
				}
			}
		}
	}
	place(true)
	place(false)
	for _, e := range es {
		if _, ok := res[e.Key]; !ok {
			res[e.Key] = 0
		}
	}
	return res
}
