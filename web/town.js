/**
 * town.js — 海边小镇（参考图 1/4 的住宅街）
 *
 * 每栋房子都是真结构：外墙开窗开门、一楼客厅+厨房+玄关楼梯、二楼卧室+儿童房+阳台，
 * 家具齐全、住户在里面坐/躺/站。剖切开关可以「揭顶」看二楼、「剖面」看一楼。
 *   house()     两层住宅（随机配色/户型细节）
 *   oldHouse()  平屋老宅：缘侧、障子、榻榻米、被炉、奶奶和猫
 *   ramen()     拉面店：暖帘、吧台座、厨房、红灯笼；二楼住家
 */
import * as THREE from 'three';
import { Kit, bx, cy, sp, plane, G as grp, at, wall, room, sofa, coffeeTable, diningSet, kotatsu, zabuton, tv, bookshelf, bed,
  futon, desk, officeChair, wardrobe, kitchen, fridge, washer, plant, pendant, floorLamp, rug, frame, wallClock, shoeRack,
  counter, stool, bicycle, acUnit, laundry, stairs, toyBox, cat, woodFloor, tatami, siding, shoji, chair } from './interior.js';
import { makeChar, randomLook, place, seeded, clipChars } from './chars.js';
import { buildCherryTree } from './cherry.js';
import { bake } from './bake.js';

const PI = Math.PI;
const FONT = '"Hiragino Sans","PingFang SC",sans-serif';
const F0 = 0.35, H1 = 2.8, H2 = 2.6, SLAB = 0.2;
export const CUT_LEVELS = [1e6, F0 + H1 + SLAB + 2.0, F0 + H1 - 0.25];   // 外观 / 揭顶 / 剖面

const WALLS = ['#f6efe2', '#eef2f6', '#f6e6e0', '#eaf2e6', '#f2ece0', '#e6ecf6'];
const ROOFS = [0x6a7a9a, 0x5a8a7a, 0xb06a5a, 0x5a6478, 0x8a6a8a, 0x4a6a8a];
const CURT = [0xf2c4d0, 0xb8d8f0, 0xf6e6a0, 0xc8e6c0, 0xe0d0f0];

function gable(K, o, { W, D, y, rise, color, ext }) {
  const over = 0.55;
  const half = D / 2 + over;
  const ang = Math.atan2(rise, D / 2);
  const len = Math.hypot(half, rise * half / (D / 2));
  for (const s of [-1, 1]) {
    const r = bx(o, K.c(color, { steps: 3, low: 0.72 }), W + over * 2, 0.16, len, 0, 0, 0);
    r.position.set(0, y + rise / 2 - 0.05 + 0.08, s * (D / 4 + over / 2));
    r.rotation.x = s * ang;
    // 瓦楞线
    for (let k = 0; k < 6; k++) {
      const t = bx(o, K.c(new THREE.Color(color).offsetHSL(0, 0, -0.06).getHex()), W + over * 2, 0.05, 0.06, 0, 0, 0);
      const f = (k + 0.5) / 6;
      t.position.set(0, y + rise * (1 - f) + 0.17, s * f * half);
      t.rotation.x = s * ang; t.userData.noInk = true;
    }
  }
  bx(o, K.c(color, { steps: 3 }), W + over * 2, 0.18, 0.3, 0, y + rise + 0.02, 0);
  const tri = new THREE.Shape();
  tri.moveTo(-D / 2, 0); tri.lineTo(D / 2, 0); tri.lineTo(0, rise); tri.lineTo(-D / 2, 0);
  for (const s of [-1, 1]) {
    const gm = new THREE.Mesh(new THREE.ShapeGeometry(tri), K.c(0xffffff, { map: ext, side: THREE.DoubleSide }));
    gm.position.set(s * W / 2, y, 0); gm.rotation.y = PI / 2; gm.castShadow = true;
    o.add(gm);
  }
  // 雨水槽
  for (const s of [-1, 1]) {
    const gt = cy(o, K.c(0xc8ccd8), 0.07, 0.07, W + over * 2, 0, 0, 0, 8);
    gt.rotation.z = PI / 2; gt.position.set(0, y - 0.05, s * (half + 0.05));
  }
}

/* ============================== 两层住宅 ============================== */
function house(K, rng, i) {
  const o = grp();
  const W = 8, D = 7, T = 0.18;
  const wc = WALLS[i % WALLS.length], roofC = ROOFS[(i * 3) % ROOFS.length], curtain = CURT[i % CURT.length];
  const ext = siding(K, wc);
  const out = K.c(0xffffff, { map: ext }), inn = K.c([0xfdf8f0, 0xf8f6fa, 0xfdf6f0][i % 3]);
  const pick = a => a[Math.floor(rng() * a.length)];
  const HX = W / 2 - 2.3;                       // 玄关/楼梯间分隔墙

  bx(o, K.c(0xd8d4cc), W + 0.25, F0, D + 0.25, 0, 0, 0);
  // ---------- 一楼 ----------
  const g1 = grp(); g1.position.y = F0; o.add(g1);
  bx(g1, K.c(0xffffff, { map: woodFloor(K, ['#e6c79c', '#d8b48a', '#ecd6b0'][i % 3]) }), W - T, 0.05, D - T, 0, 0, 0).receiveShadow = true;
  g1.add(room(K, { w: W, d: D, h: H1, out, inn, curtain, open: {
    s: [{ x: W / 2 - 1.15, y: 0, w: 0.95, h: 2.1, kind: 'door', open: 0.15, color: pick([0x8a5a3a, 0x5a6a8a, 0xb07a4a]), window: true },
        { x: -1.5, y: 0.25, w: 2.6, h: 1.95, kind: 'slide' }],
    n: [{ x: -1.6, y: 1.05, w: 1.4, h: 0.9, kind: 'window' }, { x: 2.6, y: 1.5, w: 0.6, h: 0.6, kind: 'window' }],
    e: [{ x: -0.6, y: 0.9, w: 1.2, h: 1.0, kind: 'window' }],
    w: [{ x: 1.2, y: 0.8, w: 1.5, h: 1.3, kind: 'window' }],
  } }));
  const part = wall(K, { len: D - T, h: H1, t: 0.1, out: inn, inn, openings: [{ x: 1.0, y: 0, w: 0.85, h: 2.05, kind: 'door', open: 0.6, color: 0xd8b88a }] });
  at(part, HX, 0, 0, -PI / 2); g1.add(part);
  // 楼梯 + 玄关
  const st = stairs(K, { w: 0.95, rise: H1 + SLAB, run: 3.2, n: 14 }); at(st, W / 2 - 0.62, 0, D / 2 - 1.6); g1.add(st);
  const sr = shoeRack(K); at(sr, HX + 0.35, 0, D / 2 - 0.55, PI / 2); g1.add(sr);
  bx(g1, K.c(0xc8c0b0), 1.9, 0.02, 1.2, W / 2 - 1.15, 0.02, D / 2 - 0.65).userData.noInk = true;
  // 客厅（前左）
  g1.add(at(rug(K, { w: 2.4, d: 1.8, color: pick([0xf2c4d0, 0xb8d8f0, 0xf6e6a0, 0xc8e6c0]) }), -1.9, 0.05, 1.5));
  const tvs = tv(K); at(tvs, -W / 2 + 0.35, 0.05, 1.5, PI / 2); g1.add(tvs);
  const sf = sofa(K, { w: 1.9, color: pick([0x8fb8e0, 0xf2a6c0, 0xb8d89a, 0xe0c49a, 0xc0a8e0]) }); at(sf, -0.55, 0.05, 1.5, -PI / 2); g1.add(sf);
  const useKotatsu = rng() < 0.4;
  if (useKotatsu) g1.add(at(kotatsu(K, { color: pick([0xe07a8a, 0x7ec4d8, 0xf2c744]) }), -1.9, 0.05, 1.5));
  else g1.add(at(coffeeTable(K), -1.9, 0.05, 1.5, PI / 2));
  g1.add(at(plant(K, { h: 1.2 }), -W / 2 + 0.4, 0.05, D / 2 - 0.45));
  g1.add(at(floorLamp(K), -0.2, 0.05, D / 2 - 0.4));
  const fr = frame(K, 'h' + (i % 4), [['#bfe6f8', '#8fd09a'], ['#fde6f0', '#f2a6c0'], ['#fff2c0', '#9fd0f0'], ['#e6e0f8', '#c0a8e6']][i % 4]);
  at(fr, -W / 2 + 0.12, 1.65, 1.5, PI / 2); g1.add(fr);
  const clk = wallClock(K); at(clk, HX - 0.08, 2.1, 1.6, -PI / 2); g1.add(clk);
  // 厨房 + 餐桌（后左）
  const kt = kitchen(K, { len: 2.6, accent: pick([0x9fd0e8, 0xf2c4d0, 0xb8e0a0, 0xf6e0a0]) }); at(kt, -1.3, 0.05, -D / 2 + 0.42); g1.add(kt);
  g1.add(at(fridge(K, pick([0xfdfdfd, 0xd8f0f8, 0xfde6f0])), -W / 2 + 0.5, 0.05, -D / 2 + 0.48));
  const ds = diningSet(K, { n: 4 }); at(ds.group, -1.3, 0.05, -0.85); g1.add(ds.group);
  g1.add(at(washer(K), HX + 0.5, 0.05, -D / 2 + 0.5));
  g1.add(at(pendant(K, { y: H1, drop: 0.85, color: pick([0xfde6c8, 0xf2c4d0, 0xd8f0f8]) }), -1.3, 0, -0.85));
  g1.add(at(pendant(K, { y: H1, drop: 0.5 }), -1.9, 0, 1.5));
  // ---------- 二楼楼板（楼梯处开洞）----------
  const fl2 = K.c(0xffffff, { map: woodFloor(K, '#ecd6b0') });
  const sTop = D / 2 - 1.6 - 3.2;
  bx(o, fl2, HX + W / 2, SLAB, D, (-W / 2 + HX) / 2, F0 + H1, 0);
  bx(o, fl2, W / 2 - HX, SLAB, sTop + D / 2, (HX + W / 2) / 2, F0 + H1, (-D / 2 + sTop) / 2);
  bx(o, fl2, W / 2 - HX, SLAB, 1.6, (HX + W / 2) / 2, F0 + H1, D / 2 - 0.8);
  // ---------- 二楼 ----------
  const y2 = F0 + H1 + SLAB;
  const g2 = grp(); g2.position.y = y2; o.add(g2);
  g2.add(room(K, { w: W, d: D, h: H2, out, inn, curtain, open: {
    s: [{ x: -1.9, y: 0, w: 2.2, h: 2.05, kind: 'slide' }, { x: 2.3, y: 0.9, w: 1.2, h: 1.1, kind: 'window' }],
    n: [{ x: -1.6, y: 0.9, w: 1.4, h: 1.1, kind: 'window' }, { x: 2.6, y: 1.2, w: 0.7, h: 0.7, kind: 'window' }],
    e: [{ x: 0.6, y: 0.9, w: 1.0, h: 1.0, kind: 'window' }],
    w: [{ x: 1.6, y: 0.9, w: 1.2, h: 1.1, kind: 'window' }, { x: -1.6, y: 0.9, w: 1.2, h: 1.1, kind: 'window' }],
  } }));
  const p2 = wall(K, { len: D - T, h: H2, t: 0.1, out: inn, inn, openings: [{ x: 1.6, y: 0, w: 0.8, h: 2.0, kind: 'door', open: 0.5, color: 0xf2ece0 }, { x: -2.1, y: 0, w: 0.8, h: 2.0, kind: 'door', open: 0.3, color: 0xf2ece0 }] });
  at(p2, HX, 0, 0, -PI / 2); g2.add(p2);
  const p3 = wall(K, { len: HX + W / 2 - T / 2, h: H2, t: 0.1, out: inn, inn });
  at(p3, (-W / 2 + HX) / 2, 0, -0.2, 0); g2.add(p3);
  // 卧室（前左）
  const bd = bed(K, { w: 1.4, l: 2.0, color: pick([0xb8d8f0, 0xf2c4d0, 0xf6e6a0, 0xd8c8f0]) }); at(bd, -W / 2 + 1.15, 0, 1.6, PI / 2); g2.add(bd);
  g2.add(at(wardrobe(K), HX - 0.4, 0, 0.9, -PI / 2));
  g2.add(at(plant(K, { h: 0.8, pot: 0xf2a6c0 }), HX - 0.4, 0, D / 2 - 0.4));
  g2.add(at(rug(K, { w: 1.6, d: 1.2, color: 0xfde6f0 }), -0.8, 0.02, 2.2));
  // 儿童房（后左）
  g2.add(at(desk(K), -1.0, 0, -D / 2 + 0.42));
  g2.add(at(officeChair(K, pick([0xf2a6c0, 0x7ec4d8, 0xf2c744])), -1.0, 0, -D / 2 + 1.1, PI));
  g2.add(at(bookshelf(K, { w: 0.9, h: 1.6, rng }), -W / 2 + 0.3, 0, -1.4, PI / 2));
  const ft = futon(K, pick([0xf2c4d0, 0xb8e0a0, 0xb8d8f0])); at(ft, HX - 0.9, 0, -2.1); g2.add(ft);
  g2.add(at(toyBox(K), HX - 0.5, 0, -0.75));
  g2.add(at(pendant(K, { y: H2, drop: 0.4 }), -1.6, 0, 1.6));
  // 阳台：栏杆 + 晒被子 + 晾衣 + 空调外机
  const bal = grp(); at(bal, -1.2, y2 - SLAB, D / 2); o.add(bal);
  bx(bal, K.c(0xd8d4cc), 4.6, SLAB, 1.25, 0, 0, 0.62);
  for (const [x, z, w, d] of [[0, 1.2, 4.6, 0.08], [-2.27, 0.62, 0.08, 1.25], [2.27, 0.62, 0.08, 1.25]]) bx(bal, K.c(0xfdfdfd), w, 1.0, d, x, SLAB, z);
  for (let k = 0; k < 11; k++) bx(bal, K.c(0xfdfdfd), 0.04, 0.95, 0.04, -2.1 + k * 0.42, SLAB, 1.2).userData.inkWidth = 0.0008;
  if (rng() < 0.6) {
    const fc = K.c(pick([0xf2c4d0, 0xfdfdfd, 0xb8d8f0, 0xf6e6a0]), { side: THREE.DoubleSide });
    bx(bal, fc, 1.4, 0.06, 0.9, -1.0, 1.18, 0.82).rotation.x = 1.2;
    bx(bal, fc, 1.4, 0.06, 0.9, -1.0, 0.75, 1.55).rotation.x = -1.4;
  }
  const ld = laundry(K, 2.2, rng); at(ld, 0.9, SLAB, 0.55); ld.scale.setScalar(0.85); bal.add(ld);
  bal.add(at(acUnit(K), 1.8, SLAB, 0.3));
  // 屋顶
  gable(K, o, { W, D, y: y2 + H2, rise: 1.7, color: roofC, ext });
  // 玄关雨棚 + 门灯 + 门牌
  bx(o, K.c(0xfdfdfd), 1.5, 0.08, 0.8, W / 2 - 1.15, F0 + 2.35, D / 2 + 0.4);
  sp(o, K.f(0xfff2c8), 0.08, W / 2 - 0.45, F0 + 2.0, D / 2 + 0.12).userData.noInk = true;
  plane(o, K.f(0xffffff, { map: K.tex('np' + i, 64, 24, (c) => {
    c.fillStyle = '#fdfaf2'; c.fillRect(0, 0, 64, 24); c.fillStyle = '#2c3e5c'; c.font = `800 15px ${FONT}`; c.textAlign = 'center';
    c.fillText(['佐藤', '鈴木', '高橋', '田中', '渡辺', '伊藤', '山本', '中村', '小林', '加藤', '吉田', '桜井'][i % 12], 32, 18);
  }) }), 0.4, 0.15, W / 2 - 1.85, F0 + 1.6, D / 2 + 0.1);
  // 外机/燃气表/落水管
  o.add(at(acUnit(K), W / 2 + 0.35, 0, -1.2, PI / 2));
  bx(o, K.c(0xc8ccd8), 0.35, 0.5, 0.2, -W / 2 - 0.12, 1.0, -1.5);
  cy(o, K.c(0xc8ccd8), 0.06, 0.06, y2 + H2, W / 2 + 0.6, 0, D / 2 + 0.6, 8);

  // 住户
  const ppl = [];
  if (rng() < 0.8) ppl.push(useKotatsu
    ? { pos: [-1.9, F0 + 0.05, 1.5 + 0.85], yaw: PI, pose: 'cross', surface: F0 + 0.1 }
    : { pos: [-0.65, 0, 1.5 - 0.3], yaw: -PI / 2, pose: rng() < 0.5 ? 'read' : 'sit', surface: F0 + 0.5 });
  if (rng() < 0.7) ppl.push({ pos: [-1.3, F0 + 0.05, -D / 2 + 1.05], yaw: PI, pose: 'stand', look: { outfit: 'casual' } });
  if (rng() < 0.6) ppl.push({ pos: [-W / 2 + 2.05, 0, 1.6], yaw: -PI / 2, pose: 'sleep', surface: y2 + 0.5, look: { outfit: 'pajama' } });
  if (rng() < 0.5) ppl.push({ pos: [-1.0, 0, -D / 2 + 1.05], yaw: PI, pose: 'sit', surface: y2 + 0.5, look: { kid: true } });
  if (rng() < 0.3) ppl.push({ pos: [-1.3, y2, D / 2 + 0.6], yaw: 0, pose: 'lean', look: { outfit: 'dress' } });
  for (const p of ppl) place(makeChar(randomLook(rng, p.look || {})), o, p);
  if (rng() < 0.4) o.add(at(cat(K, pick([0xf2c48a, 0xfdfdfd, 0x5a5a6a])), -0.3, F0 + 0.5, 1.2, 1.2));
  return o;
}

/* ============================== 平屋老宅 ============================== */
function oldHouse(K, rng) {
  const o = grp();
  const W = 11, D = 8, H = 2.6;
  const out = K.c(0xd8c8a8), inn = K.c(0xf2ead8), wood = K.c(0x8a6a4a);
  bx(o, K.c(0xc8c0b0), W + 0.3, 0.55, D + 0.3, 0, 0, 0);
  const g = grp(); g.position.y = 0.55; o.add(g);
  bx(g, K.c(0xffffff, { map: tatami(K) }), W - 0.2, 0.06, D - 0.2, 0, 0, 0).receiveShadow = true;
  g.add(room(K, { w: W, d: D, h: H, out, inn, open: {
    s: [{ x: -2.6, y: 0, w: 4.4, h: 2.1, kind: 'open' }, { x: 2.6, y: 0, w: 4.0, h: 2.1, kind: 'open' }],
    n: [{ x: -2, y: 0.8, w: 1.8, h: 1.0, kind: 'window' }, { x: 3, y: 0.8, w: 1.4, h: 1.0, kind: 'window' }],
  } }));
  // 障子拉门（半开）
  const sj = K.c(0xffffff, { map: shoji(K) });
  for (let k = 0; k < 4; k++) bx(g, sj, 1.0, 2.05, 0.05, -4.3 + k * 2.4 + (k % 2) * 0.6, 0.02, D / 2 - 0.25).userData.inkWidth = 0.0012;
  // 室内隔扇
  const fus = wall(K, { len: D - 0.2, h: H, t: 0.08, out: inn, inn, openings: [{ x: 0.5, y: 0, w: 1.6, h: 2.0, kind: 'open' }] });
  at(fus, 0.3, 0, 0, PI / 2); g.add(fus);
  // 缘侧
  bx(o, K.c(0xc49a6c), W, 0.12, 1.3, 0, 0.45, D / 2 + 0.65);
  for (let k = 0; k < 6; k++) bx(o, wood, 0.15, 0.45, 0.15, -W / 2 + 0.3 + k * 2.08, 0, D / 2 + 1.2);
  // 和室：被炉 + 坐垫 + 佛坛 + 矮柜 + 电视
  const kt = kotatsu(K, { color: 0xc0606a }); at(kt, -2.6, 0.06, 0.4); g.add(kt);
  for (const [x, z] of [[-2.6, 1.3], [-3.6, 0.4]]) g.add(at(zabuton(K, 0x7a5a9a), x, 0.06, z));
  bx(g, K.c(0x5a3a2a), 1.2, 1.6, 0.6, -4.8, 0.06, -3.2);
  bx(g, K.c(0xd8b860), 0.5, 0.4, 0.1, -4.8, 0.9, -2.88);
  for (let k = 0; k < 2; k++) cy(g, K.c(0xf2f2f2), 0.03, 0.03, 0.2, -5.0 + k * 0.4, 1.66, -3.1, 6);
  bx(g, K.c(0x8a6a4a), 1.8, 0.7, 0.45, -1.5, 0.06, -3.4);
  const tvo = tv(K); at(tvo, -1.5, 0.06, -3.3); tvo.scale.setScalar(0.7); g.add(tvo);
  // 另一间：叠好的被褥、书法挂轴、插花
  const fb = futon(K, 0xb8d8f0); at(fb, 3.0, 0.06, -1.0); g.add(fb);
  bx(g, K.c(0x8a6a4a), 1.4, 0.05, 0.5, 4.6, 0.06, -3.4);
  plane(g, K.f(0xffffff, { map: K.tex('kake2', 48, 128, (c) => {
    c.fillStyle = '#f6efe0'; c.fillRect(0, 0, 48, 128); c.fillStyle = '#2c3e5c'; c.font = `900 28px ${FONT}`; c.textAlign = 'center';
    c.fillText('和', 24, 48); c.fillText('敬', 24, 88);
  }) }), 0.5, 1.3, 4.6, 1.3, -D / 2 + 0.12);
  cy(g, K.c(0x5a6a9a), 0.12, 0.1, 0.3, 4.6, 0.11, -3.4, 12);
  sp(g, K.c(0xf2a6c0), 0.12, 4.55, 0.65, -3.4); sp(g, K.c(0xffffff), 0.1, 4.68, 0.58, -3.35);
  g.add(at(pendant(K, { y: H, drop: 0.7, color: 0xfde6c8 }), -2.6, 0, 0.4));
  // 屋顶（深灰瓦）
  gable(K, o, { W, D: D + 1.2, y: 0.55 + H, rise: 2.0, color: 0x5a5a68, ext: K.tex('plaster', 16, 16, (c) => { c.fillStyle = '#e8dcc4'; c.fillRect(0, 0, 16, 16); }) });
  // 人：缘侧上的奶奶 + 猫，被炉里的爷爷
  place(makeChar(randomLook(rng, { outfit: 'yukata', c1: 0x7a8aa8, hair: 0xe8e8ee, style: 'bun' })), o, { pos: [1.2, 0, D / 2 + 0.45], yaw: 0, pose: 'seiza', surface: 0.57 });
  o.add(at(cat(K, 0xf2c48a), 2.2, 0.57, D / 2 + 0.6, 0.5));
  place(makeChar(randomLook(rng, { outfit: 'casual', c1: 0x8a9a7a, hair: 0xd8d8de, style: 'short' })), o, { pos: [-2.6, 0, 0.4 + 0.85], yaw: PI, pose: 'cross', surface: 0.62 });
  // 庭院：松树、石灯笼、晾衣竿
  const pine = grp(); at(pine, -4.0, 0, D / 2 + 3.4); o.add(pine);
  cy(pine, K.c(0x7a5a4a), 0.18, 0.25, 2.4, 0, 0, 0, 8);
  for (let k = 0; k < 3; k++) sp(pine, K.c(0x5f9a6a, { low: 0.7 }), 0.9 - k * 0.15, (k - 1) * 0.7, 2.0 + k * 0.6, 0, 1.4, 0.45, 1.1);
  const lan = grp(); at(lan, 4.4, 0, D / 2 + 3.0); o.add(lan);
  cy(lan, K.c(0xc8c4bc), 0.25, 0.32, 0.6, 0, 0, 0, 6); cy(lan, K.c(0xc8c4bc), 0.1, 0.1, 0.5, 0, 0.6, 0, 6);
  bx(lan, K.c(0xc8c4bc), 0.55, 0.45, 0.55, 0, 1.1, 0);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.4, 4), K.c(0xb8b4ac)); cap.position.y = 1.75; cap.rotation.y = PI / 4; lan.add(cap);
  o.add(at(laundry(K, 3.0, rng), 0.6, 0, D / 2 + 3.2));
  return o;
}

/* ============================== 拉面店 ============================== */
function ramen(K, rng) {
  const o = grp();
  const W = 7, D = 8;
  const out = K.c(0xffffff, { map: siding(K, '#f2e6d6') }), inn = K.c(0xfdf2e2);
  bx(o, K.c(0xd8d4cc), W + 0.2, F0, D + 0.2, 0, 0, 0);
  const g = grp(); g.position.y = F0; o.add(g);
  bx(g, K.c(0xffffff, { map: K.tex('ramenfloor', 64, 64, (c) => {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { c.fillStyle = (x + y) % 2 ? '#d8d0c4' : '#efe8dc'; c.fillRect(x * 16, y * 16, 16, 16); }
  }, [4, 4]) }), W - 0.18, 0.05, D - 0.18, 0, 0, 0).receiveShadow = true;
  g.add(room(K, { w: W, d: D, h: H1, out, inn, open: {
    s: [{ x: -1.4, y: 0, w: 1.6, h: 2.1, kind: 'open' }, { x: 1.6, y: 0.6, w: 2.4, h: 1.5, kind: 'window' }],
    e: [{ x: 0, y: 1.0, w: 1.2, h: 1.0, kind: 'window' }],
  } }));
  // 暖帘
  for (let k = 0; k < 4; k++) {
    const n = bx(g, K.c(0xffffff, { map: K.tex('noren' + k, 32, 64, (c) => {
      c.fillStyle = '#2c4a8a'; c.fillRect(0, 0, 32, 64); c.fillStyle = '#fff'; c.font = `900 22px ${FONT}`; c.textAlign = 'center';
      c.fillText('ラーメン'[k], 16, 34);
    }), side: THREE.DoubleSide }), 0.38, 0.75, 0.02, -2.0 + k * 0.4, 1.35, D / 2 + 0.12);
    n.userData.inkWidth = 0.001;
  }
  // 吧台座 + 厨房
  const ct = counter(K, { len: 4.4, color: 0xb07a4a, top: 0xe8d0a8 }); at(ct, 0.2, 0, -0.6); g.add(ct);
  const stools = [];
  for (let k = 0; k < 5; k++) { const s = stool(K, 0xe8505a); at(s, -1.6 + k * 0.9, 0, 0.2); g.add(s); stools.push(-1.6 + k * 0.9); }
  bx(g, K.c(0xc8ccd8), W - 0.4, 0.85, 0.6, 0, 0, -D / 2 + 0.45);
  for (let k = 0; k < 3; k++) {
    cy(g, K.c(0xb9c2cc), 0.3, 0.3, 0.5, -2.0 + k * 1.1, 0.88, -D / 2 + 0.45, 16);
    for (let p = 0; p < 3; p++) { const st = sp(g, K.f(0xffffff), 0.12 + p * 0.03, -2.0 + k * 1.1, 1.5 + p * 0.3, -D / 2 + 0.45); st.userData.noInk = true; }
  }
  // 拉面碗
  for (let k = 0; k < 4; k++) {
    const x = -1.6 + k * 0.9;
    cy(g, K.c(0xe8505a), 0.17, 0.11, 0.12, x, 1.05, -0.45, 14);
    cy(g, K.c(0xf2c870), 0.16, 0.16, 0.01, x, 1.16, -0.45, 14).userData.noInk = true;
    sp(g, K.c(0xfdfdf0), 0.05, x + 0.05, 1.18, -0.45, 1, 0.6, 1);
    bx(g, K.c(0x6aa85a), 0.08, 0.02, 0.05, x - 0.05, 1.17, -0.42).userData.noInk = true;
  }
  // 墙上菜单木牌
  const items = ['醤油', '味噌', '塩', '豚骨', '餃子', 'ビール'];
  items.forEach((t, k) => {
    plane(g, K.f(0xffffff, { map: K.tex('rm' + k, 24, 72, (c) => {
      c.fillStyle = '#e6c79c'; c.fillRect(0, 0, 24, 72); c.fillStyle = '#2c2c34'; c.font = `900 15px ${FONT}`; c.textAlign = 'center';
      [...t].forEach((ch, i) => c.fillText(ch, 12, 18 + i * 18));
    }) }), 0.25, 0.75, -2.6 + k * 0.42, 2.1, -D / 2 + 0.11);
  });
  // 二楼（住家，简单）
  const y2 = F0 + H1 + SLAB;
  bx(o, K.c(0xffffff, { map: woodFloor(K, '#ecd6b0') }), W, SLAB, D, 0, F0 + H1, 0);
  const g2 = grp(); g2.position.y = y2; o.add(g2);
  g2.add(room(K, { w: W, d: D, h: H2, out, inn, curtain: 0xf6e6a0, open: { s: [{ x: 0, y: 0.8, w: 2.6, h: 1.2, kind: 'window' }], w: [{ x: 0, y: 0.8, w: 1.4, h: 1.2, kind: 'window' }] } }));
  const fb = futon(K, 0xf2c4d0); at(fb, -1.8, 0, -1.5); g2.add(fb);
  g2.add(at(kotatsu(K, { color: 0x7ec4d8 }), 1.2, 0, 0.8));
  gable(K, o, { W, D, y: y2 + H2, rise: 1.5, color: 0x8a5a5a, ext: siding(K, '#f2e6d6') });
  // 招牌 + 红灯笼
  plane(o, K.f(0xffffff, { map: K.tex('ramensign', 256, 64, (c) => {
    c.fillStyle = '#e8505a'; c.fillRect(0, 0, 256, 64); c.fillStyle = '#fff'; c.font = `900 40px ${FONT}`; c.textAlign = 'center';
    c.fillText('ラーメン 桜屋', 128, 46);
  }) }), 4.2, 1.0, 0, F0 + H1 - 0.1, D / 2 + 0.2);
  const ch = sp(o, K.f(0xff6a5a), 0.35, -2.6, F0 + 2.2, D / 2 + 0.5, 1, 1.35, 1); ch.userData.noInk = true;
  // 人
  place(makeChar(randomLook(rng, { outfit: 'chef' })), g, { pos: [0.5, 0, -D / 2 + 1.3], yaw: 0, pose: 'stand' });
  stools.slice(0, 4).forEach((x, k) => { if (k !== 2) place(makeChar(randomLook(rng, { outfit: k % 2 ? 'suit' : 'casual' })), g, { pos: [x, 0, 0.35], yaw: PI, pose: 'sit', surface: 0.62 }); });
  return o;
}

/* ============================== 院子/围墙 ============================== */
function lotDecor(K, rng, o, { W, D, doorX }) {
  const blk = K.c(0xdcd6cc, { steps: 3 });
  const fz = D / 2 + 2.6;
  // 前院围墙（留门口）
  for (const [a, b] of [[-W / 2 - 1, doorX - 0.9], [doorX + 0.9, W / 2 + 1]]) {
    if (b - a < 0.2) continue;
    bx(o, blk, b - a, 1.1, 0.2, (a + b) / 2, 0, fz);
    bx(o, K.c(0xc8c0b4), b - a, 0.08, 0.26, (a + b) / 2, 1.1, fz);
  }
  for (const s of [-1, 1]) bx(o, blk, 0.2, 1.1, 2.6, s * (W / 2 + 1), 0, D / 2 + 1.3);
  // 门柱 + 信箱
  for (const s of [-1, 1]) bx(o, K.c(0xc8c0b4), 0.35, 1.4, 0.35, doorX + s * 0.95, 0, fz);
  bx(o, K.c(0xe8505a), 0.35, 0.3, 0.2, doorX + 1.0, 1.0, fz + 0.15);
  // 盆栽、自行车、小树
  for (let k = 0; k < 3; k++) o.add(at(plant(K, { h: 0.6 + k * 0.2, pot: [0xe0905a, 0x7ec4d8, 0xf2a6c0][k] }), doorX - 1.4 - k * 0.5, 0, D / 2 + 0.6));
  if (rng() < 0.6) o.add(at(bicycle(K, [0x7ec4d8, 0xf2a6c0, 0xf2c744, 0x8fd09a][Math.floor(rng() * 4)]), -W / 2 + 0.8, 0, D / 2 + 1.5, 0.1));
  const tr = grp(); at(tr, W / 2 - 0.2, 0, D / 2 + 1.6); o.add(tr);
  cy(tr, K.c(0x8a6a5a), 0.12, 0.16, 1.4, 0, 0, 0, 8);
  sp(tr, K.c(0x8fc46a, { low: 0.72, shadow: 0x5f86bb }), 0.9, 0, 1.9, 0, 1, 0.9, 1);
  // 院子铺地
  bx(o, K.c(0xc8d8b0, { low: 0.88 }), W + 1.8, 0.02, 2.4, 0, 0, D / 2 + 1.3).userData.noInk = true;
  bx(o, K.c(0xd8d0c4), 1.4, 0.03, 2.5, doorX, 0, D / 2 + 1.3).userData.noInk = true;
}

/* ============================== 总装 ============================== */
export function buildTown(K) {
  const rng = seeded(4242);
  const root = new THREE.Group();
  const lots = [];
  const ZA = [-112, -97, -82, -67, -52, -37, -22, 33, 48, 63, 78];
  ZA.forEach((z, i) => lots.push({ x: 58, z, face: -1, kind: z === -22 ? 'ramen' : 'house' }));
  [-112, -97, -82, -67, -52, -37, -22, 33, 48, 63].forEach((z, i) => lots.push({ x: 82, z, face: 1, kind: z === -67 ? 'old' : 'house' }));
  let hi = 0;
  for (const L of lots) {
    const lot = new THREE.Group();
    let b, W, D, doorX;
    if (L.kind === 'old') { b = oldHouse(K, rng); W = 11; D = 8; doorX = 0; }
    else if (L.kind === 'ramen') { b = ramen(K, rng); W = 7; D = 8; doorX = -1.4; }
    else { b = house(K, rng, hi++); W = 8; D = 7; doorX = 4 - 1.15; }
    lot.add(b);
    if (L.kind !== 'ramen') lotDecor(K, rng, lot, { W, D, doorX });
    // 房子前面朝 +Z（局部）→ 面朝道路
    lot.position.set(L.x - L.face * 0.0, 0, L.z);
    lot.rotation.y = L.face < 0 ? -PI / 2 : PI / 2;
    root.add(lot);
  }
  // 后巷 + 樱花
  const lane = new THREE.Mesh(new THREE.PlaneGeometry(5, 220).rotateX(-PI / 2), K.c(0xa8aec0, { low: 0.9 }));
  lane.position.set(95, 0.03, -20); lane.userData.noInk = true; lane.receiveShadow = true; root.add(lane);
  const trees = new THREE.Group();
  [[70, -104], [70, -60], [70, -30], [70, 40], [70, 70], [100, -90], [100, -40], [100, 55]].forEach(([x, z], i) => {
    const t = buildCherryTree(7 + (i % 3), 4.5);
    t.position.set(x, 0, z); t.rotation.y = i * 1.3; trees.add(t);
  });
  clipChars(root, K.planes);
  bake(root);
  return { group: root, trees };
}
