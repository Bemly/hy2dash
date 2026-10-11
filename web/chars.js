/**
 * chars.js — Q版二次元角色（约 3.3 头身，站高 ≈ 1.45）
 *
 * 关节层级：root → hips → spine → neck/head(eyes) ; spine → shL/shR → elL/elR ; hips → hipL/hipR → kneeL/kneeR
 * 角色面朝 +Z，左手在 +X。姿势就是一组关节欧拉角 + root 的落位规则：
 *   stand 站 / sit 坐椅子 / seiza 正坐 / cross 盘腿 / lie 平躺 / strap 拉吊环 / wave 挥手
 *   read 看书 / lean 扶栏 / recline 半躺 / float 失重漂浮 / hold 握方向盘
 * 静态角色可以整体 bake 进建筑；乘客只保留头、眼睛（眨眼）和挥手的手臂会动。
 */
import * as THREE from 'three';
import { cel, flat } from './toon.js';
import { bake } from './bake.js';

/* -------------------------- 共享材质/几何 -------------------------- */
const MC = new Map();
function M(color, o = {}) {
  const k = color + JSON.stringify(o, (_, v) => (v && v.isTexture ? v.uuid : v));
  if (!MC.has(k)) MC.set(k, cel(color, { steps: 2, low: 0.78, shadow: 0xc8a0c8, ...o }));
  return MC.get(k);
}
const FC = new Map();
function F(color) { if (!FC.has(color)) FC.set(color, flat(color)); return FC.get(color); }
const GC = new Map();
function G(key, make) { if (!GC.has(key)) GC.set(key, make()); return GC.get(key); }
const sph = (r, w = 16, h = 12) => G(`s${r}|${w}`, () => new THREE.SphereGeometry(r, w, h));
const cap = (r, l) => G(`c${r}|${l}`, () => new THREE.CapsuleGeometry(r, l, 6, 12));
const cyl = (a, b, h, open = false) => G(`y${a}|${b}|${h}|${open}`, () => new THREE.CylinderGeometry(a, b, h, 18, 1, open));

function mesh(geo, mat, p, pos, sc, rot) {
  const m = new THREE.Mesh(geo, mat);
  if (pos) m.position.set(...pos);
  if (sc) m.scale.set(...sc);
  if (rot) m.rotation.set(...rot);
  m.castShadow = true;
  p.add(m);
  return m;
}
const grp = (p, pos, name) => { const g = new THREE.Group(); if (pos) g.position.set(...pos); g.userData.joint = name; p.add(g); return g; };

/* ------------------------------ 配色 ------------------------------ */
export const HAIR = [0xf2a6c0, 0x7f9ee0, 0x5a4038, 0x34344a, 0xf2d27a, 0x8fd0c0, 0xc0a0e6, 0xe58a5a, 0xf6f0f8, 0x6a4a7a];
export const SKIN = [0xffe8d8, 0xffdcc8, 0xf6cfb2];
export const EYE = [0x4a6ad0, 0x7a4ab0, 0x3a9a80, 0xc05a7a, 0x8a5a3a, 0x3a5a9a];
const OUTFITS = ['sailor', 'hoodie', 'dress', 'casual', 'swim', 'yukata', 'suit', 'staff', 'chef', 'pajama', 'astro'];
const STYLES = ['bob', 'long', 'pony', 'twin', 'short', 'bun'];

let yukataTex;
function yukataMap(base) {
  if (!yukataTex) yukataTex = new Map();
  if (yukataTex.has(base)) return yukataTex.get(base);
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const c = cv.getContext('2d');
  c.fillStyle = '#' + new THREE.Color(base).getHexString(); c.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 9; i++) {
    const x = (i * 47) % 128, y = (i * 71) % 128;
    c.fillStyle = i % 2 ? '#ffffff' : '#ffd6e6';
    for (let k = 0; k < 5; k++) {
      const a = k / 5 * Math.PI * 2;
      c.beginPath(); c.arc(x + Math.cos(a) * 6, y + Math.sin(a) * 6, 4.5, 0, 7); c.fill();
    }
    c.fillStyle = '#f2c744'; c.beginPath(); c.arc(x, y, 2.5, 0, 7); c.fill();
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2, 2);
  yukataTex.set(base, t);
  return t;
}

/** 随机生成一套外观（可用 over 覆盖） */
export function randomLook(rng = Math.random, over = {}) {
  const pick = a => a[Math.floor(rng() * a.length)];
  const pastel = [0xf2a6c0, 0x9fd0f0, 0xb8e6a0, 0xffd98a, 0xd0b8f0, 0xffb8a0, 0x9fe0d8, 0xfff2b0, 0xf6f6f6];
  return {
    hair: pick(HAIR), skin: pick(SKIN), eye: pick(EYE), style: pick(STYLES),
    outfit: pick(['sailor', 'hoodie', 'dress', 'casual', 'casual', 'suit']),
    c1: pick(pastel), c2: pick([0x3a4a7a, 0x5a6a9a, 0xf6f6f6, 0x7a5a4a, 0xe07a8a, 0x6ab0d0]),
    hat: rng() < 0.15 ? pick(['straw', 'beret']) : null,
    ahoge: rng() < 0.4,
    kid: false,
    ...over,
  };
}

/* ------------------------------ 构建 ------------------------------ */
export function makeChar(look = randomLook()) {
  const L = { ...randomLook(), ...look };
  const root = new THREE.Group();
  root.userData.isChar = true;
  const skin = M(L.skin, { shadow: 0xe0a0b0, low: 0.82 });
  const hairM = M(L.hair, { shadow: 0x8a7ab8, low: 0.7 });
  let top = M(L.c1), bottom = M(L.c2), sleeve = top, sock = M(0xfdfaf6), shoe = M(0x7a5a4a, { low: 0.7 });
  let longSleeve = true, skirt = true, legsSkin = true, dress = false, robe = false;
  const acc = [];

  switch (L.outfit) {
    case 'sailor': top = M(0xfbfbfb); bottom = M(L.c2 === 0xf6f6f6 ? 0x3a4a7a : L.c2); sleeve = top; acc.push('sailor'); break;
    case 'hoodie': skirt = false; longSleeve = true; acc.push('hood'); sock = M(0xffffff); shoe = M(0xf6f6f6); break;
    case 'dress': bottom = top; dress = true; longSleeve = false; shoe = M(0xe07a8a); break;
    case 'casual': skirt = L.rngSkirt ?? true; longSleeve = false; break;
    case 'swim': top = M(L.c1); bottom = M(L.c1); longSleeve = false; skirt = false; legsSkin = true; acc.push('swim'); shoe = skin; sock = skin; break;
    case 'yukata': top = M(0xffffff, { map: yukataMap(L.c1) }); bottom = top; robe = true; longSleeve = true; acc.push('obi'); shoe = M(0xc49a6c); sock = M(0xfdfaf6); break;
    case 'suit': top = M(0x3a4660); bottom = M(0x3a4660); skirt = false; legsSkin = false; acc.push('tie'); shoe = M(0x2c2c3a); break;
    case 'staff': top = M(0x2c3e66); bottom = M(0x2c3e66); skirt = false; legsSkin = false; acc.push('tie'); L.hat = 'cap'; shoe = M(0x2c2c3a); break;
    case 'chef': top = M(0xfdfdfd); bottom = M(0x4a4a5a); skirt = false; legsSkin = false; L.hat = 'chef'; shoe = M(0x3a3a4a); break;
    case 'pajama': top = M(L.c1); bottom = M(L.c1); skirt = false; legsSkin = false; shoe = skin; sock = skin; acc.push('dots'); break;
    case 'astro': top = M(0xf6f6fa); bottom = M(0xf6f6fa); skirt = false; legsSkin = false; acc.push('astro'); shoe = M(0x9fb0d0); break;
  }
  if (!longSleeve) sleeve = top;

  // ---------- 骨架 ----------
  const hips = grp(root, [0, 0.56, 0], 'hips');
  const spine = grp(hips, [0, 0.02, 0], 'spine');
  const head = grp(spine, [0, 0.39, 0], 'head');
  const eyes = grp(head, [0, 0, 0], 'eyes');
  const shL = grp(spine, [0.15, 0.33, 0], 'shL'), shR = grp(spine, [-0.15, 0.33, 0], 'shR');
  const elL = grp(shL, [0, -0.21, 0], 'elL'), elR = grp(shR, [0, -0.21, 0], 'elR');
  const hipL = grp(hips, [0.072, -0.02, 0], 'hipL'), hipR = grp(hips, [-0.072, -0.02, 0], 'hipR');
  const knL = grp(hipL, [0, -0.27, 0], 'kneeL'), knR = grp(hipR, [0, -0.27, 0], 'kneeR');

  // ---------- 躯干 ----------
  mesh(sph(0.14), bottom, hips, [0, 0, 0], [1.05, 0.72, 0.8]);
  mesh(cap(0.118, 0.17), top, spine, [0, 0.19, 0], [1, 1, 0.8]);
  mesh(cyl(0.042, 0.046, 0.08), skin, spine, [0, 0.36, 0]);
  if (skirt && !dress && !robe && L.outfit !== 'swim') mesh(cyl(0.13, 0.25, 0.22, true), M(bottom.color.getHex(), { side: THREE.DoubleSide }), hips, [0, -0.07, 0]);
  if (dress) mesh(cyl(0.12, 0.27, 0.32, true), M(L.c1, { side: THREE.DoubleSide }), hips, [0, -0.08, 0]);
  if (robe) mesh(cyl(0.14, 0.2, 0.5, true), M(0xffffff, { side: THREE.DoubleSide, map: yukataMap(L.c1) }), hips, [0, -0.2, 0]);

  // 配件
  if (acc.includes('sailor')) {
    mesh(G('collar', () => new THREE.BoxGeometry(0.26, 0.02, 0.16)), M(0x3a4a7a), spine, [0, 0.33, -0.06], null, [0.4, 0, 0]);
    mesh(sph(0.04, 8, 6), M(0xe0505a), spine, [0.03, 0.27, 0.1], [1.2, 0.8, 0.6]);
    mesh(sph(0.04, 8, 6), M(0xe0505a), spine, [-0.03, 0.27, 0.1], [1.2, 0.8, 0.6]);
    mesh(G('rib', () => new THREE.ConeGeometry(0.03, 0.1, 6)), M(0xe0505a), spine, [0, 0.21, 0.1], null, [0, 0, Math.PI]);
  }
  if (acc.includes('tie')) {
    mesh(G('tie', () => new THREE.BoxGeometry(0.04, 0.16, 0.02)), M(L.outfit === 'staff' ? 0xc8a040 : 0xd05060), spine, [0, 0.23, 0.098]);
    mesh(G('shirt', () => new THREE.BoxGeometry(0.1, 0.12, 0.02)), M(0xffffff), spine, [0, 0.27, 0.092]);
  }
  if (acc.includes('hood')) mesh(G('hood', () => new THREE.TorusGeometry(0.11, 0.045, 8, 16)), top, spine, [0, 0.34, -0.06], null, [1.2, 0, 0]);
  if (acc.includes('obi')) mesh(cyl(0.125, 0.125, 0.09), M(L.c2 === 0xf6f6f6 ? 0xe07a8a : L.c2), spine, [0, 0.1, 0], [1, 1, 0.82]);
  if (acc.includes('swim')) mesh(cyl(0.12, 0.12, 0.06), skin, spine, [0, 0.12, 0], [1, 1, 0.8]);
  if (acc.includes('astro')) {
    mesh(G('pack', () => new THREE.BoxGeometry(0.2, 0.22, 0.1)), M(0x9fb0d0), spine, [0, 0.2, -0.12]);
    mesh(G('badge', () => new THREE.CircleGeometry(0.03, 10)), F(0x6fb5e8), spine, [0.05, 0.27, 0.095]).userData.noInk = true;
  }

  // ---------- 手臂 ----------
  for (const [sh, el, s] of [[shL, elL, 1], [shR, elR, -1]]) {
    mesh(sph(0.055, 10, 8), sleeve, sh, [0, -0.01, 0]);
    mesh(cap(0.04, 0.13), longSleeve ? sleeve : skin, sh, [0, -0.1, 0]);
    if (!longSleeve) mesh(cyl(0.05, 0.055, 0.07), sleeve, sh, [0, -0.04, 0]);
    mesh(cap(0.036, 0.12), longSleeve ? sleeve : skin, el, [0, -0.08, 0]);
    mesh(sph(0.042, 10, 8), L.outfit === 'staff' ? M(0xffffff) : skin, el, [0, -0.19, 0.005]);
  }

  // ---------- 腿 ----------
  for (const [hp, kn] of [[hipL, knL], [hipR, knR]]) {
    mesh(cap(0.052, 0.17), (skirt || dress || L.outfit === 'swim') && legsSkin ? skin : bottom, hp, [0, -0.13, 0]);
    if (robe) mesh(cap(0.056, 0.15), top, hp, [0, -0.13, 0]);
    mesh(cap(0.045, 0.15), legsSkin ? skin : bottom, kn, [0, -0.11, 0]);
    if (legsSkin && sock !== skin) mesh(cyl(0.049, 0.047, L.outfit === 'sailor' ? 0.16 : 0.07), sock, kn, [0, L.outfit === 'sailor' ? -0.15 : -0.19, 0]);
    mesh(sph(0.06, 10, 8), shoe, kn, [0, -0.245, 0.03], [1, 0.75, 1.55]);
  }

  // ---------- 头 ----------
  const hr = 0.23;
  mesh(sph(hr, 24, 18), skin, head, [0, 0.2, 0], [1, 0.95, 0.97]);
  for (const s of [-1, 1]) mesh(sph(0.04, 8, 6), skin, head, [s * 0.225, 0.17, 0], [0.5, 1, 0.8]);
  // 眼睛（大而竖长，两颗高光）
  const iris = F(L.eye), dark = F(0x2a2a40), white = F(0xffffff);
  for (const s of [-1, 1]) {
    const e = mesh(sph(0.052, 14, 10), iris, eyes, [s * 0.085, 0.165, 0.198], [0.78, 1.18, 0.32]); e.userData.noInk = true;
    const p = mesh(sph(0.03, 10, 8), dark, eyes, [s * 0.085, 0.16, 0.214], [0.8, 1.15, 0.3]); p.userData.noInk = true;
    const h1 = mesh(sph(0.016, 8, 6), white, eyes, [s * 0.085 + 0.016, 0.19, 0.222]); h1.userData.noInk = true;
    const h2 = mesh(sph(0.008, 6, 4), white, eyes, [s * 0.085 - 0.014, 0.142, 0.222]); h2.userData.noInk = true;
    const lash = mesh(G('lash', () => new THREE.BoxGeometry(0.085, 0.014, 0.02)), dark, eyes, [s * 0.087, 0.225, 0.2], null, [0, 0, s * -0.18]); lash.userData.noInk = true;
    const brow = mesh(G('brow', () => new THREE.BoxGeometry(0.06, 0.01, 0.01)), F(new THREE.Color(L.hair).multiplyScalar(0.7).getHex()), head, [s * 0.085, 0.27, 0.205], null, [0, 0, s * -0.12]); brow.userData.noInk = true;
    const bl = mesh(G('blush', () => new THREE.CircleGeometry(0.03, 12)), F(0xffb8c8), head, [s * 0.13, 0.115, 0.19], [1.4, 0.8, 1], [0, s * 0.55, 0]); bl.userData.noInk = true;
  }
  // 闭眼（睡觉用），默认隐藏
  const closed = grp(head, [0, 0, 0], 'closed');
  for (const s of [-1, 1]) {
    const c = mesh(G('closedEye', () => new THREE.TorusGeometry(0.035, 0.008, 4, 10, Math.PI)), dark, closed, [s * 0.085, 0.16, 0.205], null, [0, 0, Math.PI]); c.userData.noInk = true;
  }
  closed.visible = false;
  const mouth = mesh(G('mouth', () => new THREE.TorusGeometry(0.022, 0.007, 4, 10, Math.PI)), F(0xc0506a), head, [0, 0.08, 0.215], null, [0, 0, Math.PI]);
  mouth.userData.noInk = true;

  // ---------- 头发 ----------
  mesh(G('hcap', () => new THREE.SphereGeometry(0.248, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.56)), hairM, head, [0, 0.215, -0.012], null, [-0.32, 0, 0]);
  mesh(sph(0.24, 20, 14), hairM, head, [0, 0.19, -0.04], [1.03, 0.98, 0.96]);
  // 刘海
  for (let i = 0; i < 7; i++) {
    const a = (i - 3) / 3;
    mesh(sph(0.06, 8, 6), hairM, head, [a * 0.15, 0.3 - Math.abs(a) * 0.03, 0.19 - Math.abs(a) * 0.04], [0.85, 1.7, 0.5], [0.25, 0, -a * 0.35]);
  }
  // 鬓角
  for (const s of [-1, 1]) mesh(cap(0.045, 0.16), hairM, head, [s * 0.2, 0.08, 0.06], [1, 1, 0.6], [0, 0, s * 0.08]);
  switch (L.style) {
    case 'bob': mesh(sph(0.25, 20, 14), hairM, head, [0, 0.12, -0.05], [1.1, 0.85, 1.0]); break;
    case 'long': mesh(cap(0.2, 0.42), hairM, head, [0, -0.12, -0.12], [1.1, 1, 0.45]); break;
    case 'pony':
      mesh(cap(0.08, 0.34), hairM, head, [0, 0.06, -0.3], null, [0.35, 0, 0]);
      mesh(G('scr', () => new THREE.TorusGeometry(0.05, 0.02, 6, 12)), M(L.c1), head, [0, 0.26, -0.26], null, [1.2, 0, 0]);
      break;
    case 'twin':
      for (const s of [-1, 1]) {
        mesh(cap(0.075, 0.38), hairM, head, [s * 0.27, 0.0, -0.06], null, [0, 0, s * 0.12]);
        mesh(G('ribbon', () => new THREE.ConeGeometry(0.06, 0.12, 4)), M(0xf26a8a), head, [s * 0.25, 0.28, -0.05], null, [0, 0, s * 1.4]);
      }
      break;
    case 'short':
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * Math.PI * 2;
        mesh(G('spike', () => new THREE.ConeGeometry(0.07, 0.16, 6)), hairM, head, [Math.cos(a) * 0.17, 0.32, Math.sin(a) * 0.15 - 0.04], null, [Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6]);
      }
      break;
    case 'bun':
      mesh(sph(0.1, 12, 10), hairM, head, [0, 0.42, -0.1]);
      mesh(sph(0.25, 20, 14), hairM, head, [0, 0.14, -0.05], [1.06, 0.8, 1.0]);
      break;
  }
  if (L.ahoge) mesh(G('ahoge', () => new THREE.TorusGeometry(0.06, 0.012, 4, 10, Math.PI * 1.2)), hairM, head, [0.02, 0.47, 0.02], null, [0, 1.2, 0]);
  // 帽子
  if (L.hat === 'cap') {
    mesh(cyl(0.2, 0.23, 0.1), M(0x2c3e66), head, [0, 0.39, -0.01]);
    mesh(cyl(0.24, 0.24, 0.03), M(0x2c3e66), head, [0, 0.45, -0.01]);
    mesh(G('visor', () => new THREE.BoxGeometry(0.2, 0.015, 0.1)), M(0x1c2436), head, [0, 0.35, 0.21], null, [0.25, 0, 0]);
    mesh(G('cband', () => new THREE.CylinderGeometry(0.205, 0.235, 0.025, 18)), M(0xc8a040), head, [0, 0.36, -0.01]);
  } else if (L.hat === 'straw') {
    mesh(cyl(0.38, 0.38, 0.015), M(0xf2dc9a), head, [0, 0.38, -0.02], null, [-0.12, 0, 0]);
    mesh(cyl(0.17, 0.2, 0.12), M(0xf2dc9a), head, [0, 0.44, -0.03], null, [-0.12, 0, 0]);
    mesh(cyl(0.205, 0.205, 0.04), M(0xe07a8a), head, [0, 0.41, -0.025], null, [-0.12, 0, 0]);
  } else if (L.hat === 'beret') {
    mesh(sph(0.2, 14, 10), M(L.c2), head, [0.04, 0.42, -0.02], [1.15, 0.38, 1.1], [0, 0, -0.2]);
  } else if (L.hat === 'chef') {
    mesh(cyl(0.18, 0.18, 0.2), M(0xffffff), head, [0, 0.47, 0]);
    mesh(sph(0.2, 14, 10), M(0xffffff), head, [0, 0.6, 0], [1, 0.6, 1]);
  }

  if (L.kid) root.scale.setScalar(0.78);

  // ---------- 控制 ----------
  const J = { hips, spine, head, eyes, closed, shL, shR, elL, elR, hipL, hipR, knL, knR };
  const ch = {
    root, J, look: L, pose: 'stand', ph: Math.random() * 10, base: {}, armWave: false,
    lean: 0,
    setPose(name) { applyPose(ch, name); return ch; },
    update(t) {
      const ph = ch.ph;
      spine.scale.y = 1 + Math.sin(t * 2.1 + ph) * 0.012;
      head.rotation.y = (ch.base.hy || 0) + Math.sin(t * 0.37 + ph) * 0.22 * (ch.pose === 'lie' ? 0.3 : 1);
      head.rotation.x = (ch.base.hx || 0) + Math.sin(t * 0.53 + ph * 2) * 0.05;
      head.rotation.z = (ch.base.hz || 0) + ch.lean * 0.5;
      spine.rotation.z = (ch.base.sz || 0) + ch.lean;
      const blink = ((t + ph) % 3.7) < 0.12;
      if (!closed.visible) eyes.scale.y = blink ? 0.12 : 1;
      if (ch.armWave) {
        shR.rotation.z = -2.5 + Math.sin(t * 5 + ph) * 0.25;
        elR.rotation.z = -0.4 + Math.sin(t * 5 + ph + 1) * 0.4;
      }
      if (ch.pose === 'float') {
        root.rotation.z = Math.sin(t * 0.6 + ph) * 0.25;
        shL.rotation.z = 1.1 + Math.sin(t * 1.1) * 0.2;
        shR.rotation.z = -1.1 - Math.sin(t * 1.1) * 0.2;
      }
      if (ch.pose === 'walk') {
        const w = Math.sin(t * 6 + ph);
        hipL.rotation.x = w * 0.5; hipR.rotation.x = -w * 0.5;
        knL.rotation.x = Math.max(0, -w) * 0.7; knR.rotation.x = Math.max(0, w) * 0.7;
        shL.rotation.x = -w * 0.45; shR.rotation.x = w * 0.45;
        hips.position.y = 0.56 + Math.abs(Math.cos(t * 6 + ph)) * 0.025;
      }
    },
    /** 静态角色：把身体合并到少量网格（只留头/眼/挥手臂会动） */
    freeze(full = false) {
      if (full) { bake(root); return ch; }
      bake(head, { keep: o => o === eyes || o === closed });
      bake(root, { keep: o => o === head || (ch.armWave && o === shR) });
      return ch;
    },
  };
  root.userData.char = ch;
  return ch;
}

/* ------------------------------ 姿势 ------------------------------ */
const P = Math.PI;
const POSES = {
  stand:   { shL: [0, 0, 0.1], shR: [0, 0, -0.1], elL: [-0.15, 0, 0], elR: [-0.15, 0, 0] },
  sit:     { hipL: [-1.57, 0, 0.05], hipR: [-1.57, 0, -0.05], knL: [1.5, 0, 0], knR: [1.5, 0, 0], shL: [-0.35, 0, 0.12], shR: [-0.35, 0, -0.12], elL: [-0.7, 0, 0], elR: [-0.7, 0, 0] },
  seiza:   { hipL: [-1.45, 0, 0.04], hipR: [-1.45, 0, -0.04], knL: [2.95, 0, 0], knR: [2.95, 0, 0], shL: [-0.45, 0, 0.12], shR: [-0.45, 0, -0.12], elL: [-0.9, 0, 0], elR: [-0.9, 0, 0] },
  cross:   { hipL: [-1.35, 0, 0.75], hipR: [-1.35, 0, -0.75], knL: [2.4, 0, 0], knR: [2.4, 0, 0], shL: [-0.4, 0, 0.2], shR: [-0.4, 0, -0.2], elL: [-0.6, 0, 0], elR: [-0.6, 0, 0] },
  lie:     { shL: [0, 0, 0.28], shR: [0, 0, -0.28], hipL: [0, 0, 0.05], hipR: [0, 0, -0.05], knL: [0.15, 0, 0], head: [0.15, 0.5, 0] },
  recline: { spine: [-0.5, 0, 0], hipL: [-1.1, 0, 0.05], hipR: [-1.1, 0, -0.05], knL: [0.9, 0, 0], knR: [0.9, 0, 0], shL: [-0.2, 0, 0.2], shR: [-0.2, 0, -0.2], elL: [-1.1, 0, 0], elR: [-1.1, 0, 0], head: [0.35, 0, 0] },
  strap:   { shR: [0, 0, -2.85], elR: [0, 0, -0.25], shL: [0, 0, 0.12], elL: [-0.3, 0, 0] },
  wave:    { shR: [0, 0, -2.5], elR: [0, 0, -0.4], shL: [0, 0, 0.12] },
  read:    { hipL: [-1.57, 0, 0.05], hipR: [-1.57, 0, -0.05], knL: [1.5, 0, 0], knR: [1.5, 0, 0], shL: [-0.9, 0, 0.25], shR: [-0.9, 0, -0.25], elL: [-1.1, 0, -0.5], elR: [-1.1, 0, 0.5], head: [0.35, 0, 0] },
  lean:    { spine: [0.15, 0, 0], shL: [-1.2, 0, 0.25], shR: [-1.2, 0, -0.25], elL: [-0.5, 0, 0], elR: [-0.5, 0, 0], head: [0.05, 0, 0] },
  float:   { hipL: [-0.4, 0, 0.2], hipR: [0.3, 0, -0.15], knL: [0.6, 0, 0], knR: [0.3, 0, 0], shL: [0, 0, 1.1], shR: [0, 0, -1.1] },
  hold:    { hipL: [-1.57, 0, 0.05], hipR: [-1.57, 0, -0.05], knL: [1.5, 0, 0], knR: [1.5, 0, 0], shL: [-1.15, 0, 0.1], shR: [-1.15, 0, -0.1], elL: [-0.35, 0, 0], elR: [-0.35, 0, 0] },
  walk:    {},
  cheer:   { shL: [0, 0, 2.6], shR: [0, 0, -2.6], elL: [0, 0, 0.3], elR: [0, 0, -0.3] },
  sleep:   { shL: [0, 0, 0.28], shR: [0, 0, -0.28], knL: [0.2, 0, 0], head: [0.1, 0.6, 0] },
};

function applyPose(ch, name) {
  const J = ch.J, p = POSES[name] || POSES.stand;
  ch.pose = name;
  for (const k of ['spine', 'shL', 'shR', 'elL', 'elR', 'hipL', 'hipR', 'knL', 'knR', 'head']) {
    const r = p[k] || [0, 0, 0];
    J[k].rotation.set(r[0], r[1], r[2]);
  }
  ch.base = { hx: (p.head || [0])[0], hy: (p.head || [0, 0])[1], sz: 0 };
  ch.armWave = name === 'wave';
  if (name === 'read' && !J.book) {           // 摊开的书
    const b = new THREE.Group();
    for (const s of [-1, 1]) {
      const pg = new THREE.Mesh(G('page', () => new THREE.BoxGeometry(0.12, 0.16, 0.015)), M(s > 0 ? 0xfdfaf2 : 0xf6f0e0));
      pg.position.x = s * 0.06; pg.rotation.y = -s * 0.25; b.add(pg);
    }
    const cv = new THREE.Mesh(G('cover', () => new THREE.BoxGeometry(0.26, 0.17, 0.01)), M(0xe07a8a));
    cv.position.z = -0.015; b.add(cv);
    b.position.set(0, 0.12, 0.27); b.rotation.x = -0.75;
    J.spine.add(b); J.book = b;
  }
  J.closed.visible = name === 'sleep';
  J.eyes.visible = name !== 'sleep';
  if (name === 'sleep') { ch.root.userData.lying = true; }
  return ch;
}

/**
 * 把角色安放到某处
 *   surface: 坐/躺时的接触面高度（椅面、床面、地面）
 *   姿势决定 root 的偏移：坐 → 臀部落在椅面；躺 → 整个人转平
 */
export function place(ch, parent, { pos = [0, 0, 0], yaw = 0, pose = 'stand', surface = null }) {
  ch.setPose(pose);
  const r = ch.root, k = ch.look.kid ? 0.78 : 1;
  r.rotation.set(0, yaw, 0);
  const y0 = surface ?? pos[1];
  let y = pos[1];
  if (pose === 'sit' || pose === 'read' || pose === 'hold') y = y0 - 0.5 * k;
  else if (pose === 'seiza') y = y0 - 0.4 * k;
  else if (pose === 'cross') y = y0 - 0.45 * k;
  else if (pose === 'recline') y = y0 - 0.46 * k;
  else if (pose === 'lie' || pose === 'sleep') {
    r.rotation.set(-Math.PI / 2, yaw, 0, 'YXZ');
    y = y0 + 0.14 * k;
  }
  // 躺姿：root 原点在脚底，转平后头朝 yaw 旋转后的 -Z 方向
  r.position.set(pos[0], y, pos[2]);
  parent.add(r);
  return ch;
}

/** 便捷：随机角色 + 安放 */
export function person(parent, opts = {}, look = {}, rng = Math.random) {
  const ch = makeChar(randomLook(rng, look));
  return place(ch, parent, opts);
}

/** 简易种子随机，让每次生成的场景一致 */
export function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** 让角色跟随剖切平面（房子里的住户：楼层被切掉时人也一起切掉，不会悬空） */
const CLIP = new Map();
export function clipChars(root, planes) {
  const id = planes.__cid || (planes.__cid = Math.random().toString(36).slice(2));
  root.traverse(o => {
    if (!o.isMesh || o.userData.isInk) return;
    let a = o, isChar = false;
    while (a) { if (a.userData.isChar) { isChar = true; break; } a = a.parent; }
    if (!isChar) return;
    const k = o.material.uuid + id;
    if (!CLIP.has(k)) {
      const m = o.material.clone();
      m.clippingPlanes = planes; m.clipShadows = true;
      CLIP.set(k, m);
    }
    o.material = CLIP.get(k);
  });
}
