/**
 * beach.js — 海滩上的生活
 *   海の家（带内饰：刨冰机、炒面铁板、菜单板、座敷、灯笼、「氷」旗）
 *   救生员高台、遮阳伞+浴巾+晒太阳的人、沙堡、排球、手划船、
 *   戏水的人（会随浪起伏）、浮标线、堤防+台阶、脚印、海鸥
 */
import * as THREE from 'three';
import { Kit, bx, cy, sp, plane, G as grp, at, counter, stool, plant, pendant } from './interior.js';
import { makeChar, randomLook, place, seeded } from './chars.js';
import { shoreX, groundY, SEA_Y } from './world.js';
import { bake } from './bake.js';

const PI = Math.PI;
const FONT = '"Hiragino Sans","PingFang SC",sans-serif';

function stripes(K, key, a, b, n = 8, vertical = true) {
  return K.tex('st' + key, 128, 128, (c) => {
    for (let i = 0; i < n; i++) {
      c.fillStyle = i % 2 ? b : a;
      if (vertical) c.fillRect(i * 128 / n, 0, 128 / n + 1, 128); else c.fillRect(0, i * 128 / n, 128, 128 / n + 1);
    }
  });
}

/* ------------------------------ 遮阳伞 ------------------------------ */
function parasol(K, a, b) {
  const o = grp();
  cy(o, K.c(0xf6f6f6), 0.05, 0.05, 2.9, 0, -0.4, 0, 8);
  const top = new THREE.Mesh(new THREE.ConeGeometry(2.0, 0.75, 16, 1, true), K.c(0xffffff, { map: stripes(K, a + b, a, b, 16), side: THREE.DoubleSide }));
  top.position.y = 2.75; top.castShadow = true; o.add(top);
  sp(o, K.c(a), 0.09, 0, 3.15, 0);
  return o;
}
function towel(K, a, b) {
  const o = grp();
  bx(o, K.c(0xffffff, { map: stripes(K, 'tw' + a + b, a, b, 6, false) }), 0.95, 0.03, 1.9, 0, 0, 0).userData.noInk = true;
  return o;
}
function deckChair(K, color) {
  const o = grp();
  const m = K.c(0xf6f6f6);
  for (const s of [-1, 1]) {
    bx(o, m, 0.05, 0.05, 1.6, s * 0.3, 0.3, 0.1);
    for (const z of [-0.5, 0.7]) bx(o, m, 0.05, 0.3, 0.05, s * 0.3, 0, z);
  }
  bx(o, K.c(color), 0.6, 0.04, 1.1, 0, 0.34, 0.35).userData.inkWidth = 0.001;
  const bk = bx(o, K.c(color), 0.6, 0.85, 0.04, 0, 0.3, -0.25); bk.rotation.x = -0.7;
  o.userData.seatY = 0.36;
  return o;
}
function cooler(K) {
  const o = grp();
  bx(o, K.c(0x6fb5e8), 0.6, 0.4, 0.4, 0, 0, 0);
  bx(o, K.c(0xfdfdfd), 0.62, 0.08, 0.42, 0, 0.4, 0);
  return o;
}
function sandcastle(K) {
  const o = grp(), m = K.c(0xe8d2a8, { low: 0.8 });
  cy(o, m, 1.2, 1.4, 0.4, 0, 0, 0, 20);
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * PI * 2 + PI / 4;
    cy(o, m, 0.3, 0.34, 0.9, Math.cos(a) * 0.85, 0.35, Math.sin(a) * 0.85, 12);
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.4, 12), m); c.position.set(Math.cos(a) * 0.85, 1.45, Math.sin(a) * 0.85); o.add(c);
  }
  cy(o, m, 0.45, 0.5, 1.4, 0, 0.35, 0, 16);
  cy(o, K.c(0x8a6a5a), 0.015, 0.015, 0.6, 0, 1.75, 0, 4);
  bx(o, K.c(0xf26a8a, { side: THREE.DoubleSide }), 0.3, 0.18, 0.01, 0.15, 2.15, 0);
  cy(o, K.c(0xf2c744), 0.16, 0.12, 0.25, 1.6, 0, 0.4, 12);     // 小桶
  bx(o, K.c(0x6fb5e8), 0.06, 0.03, 0.4, 1.5, 0.02, -0.3);
  return o;
}
function rowboat(K, color) {
  const o = grp();
  const hullG = new THREE.CylinderGeometry(0.8, 0.8, 4.2, 18, 1, true, PI, PI);
  const h = new THREE.Mesh(hullG, K.c(color, { side: THREE.DoubleSide })); h.rotation.z = PI / 2; h.scale.set(1, 1, 1); h.position.y = 0.8; h.castShadow = true; o.add(h);
  for (const s of [-1, 1]) { const c = sp(o, K.c(color), 0.8, s * 2.1, 0.8, 0, 0.3, 1, 1); }
  bx(o, K.c(0xfdfaf2), 4.2, 0.08, 0.12, 0, 0.78, 0.76); bx(o, K.c(0xfdfaf2), 4.2, 0.08, 0.12, 0, 0.78, -0.76);
  for (const x of [-0.8, 0.8]) bx(o, K.c(0xc49a6c), 0.3, 0.06, 1.5, x, 0.45, 0);
  for (const s of [-1, 1]) { const oar = bx(o, K.c(0xc49a6c), 2.4, 0.05, 0.08, 0.2, 0.6, s * 0.5); oar.rotation.y = s * 0.15; }
  return o;
}
function lifeguard(K) {
  const o = grp();
  const w = K.c(0xfdfdfd), r = K.c(0xe8505a);
  for (const x of [-0.6, 0.6]) for (const z of [-0.6, 0.6]) { const l = cy(o, w, 0.07, 0.09, 3.0, x, 0, z, 8); l.rotation.set(z * 0.08, 0, -x * 0.08); }
  for (let i = 0; i < 4; i++) bx(o, r, 1.35, 0.06, 0.08, 0, 0.6 + i * 0.6, 0.62);
  bx(o, w, 1.3, 0.1, 1.3, 0, 2.95, 0);
  bx(o, r, 0.9, 0.45, 0.1, 0, 3.05, -0.55);
  bx(o, w, 0.9, 0.06, 0.6, 0, 3.4, -0.2);
  cy(o, w, 0.04, 0.04, 2.6, 0.55, 3.0, -0.5, 6);
  const umb = new THREE.Mesh(new THREE.ConeGeometry(1.3, 0.45, 12, 1, true), K.c(0xffffff, { map: stripes(K, 'lg', '#e8505a', '#fdfdfd', 12), side: THREE.DoubleSide }));
  umb.position.set(0.55, 5.6, -0.5); o.add(umb);
  for (const [z, c] of [[1.4, 0xe8505a], [1.9, 0xf2c744]]) {
    cy(o, K.c(0x8a94a8), 0.03, 0.03, 3.2, -1.2, 0, z, 6);
    bx(o, K.c(c, { side: THREE.DoubleSide }), 0.02, 0.5, 0.7, -1.2, 2.6, z + 0.35);
  }
  o.userData.seat = { y: 3.45, z: -0.2 };
  return o;
}
function volleyball(K) {
  const o = grp();
  for (const z of [-4.5, 4.5]) cy(o, K.c(0xfdfdfd), 0.06, 0.06, 2.6, 0, 0, z, 8);
  const net = plane(o, K.c(0xffffff, { map: K.tex('net', 64, 64, (c) => {
    c.clearRect(0, 0, 64, 64); c.strokeStyle = '#2c3446'; c.lineWidth = 2;
    for (let i = 0; i <= 64; i += 8) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i, 64); c.stroke(); c.beginPath(); c.moveTo(0, i); c.lineTo(64, i); c.stroke(); }
  }, [12, 2]), transparent: true, alphaTest: 0.3, side: THREE.DoubleSide }), 9, 1.0, 0, 2.0, 0, PI / 2);
  bx(o, K.c(0xfdfdfd), 0.04, 0.08, 9, 0, 2.5, 0);
  return o;
}
function sign(K) {
  const o = grp();
  cy(o, K.c(0xc49a6c), 0.06, 0.06, 2.2, 0, 0, 0, 6);
  plane(o, K.f(0xffffff, { map: K.tex('swim', 192, 96, (c) => {
    c.fillStyle = '#fdfaf2'; c.fillRect(0, 0, 192, 96); c.fillStyle = '#e8505a'; c.fillRect(0, 0, 192, 22);
    c.fillStyle = '#fff'; c.font = `800 16px ${FONT}`; c.textAlign = 'center'; c.fillText('桜ヶ浜 海水浴場', 96, 16);
    c.fillStyle = '#2c3e5c'; c.font = `900 30px ${FONT}`; c.fillText('遊泳区域', 96, 58);
    c.font = `700 14px ${FONT}`; c.fillText('SWIM ZONE · 9:00-17:00', 96, 84);
  }), side: THREE.DoubleSide }), 1.6, 0.8, 0, 2.4, 0, PI / 2);
  return o;
}

/* ------------------------------ 海の家 ------------------------------ */
function umiNoIe(K, rng) {
  const o = grp();
  const W = 9, L = 15, H = 3.2;
  const wood = K.c(0xd8a870), dark = K.c(0xa87a52), post = K.c(0xc49a6c);
  const deckT = K.tex('umideck', 128, 128, (c) => {
    c.fillStyle = '#e2bc8a'; c.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 8; i++) { c.fillStyle = 'rgba(140,90,50,.35)'; c.fillRect(0, i * 16 + 15, 128, 1.5); }
  }, [3, 4]);
  // 甲板 + 立柱 + 斜屋顶（前低后高，朝海 -X 开口）
  bx(o, K.c(0xffffff, { map: deckT }), W, 0.3, L, 0, 0.3, 0).receiveShadow = true;
  for (const x of [-W / 2 + 0.2, W / 2 - 0.2]) for (let z = -L / 2 + 0.2; z <= L / 2; z += L / 4 - 0.1) bx(o, post, 0.22, x < 0 ? H : H + 0.8, 0.22, x, 0.6, z);
  for (let z = -L / 2 + 0.2; z <= L / 2; z += L / 4 - 0.1) bx(o, post, 0.2, 0.6, 0.2, 0, 0, z);
  const roof = bx(o, K.c(0x6fb5e8), W + 1.6, 0.14, L + 0.8, 0, H + 0.95, 0); roof.rotation.z = -0.09;
  for (let k = 0; k < 14; k++) bx(o, K.c(0x8fc8f0), 0.08, 0.16, L + 0.8, -W / 2 - 0.2 + k * 0.72, H + 0.98 + (k * 0.72 - W / 2) * 0.09, 0).userData.noInk = true;
  // 后墙（带出餐窗口）+ 侧墙半高
  bx(o, wood, 0.15, H + 0.8, L, W / 2 - 0.1, 0.6, 0);
  for (const s of [-1, 1]) {
    bx(o, wood, W, 1.1, 0.12, 0, 0.6, s * (L / 2 - 0.06));
    for (let k = 0; k < 6; k++) bx(o, dark, 0.1, 1.1, 0.13, -W / 2 + 0.6 + k * 1.6, 0.6, s * (L / 2 - 0.06)).userData.inkWidth = 0.001;
  }
  // 厨房吧台
  const ct = counter(K, { len: 7, color: 0xf2f2ee, top: 0xd8a870 });
  at(ct, W / 2 - 1.6, 0.6, 0, -PI / 2); o.add(ct);
  // 刨冰机
  const ice = grp(); at(ice, W / 2 - 1.4, 1.65, -2.2); o.add(ice);
  cy(ice, K.c(0xf26a8a), 0.25, 0.3, 0.25, 0, 0, 0, 14);
  cy(ice, K.c(0xfdfdfd), 0.08, 0.08, 0.6, 0, 0.25, 0, 8);
  cy(ice, K.c(0xf26a8a), 0.3, 0.3, 0.3, 0, 0.85, 0, 14);
  sp(ice, K.c(0xd8f4ff), 0.2, 0, 0.42, 0.0);
  // 炒面铁板 + 锅铲
  bx(o, K.c(0x3a3e4a), 1.4, 0.08, 0.7, W / 2 - 1.4, 1.62, 1.5);
  for (let i = 0; i < 10; i++) bx(o, K.c(0xc8905a), 0.12, 0.03, 0.04, W / 2 - 1.9 + (i % 5) * 0.22, 1.71, 1.3 + Math.floor(i / 5) * 0.3, i).userData.noInk = true;
  // 糖浆瓶
  for (let i = 0; i < 4; i++) cy(o, K.c([0xe8505a, 0x8fd09a, 0xf2c744, 0x6fb5e8][i], { transparent: true, opacity: 0.9 }), 0.06, 0.06, 0.3, W / 2 - 1.2, 1.62, -1.2 + i * 0.18, 10);
  // 菜单板（贴在后墙）
  const menu = [['かき氷', '¥300', '#e8505a'], ['ラムネ', '¥150', '#3f78c8'], ['焼きそば', '¥500', '#c8702a'], ['カレー', '¥600', '#b8902a'], ['ビール', '¥500', '#d8a020']];
  menu.forEach(([a, b, c], i) => {
    plane(o, K.f(0xffffff, { map: K.tex('menu' + i, 64, 160, (x) => {
      x.fillStyle = '#fdfaf2'; x.fillRect(0, 0, 64, 160); x.fillStyle = c; x.fillRect(0, 0, 64, 10);
      x.fillStyle = '#2c3e5c'; x.font = `900 22px ${FONT}`; x.textAlign = 'center';
      [...a].forEach((ch, k) => x.fillText(ch, 32, 36 + k * 24));
      x.fillStyle = c; x.font = `800 15px ${FONT}`; x.fillText(b, 32, 152);
    }) }), 0.45, 1.1, W / 2 - 0.2, 2.9, -3 + i * 0.55, -PI / 2);
  });
  // 门帘招牌
  plane(o, K.f(0xffffff, { map: K.tex('umisign', 256, 64, (c) => {
    c.fillStyle = '#2c4a8a'; c.fillRect(0, 0, 256, 64); c.fillStyle = '#fff'; c.textAlign = 'center';
    c.font = `900 36px ${FONT}`; c.fillText('海の家 さくら', 128, 44);
  }), side: THREE.DoubleSide }), 5, 1.2, -W / 2 - 0.15, H + 0.55, 0, -PI / 2);
  // 灯笼一排
  for (let k = 0; k < 7; k++) {
    const z = -L / 2 + 1.2 + k * 2.1;
    const l = sp(o, K.f(k % 2 ? 0xff8a8a : 0xffe2a0), 0.24, -W / 2 + 0.1, H + 0.15, z, 1, 1.3, 1);
    l.userData.noInk = true;
    cy(o, K.c(0x2c2c34), 0.12, 0.12, 0.06, -W / 2 + 0.1, H + 0.43, z, 10);
  }
  // 座敷：榻榻米 + 矮桌 + 刨冰
  const tm = K.c(0xd8dca0, { low: 0.85 });
  const ppl = [];
  [[-2.4, -4.5], [-2.4, -0.8], [-2.4, 3.0], [0.6, -4.2], [0.6, 3.3]].forEach(([x, z], i) => {
    bx(o, tm, 2.2, 0.08, 2.6, x, 0.6, z).userData.noInk = true;
    bx(o, K.c(0x8a5a3a), 1.0, 0.05, 0.7, x, 0.95, z);
    for (const s of [-1, 1]) bx(o, K.c(0x8a5a3a), 0.06, 0.3, 0.6, x + s * 0.42, 0.66, z);
    // 刨冰（玻璃碗 + 彩色冰山）
    for (const s of [-1, 1]) {
      cy(o, K.c(0xd8f4ff, { transparent: true, opacity: 0.8 }), 0.13, 0.08, 0.1, x, 1.0, z + s * 0.18, 12);
      const c = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.24, 12), K.c([0xe8505a, 0x8fd09a, 0x6fb5e8, 0xf2c744, 0xf2a6c0][(i + (s > 0 ? 1 : 0)) % 5]));
      c.position.set(x, 1.22, z + s * 0.18); o.add(c);
    }
    if (i < 4) ppl.push({ pos: [x - 0.85, 0, z - 0.3], yaw: PI / 2, pose: 'cross', surface: 0.68 });
    if (i % 2 === 0) ppl.push({ pos: [x + 0.85, 0, z + 0.3], yaw: -PI / 2, pose: 'seiza', surface: 0.68 });
  });
  // 泳圈租借 + 冲凉
  for (let i = 0; i < 4; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.17, 10, 20), K.c(0xffffff, { map: stripes(K, 'ring' + i, ['#f26a8a', '#6fb5e8', '#f2c744', '#8fd09a'][i], '#ffffff', 8) }));
    ring.position.set(-W / 2 - 0.9, 0.35 + i * 0.12, -L / 2 + 0.8); ring.rotation.x = PI / 2; o.add(ring);
  }
  const sh = grp(); at(sh, -W / 2 - 1.2, 0, L / 2 - 0.8); o.add(sh);
  cy(sh, K.c(0x8a94a8), 0.05, 0.05, 2.6, 0, 0, 0, 6);
  bx(sh, K.c(0x8a94a8), 0.5, 0.05, 0.05, 0.25, 2.6, 0);
  cy(sh, K.c(0x8a94a8), 0.12, 0.06, 0.1, 0.5, 2.5, 0, 10);
  // 「氷」旗
  const fl = grp(); at(fl, -W / 2 - 1.0, 0, 0.6); o.add(fl);
  cy(fl, K.c(0xc49a6c), 0.04, 0.04, 3.4, 0, 0, 0, 6);
  plane(fl, K.f(0xffffff, { map: K.tex('kori', 96, 96, (c) => {
    c.fillStyle = '#fdfdfd'; c.fillRect(0, 0, 96, 96);
    c.fillStyle = '#3f78c8'; c.beginPath(); c.moveTo(0, 70);
    for (let x = 0; x <= 96; x += 12) c.quadraticCurveTo(x + 6, 58, x + 12, 70);
    c.lineTo(96, 96); c.lineTo(0, 96); c.fill();
    c.fillStyle = '#e8505a'; c.font = `900 58px ${FONT}`; c.textAlign = 'center'; c.fillText('氷', 48, 60);
  }), side: THREE.DoubleSide }), 1.0, 1.0, 0, 2.8, 0.5, PI / 2);
  // 人
  const chars = [];
  for (const p of ppl) chars.push(place(makeChar(randomLook(rng, { outfit: rng() < 0.6 ? 'swim' : 'casual' })), o, p));
  chars.push(place(makeChar(randomLook(rng, { outfit: 'chef' })), o, { pos: [W / 2 - 0.7, 0.6, 1.5], yaw: -PI / 2, pose: 'stand' }));
  chars.push(place(makeChar(randomLook(rng, { outfit: 'yukata', c1: 0x9fd0f0 })), o, { pos: [W / 2 - 0.7, 0.6, -2.0], yaw: -PI / 2, pose: 'stand' }));
  chars.push(place(makeChar(randomLook(rng, { outfit: 'casual', hat: 'straw' })), o, { pos: [-0.8, 0.6, 0.6], yaw: -PI / 2 + 0.3, pose: 'wave' }));
  return o;
}

/* ------------------------------ 海鸥 ------------------------------ */
function gull(K) {
  const o = grp();
  sp(o, K.c(0xfdfdfd), 0.22, 0, 0, 0, 1.6, 0.7, 0.7);
  sp(o, K.c(0xfdfdfd), 0.12, 0.32, 0.06, 0);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.14, 6), K.c(0xf2b544)); beak.rotation.z = -PI / 2; beak.position.set(0.48, 0.05, 0); o.add(beak);
  const wings = [];
  for (const s of [-1, 1]) {
    const w = grp(); w.position.set(0, 0.05, s * 0.1); o.add(w);
    const m = bx(w, K.c(0xf2f4f8, { side: THREE.DoubleSide }), 0.35, 0.03, 0.9, 0, 0, s * 0.45);
    const tip = bx(w, K.c(0x5a6478), 0.2, 0.031, 0.25, -0.05, 0, s * 0.8);
    w.userData.s = s; wings.push(w);
  }
  o.userData.wings = wings;
  return o;
}

/* ============================== 总装 ============================== */
export function buildBeachLife({ houseKit }) {
  const K = new Kit();
  const rng = seeded(31415);
  const root = new THREE.Group();
  const stat = new THREE.Group(); root.add(stat);
  const at2 = (o, x, z, ry = 0, dy = 0) => { o.position.set(x, groundY(x, z) + dy, z); o.rotation.y = ry; return o; };
  const ok = z => !(z > -14 && z < 18);

  // 堤防 + 台阶
  const wallM = K.c(0xdcd8d0, { steps: 3 });
  for (let z = -430; z < 330; z += 4) {
    if (!ok(z) || !ok(z + 4)) continue;
    const x0 = shoreX(z) + 26.5, x1 = shoreX(z + 4) + 26.5;
    const seg = bx(stat, wallM, 0.7, 1.0, Math.hypot(4, x1 - x0) + 0.05, (x0 + x1) / 2, -0.1, z + 2);
    seg.rotation.y = Math.atan2(x1 - x0, 4);
    if (Math.round(z / 4) % 14 === 0) for (let k = 0; k < 4; k++) bx(stat, wallM, 0.5, 0.25 * (4 - k), 2.4, (x0 + x1) / 2 - 0.6 - k * 0.5, -0.2, z + 2);
  }
  // 海の家
  const umi = umiNoIe(houseKit, rng);
  at2(umi, shoreX(-46) + 14, -46, 0, -0.15);
  stat.add(umi);
  // 救生员高台
  const lg = lifeguard(K); at2(lg, shoreX(-86) + 6, -86, -PI / 2); stat.add(lg);
  place(makeChar(randomLook(rng, { outfit: 'swim', c1: 0xe8505a, hat: 'cap' })), lg, { pos: [0, 0, -0.1], yaw: 0, pose: 'sit', surface: lg.userData.seat.y });
  const sg = sign(K); at2(sg, shoreX(-100) + 9, -100, 0); stat.add(sg);
  // 遮阳伞组
  const combos = [['#f26a8a', '#ffffff'], ['#6fb5e8', '#ffffff'], ['#f2c744', '#ffffff'], ['#8fd09a', '#fdfaf2'], ['#c0a0e6', '#ffffff'], ['#ff9a6a', '#fff6d0']];
  const spots = [[-28, 7], [-62, 9], [-118, 8], [-140, 11], [36, 8], [58, 10], [84, 7], [-170, 9], [110, 11]];
  spots.forEach(([z, dx], i) => {
    const x = shoreX(z) + dx;
    const [a, b] = combos[i % combos.length];
    const p = parasol(K, a, b); at2(p, x, z, rng() * PI, 0.3); stat.add(p);
    const tw = towel(K, a, b); at2(tw, x - 0.4, z + 1.1, 0.3, 0.02); stat.add(tw);
    const kind = i % 4;
    if (kind === 0 || kind === 2) place(makeChar(randomLook(rng, { outfit: 'swim', hat: kind === 2 ? 'straw' : null })), stat, { pos: [x - 0.45, 0, z + 2.0], yaw: PI + 0.3, pose: kind === 0 ? 'lie' : 'sleep', surface: groundY(x, z) + 0.05 });
    if (kind !== 2) {
      const dc = deckChair(K, [0xf26a8a, 0x6fb5e8, 0xf2c744][i % 3]); at2(dc, x + 1.2, z - 0.6, -PI / 2 + 0.2); stat.add(dc);
      place(makeChar(randomLook(rng, { outfit: rng() < 0.5 ? 'swim' : 'dress' })), stat, { pos: [x + 1.15, 0, z - 0.6], yaw: -PI / 2 + 0.2, pose: kind === 1 ? 'read' : 'recline', surface: groundY(x, z) + 0.38 });
    }
    if (i % 3 === 0) { const c = cooler(K); at2(c, x + 0.4, z + 0.9, 0.4); stat.add(c); }
    if (i % 3 === 1) sp(stat, K.c(0xffffff, { map: stripes(K, 'ball', '#f26a8a', '#f2c744', 6) }), 0.25, x - 1.5, groundY(x - 1.5, z) + 0.25, z - 1.4);
  });
  // 沙堡 + 堆沙的小孩
  const sc = sandcastle(K); at2(sc, shoreX(-12 - 40) + 4, -52, 0.4); stat.add(sc);
  place(makeChar(randomLook(rng, { kid: true, outfit: 'swim', hat: 'straw' })), stat, { pos: [shoreX(-52) + 2.6, 0, -52.6], yaw: PI / 2 + 0.4, pose: 'seiza', surface: groundY(shoreX(-52) + 2.6, -52) });
  place(makeChar(randomLook(rng, { kid: true, outfit: 'swim' })), stat, { pos: [shoreX(-52) + 5.6, 0, -50.4], yaw: -PI / 2 - 0.5, pose: 'cross', surface: groundY(shoreX(-52) + 5.6, -50) });
  // 排球
  const vb = volleyball(K); at2(vb, shoreX(66) + 12, 66, 0); stat.add(vb);
  const vx = shoreX(66) + 12;
  [[-3, 63, PI / 2, 'cheer'], [3.2, 64, -PI / 2, 'stand'], [-3.5, 69, PI / 2 + 0.3, 'stand'], [2.8, 69.5, -PI / 2, 'wave']].forEach(([dx, z, ry, pose]) => {
    place(makeChar(randomLook(rng, { outfit: 'swim' })), stat, { pos: [vx + dx, groundY(vx + dx, z), z], yaw: ry, pose });
  });
  const ball = sp(root, K.c(0xffffff, { map: stripes(K, 'vball', '#f2c744', '#6fb5e8', 6) }), 0.22, vx - 1, 4, 66);
  // 手划船
  for (const [z, c] of [[128, 0x6fb5e8], [136, 0xf26a8a]]) { const b = rowboat(K, c); at2(b, shoreX(z) + 1.5, z, 0.3 + z * 0.01, -0.1); stat.add(b); }
  // 脚印：从海の家走向海边
  for (let i = 0; i < 26; i++) {
    const z = -46 + 6 + Math.sin(i * 0.4) * 2.5 + i * 0.25, x = shoreX(-40) + 9 - i * 0.42;
    const f = new THREE.Mesh(new THREE.CircleGeometry(0.1, 8), K.c(0xd8c49a));
    f.rotation.x = -PI / 2; f.scale.set(1, 1.8, 1);
    f.position.set(x, groundY(x, z) + 0.02, z + (i % 2 ? 0.18 : -0.18)); f.userData.noInk = true;
    stat.add(f);
  }

  // ---- 会动的：戏水的人、浮标、渔船、海鸥 ----
  const bobbers = [];
  const swim = [[-40, -3, 'lie'], [-58, -5, 'stand'], [-72, -2.5, 'lie'], [-30, -6, 'stand'], [44, -4, 'lie'], [70, -3, 'stand']];
  swim.forEach(([z, dx, pose], i) => {
    const g = new THREE.Group();
    const x = shoreX(z) + dx;
    g.position.set(x, SEA_Y, z);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.18, 10, 20), K.c(0xffffff, { map: stripes(K, 'sw' + i, ['#f26a8a', '#f2c744', '#6fb5e8'][i % 3], '#ffffff', 8) }));
    ring.rotation.x = PI / 2; ring.position.y = 0.1; g.add(ring);
    const ch = makeChar(randomLook(rng, { outfit: 'swim', kid: i % 2 === 0 }));
    if (pose === 'lie') place(ch, g, { pos: [0, 0, 0.6], yaw: 0, pose: 'lie', surface: 0.05 });
    else place(ch, g, { pos: [0, -0.75, 0], yaw: PI / 2 + rng() - 0.5, pose: i % 2 ? 'wave' : 'cheer' });
    ch.freeze(true);
    g.userData.ph = i * 1.3;
    root.add(g); bobbers.push(g);
  });
  // 浮标线
  for (let z = -130; z <= -10; z += 4) {
    const x = shoreX(z) - 34;
    const b = sp(root, K.c(Math.round(z / 4) % 2 ? 0xe8505a : 0xfdfdfd), 0.35, x, SEA_Y + 0.1, z);
    b.userData.ph = z * 0.1; bobbers.push(b);
  }
  // 渔船
  const fb = grp(); at(fb, -70, SEA_Y, -160, 0.6); root.add(fb);
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.2, 9, 16, 1, false, PI, PI), K.c(0xfdfdfd, { side: THREE.DoubleSide }));
  hull.rotation.z = PI / 2; hull.position.y = 0.6; fb.add(hull);
  bx(fb, K.c(0x6fb5e8), 9, 0.25, 3.2, 0, 0.55, 0);
  bx(fb, K.c(0xfdfdfd), 2.6, 1.8, 2.0, -1.5, 0.8, 0);
  bx(fb, K.c(0x9fd0f0), 2.65, 0.6, 2.05, -1.5, 1.8, 0);
  cy(fb, K.c(0xc8ccd8), 0.06, 0.06, 4.5, 1.6, 0.8, 0, 6);
  for (let i = 0; i < 5; i++) sp(fb, K.f(i % 2 ? 0xffe2a0 : 0xff8a8a), 0.22, 1.6, 2.2 + i * 0.5, 0);
  place(makeChar(randomLook(rng, { outfit: 'casual', hat: 'cap' })), fb, { pos: [2.5, 0.8, 0.4], yaw: PI / 2, pose: 'lean' });
  fb.userData.ph = 0.5; bobbers.push(fb);
  // 海鸥
  const gulls = [];
  for (let i = 0; i < 12; i++) {
    const g = gull(K);
    g.userData.c = new THREE.Vector3(shoreX(0) + (rng() - 0.5) * 60, 14 + rng() * 16, -120 + rng() * 220);
    g.userData.r = 10 + rng() * 18; g.userData.w = (0.25 + rng() * 0.2) * (i % 2 ? 1 : -1); g.userData.ph = rng() * 6;
    root.add(g); gulls.push(g);
  }

  bake(stat);
  return {
    group: root,
    update(t) {
      for (const b of bobbers) {
        b.position.y = SEA_Y + Math.sin(t * 1.2 + b.userData.ph) * 0.15 + (b.userData.dy || 0);
        b.rotation.z = Math.sin(t * 0.9 + b.userData.ph) * 0.06;
      }
      const bt = (t % 2.4) / 2.4;
      ball.position.set(vx - 3 + bt * 6, 1.6 + Math.sin(bt * PI) * 4, 66 + Math.sin(t) * 1.5);
      for (const g of gulls) {
        const u = g.userData, a = t * u.w + u.ph;
        g.position.set(u.c.x + Math.cos(a) * u.r, u.c.y + Math.sin(t * 0.7 + u.ph) * 1.5, u.c.z + Math.sin(a) * u.r);
        const sg = Math.sign(u.w);
        g.rotation.set(sg * 0.35, Math.atan2(-Math.cos(a) * sg, -Math.sin(a) * sg), 0, 'YXZ');
        for (const w of u.wings) w.rotation.x = w.userData.s * Math.sin(t * 7 + u.ph) * 0.5;
      }
    },
  };
}
