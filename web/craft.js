/**
 * craft.js — 异世界飞行器机队（真人比例 + 完整内饰 + 乘客）
 *
 * 角色站高约 1.45，所以每台机体都按「人能坐进去」的尺寸重做：
 *   折纸机  ：纸盒驾驶座 + 机翼上晒太阳 / 盘腿坐
 *   茶壶船  ：壶里是一间榻榻米茶室
 *   水母艇  ：伞盖下的环形观景台
 *   猫巴士  ：毛绒座椅车厢，后排有小孩在睡觉
 *   空中電車：长条座椅、吊环、中吊广告、司机室
 *   金鱼灯笼：鱼背骑手 + 灯笼里的祭典小摊
 *   蒲公英伞：吊篮 + 吊床
 *   汽水火箭：玻璃瓶身里的躺椅座舱，有人在失重漂浮
 *   天空鲸  ：背上凉亭 + 腹中酒廊（吧台、钢琴、床铺）
 * 机头统一朝 +X。剖切平面挂在 G.userData.cut 上，由 Flight 每帧更新。
 */
import * as THREE from 'three';
import { cel, flat } from './toon.js';
import { Kit, bx, cy, sp, plane, G as grp, at, sofa, coffeeTable, chabudai, teaSet, zabuton, bed, plant, pendant,
  rug, stool, counter, cat, bookshelf, tatami, woodFloor, wall, poster } from './interior.js';
import { makeChar, randomLook, place, seeded } from './chars.js';
import { bake } from './bake.js';

const FONT = '"Hiragino Sans","PingFang SC",sans-serif';
const PI = Math.PI;

/* ------------------------------ 公共件 ------------------------------ */
function labelTex(text, { w = 256, h = 64, bg = '#2c3e5c', fg = '#ffd98a', size = 34 } = {}) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  c.fillStyle = bg; c.fillRect(0, 0, w, h);
  c.fillStyle = fg; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.font = `800 ${size}px ${FONT}`;
  c.fillText(text, w / 2, h / 2 + 2);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 尾焰：锥体沿 -X */
function thruster(parent, pos, color = 0x8fe8ff, scale = 1) {
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.3 * scale, 1.1 * scale, 12), flat(color));
  cone.rotation.z = PI / 2;
  cone.position.copy(pos);
  cone.userData.noInk = true;
  cone.userData.jet = true;
  parent.add(cone);
  return cone;
}

/** 每台机体一套带剖切平面的材质工厂 */
function kit(G, cutY) {
  const pl = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
  G.userData.cut = { plane: pl, y: cutY };
  G.userData.chars = [];
  return new Kit({ planes: [pl] });
}

/** 安排乘客：pose/pos/yaw/surface 见 chars.place */
function crew(G, parent, rng, list) {
  for (const it of list) {
    const ch = makeChar(randomLook(rng, it.look || {}));
    place(ch, parent, it);
    ch.freeze();
    // 位于剖切面以上的乘客（甲板、鞍座上的人）：剖切时一起隐藏，免得悬空
    const y = (parent === G ? 0 : parent.position.y) + (it.surface ?? it.pos[1]);
    if (y > G.userData.cut.y - 0.2) ch.upper = true;
    if (it.lean) ch.leanable = true;
    G.userData.chars.push(ch);
  }
}

const ANIM = ['jet', 'steam', 'tentacle', 'leg', 'flap', 'tailwag', 'bubble', 'spin', 'swing', 'fluke', 'spout', 'pulse', 'wheel'];
const isAnim = o => o.userData.isChar || ANIM.some(k => o.userData[k] !== undefined);
/** 合并静态零件；会动的部件和角色原样保留，容器里再递归合并 */
function finish(node) {
  bake(node, { keep: isAnim });
  const kept = [];
  (function f(o) { for (const c of o.children) { if (isAnim(c)) kept.push(c); else f(c); } })(node);
  kept.forEach(k => { if (!k.userData.isChar && !k.isMesh) finish(k); });
  return node;
}

function featherWing(side, mat, span = 2.4) {
  const pivot = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 8), mat);
    const len = span * (1 - i * 0.22);
    f.scale.set(0.6 - i * 0.1, 0.12, len);
    f.position.set(-0.4 * i, -0.08 * i, side * len * 0.48);
    f.rotation.y = side * 0.18 * i;
    f.castShadow = true;
    pivot.add(f);
  }
  pivot.userData.flap = side;
  return pivot;
}

/** 悬挂的触手/绳：pivot 在顶端，网格向下 */
function dangle(parent, mat, x, y, z, len, r0, r1, ph, key = 'tentacle') {
  const p = new THREE.Group();
  p.position.set(x, y, z);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, len, 7, 6), mat);
  m.position.y = -len / 2;
  p.add(m);
  p.userData[key] = { ph };
  parent.add(p);
  return p;
}

/* ============================== 1. 折纸机 ============================== */
export function paper() {
  const G = new THREE.Group();
  const K = kit(G, 3);
  const rng = seeded(11);
  const note = K.tex('note', 256, 256, (c) => {
    c.fillStyle = '#fffdf5'; c.fillRect(0, 0, 256, 256);
    c.strokeStyle = 'rgba(120,160,220,.5)'; c.lineWidth = 2;
    for (let y = 12; y < 256; y += 18) { c.beginPath(); c.moveTo(0, y); c.lineTo(256, y); c.stroke(); }
    c.strokeStyle = 'rgba(230,120,140,.6)'; c.beginPath(); c.moveTo(40, 0); c.lineTo(40, 256); c.stroke();
    c.fillStyle = 'rgba(242,166,192,.8)';
    c.font = `800 26px ${FONT}`; c.fillText('★ SKY', 120, 120);
  }, [2, 2]);
  const w = K.c(0xffffff, { side: THREE.DoubleSide, map: note, low: 0.8, shadow: 0x9fb4dd });
  const w2 = K.c(0xf2e8d6, { side: THREE.DoubleSide, low: 0.78, shadow: 0x97a8cc });
  const tri = (a, b, c, m) => {
    const geo = new THREE.BufferGeometry();
    const pos = [...a, ...b, ...c];
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([a[0] / 5, a[2] / 5, b[0] / 5, b[2] / 5, c[0] / 5, c[2] / 5], 2));
    geo.computeVertexNormals();
    const o = new THREE.Mesh(geo, m); o.castShadow = o.receiveShadow = true; G.add(o); return o;
  };
  const N = [5.6, 0, 0], TL = [-5.6, 0.25, 4.7], TR = [-5.6, 0.25, -4.7], TC = [-5.6, 0, 0], KB = [-4.9, -1.5, 0];
  tri(N, TC, TL, w); tri(N, TR, TC, w); tri(N, KB, TC, w2);
  tri(TL, [-3.4, 0.17, 3.35], [-5.3, 1.25, 4.6], w2);
  tri(TR, [-5.3, 1.25, -4.6], [-3.4, 0.17, -3.35], w2);
  bx(G, K.c(0xd8c8a8), 11, 0.04, 0.04, 0, 0.0, 0).userData.inkWidth = 0.001;

  // 纸盒驾驶座
  const pm = K.c(0xfdf2dc, { side: THREE.DoubleSide });
  const ck = grp(); at(ck, 1.4, 0.02, 0); G.add(ck);
  bx(ck, pm, 1.5, 0.55, 0.04, 0, 0, 0.62); bx(ck, pm, 1.5, 0.55, 0.04, 0, 0, -0.62);
  bx(ck, pm, 0.04, 0.75, 1.24, 0.75, 0, 0); bx(ck, pm, 0.04, 0.55, 1.24, -0.75, 0, 0);
  bx(ck, K.c(0xf2a6c0), 0.55, 0.42, 0.6, -0.3, 0, 0);
  bx(ck, K.c(0xf2a6c0), 0.12, 0.55, 0.6, -0.58, 0.42, 0);
  cy(ck, K.c(0x7ec4d8), 0.025, 0.025, 0.5, 0.35, 0, 0, 6);
  sp(ck, K.c(0xe07a8a), 0.06, 0.35, 0.52, 0);
  // 纸风车（尾部，会转）
  const pwBase = grp(); at(pwBase, -5.2, 0.2, 0); G.add(pwBase);
  cy(pwBase, K.c(0xc49a6c), 0.03, 0.03, 1.4, 0, 0, 0, 6);
  const pw = grp(); pw.position.y = 1.45; pw.rotation.z = -PI / 2; pwBase.add(pw);
  const spin = grp(); pw.add(spin); spin.userData.spin = 3;
  for (let i = 0; i < 4; i++) {
    const b = bx(spin, K.c([0xf2a6c0, 0x7ec4d8, 0xf2c744, 0x8fd09a][i], { side: THREE.DoubleSide }), 0.32, 0.02, 0.5, 0, 0, 0.28);
    const s = grp(); s.rotation.y = i * PI / 2; s.add(b); spin.add(s); b.rotation.x = 0.4;
  }
  // 机翼上的浴巾
  bx(G, K.c(0x9fd8f0), 2.0, 0.03, 0.9, -2.3, 0.1, 2.05).rotation.y = 0;
  for (let i = 0; i < 4; i++) bx(G, K.c(0xffffff), 0.15, 0.032, 0.9, -3.1 + i * 0.5, 0.1, 2.05).userData.noInk = true;
  sp(G, K.c(0xff7a5a), 0.25, -1.0, 0.35, -2.6);                        // 沙滩球
  bx(G, K.c(0xfdfaf2), 0.3, 0.25, 0.2, -2.8, 0.1, -1.9);              // 便当

  crew(G, ck, rng, [{ pos: [-0.3, 0, 0], yaw: PI / 2, pose: 'hold', surface: 0.42, look: { outfit: 'casual', hat: null, style: 'short', ahoge: true } }]);
  crew(G, G, rng, [
    { pos: [-3.25, 0, 2.05], yaw: -PI / 2, pose: 'lie', surface: 0.13, look: { outfit: 'swim', hat: 'straw' } },
    { pos: [-1.9, 0, -2.0], yaw: PI / 2 - 0.3, pose: 'cross', surface: 0.1, look: { outfit: 'dress' } },
  ]);
  thruster(G, new THREE.Vector3(-5.7, -0.3, 0), 0xffd98a, 1.0);
  G.userData.cabin = { pos: [-0.9, 1.7, 0], look: [6, 0.9, 0] };
  G.userData.seats = 3;
  return finish(G);
}

/* ============================== 2. 茶壶船 ============================== */
export function teapot() {
  const G = new THREE.Group();
  const FLOOR = -1.4;
  const K = kit(G, FLOOR + 1.85);
  const rng = seeded(22);
  const R = 3.2, SY = 0.86;
  const shell = K.hull(0xf4f8fa, 0xfff0dc);
  const trim = K.c(0x7ec4d8, { low: 0.75 });

  const pot = new THREE.Mesh(new THREE.SphereGeometry(R, 48, 32), shell);
  pot.scale.y = SY; pot.castShadow = pot.receiveShadow = true; G.add(pot);
  const belt = new THREE.Mesh(new THREE.TorusGeometry(R * 0.99, 0.1, 8, 64), trim);
  belt.rotation.x = PI / 2; belt.position.y = 0.2; G.add(belt);
  // 腰线上的樱花纹
  for (let i = 0; i < 10; i++) {
    const a = i / 10 * PI * 2;
    const f = sp(G, K.c(0xf2a6c0), 0.18, Math.cos(a) * R * 0.985, -0.6, Math.sin(a) * R * 0.985, 0.4, 1, 1);
    f.lookAt(0, -0.6, 0);
  }
  cy(G, K.hull(0xf4f8fa, 0xfff0dc), 1.7, 2.0, 0.4, 0, -R * SY - 0.2, 0, 32);          // 壶底圈足
  const spout = cy(G, shell, 0.38, 0.85, 4.1, 0, 0, 0, 20);
  spout.position.set(3.55, 1.0, 0); spout.rotation.z = -1.05;
  const tip = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.08, 8, 20), trim);
  tip.position.set(5.3, 2.05, 0); tip.rotation.set(0, PI / 2, -1.05); tip.rotation.order = 'ZYX'; G.add(tip);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.3, 12, 28, PI * 1.25), shell);
  handle.position.set(-3.0, 0.5, 0); handle.rotation.set(PI / 2, 0, -0.5); G.add(handle);
  cy(G, trim, 1.6, 1.9, 0.5, 0, R * SY - 0.32, 0, 32);
  sp(G, trim, 0.42, 0, R * SY + 0.55, 0);
  // 舷窗：外圈金属框 + 外侧玻璃 + 内侧透光
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * PI * 2 + 0.25;
    if (Math.abs(Math.cos(a) - 1) < 0.15) continue;
    const y = 0.75, rr = R * Math.sqrt(1 - (y / (R * SY)) ** 2);
    const p = new THREE.Vector3(Math.cos(a) * rr, y, Math.sin(a) * rr);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.07, 8, 20), trim);
    ring.position.copy(p).multiplyScalar(1.005); ring.lookAt(p.clone().multiplyScalar(2)); G.add(ring);
    const gl = new THREE.Mesh(new THREE.CircleGeometry(0.4, 20), K.f(0xcfeefa));
    gl.position.copy(p).multiplyScalar(1.004); gl.lookAt(p.clone().multiplyScalar(2)); gl.userData.noInk = true; G.add(gl);
    const inn = new THREE.Mesh(new THREE.CircleGeometry(0.4, 20), K.f(0xfff6d8));
    inn.position.copy(p).multiplyScalar(0.985); inn.lookAt(0, y, 0); inn.userData.noInk = true; G.add(inn);
  }
  // 圆门
  const door = new THREE.Mesh(new THREE.CircleGeometry(0.8, 24), K.c(0xc49a6c));
  const dp = new THREE.Vector3(0, -0.4, R * Math.sqrt(1 - (0.4 / (R * SY)) ** 2) + 0.02);
  door.position.copy(dp); door.scale.y = 1.4; G.add(door);

  // ---- 茶室 ----
  const fr = R * Math.sqrt(1 - (FLOOR / (R * SY)) ** 2) - 0.05;
  const floor = cy(G, K.c(0xffffff, { map: tatami(K) }), fr, fr, 0.12, 0, FLOOR - 0.12, 0, 40);
  floor.receiveShadow = true;
  const tb = chabudai(K); at(tb, 0, FLOOR, 0); G.add(tb);
  const ts = teaSet(K); at(ts, 0, FLOOR + 0.35, 0); G.add(ts);
  const seats = [];
  [0.4, 2.5, 4.4].forEach((a, i) => {
    const z = zabuton(K, [0xd96a7a, 0x7ec4d8, 0xf2c744][i]);
    const x = Math.cos(a) * 1.05, zz = Math.sin(a) * 1.05;
    at(z, x, FLOOR, zz, -a); G.add(z);
    seats.push({ pos: [x, 0, zz], yaw: Math.atan2(-x, -zz), pose: 'seiza', surface: FLOOR + 0.08 });
  });
  // 火钵 + 铁壶
  cy(G, K.c(0xc49a6c), 0.32, 0.28, 0.4, -1.9, FLOOR, 0.9, 16);
  cy(G, K.c(0x5a5a6a), 0.2, 0.18, 0.22, -1.9, FLOOR + 0.42, 0.9, 14);
  // 墙边矮柜 + 茶罐
  const sh = grp(); at(sh, -1.6, FLOOR, -1.8, 0.7); G.add(sh);
  bx(sh, K.c(0xb07a4a), 1.2, 0.6, 0.4, 0, 0, 0);
  for (let i = 0; i < 4; i++) cy(sh, K.c([0x8fd09a, 0xe07a8a, 0xf2c744, 0x7ec4d8][i]), 0.08, 0.08, 0.2, -0.42 + i * 0.28, 0.6, 0, 12);
  // 挂轴
  const sc = grp(); at(sc, 2.55, FLOOR + 0.5, -0.9); sc.lookAt(0, FLOOR + 0.5, 0); G.add(sc);
  plane(sc, K.f(0xffffff, { map: K.tex('kakejiku', 64, 160, (c) => {
    c.fillStyle = '#f6efe0'; c.fillRect(0, 0, 64, 160);
    c.fillStyle = '#8fa86a'; c.fillRect(0, 0, 64, 12); c.fillRect(0, 148, 64, 12);
    c.fillStyle = '#2c3e5c'; c.font = `900 34px ${FONT}`; c.textAlign = 'center';
    c.fillText('一', 32, 56); c.fillText('期', 32, 92); c.fillText('一会', 32, 128);
  }) }), 0.45, 1.1, 0, 0.55, 0);
  G.add(at(pendant(K, { y: R * SY - 0.3, drop: 0.9, color: 0xfff2c8 }), 0, 0, 0));
  const ct = cat(K, 0xf2c48a); at(ct, 1.9, FLOOR, -0.8, 0.6); G.add(ct);
  crew(G, G, rng, seats.map((s, i) => ({ ...s, look: { outfit: ['yukata', 'sailor', 'hoodie'][i] } })));

  // 蒸汽
  for (let i = 0; i < 5; i++) {
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.45 - i * 0.05, 10, 8), flat(0xffffff));
    p.position.set(5.6 + i * 0.6, 2.4 + i * 0.5, 0);
    p.userData.noInk = true; p.userData.steam = { i, x: 5.6, y: 2.4 };
    G.add(p);
  }
  thruster(G, new THREE.Vector3(-3.6, -1.4, 0), 0xffc8e8, 1.2);
  G.userData.cabin = { pos: [1.9, FLOOR + 1.35, 1.4], look: [-1.2, FLOOR + 0.4, -0.6] };
  G.userData.seats = 3;
  return finish(G);
}

/* ============================== 3. 水母艇 ============================== */
export function jelly() {
  const G = new THREE.Group();
  const K = kit(G, 2.4);
  const rng = seeded(33);
  const R = 4.4;
  const bell = K.c(0xecc0f4, { transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false, low: 0.86 });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(R, 48, 20, 0, PI * 2, 0, PI / 2), bell);
  dome.scale.y = 1.05; dome.userData.pulse = true; dome.userData.noInk = true; G.add(dome);
  for (let i = 0; i < 10; i++) {
    const m = new THREE.Mesh(new THREE.TorusGeometry(R * 1.003, 0.05, 6, 32, PI / 2), K.c(0xf8dcfc));
    m.rotation.y = i / 10 * PI * 2; m.scale.y = 1.05; m.userData.noInk = true; G.add(m);
  }
  const hem = new THREE.Mesh(new THREE.TorusGeometry(R, 0.2, 10, 64), K.c(0xf6d0f8));
  hem.rotation.x = PI / 2; G.add(hem);
  // 平台
  cy(G, K.c(0xfdf6ff), 4.15, 4.15, 0.3, 0, -0.2, 0, 48).receiveShadow = true;
  const bowl = new THREE.Mesh(new THREE.SphereGeometry(4.1, 40, 14, 0, PI * 2, PI / 2, PI / 2), K.c(0xf2d8f6, { side: THREE.DoubleSide }));
  bowl.scale.y = 0.35; bowl.position.y = -0.2; G.add(bowl);
  // 玻璃护栏
  const rail = new THREE.Mesh(new THREE.TorusGeometry(3.85, 0.05, 6, 64), K.c(0xffffff));
  rail.rotation.x = PI / 2; rail.position.y = 1.05; G.add(rail);
  for (let i = 0; i < 20; i++) {
    const a = i / 20 * PI * 2;
    cy(G, K.c(0xffffff), 0.03, 0.03, 1.0, Math.cos(a) * 3.85, 0.1, Math.sin(a) * 3.85, 6);
  }
  const gb = new THREE.Mesh(new THREE.CylinderGeometry(3.85, 3.85, 0.85, 48, 1, true), K.glass(0xe0f6ff, 0.25));
  gb.position.y = 0.55; gb.userData.noInk = true; G.add(gb);
  // 光核柱
  cy(G, K.f(0xfff2b8), 0.32, 0.32, 3.8, 0, 0.1, 0, 16).userData.noInk = true;
  for (const y of [1.0, 2.2, 3.4]) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.06, 6, 20), K.c(0xd0b8f0));
    r.rotation.x = PI / 2; r.position.y = y; G.add(r);
  }
  const orb = sp(G, K.f(0xfff6d0), 0.85, 0, 4.0, 0); orb.userData.noInk = true;
  // 环形长椅（坐的人朝外看风景）
  cy(G, K.c(0xd0b8f0), 1.25, 1.3, 0.42, 0, 0.1, 0, 32);
  cy(G, K.c(0xfde6f6), 1.42, 1.42, 0.1, 0, 0.52, 0, 32);
  const seats = [0.3, 2.35, 4.3].map(a => ({ pos: [Math.cos(a) * 1.3, 0, Math.sin(a) * 1.3], yaw: Math.atan2(Math.cos(a), Math.sin(a)), pose: 'sit', surface: 0.62 }));
  // 平台小物
  for (const [a, h] of [[1.2, 0.8], [3.4, 1.0], [5.4, 0.7]]) G.add(at(plant(K, { h, pot: 0xf2a6c0, leaf: 0x9fe0c8 }), Math.cos(a) * 3.2, 0.1, Math.sin(a) * 3.2));
  const telescope = grp(); at(telescope, 3.1, 0.1, -1.4); G.add(telescope);
  for (let i = 0; i < 3; i++) { const l = cy(telescope, K.c(0x8a94a8), 0.02, 0.02, 1.1, 0, 0, 0, 6); l.rotation.set(Math.cos(i * 2.1) * 0.3, 0, Math.sin(i * 2.1) * 0.3); }
  const tube = cy(telescope, K.c(0xf2c744), 0.08, 0.12, 0.9, 0, 0.9, 0, 12); tube.rotation.z = -1.1;

  crew(G, G, rng, [
    ...seats.map((s, i) => ({ ...s, look: { outfit: ['dress', 'casual', 'sailor'][i] } })),
    { pos: [Math.cos(1.35) * 3.25, 0.1, Math.sin(1.35) * 3.25], yaw: Math.atan2(Math.cos(1.35), Math.sin(1.35)), pose: 'lean', lean: true, look: { outfit: 'hoodie' } },
  ]);
  // 触手 + 口腕
  const tm = K.c(0xecc0f4, { transparent: true, opacity: 0.75, depthWrite: false });
  for (let i = 0; i < 14; i++) {
    const a = i / 14 * PI * 2, r = 1.2 + (i % 3) * 0.95;
    dangle(G, tm, Math.cos(a) * r, -0.6, Math.sin(a) * r, 3.5 + rng() * 3.5, 0.1, 0.03, rng() * 6).children[0].userData.inkWidth = 0.006;
  }
  const frill = K.c(0xf8d8fc, { side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false });
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * PI * 2 + 0.4;
    const p = new THREE.Group(); p.position.set(Math.cos(a) * 0.6, -1.0, Math.sin(a) * 0.6);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 6, 1, 10), frill);
    const pos = m.geometry.attributes.position;
    for (let k = 0; k < pos.count; k++) pos.setZ(k, Math.sin(pos.getY(k) * 1.8) * 0.25);
    m.geometry.computeVertexNormals();
    m.position.y = -3; m.rotation.y = a; m.userData.noInk = true; p.add(m);
    p.userData.tentacle = { ph: i * 1.7 };
    G.add(p);
  }
  G.userData.cabin = { pos: [-2.4, 1.65, 0.8], look: [4, 1.2, 0] };
  G.userData.seats = 4;
  return finish(G);
}

/* ============================== 4. 猫巴士 ============================== */
export function catbus() {
  const G = new THREE.Group();
  const FLOOR = -1.0;
  const K = kit(G, FLOOR + 1.85);
  const rng = seeded(44);
  const R = 2.05, MID = 7.0, ZS = 0.95;
  const fur = K.hull(0xf0b870, 0xfbe6c8);
  const dark = K.c(0xc98f4e, { low: 0.76 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(R, MID, 16, 40), fur);
  body.rotation.z = PI / 2; body.scale.z = ZS; body.castShadow = true; G.add(body);
  for (let i = 0; i < 5; i++) {
    const st = new THREE.Mesh(new THREE.TorusGeometry(R * 1.01, 0.13, 8, 40, PI * 0.8), dark);
    st.rotation.set(0, PI / 2, PI * 0.1); st.scale.set(ZS, 1, 1); st.position.x = -2.8 + i * 1.15;
    st.userData.inkWidth = 0.002; G.add(st);
  }
  // 脸
  const HX = MID / 2 + R * 0.75;
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.2, 6), fur);
    ear.position.set(MID / 2 + 0.6, R * 0.95, s * 1.0); ear.rotation.z = -0.25; G.add(ear);
    sp(G, K.c(0xfff8e0), 0.55, HX - 0.1, 0.9, s * 0.95, 1, 1.15, 1);
    const pu = sp(G, K.f(0x2a3550), 0.24, HX + 0.36, 0.9, s * 1.0); pu.userData.noInk = true;
    const hl = sp(G, K.f(0xffffff), 0.08, HX + 0.5, 1.02, s * 1.04); hl.userData.noInk = true;
    for (let k = 0; k < 3; k++) {
      const wsk = bx(G, K.c(0x5a4a3a), 1.0, 0.03, 0.03, HX + 0.1, -0.1 + k * 0.15, s * 1.35, s * (0.2 - k * 0.2));
      wsk.rotation.z = (k - 1) * 0.15;
    }
  }
  sp(G, K.c(0x8a5a4a), 0.13, HX + 0.62, 0.35, 0);
  const grin = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.14, 8, 24, PI), K.c(0x8a3a4a));
  grin.position.set(HX + 0.32, -0.25, 0); grin.rotation.set(0, PI / 2, PI); G.add(grin);
  for (let i = 0; i < 6; i++) bx(G, K.c(0xffffff), 0.1, 0.16, 0.12, HX + 0.4, -1.12 + Math.abs(i - 2.5) * 0.06, -0.75 + i * 0.3);
  // 侧窗（暖光）
  for (let i = 0; i < 5; i++) for (const s of [-1, 1]) {
    const w = plane(G, K.f(0xffe9a8), 0.95, 0.75, -2.6 + i * 1.3, 0.55, s * (R * ZS * 0.985), s > 0 ? 0 : PI);
    w.renderOrder = 1;
  }
  // ---- 车厢 ----
  const fw = R * ZS * Math.sqrt(1 - (FLOOR / R) ** 2) - 0.05;
  bx(G, K.c(0xffffff, { map: woodFloor(K, '#e8c8a0') }), MID + 1.4, 0.12, fw * 2, 0, FLOOR - 0.12, 0).receiveShadow = true;
  const seatM = K.c(0xe8a860, { low: 0.75 }), seatTop = K.c(0xf6d0a0);
  const seatSpots = [];
  for (const x of [2.5, 0.9, -0.7]) for (const s of [-1, 1]) {
    const z = s * 0.95;
    bx(G, seatM, 0.62, 0.42, 0.78, x, FLOOR, z);
    sp(G, seatTop, 0.32, x + 0.02, FLOOR + 0.46, z, 1.0, 0.3, 1.2);
    const bk = bx(G, seatM, 0.16, 0.7, 0.78, x - 0.34, FLOOR + 0.4, z); bk.rotation.z = 0.12;
    sp(G, seatTop, 0.12, x - 0.32, FLOOR + 1.1, z, 1, 0.6, 3);
    seatSpots.push({ x, z });
  }
  // 后排长椅
  bx(G, seatM, 0.75, 0.42, 2.9, -2.6, FLOOR, 0);
  sp(G, seatTop, 0.36, -2.6, FLOOR + 0.46, 0, 1.0, 0.3, 4.0);
  // 吊环（毛绒小环）
  cy(G, K.c(0xc98f4e), 0.035, 0.035, 6, 0, 0.92, 0, 6).rotation.z = PI / 2;
  for (let x = -2.4; x <= 2.6; x += 0.8) {
    cy(G, K.c(0xc98f4e), 0.015, 0.015, 0.22, x, 0.7, 0, 4);
    const r = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.025, 6, 12), K.c(0xfde6c8));
    r.position.set(x, 0.62, 0); G.add(r);
  }
  // 小物：橡果、雨伞
  for (let i = 0; i < 3; i++) sp(G, K.c(0xa0704a), 0.07, -2.3 + i * 0.12, FLOOR + 0.5, 1.2, 1, 1.3, 1);
  cy(G, K.c(0x5a6a9a), 0.02, 0.02, 1.0, 3.2, FLOOR, -1.2, 6).rotation.z = 0.25;

  crew(G, G, rng, [
    { pos: [2.5 - 0.15, 0, 0.95], yaw: PI / 2, pose: 'sit', surface: FLOOR + 0.5, look: { outfit: 'sailor' } },
    { pos: [0.9 - 0.15, 0, -0.95], yaw: PI / 2, pose: 'read', surface: FLOOR + 0.5, look: { outfit: 'casual' } },
    { pos: [-0.7 - 0.15, 0, 0.95], yaw: PI / 2, pose: 'sit', surface: FLOOR + 0.5, look: { outfit: 'dress', hat: 'straw' } },
    { pos: [1.7, FLOOR, 0.15], yaw: PI / 2, pose: 'strap', lean: true, look: { outfit: 'hoodie' } },
    { pos: [-2.6, 0, 0.75], yaw: 0, pose: 'sleep', surface: FLOOR + 0.5, look: { outfit: 'pajama', kid: true } },
  ]);
  // 腿 + 尾巴
  for (let i = 0; i < 12; i++) {
    const s = i % 2 ? 1 : -1;
    const legG = new THREE.Group();
    legG.position.set(-3.0 + Math.floor(i / 2) * 1.2, -1.75, s * 1.05);
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.75, 6, 12), K.c(0xf0b870));
    leg.position.y = -0.3; legG.add(leg);
    const paw = sp(legG, K.c(0xfff0d8), 0.28, 0, -0.75, 0.05, 1.1, 0.7, 1.2);
    legG.userData.leg = { ph: i * 1.1, base: -1.75 };
    G.add(legG);
  }
  const tail = new THREE.Group(); tail.position.set(-MID / 2 - R * 0.8, 0.6, 0);
  const tm = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 2.2, 6, 12), K.c(0xf0b870));
  tm.position.y = 1.1; tail.add(tm); tail.rotation.z = 0.7;
  tail.userData.tailwag = true; G.add(tail);
  G.userData.cabin = { pos: [3.4, FLOOR + 1.4, 0.3], look: [-3, FLOOR + 0.6, 0] };
  G.userData.seats = 5;
  return finish(G);
}

/* ============================== 5. 空中電車 ============================== */
/**
 * opts.L 车长；wings=false 用作地面列车；cab=true 带司机室；crowd=人数
 */
export function tram({ L = 10, wings = true, dest = '桜ヶ浜 ⇄ 雲の上', cab = true, crowd = 6, seed = 55 } = {}) {
  const G = new THREE.Group();
  const W = 2.8, H = 2.75, FLOOR = -1.3;
  const K = kit(G, FLOOR + 2.15);
  const rng = seeded(seed);
  const cream = K.c(0xf8f1e2, { steps: 3, shadow: 0xa4b2d6, low: 0.8 });
  const inner = K.c(0xfdf8ee, { low: 0.86 });
  const pink = K.c(0xf29bb6, { shadow: 0xb486b8 });
  const green = K.c(0x7fcaa8, { shadow: 0x6f9cb8 });
  const dark = K.c(0x5d6b84, { low: 0.7 });
  const steel = K.c(0xd8dee6, { low: 0.82 });

  // 车门位置与窗段
  const doors = L > 9 ? [-L / 4, L / 4 - (cab ? 0.6 : 0)] : [0];
  const x0 = -L / 2 + 0.5, x1 = L / 2 - (cab ? 1.55 : 0.5);
  const segs = [];
  let a = x0;
  for (const d of doors) { segs.push([a, d - 0.75]); a = d + 0.75; }
  segs.push([a, x1]);
  const windows = [];
  for (const [s0, s1] of segs) {
    const n = Math.max(1, Math.round((s1 - s0) / 1.25));
    const ww = (s1 - s0) / n;
    for (let i = 0; i < n; i++) windows.push({ x: s0 + ww * (i + 0.5), y: 1.0, w: ww - 0.32, h: 0.95, kind: 'window' });
  }
  const sideOps = [...windows, ...doors.map(d => ({ x: d, y: 0, w: 1.15, h: 2.1, kind: 'open' }))];
  if (cab) sideOps.push({ x: L / 2 - 0.75, y: 1.0, w: 0.7, h: 0.95, kind: 'window' });
  for (const s of [1, -1]) {
    const wl = wall(K, { len: L, h: H, t: 0.12, out: cream, inn: inner, openings: sideOps, frame: 0xc8ccd8 });
    at(wl, 0, FLOOR, s * (W / 2 - 0.06), s > 0 ? 0 : PI);
    G.add(wl);
    // 粉色腰带 + 绿线
    for (const [y0, h, m] of [[0.35, 0.42, pink], [0.82, 0.08, green]]) {
      for (const [s0, s1] of [[-L / 2, doors[0] - 0.58], ...doors.slice(0, -1).map((d, i) => [d + 0.58, doors[i + 1] - 0.58]), [doors[doors.length - 1] + 0.58, L / 2]]) {
        bx(G, m, s1 - s0, h, 0.02, (s0 + s1) / 2, FLOOR + y0, s * (W / 2 + 0.005)).userData.inkWidth = 0.001;
      }
    }
    // 拉门（半开）
    for (const d of doors) for (const k of [-1, 1]) {
      const leaf = bx(G, steel, 0.58, 2.05, 0.04, d + k * 0.86, FLOOR, s * (W / 2 - 0.02));
      leaf.userData.inkWidth = 0.0012;
      bx(G, K.glass(), 0.32, 0.7, 0.05, d + k * 0.86, FLOOR + 1.1, s * (W / 2 - 0.02));
    }
  }
  // 车头/车尾端墙
  for (const s of [1, -1]) {
    const wl = wall(K, { len: W - 0.12, h: H, t: 0.12, out: cream, inn: inner, frame: 0xc8ccd8,
      openings: [{ x: 0, y: 1.0, w: W * 0.72, h: 1.0, kind: 'window' }] });
    at(wl, s * (L / 2 - 0.06), FLOOR, 0, s * PI / 2);
    G.add(wl);
    bx(G, pink, 0.02, 0.42, W - 0.1, s * (L / 2 + 0.005), FLOOR + 0.35, 0);
    for (const z of [-0.85, 0.85]) {
      const lamp = plane(G, K.f(s > 0 ? 0xfff3c0 : 0xff8a8a), 0.3, 0.2, s * (L / 2 + 0.02), FLOOR + 0.55, z, s * PI / 2);
      lamp.userData.noInk = true;
    }
  }
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.36), new THREE.MeshBasicMaterial({ map: labelTex(dest, { size: 26 }) }));
  sign.material.clippingPlanes = K.planes;
  sign.position.set(L / 2 + 0.02, FLOOR + 2.3, 0); sign.rotation.y = PI / 2; sign.userData.noInk = true; G.add(sign);
  // 地板 / 车顶 / 天花灯带
  bx(G, K.c(0xffffff, { map: K.tex('trainfloor', 128, 128, (c) => {
    c.fillStyle = '#c8ccd8'; c.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 300; i++) { c.fillStyle = i % 2 ? '#b8bcc8' : '#d8dce6'; c.fillRect((i * 37) % 128, (i * 61) % 128, 2, 2); }
    c.fillStyle = '#f2c744'; c.fillRect(0, 60, 128, 8);
  }, [L / 2, 1]) }), L, 0.12, W, 0, FLOOR - 0.12, 0).receiveShadow = true;
  bx(G, K.c(0xdfe3ea), L + 0.1, 0.24, W + 0.06, 0, FLOOR + H, 0);
  bx(G, K.c(0xfdfdfd), L - 0.3, 0.04, W - 0.3, 0, FLOOR + H - 0.04, 0);
  for (const z of [-0.55, 0.55]) bx(G, K.f(0xfffce8), L - 1.2, 0.03, 0.18, 0, FLOOR + H - 0.07, z).userData.noInk = true;
  // 长条座椅（ロングシート）
  const moq = K.c(seed % 2 ? 0xd9707a : 0x6aa88a, { low: 0.76 });
  const seatSpots = [];
  for (const [s0, s1] of segs) for (const s of [1, -1]) {
    const len = s1 - s0 - 0.1, cx = (s0 + s1) / 2, z = s * (W / 2 - 0.42);
    bx(G, dark, len, 0.3, 0.45, cx, FLOOR, z);
    bx(G, moq, len, 0.14, 0.5, cx, FLOOR + 0.3, z);
    const bk = bx(G, moq, len, 0.5, 0.1, cx, FLOOR + 0.5, s * (W / 2 - 0.16)); bk.rotation.x = s * 0.12;
    cy(G, steel, 0.025, 0.025, 2.1, s0 + 0.05, FLOOR, z + s * -0.25, 8);
    for (let k = 0; k < Math.floor(len / 0.62); k++) seatSpots.push({ x: s0 + 0.4 + k * 0.62, s });
  }
  // 吊环 + 行李架 + 中吊广告
  for (const s of [1, -1]) {
    cy(G, steel, 0.025, 0.025, L - 1.6, -0.3, FLOOR + 2.2, s * (W / 2 - 0.7), 8).rotation.z = PI / 2;
    for (let x = -L / 2 + 1.0; x < L / 2 - 1.8; x += 0.55) {
      bx(G, K.c(0xfdfdfd), 0.03, 0.2, 0.03, x, FLOOR + 1.98, s * (W / 2 - 0.7)).userData.inkWidth = 0.0008;
      const r = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.016, 4, 3), K.c(0xfdfdfd));
      r.position.set(x, FLOOR + 1.9, s * (W / 2 - 0.7)); r.rotation.z = -PI / 2; G.add(r);
    }
    bx(G, steel, L - 1.8, 0.03, 0.35, -0.3, FLOOR + 2.05, s * (W / 2 - 0.25));
  }
  const ads = [['#f2a6c0', '#ffffff', '春', '桜まつり'], ['#7ec4d8', '#ffffff', '海', '夏の空港'], ['#f2c744', '#2c3e5c', '茶', '新茶入荷'], ['#8fd09a', '#2c3e5c', '鯨', '空の旅']];
  for (let i = 0; i < Math.floor(L / 2.5); i++) {
    const ad = ads[i % ads.length];
    const t = poster(K, ad[2], ad[0], ad[1], ad[2], ad[3]);
    plane(G, K.f(0xffffff, { map: t, side: THREE.DoubleSide }), 0.6, 0.42, -L / 2 + 1.6 + i * 2.4, FLOOR + 2.15, 0, 0);
  }
  for (const s of [1, -1]) for (let i = 0; i < Math.floor(L / 2.4); i++) {
    const ad = ads[(i + (s > 0 ? 1 : 2)) % ads.length];
    plane(G, K.f(0xffffff, { map: poster(K, ad[2], ad[0], ad[1], ad[2], ad[3]) }), 0.7, 0.42, -L / 2 + 1.4 + i * 2.4, FLOOR + 2.32, s * (W / 2 - 0.13), s > 0 ? PI : 0);
  }
  // 司机室
  if (cab) {
    const cx = L / 2 - 1.5;
    const pw = wall(K, { len: W - 0.12, h: H, t: 0.08, out: inner, inn: inner, frame: 0xc8ccd8,
      openings: [{ x: 0.75, y: 0, w: 0.7, h: 2.0, kind: 'door', open: 0.35, color: 0xd8dee6, window: true }, { x: -0.5, y: 1.1, w: 0.9, h: 0.6, kind: 'window' }] });
    at(pw, cx, FLOOR, 0, PI / 2); G.add(pw);
    const desk = bx(G, K.c(0x5d6b84), 0.7, 1.0, W - 0.5, L / 2 - 0.42, FLOOR, 0);
    bx(G, K.c(0x3a4058), 0.5, 0.05, W - 0.6, L / 2 - 0.45, FLOOR + 1.0, 0).rotation.z = 0.35;
    for (let i = 0; i < 4; i++) {
      const gg = plane(G, K.f([0xfdfaf2, 0x9fe0c8, 0xffd98a, 0xfdfaf2][i]), 0.14, 0.14, L / 2 - 0.62, FLOOR + 1.12, -0.6 + i * 0.4, -PI / 2, -0.35);
    }
    cy(G, K.c(0x2c3446), 0.03, 0.03, 0.3, L / 2 - 0.5, FLOOR + 1.02, 0.5, 6).rotation.z = 0.4;
    sp(G, K.c(0xe07a8a), 0.05, L / 2 - 0.56, FLOOR + 1.3, 0.5);
    G.userData.driver = { pos: [L / 2 - 1.0, FLOOR, -0.25], yaw: PI / 2 };
  }
  // 集电弓
  const panto = grp(); at(panto, L * 0.22, FLOOR + H + 0.24, 0); G.add(panto);
  bx(panto, dark, 0.9, 0.12, 0.9, 0, 0, 0);
  for (const s of [-1, 1]) { const arm = bx(panto, dark, 0.06, 1.1, 0.06, s * 0.25, 0.05, 0); arm.rotation.z = s * 0.55; }
  bx(panto, dark, 0.12, 0.06, 1.5, 0, 1.0, 0);
  // 转向架 + 车轮
  for (const bxp of [-L / 2 + 1.5, L / 2 - 1.5]) {
    bx(G, dark, 2.1, 0.34, W * 0.8, bxp, FLOOR - 0.5, 0);
    for (const wx of [-0.65, 0.65]) for (const s of [-1, 1]) {
      const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.16, 16), wings ? flat(0xa8f0ff) : dark);
      wh.rotation.x = PI / 2; wh.position.set(bxp + wx, FLOOR - 0.6, s * W * 0.36);
      if (wings) { wh.userData.noInk = true; wh.userData.wheel = true; }
      G.add(wh);
    }
  }
  // 乘客
  const picks = [];
  const pool = seatSpots.slice();
  for (let i = 0; i < Math.min(crowd, pool.length); i++) picks.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  const list = [];
  picks.forEach((p, i) => {
    if (i % 3 === 2) {
      list.push({ pos: [p.x, FLOOR, p.s * (W / 2 - 0.85)], yaw: p.s > 0 ? PI : 0, pose: 'strap', lean: true });
    } else {
      list.push({ pos: [p.x, 0, p.s * (W / 2 - 0.58)], yaw: p.s > 0 ? PI : 0, pose: i % 4 === 1 ? 'read' : 'sit', surface: FLOOR + 0.48 });
    }
  });
  if (cab) list.push({ ...G.userData.driver, pose: 'lean', look: { outfit: 'staff', style: 'short' } });
  crew(G, G, rng, list);

  if (wings) {
    const fm = cel(0xffffff, { steps: 2, shadow: 0xc0cdee, low: 0.8 });
    for (const s of [-1, 1]) {
      const wgl = featherWing(s, fm, 3.4);
      wgl.position.set(0.4, FLOOR + H - 0.1, s * (W / 2 + 0.05));
      G.add(wgl);
    }
    thruster(G, new THREE.Vector3(-L / 2 - 0.3, FLOOR + 0.9, 0), 0xffd0e6, 1.0);
  }
  G.userData.cabin = { pos: [-L / 2 + 1.0, FLOOR + 1.5, 0.35], look: [L / 2, FLOOR + 1.3, 0] };
  G.userData.seats = list.length;
  return finish(G);
}

/* ============================== 6. 金鱼灯笼 ============================== */
export function goldfish() {
  const G = new THREE.Group();
  const LF = -6.4;                                  // 灯笼内地板（机体坐标）
  const K = kit(G, LF + 1.95);
  const rng = seeded(66);
  const red = K.c(0xf5835f, { steps: 3, shadow: 0xb879a8, low: 0.72 });
  const white = K.c(0xfff6ee, { shadow: 0xc4b4d8 });
  const finM = K.c(0xffb08a, { side: THREE.DoubleSide, transparent: true, opacity: 0.88, shadow: 0xd08aa8 });

  const body = sp(G, red, 2.4, 0, 0, 0, 1.5, 1.12, 1.0);
  sp(G, white, 2.2, 0, -0.62, 0, 1.38, 0.72, 0.9);
  for (const [x, z] of [[0.5, 1.0], [-1.4, -0.8], [1.5, -0.5], [-0.6, 0.4]]) sp(G, white, 0.75, x, 1.95, z, 1, 0.35, 0.8);
  for (const s of [-1, 1]) {
    sp(G, white, 0.7, 2.45, 0.95, s * 1.3);
    const pu = sp(G, K.f(0x2a3550), 0.36, 2.9, 1.0, s * 1.5, 0.8, 1, 0.5); pu.userData.noInk = true;
    const hl = sp(G, K.f(0xffffff), 0.13, 3.1, 1.2, s * 1.55); hl.userData.noInk = true;
  }
  const lip = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.13, 8, 18), K.c(0xff9bb0));
  lip.position.set(3.55, -0.1, 0); lip.rotation.y = PI / 2; G.add(lip);
  // 尾鳍
  const lobe = new THREE.Shape();
  lobe.moveTo(0, 0); lobe.bezierCurveTo(-1.4, 1.5, -4.0, 4.0, -6.0, 3.2);
  lobe.quadraticCurveTo(-4.6, 2.0, -5.2, 0.5); lobe.quadraticCurveTo(-2.6, 0.7, 0, 0);
  const tail = new THREE.Group();
  for (const s of [1, -1]) {
    const m = new THREE.Mesh(new THREE.ShapeGeometry(lobe, 14), finM);
    m.scale.y = s; m.userData.inkWidth = 0.002; tail.add(m);
  }
  tail.position.set(-3.2, 0.15, 0); tail.userData.tailwag = true; G.add(tail);
  const dorsal = new THREE.Shape();
  dorsal.moveTo(1.4, 0); dorsal.quadraticCurveTo(0.3, 2.2, -2.0, 1.7); dorsal.lineTo(-1.7, 0); dorsal.lineTo(1.4, 0);
  const df = new THREE.Mesh(new THREE.ShapeGeometry(dorsal, 10), finM); df.position.set(-0.4, 2.35, 0); G.add(df);
  for (const s of [-1, 1]) {
    const pf = new THREE.Group(); pf.position.set(0.9, -0.8, s * 2.2);
    const m = sp(pf, finM, 0.8, 0, 0, s * 0.5, 1.2, 0.18, 0.75); m.rotation.x = s * 0.5;
    pf.userData.flap = s * 0.6; G.add(pf);
  }
  // 鱼背鞍座 + 骑手 + 缰绳
  const sad = grp(); at(sad, 0.4, 2.55, 0); G.add(sad);
  bx(sad, K.c(0x5a6a9a), 1.0, 0.25, 0.9, 0, -0.15, 0);
  bx(sad, K.c(0xf2c744), 0.12, 0.45, 0.9, -0.45, 0, 0);
  for (const s of [-1, 1]) cy(sad, K.c(0xc8a050), 0.02, 0.02, 0.8, 0.1, -0.85, s * 0.5, 6);
  crew(G, sad, rng, [{ pos: [0, 0, 0], yaw: PI / 2, pose: 'hold', surface: 0.1, look: { outfit: 'yukata', c1: 0x6f8fd8, style: 'pony' } }]);
  for (const s of [-1, 1]) {
    const a = new THREE.Vector3(1.0, 3.0, s * 0.18), b = new THREE.Vector3(3.5, 0.2, s * 0.32);
    const r = cy(G, K.c(0xe07a8a), 0.02, 0.02, a.distanceTo(b), 0, 0, 0, 4);
    r.position.copy(a).add(b).multiplyScalar(0.5);
    r.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    r.userData.noInk = true;
  }

  // ---- 吊着的灯笼小屋（会像钟摆一样晃）----
  const lan = new THREE.Group(); lan.position.set(0, -2.3, 0); lan.userData.swing = { k: 0.04 };
  G.add(lan);
  const C = -3.9;                                         // 灯笼中心（相对挂点）
  const prof = [[0.95, 1.75], [1.6, 1.5], [2.05, 0.95], [2.15, 0], [2.05, -0.95], [1.6, -1.5], [0.95, -1.75]].map(([r, y]) => new THREE.Vector2(r, y));
  const lpaper = new THREE.Mesh(new THREE.LatheGeometry(prof, 40), K.hull(0xffe2a0, 0xfff4dc, { low: 0.9, shadow: 0xe8b890 }));
  lpaper.position.y = C; lpaper.castShadow = true; lan.add(lpaper);
  for (const y of [-1.2, -0.6, 0, 0.6, 1.2]) {
    const rr = 2.15 * Math.cos(y / 1.75 * 1.05) + 0.02;
    const rib = new THREE.Mesh(new THREE.TorusGeometry(Math.max(rr, 1.0), 0.03, 6, 48), K.c(0xe0a060));
    rib.rotation.x = PI / 2; rib.position.y = C + y; rib.userData.noInk = true; lan.add(rib);
  }
  const capM = K.c(0xd9534f, { shadow: 0x9a6aa0 });
  cy(lan, capM, 1.0, 1.0, 0.35, 0, C + 1.7, 0, 24);
  cy(lan, capM, 1.0, 1.0, 0.35, 0, C - 2.05, 0, 24);
  for (const s of [-1, 1]) {
    const t = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), K.f(0xffffff, { map: K.tex('kingyo', 128, 128, (c) => {
      c.clearRect(0, 0, 128, 128); c.fillStyle = '#d9534f'; c.textAlign = 'center';
      c.font = `900 56px ${FONT}`; c.fillText('金', 64, 54); c.fillText('魚', 64, 112);
    }), transparent: true, side: THREE.DoubleSide }));
    t.position.set(0, C, s * 2.17); t.rotation.y = s > 0 ? 0 : PI; t.userData.noInk = true; lan.add(t);
  }
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * PI * 2 + PI / 4;
    const rope = cy(lan, K.c(0x8a6a5a), 0.025, 0.025, 1.6, Math.cos(a) * 0.7, C + 1.8, Math.sin(a) * 0.7, 4);
    rope.rotation.set(Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3);
    rope.userData.noInk = true;
  }
  // 灯笼内：祭典小摊
  const F = LF + 2.3;                                     // 相对挂点的地板高度
  cy(lan, K.c(0xffffff, { map: woodFloor(K, '#d8a878') }), 1.85, 1.85, 0.1, 0, F - 0.1, 0, 32).receiveShadow = true;
  const ct = counter(K, { len: 1.6, color: 0xd9534f, top: 0xf6e6c8 });
  at(ct, 0.55, F, 0, -PI / 2); ct.scale.set(1, 0.85, 0.8); lan.add(ct);
  const tub = cy(lan, K.c(0x6fb5e8), 0.38, 0.32, 0.18, 0.5, F + 0.92, -0.3, 20);
  cy(lan, K.f(0xa8e6f6), 0.34, 0.34, 0.01, 0.5, F + 1.08, -0.3, 20).userData.noInk = true;
  for (let i = 0; i < 4; i++) sp(lan, K.c(0xff7a4a), 0.05, 0.5 + Math.cos(i * 1.7) * 0.18, F + 1.1, -0.3 + Math.sin(i * 1.7) * 0.18, 1.6, 0.6, 0.9);
  for (let i = 0; i < 4; i++) cy(lan, K.c(0x9fe6f0, { transparent: true, opacity: 0.8 }), 0.06, 0.06, 0.32, 0.45 + (i % 2) * 0.15, F + 0.92, 0.35 + i * 0.1, 10);
  for (let i = 0; i < 3; i++) {
    const p = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.015, 4, 14), K.c(0xf6f6f6));
    p.position.set(0.85, F + 0.97, 0.05 + i * 0.12); p.rotation.x = PI / 2; lan.add(p);
  }
  // 狐狸面具墙
  for (let i = 0; i < 3; i++) {
    const a = -0.6 + i * 0.6;
    const m = sp(lan, K.c(0xffffff), 0.2, Math.cos(a) * 1.85, F + 1.6, Math.sin(a) * 1.85, 0.4, 1.1, 0.9);
    m.lookAt(0, F + 1.6, 0);
    for (const s of [-1, 1]) { const e = sp(lan, K.f(0xe0505a), 0.04, Math.cos(a) * 1.78, F + 1.68, Math.sin(a) * 1.78 + s * 0.07); e.userData.noInk = true; }
  }
  // 风铃
  const fu = grp(); at(fu, -0.3, F + 2.45, 0.6); lan.add(fu);
  sp(fu, K.c(0xd8f4ff, { transparent: true, opacity: 0.8 }), 0.14, 0, 0, 0, 1, 0.9, 1);
  bx(fu, K.c(0xf2a6c0, { side: THREE.DoubleSide }), 0.08, 0.3, 0.01, 0, -0.32, 0);
  const st = stool(K, 0x6fb5e8); at(st, -0.75, F, 0.1); st.scale.setScalar(0.8); lan.add(st);
  crew(G, lan, rng, [
    { pos: [1.25, F, -0.1], yaw: -PI / 2, pose: 'stand', look: { outfit: 'yukata', c1: 0xf2a6c0, style: 'bun' } },
    { pos: [-0.85, 0, 0.1], yaw: PI / 2, pose: 'sit', surface: F + 0.5, look: { outfit: 'yukata', c1: 0x8fd0c0, kid: true, style: 'twin' } },
  ]);
  thruster(G, new THREE.Vector3(-3.6, -0.4, 0), 0xffc0a0, 0.9);
  G.userData.cabin = { node: lan, pos: [-1.35, F + 1.25, 1.05], look: [1.0, F + 0.7, -0.4] };
  G.userData.seats = 3;
  finish(G);
  return G;
}

/* ============================== 7. 蒲公英伞 ============================== */
export function dandelion() {
  const G = new THREE.Group();
  const K = kit(G, 99);
  const rng = seeded(77);
  // 种子球（慢慢转）
  const head = new THREE.Group(); head.position.y = 5.2; head.userData.spin = 0.35; G.add(head);
  const stemM = K.c(0xeee4cc, { low: 0.8 });
  const fluff = K.c(0xffffff, { shadow: 0xc8d4ee, low: 0.86 });
  sp(head, K.c(0xd8c49a), 0.75, 0, 0, 0);
  const N = 40, up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 1.3;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = i * 2.399963;
    const dir = new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r).normalize();
    const len = 3.4;
    const s = cy(head, stemM, 0.035, 0.035, len, 0, 0, 0, 5);
    s.position.copy(dir).multiplyScalar(len / 2 + 0.55);
    s.quaternion.setFromUnitVectors(up, dir);
    s.userData.noInk = true;
    for (let k = 0; k < 3; k++) {
      const pom = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42 - k * 0.08, 1), fluff);
      pom.position.copy(dir).multiplyScalar(len + 0.6 + k * 0.28);
      pom.scale.set(1, 0.6, 1);
      pom.quaternion.setFromUnitVectors(up, dir);
      pom.userData.inkWidth = 0.002;
      head.add(pom);
    }
  }
  cy(G, K.c(0x9fcf7a), 0.12, 0.1, 4.4, 0, 0.8, 0, 8);
  for (const s of [-1, 1]) {
    const lf = sp(G, K.c(0x8fc46a, { side: THREE.DoubleSide }), 0.5, s * 0.5, 2.2, 0, 1.6, 0.1, 0.5);
    lf.rotation.z = s * 0.6;
  }
  // 吊篮（钟摆）
  const bas = new THREE.Group(); bas.position.y = 0.9; bas.userData.swing = { k: 0.05 }; G.add(bas);
  const F = -2.3;
  const wicker = K.tex('wicker', 128, 64, (c) => {
    c.fillStyle = '#d8a870'; c.fillRect(0, 0, 128, 64);
    for (let y = 0; y < 64; y += 8) for (let x = 0; x < 128; x += 16) {
      c.fillStyle = (x / 16 + y / 8) % 2 ? '#c8945a' : '#e6bc84'; c.fillRect(x, y, 14, 7);
    }
  }, [6, 2]);
  const bsk = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.25, 1.1, 32, 1, true), K.c(0xffffff, { map: wicker, side: THREE.DoubleSide }));
  bsk.position.y = F + 0.55; bsk.castShadow = true; bas.add(bsk);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.08, 8, 40), K.c(0xb07a4a));
  rim.rotation.x = PI / 2; rim.position.y = F + 1.1; bas.add(rim);
  cy(bas, K.c(0xc8945a), 1.25, 1.25, 0.1, 0, F - 0.05, 0, 32);
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * PI * 2 + PI / 4;
    const p0 = new THREE.Vector3(Math.cos(a) * 1.45, F + 1.1, Math.sin(a) * 1.45), p1 = new THREE.Vector3(0, 0, 0);
    const r = cy(bas, K.c(0x8a6a5a), 0.02, 0.02, p0.distanceTo(p1), 0, 0, 0, 4);
    r.position.copy(p0).add(p1).multiplyScalar(0.5); r.quaternion.setFromUnitVectors(up, p1.clone().sub(p0).normalize());
    r.userData.noInk = true;
  }
  bx(bas, K.c(0xb07a4a), 0.4, 0.06, 2.4, -0.6, F + 0.42, 0);              // 横板座
  const pb = grp(); at(pb, 0.7, F, -0.6); bas.add(pb);                       // 野餐篮
  bx(pb, K.c(0xd8a870), 0.5, 0.3, 0.35, 0, 0, 0);
  const hdl = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.025, 4, 12, PI), K.c(0xb07a4a)); hdl.position.y = 0.3; pb.add(hdl);
  bx(pb, K.c(0xf2a6c0), 0.52, 0.02, 0.37, 0, 0.3, 0);
  // 吊床
  const hm = new THREE.Group(); hm.position.y = F - 1.2; bas.add(hm);
  const cloth = K.c(0x9fd8f0, { side: THREE.DoubleSide });
  for (let i = 0; i < 10; i++) {
    const x0 = -1.6 + i * 0.32, x1 = x0 + 0.32;
    const y = (x) => -0.45 * (1 - (x / 1.6) ** 2);
    const seg = bx(hm, cloth, 0.34, 0.03, 0.9, (x0 + x1) / 2, (y(x0) + y(x1)) / 2, 0);
    seg.rotation.z = Math.atan2(y(x1) - y(x0), 0.32);
    seg.userData.inkWidth = 0.0015;
  }
  for (const s of [-1, 1]) {
    const r = cy(bas, K.c(0x8a6a5a), 0.02, 0.02, 1.35, s * 1.2, F - 1.3, 0, 4); r.rotation.z = s * 0.3; r.userData.noInk = true;
  }
  crew(G, bas, rng, [
    { pos: [0.4, F, 0.5], yaw: PI / 2, pose: 'wave', look: { outfit: 'hoodie', kid: true, style: 'short' } },
    { pos: [-0.6, 0, 0.2], yaw: PI / 2, pose: 'read', surface: F + 0.48, look: { outfit: 'dress', hat: 'straw' } },
  ]);
  crew(G, hm, rng, [{ pos: [1.05, 0, 0], yaw: -PI / 2, pose: 'sleep', surface: -0.28, look: { outfit: 'casual', style: 'long' } }]);
  G.userData.cabin = { node: bas, pos: [-0.9, F + 1.35, -0.6], look: [3, F + 1.0, 0.4] };
  G.userData.seats = 3;
  return finish(G);
}

/* ============================== 8. 汽水火箭 ============================== */
export function ramune() {
  const G = new THREE.Group();
  const K = kit(G, 99);
  const rng = seeded(88);
  const B = new THREE.Group();                         // 竖直建模，放倒后瓶口朝 +X
  const S = 2.0;
  const prof = [[0, -2.4], [0.92, -2.4], [1.05, -2.22], [1.05, 0.3], [0.96, 0.7], [0.58, 1.12], [0.5, 1.42], [0.62, 1.65],
    [0.52, 1.95], [0.44, 2.2], [0.5, 2.45], [0, 2.45]].map(([x, y]) => new THREE.Vector2(x * S, y * S));
  const glass = K.c(0xc6f0f4, { transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, low: 0.9 });
  const bottle = new THREE.Mesh(new THREE.LatheGeometry(prof, 48), glass);
  bottle.userData.inkWidth = 0.0025; bottle.renderOrder = 3; B.add(bottle);
  const marble = sp(B, K.f(0xe8faff), 0.8, 0, 1.92 * S * 0.5 + 1.0, 0); marble.userData.noInk = true;
  cy(B, K.c(0x6fb5e8, { low: 0.78 }), 1.05, 1.05, 0.85, 0, 2.45 * S - 0.1, 0, 28);
  const lab = new THREE.Mesh(new THREE.CylinderGeometry(2.13, 2.13, 1.1, 48, 1, true),
    K.c(0xffffff, { map: K.tex('ramune', 512, 96, (c) => {
      c.fillStyle = '#fdfaf2'; c.fillRect(0, 0, 512, 96);
      c.fillStyle = '#3f78c8'; c.font = `900 54px ${FONT}`; c.textAlign = 'center'; c.fillText('ラムネ  RAMUNE  ラムネ', 256, 66);
    }), side: THREE.DoubleSide }));
  lab.position.y = -3.8; lab.userData.noInk = true; B.add(lab);
  const finM = K.c(0xf29bb6, { shadow: 0xb486b8 });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * PI * 2 + PI / 2;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.4, 1.6), finM);
    fin.position.set(Math.cos(a) * 2.5, -4.0, Math.sin(a) * 2.5);
    fin.lookAt(0, -4.0, 0);
    B.add(fin);
  }
  B.rotation.z = -PI / 2;
  G.add(B);
  // 座舱（机体坐标：瓶身沿 X 从 -4.8 到 +0.6，半径 2.1）
  const FL = -1.15;
  const fw = Math.sqrt(2.1 ** 2 - FL ** 2) - 0.08;
  const gf = bx(G, K.glass(0xa8eef6, 0.45), 5.2, 0.05, fw * 2, -2.1, FL - 0.05, 0); gf.userData.noInk = true;
  const soda = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 5.2, 32, 1, false, 1.5 * PI - PI / 3, PI * 2 / 3), K.c(0x9fe3f0, { low: 0.84, transparent: true, opacity: 0.85 }));
  soda.rotation.z = PI / 2; soda.position.x = -2.1; soda.userData.noInk = true; G.add(soda);
  for (let i = 0; i < 12; i++) {
    const b = sp(G, K.f(0xffffff), 0.06 + (i % 3) * 0.04, -4.3 + (i * 0.43) % 4.4, -1.8, ((i * 7) % 5 - 2) * 0.35);
    b.userData.noInk = true; b.userData.bubble = { y0: -1.95, y1: -1.25, ph: i * 0.37 };
  }
  // 两张躺椅 + 操作台
  for (const z of [-0.7, 0.7]) {
    const pod = grp(); at(pod, -1.3, FL, z); G.add(pod);
    bx(pod, K.c(0xfdfaf2), 0.8, 0.35, 0.72, 0, 0, 0);
    const bk = bx(pod, K.c(0xf29bb6), 0.12, 1.1, 0.72, -0.55, 0.3, 0); bk.rotation.z = 0.75;
    sp(pod, K.c(0xfdfaf2), 0.2, -1.05, 1.15, 0, 0.6, 0.6, 1.2);
    bx(pod, K.c(0xf29bb6), 0.8, 0.1, 0.72, 0.05, 0.35, 0);
  }
  const con = grp(); at(con, 0.2, FL, 0); G.add(con);
  bx(con, K.c(0x5d6b84), 0.5, 0.9, 1.8, 0, 0, 0);
  const scr = plane(con, K.f(0xffffff, { map: K.tex('radar', 128, 96, (c) => {
    c.fillStyle = '#163a4a'; c.fillRect(0, 0, 128, 96);
    c.strokeStyle = '#7ee8c8'; c.lineWidth = 2;
    for (const r of [14, 28, 42]) { c.beginPath(); c.arc(64, 48, r, 0, 7); c.stroke(); }
    c.fillStyle = '#ffd98a'; c.beginPath(); c.arc(84, 34, 4, 0, 7); c.fill();
    c.fillStyle = '#f2a6c0'; c.beginPath(); c.arc(46, 62, 3, 0, 7); c.fill();
  }) }), 0.9, 0.55, -0.26, 1.12, 0, -PI / 2, -0.4);
  for (let i = 0; i < 5; i++) { const btn = sp(con, K.f([0xf26a8a, 0xf2c744, 0x5fd98a, 0x6fb5e8, 0xffffff][i]), 0.05, -0.26, 0.82, -0.6 + i * 0.3); btn.userData.noInk = true; }
  // 漂浮小零食
  for (let i = 0; i < 3; i++) {
    const o = grp(); at(o, -3.4 + i * 0.6, 0.6 + (i % 2) * 0.4, -0.8 + i * 0.7); G.add(o);
    o.rotation.set(i, i * 2, 0);
    const tri = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.24, 3), K.c(0xfdfdfd)); o.add(tri);
    bx(o, K.c(0x2c3446), 0.2, 0.08, 0.06, 0, -0.12, 0);
    o.userData.bubble = { float: true, ph: i };
  }
  crew(G, G, rng, [
    { pos: [-1.05, 0, -0.7], yaw: PI / 2, pose: 'recline', surface: FL + 0.42, look: { outfit: 'astro', style: 'twin' } },
    { pos: [-1.05, 0, 0.7], yaw: PI / 2, pose: 'recline', surface: FL + 0.42, look: { outfit: 'astro', style: 'short' } },
    { pos: [-3.4, -0.75, 0.3], yaw: 0.6, pose: 'float', look: { outfit: 'astro', style: 'bob' } },
  ]);
  thruster(G, new THREE.Vector3(-5.6, 0, 0), 0xb8f4ff, 1.8);
  G.userData.cabin = { pos: [-3.0, 0.5, -0.2], look: [3.0, 0.05, 0] };
  G.userData.seats = 3;
  return finish(G);
}

/* ============================== 9. 天空鲸 ============================== */
export function whale() {
  const G = new THREE.Group();
  const FL = -1.8;
  const K = kit(G, FL + 2.4);
  const rng = seeded(99);
  const R = 4.4, SX = 2.4, SZ = 1.15;
  const skin = K.hull(0x8fc4e8, 0xfff2e0);
  const belly = K.hull(0xf2f6fa, 0xfff2e0);
  sp(G, skin, R, 0, 0, 0, SX, 1.0, SZ).castShadow = true;
  sp(G, belly, R * 0.96, 0.3, -1.5, 0, SX * 0.95, 0.62, SZ * 0.96);
  for (let i = 0; i < 7; i++) bx(G, K.c(0xdde8f2), 12 - Math.abs(i - 3) * 2, 0.06, 0.08, 1.0, -4.15 + Math.abs(i - 3) * 0.12, -1.8 + i * 0.6);
  // 尾鳍（上下拍）
  const fl = new THREE.Group(); fl.position.set(-R * SX + 0.4, 0.4, 0); fl.userData.fluke = true; G.add(fl);
  for (const s of [-1, 1]) {
    const lobe = sp(fl, skin, 1.6, -1.8, 0, s * 1.9, 1.5, 0.22, 1.1);
    lobe.rotation.y = s * 0.5;
  }
  sp(fl, skin, 1.1, -0.6, 0, 0, 1.4, 0.5, 0.8);
  for (const s of [-1, 1]) {
    const pf = new THREE.Group(); pf.position.set(2.0, -2.4, s * 4.2);
    sp(pf, skin, 1.4, 0, -0.2, s * 1.0, 1.6, 0.25, 1.0).rotation.x = s * 0.6;
    pf.userData.flap = s * 0.35; G.add(pf);
  }
  // 脸
  for (const s of [-1, 1]) {
    sp(G, K.c(0xffffff), 0.7, 8.3, 0.5, s * 3.0, 1, 1.1, 0.6);
    const pu = sp(G, K.f(0x2a3550), 0.42, 8.6, 0.45, s * 3.12, 0.8, 1.1, 0.45); pu.userData.noInk = true;
    const hl = sp(G, K.f(0xffffff), 0.14, 8.75, 0.7, s * 3.16); hl.userData.noInk = true;
    const bl = plane(G, K.f(0xffb8c8), 0.7, 0.35, 8.9, -0.4, s * 3.0, s > 0 ? 0.5 : PI - 0.5); bl.userData.noInk = true;
  }
  const smile = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.07, 6, 30, 0.9), K.c(0x5a7aa0));
  smile.position.set(8.3, 0.4, 0); smile.rotation.set(PI / 2, 0, -0.45 + PI); G.add(smile);
  // 舷窗
  for (let i = 0; i < 6; i++) for (const s of [-1, 1]) {
    const x = -5 + i * 2.0, y = -0.3;
    const zz = SZ * R * Math.sqrt(Math.max(0, 1 - (x / (R * SX)) ** 2 - (y / R) ** 2));
    const p = new THREE.Vector3(x, y, s * zz);
    const nrm = new THREE.Vector3(x / (SX * SX), y, s * zz / (SZ * SZ)).normalize();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.08, 8, 20), K.c(0xfdfaf2));
    ring.position.copy(p).addScaledVector(nrm, 0.02); ring.lookAt(ring.position.clone().add(nrm)); G.add(ring);
    const gl = new THREE.Mesh(new THREE.CircleGeometry(0.48, 20), K.f(0xd4f0fa));
    gl.position.copy(p).addScaledVector(nrm, 0.015); gl.lookAt(gl.position.clone().add(nrm)); gl.userData.noInk = true; G.add(gl);
    const inn = new THREE.Mesh(new THREE.CircleGeometry(0.48, 20), K.f(0xfff6d8));
    inn.position.copy(p).addScaledVector(nrm, -0.06); inn.lookAt(inn.position.clone().sub(nrm)); inn.userData.noInk = true; G.add(inn);
  }
  // 喷水孔
  const spout = new THREE.Group(); spout.position.set(4.6, 4.25, 0); G.add(spout);
  for (let i = 0; i < 8; i++) {
    const d = new THREE.Mesh(new THREE.SphereGeometry(0.28 - i * 0.02, 10, 8), flat(0xd8f4ff));
    d.userData.noInk = true; d.userData.spout = { i }; spout.add(d);
  }
  spout.userData.spout = { root: true };

  // ---- 背上的凉亭 ----
  const DY = 4.05;
  cy(G, K.c(0xffffff, { map: woodFloor(K, '#e8c8a0') }), 3.5, 3.6, 0.35, 0, DY - 0.25, 0, 32);
  const rail = new THREE.Mesh(new THREE.TorusGeometry(3.35, 0.06, 6, 48), K.c(0xc49a6c));
  rail.rotation.x = PI / 2; rail.position.y = DY + 1.0; G.add(rail);
  for (let i = 0; i < 18; i++) { const a = i / 18 * PI * 2; cy(G, K.c(0xc49a6c), 0.04, 0.04, 1.0, Math.cos(a) * 3.35, DY + 0.1, Math.sin(a) * 3.35, 6); }
  for (let i = 0; i < 6; i++) { const a = i / 6 * PI * 2; cy(G, K.c(0xd9b98a), 0.09, 0.09, 2.4, Math.cos(a) * 1.5, DY + 0.1, Math.sin(a) * 1.5, 8); }
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.4, 1.3, 6), K.c(0xe08a7a, { steps: 3, shadow: 0x9a7ab4 }));
  roof.position.y = DY + 3.1; roof.castShadow = true; G.add(roof);
  sp(G, K.c(0xf2c744), 0.18, 0, DY + 3.85, 0);
  const benches = [0.8, 3.9];
  for (const a of benches) {
    const b = grp(); at(b, Math.cos(a) * 2.3, DY + 0.1, Math.sin(a) * 2.3, -a + PI / 2); G.add(b);
    bx(b, K.c(0xc49a6c), 1.4, 0.08, 0.45, 0, 0.42, 0);
    for (const s of [-1, 1]) bx(b, K.c(0x8a6a4a), 0.08, 0.42, 0.4, s * 0.6, 0, 0);
  }
  crew(G, G, rng, [
    ...benches.map((a, i) => ({ pos: [Math.cos(a) * 2.15, 0, Math.sin(a) * 2.15], yaw: Math.atan2(Math.cos(a), Math.sin(a)), pose: 'sit', surface: DY + 0.6, look: { outfit: ['dress', 'sailor'][i] } })),
    { pos: [Math.cos(2.4) * 3.0, DY + 0.1, Math.sin(2.4) * 3.0], yaw: Math.atan2(Math.cos(2.4), Math.sin(2.4)), pose: 'wave', look: { outfit: 'casual', style: 'twin' } },
  ]);

  // ---- 腹中酒廊 ----
  const fz = SZ * R * Math.sqrt(1 - (FL / R) ** 2) - 0.25, fx = SX * R * Math.sqrt(1 - (FL / R) ** 2) - 0.6;
  const floor = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.15, 48), K.c(0xffffff, { map: woodFloor(K, '#c99a6a') }));
  floor.scale.set(fx, 1, fz); floor.position.y = FL - 0.075; floor.receiveShadow = true; G.add(floor);
  G.add(at(rug(K, { w: 4, d: 3, color: 0x9fd0f0 }), 2.4, FL, 0));
  const s1 = sofa(K, { w: 2.2, color: 0xf2a6c0 }); at(s1, 2.4, FL, -1.6); G.add(s1);
  const s2 = sofa(K, { w: 2.2, color: 0xf2a6c0 }); at(s2, 2.4, FL, 1.6, PI); G.add(s2);
  G.add(at(coffeeTable(K, { w: 1.3, d: 0.7 }), 2.4, FL, 0));
  // 吧台
  const bar = counter(K, { len: 3.0, color: 0x6a4a5a, top: 0xf2e6d0 }); at(bar, -4.0, FL, 0.2, PI / 2); G.add(bar);
  const shelf = grp(); at(shelf, -5.6, FL, 0.2, PI / 2); G.add(shelf);
  bx(shelf, K.c(0x8a6a5a), 2.6, 1.8, 0.3, 0, 0, 0);
  for (let r = 0; r < 3; r++) for (let i = 0; i < 7; i++) cy(shelf, K.c([0x8fd09a, 0xe07a8a, 0xf2c744, 0x7ec4d8, 0xd0b8f0][(i + r) % 5], { transparent: true, opacity: 0.9 }), 0.06, 0.07, 0.32, -1.0 + i * 0.33, 0.55 + r * 0.45, 0.1, 10);
  for (let i = 0; i < 3; i++) { const st = stool(K, 0xf2c744); at(st, -3.2, FL, -0.8 + i * 1.0); G.add(st); }
  for (let i = 0; i < 3; i++) cy(G, K.c(0xfde6f0, { transparent: true, opacity: 0.85 }), 0.06, 0.04, 0.16, -3.85, FL + 1.05, -0.5 + i * 0.5, 10);
  // 床铺（前端）
  const bd = bed(K, { w: 1.3, l: 2.1, color: 0xc8b8f0 }); at(bd, 6.3, FL, 0, PI / 2); G.add(bd);
  // 钢琴
  const pi = grp(); at(pi, -0.6, FL, -2.4); G.add(pi);
  const pbody = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.32, 24, 1, false, 0, PI), K.c(0x2c2c3a));
  pbody.position.set(0, 0.85, 0); pbody.scale.set(1.0, 1, 1.4); pi.add(pbody);
  bx(pi, K.c(0x2c2c3a), 1.5, 0.32, 0.5, 0, 0.69, -0.25);
  bx(pi, K.c(0xfdfdfd), 1.3, 0.04, 0.18, 0, 0.88, -0.58);
  const lid = bx(pi, K.c(0x2c2c3a), 1.4, 0.03, 1.0, 0, 1.0, 0.3); lid.rotation.x = -0.6;
  for (const [x, z] of [[-0.6, -0.4], [0.6, -0.4], [0, 0.8]]) cy(pi, K.c(0x2c2c3a), 0.05, 0.05, 0.7, x, 0, z, 8);
  bx(pi, K.c(0x2c2c3a), 0.8, 0.45, 0.35, 0, 0, -1.05);
  G.add(at(plant(K, { h: 1.3 }), -1.8, FL, 2.6));
  G.add(at(plant(K, { h: 1.0, pot: 0x7ec4d8 }), 4.6, FL, -2.4));
  G.add(at(bookshelf(K, { w: 1.2, h: 1.6, rng }), 4.6, FL, 2.7, PI));
  for (const x of [-3.6, 0.2, 2.4, 5.0]) G.add(at(pendant(K, { y: 3.2, drop: 1.4, color: 0xfde6c8 }), x, 0, 0));
  crew(G, G, rng, [
    { pos: [2.0, 0, -1.55], yaw: 0, pose: 'sit', surface: FL + 0.45, look: { outfit: 'suit', style: 'short' } },
    { pos: [2.8, 0, 1.55], yaw: PI, pose: 'read', surface: FL + 0.45, look: { outfit: 'dress', style: 'long' } },
    { pos: [-4.8, FL, 0.2], yaw: PI / 2, pose: 'stand', look: { outfit: 'suit', style: 'pony', c1: 0xfdfdfd } },
    { pos: [-3.05, 0, 0.2], yaw: -PI / 2, pose: 'sit', surface: FL + 0.62, look: { outfit: 'casual' } },
    { pos: [-0.6, 0, -3.35], yaw: 0, pose: 'hold', surface: FL + 0.45, look: { outfit: 'dress', style: 'bun', c1: 0xd0b8f0 } },
    { pos: [7.2, 0, 0], yaw: PI / 2 + PI, pose: 'sleep', surface: FL + 0.52, look: { outfit: 'pajama' } },
  ]);
  thruster(G, new THREE.Vector3(-R * SX - 2.8, 0.4, 0), 0xa8f0ff, 2.2);
  G.userData.cabin = { pos: [5.6, FL + 1.4, 2.6], look: [-5, FL + 0.8, -1] };
  G.userData.seats = 9;
  return finish(G);
}

/**
 * 机队清单 = mihomo 的「节点列表」
 *   speed: 最高巡航速度  agility: 转弯/加速能力  mass: 姿态惯性（越大越稳越慢）
 *   style: 运动个性（见 flight.js）
 */
export const FLEET = [
  { id: 'paper',     name: '折纸机',   sub: '轻快 · 低延迟',   build: paper,     color: 0xfffdf5, scale: 1, speed: 34, agility: 1.3, mass: 0.6, ping: 38,  dest: '外滩 · 江面滑翔', style: 'glide' },
  { id: 'teapot',    name: '茶壶船',   sub: '悠闲 · 下午茶',   build: teapot,    color: 0x9fd8e8, scale: 1, speed: 20, agility: 0.8, mass: 1.2, ping: 120, dest: '陆家嘴 云端茶屋', style: 'rock' },
  { id: 'jelly',     name: '水母艇',   sub: '静音 · 慢慢飘',   build: jelly,     color: 0xe8b8f0, scale: 1, speed: 15, agility: 0.6, mass: 1.4, ping: 210, dest: '东方明珠 环游', style: 'pulse' },
  { id: 'catbus',    name: '猫巴士',   sub: '欢乐 · 三两友人', build: catbus,    color: 0xf0b870, scale: 1, speed: 26, agility: 1.0, mass: 1.0, ping: 66,  dest: '石库门 弄堂', style: 'gallop' },
  { id: 'tram',      name: '空中電車', sub: '准点 · 通勤线',   build: tram,      color: 0xf29bb6, scale: 1, speed: 28, agility: 0.9, mass: 1.1, ping: 52,  dest: '雲の上 駅', style: 'rail' },
  { id: 'goldfish',  name: '金鱼灯笼', sub: '祭典 · 夜市限定', build: goldfish,  color: 0xf5835f, scale: 1, speed: 19, agility: 1.0, mass: 1.0, ping: 145, dest: '黄浦江 灯会', style: 'swim' },
  { id: 'dandelion', name: '蒲公英伞', sub: '随风 · 不定时',   build: dandelion, color: 0xc8e6a0, scale: 1, speed: 13, agility: 0.5, mass: 1.6, ping: 320, dest: '风的尽头', style: 'drift' },
  { id: 'ramune',    name: '汽水火箭', sub: '极速 · 冒泡泡',   build: ramune,    color: 0x8fd8f0, scale: 1, speed: 46, agility: 1.6, mass: 0.7, ping: 24,  dest: '上海中心 顶上', style: 'rocket' },
  { id: 'whale',     name: '天空鲸',   sub: '旗舰 · 塔顶泊位', build: whale,     color: 0x8fc4e8, scale: 1, speed: 17, agility: 0.45, mass: 2.4, ping: 88,  dest: '魔都 环城巡游', style: 'whale' },
];
