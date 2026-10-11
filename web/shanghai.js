/**
 * shanghai.js — 隔壁的上海（二次元·迷你比例 ≈ 0.43）
 *
 *   黄浦江：从南向北，在陆家嘴处转弯向东入海
 *   浦东：东方明珠（下球体里有观景台）、上海中心（120° 扭转）、金茂（宝塔节奏）、
 *         环球金融中心（开瓶器）、滨江绿地、一栋能看见每层工位的玻璃写字楼
 *   浦西：外滩万国建筑群（海关钟楼、和平饭店绿顶、汇丰穹顶）、外滩咖啡馆、
 *         石库门弄堂（每户都有内饰）、后排街区
 *   杨浦大桥、江上渡轮
 * 本地坐标：+X 朝东（朝空港），整体放在 ORIGIN。
 */
import * as THREE from 'three';
import { Kit, bx, cy, sp, plane, G as grp, at, wall, table, chair, bed, plant, pendant, counter, stool, bookshelf, woodFloor, laundry, bicycle, stairs, rug } from './interior.js';
import { makeChar, randomLook, place, seeded, clipChars } from './chars.js';
import { bake } from './bake.js';

export const ORIGIN = new THREE.Vector3(-880, 0, -60);
const PI = Math.PI;
const FONT = '"Hiragino Sans","PingFang SC",sans-serif';
const TOP = 1.2;                                     // 地面高度

/* --------------------------- 黄浦江 --------------------------- */
export const RIVER = [[-75, 460], [-68, 220], [-60, 40], [-50, -80], [-22, -160], [40, -205], [150, -222], [340, -228]];
const RW = 64;
function banks() {
  const L = [], R = [];
  for (let i = 0; i < RIVER.length; i++) {
    const a = RIVER[Math.max(0, i - 1)], b = RIVER[Math.min(RIVER.length - 1, i + 1)];
    const tx = b[0] - a[0], tz = b[1] - a[1], l = Math.hypot(tx, tz);
    const nx = -tz / l, nz = tx / l;                 // 指向浦东一侧
    L.push([RIVER[i][0] - nx * RW / 2, RIVER[i][1] - nz * RW / 2]);
    R.push([RIVER[i][0] + nx * RW / 2, RIVER[i][1] + nz * RW / 2]);
  }
  return { puxi: L, pudong: R };
}
/** 沿江中线取点（渡轮用） */
export function riverAt(u, out = new THREE.Vector3()) {
  const n = RIVER.length - 1, f = THREE.MathUtils.clamp(u, 0, 0.9999) * n, i = Math.floor(f), t = f - i;
  out.set(RIVER[i][0] + (RIVER[i + 1][0] - RIVER[i][0]) * t, 0, RIVER[i][1] + (RIVER[i + 1][1] - RIVER[i][1]) * t);
  return out;
}

/* --------------------------- 立面贴图 --------------------------- */
function facade(K, kind) {
  const spec = {
    glass:  { bg: '#b6d2ea', win: '#a2c8ee', frame: '#eef6fc', ww: 0.86, wh: 0.78 },
    glass2: { bg: '#c8e4dc', win: '#9fd6d0', frame: '#f2fbf8', ww: 0.9, wh: 0.82 },
    glass3: { bg: '#d6cfee', win: '#b6aee6', frame: '#f6f2ff', ww: 0.9, wh: 0.8 },
    office: { bg: '#f4f1ea', win: '#9cc6ea', frame: '#ffffff', ww: 0.6, wh: 0.55 },
    res:    { bg: '#f6e8d8', win: '#a8c8e8', frame: '#ffffff', ww: 0.45, wh: 0.5, balcony: true },
    res2:   { bg: '#f2dcdc', win: '#a8c4e8', frame: '#ffffff', ww: 0.45, wh: 0.5, balcony: true },
    stone:  { bg: '#efe4cc', win: '#8aa0c0', frame: '#f8f0dc', ww: 0.38, wh: 0.62, arch: true },
    brick:  { bg: '#9a9aa4', win: '#c8a070', frame: '#e8e0d0', ww: 0.36, wh: 0.5, brick: true },
  }[kind];
  return K.tex('fac' + kind, 64, 64, (c) => {
    c.fillStyle = spec.bg; c.fillRect(0, 0, 64, 64);
    if (spec.brick) {
      c.fillStyle = 'rgba(160,80,70,.55)';
      for (let y = 0; y < 64; y += 8) c.fillRect(0, y, 64, 1.5);
    }
    const w = 64 * spec.ww, h = 64 * spec.wh, x = (64 - w) / 2, y = (64 - h) / 2 + 4;
    c.fillStyle = spec.frame; c.fillRect(x - 2, y - 2, w + 4, h + 4);
    c.fillStyle = spec.win;
    if (spec.arch) { c.beginPath(); c.moveTo(x, y + h); c.lineTo(x, y + w / 2); c.arc(x + w / 2, y + w / 2, w / 2, PI, 0); c.lineTo(x + w, y + h); c.fill(); }
    else c.fillRect(x, y, w, h);
    c.fillStyle = 'rgba(255,255,255,.45)';
    c.beginPath(); c.moveTo(x + w * 0.15, y + h); c.lineTo(x + w * 0.55, y); c.lineTo(x + w * 0.75, y); c.lineTo(x + w * 0.35, y + h); c.fill();
    if (spec.balcony) { c.fillStyle = '#ffffff'; c.fillRect(4, y + h - 4, 56, 5); }
    c.fillStyle = spec.bg; c.fillRect(0, 0, 3, 3);                    // 角落留一块纯色：屋顶采样用
  });
}
const TILE = 3.4;
/** 立面盒子：UV 按世界尺寸铺窗，屋顶采样纯色角 */
function tower(p, m, w, h, d, x, y, z, ry = 0) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  const dims = [[d, h], [d, h], [0, 0], [0, 0], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) {
    const i = f * 4 + k;
    const [fw, fh] = dims[f];
    if (fw === 0) uv.setXY(i, 0.01, 0.99);
    else uv.setXY(i, uv.getX(i) * fw / TILE, uv.getY(i) * fh / TILE);
  }
  const o = new THREE.Mesh(geo, m);
  o.position.set(x, y + h / 2, z); o.rotation.y = ry;
  o.castShadow = o.receiveShadow = true;
  p.add(o);
  return o;
}
function towerCyl(p, m, r0, r1, h, x, y, z, seg = 32) {
  const geo = new THREE.CylinderGeometry(r0, r1, h, seg, 1, false);
  const uv = geo.attributes.uv, pos = geo.attributes.position;
  for (let i = 0; i < uv.count; i++) {
    if (Math.abs(pos.getY(i)) > h / 2 - 1e-3 && Math.hypot(pos.getX(i), pos.getZ(i)) < Math.max(r0, r1) - 1e-3) uv.setXY(i, 0.01, 0.99);
    else uv.setXY(i, uv.getX(i) * 2 * PI * Math.max(r0, r1) / TILE, uv.getY(i) * h / TILE);
  }
  const o = new THREE.Mesh(geo, m);
  o.position.set(x, y + h / 2, z);
  o.castShadow = o.receiveShadow = true;
  p.add(o);
  return o;
}

/* --------------------------- 地标 --------------------------- */
/** 东方明珠：三根直筒 + 三根斜撑 + 两颗大球 + 太空舱 + 天线；下球体内有观景台 */
function pearlTower(K, KP) {
  const g = grp();
  const pink = KP.hull(0xf28ab8, 0xfff0f6, { steps: 3, shadow: 0xb070b0 });
  const col = K.c(0xf6f2f6, { steps: 3, shadow: 0xa8a8d0 });
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * PI * 2;
    cy(g, col, 2.3, 2.3, 160, Math.cos(a) * 4.5, 0, Math.sin(a) * 4.5, 20);
    const leg = cy(g, col, 1.6, 2.0, 46, 0, 0, 0, 16);
    leg.position.set(Math.cos(a) * 15, 21, Math.sin(a) * 15);
    leg.lookAt(Math.cos(a) * 4.5, 42, Math.sin(a) * 4.5); leg.rotateX(PI / 2);
  }
  // 下球体（剖切可见观景台）
  const S1 = 44;
  const b1 = new THREE.Mesh(new THREE.SphereGeometry(13, 48, 32), pink); b1.position.y = S1; b1.castShadow = true; g.add(b1);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(13.05, 13.05, 3.2, 48, 1, true), KP.c(0x9fd0f0, { transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
  band.position.y = S1 + 1.6; band.userData.noInk = true; g.add(band);
  const deck = cy(g, KP.c(0xfdfaf6, { map: woodFloor(KP, '#e6dcd0') }), 12.4, 12.4, 0.4, 0, S1 - 0.2, 0, 48);
  deck.receiveShadow = true;
  for (let i = 0; i < 24; i++) {
    const a = i / 24 * PI * 2;
    cy(g, KP.c(0xc8ccd8), 0.05, 0.05, 1.1, Math.cos(a) * 11.6, S1 + 0.2, Math.sin(a) * 11.6, 6);
  }
  const rr = new THREE.Mesh(new THREE.TorusGeometry(11.6, 0.06, 6, 64), KP.c(0xc8ccd8)); rr.rotation.x = PI / 2; rr.position.y = S1 + 1.3; g.add(rr);
  cy(g, KP.c(0xf6f2f6), 4.0, 4.0, 4.2, 0, S1 + 0.2, 0, 24);        // 电梯核
  // 观景台上的游客
  const rng = seeded(501);
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * PI * 2 + 0.2;
    const ch = makeChar(randomLook(rng));
    place(ch, g, { pos: [Math.cos(a) * 10.9, S1 + 0.2, Math.sin(a) * 10.9], yaw: Math.atan2(Math.cos(a), Math.sin(a)), pose: i % 3 ? 'lean' : 'stand' });
  }
  // 中间小球
  for (let i = 0; i < 5; i++) sp(g, pink, 3.0, Math.cos(i * 1.3) * 4.5, 70 + i * 9, Math.sin(i * 1.3) * 4.5);
  const b2 = sp(g, pink, 9.5, 0, 118, 0); b2.castShadow = true;
  const band2 = new THREE.Mesh(new THREE.CylinderGeometry(9.55, 9.55, 2, 40, 1, true), K.c(0x9fd0f0)); band2.position.y = 119; band2.userData.noInk = true; g.add(band2);
  cy(g, col, 2.4, 2.8, 40, 0, 118, 0, 16);
  sp(g, pink, 4.2, 0, 160, 0);
  cy(g, col, 1.2, 1.6, 18, 0, 163, 0, 12);
  cy(g, K.c(0xe8e8f0), 0.3, 1.0, 40, 0, 180, 0, 8);
  // 底座
  cy(g, K.c(0xe8e2da), 22, 24, 6, 0, 0, 0, 40);
  return g;
}

/** 上海中心：圆角三角形截面逐层旋转 120°，向上收分 */
function shanghaiTower(K) {
  const H = 270, N = 60, M = 48;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, y = t * H;
    const r = 22 * (1 - t * 0.42) * (t > 0.9 ? 1 - (t - 0.9) * 2.2 : 1);
    const rot = t * PI * 2 / 3;
    for (let j = 0; j <= M; j++) {
      const a = j / M * PI * 2;
      const rr = r * (1 + 0.16 * Math.cos(3 * a));         // 圆角三角
      pos.push(Math.cos(a + rot) * rr, y, Math.sin(a + rot) * rr);
      uv.push(j / M * 2 * PI * r / TILE, y / TILE);
    }
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) {
    const a = i * (M + 1) + j, b = a + M + 1;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const g = grp();
  const m = new THREE.Mesh(geo, K.c(0xffffff, { map: facade(K, 'glass'), side: THREE.DoubleSide, steps: 3, low: 0.78, shadow: 0x8aa0d0 }));
  m.castShadow = true; g.add(m);
  cy(g, K.c(0xdfe8f2), 7, 9, 12, 0, H - 4, 0, 24);
  cy(g, K.c(0xc8d4e4), 26, 28, 10, 0, 0, 0, 40);
  return g;
}

/** 金茂：宝塔式逐段收分 + 顶部尖塔 */
function jinMao(K) {
  const g = grp();
  const m = K.c(0xffffff, { map: facade(K, 'glass3'), steps: 3, low: 0.78, shadow: 0x9a98c8 });
  const rib = K.c(0xe8e4f2);
  let y = 0, r = 17;
  for (let i = 0; i < 13; i++) {
    const h = i < 8 ? 15 - i * 0.8 : 8 - (i - 8) * 0.8;
    towerCyl(g, m, r * 0.97, r, h, 0, y, 0, 8).rotation.y = PI / 8;
    const ring = cy(g, rib, r + 0.6, r + 0.6, 0.8, 0, y + h - 0.4, 0, 8); ring.rotation.y = PI / 8;
    y += h; r *= i < 8 ? 0.94 : 0.86;
  }
  const crown = new THREE.Mesh(new THREE.ConeGeometry(r * 1.3, 14, 8), K.c(0xdfe0ee)); crown.position.y = y + 7; crown.rotation.y = PI / 8; g.add(crown);
  cy(g, K.c(0xe8e8f0), 0.4, 1.5, 22, 0, y + 12, 0, 8);
  return g;
}

/** 环球金融中心：方柱斜削 + 顶部开瓶器洞口 */
function swfc(K) {
  const g = grp(), H = 220;
  const m = K.c(0xffffff, { map: facade(K, 'glass2'), steps: 3, low: 0.78, shadow: 0x88a8c8 });
  const geo = new THREE.BoxGeometry(34, H * 0.84, 34, 1, 12, 1);
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) + H * 0.42) / (H * 0.84);
    p.setZ(i, p.getZ(i) * (1 - t * 0.72));
  }
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 34 / TILE, uv.getY(i) * H * 0.84 / TILE);
  geo.computeVertexNormals();
  const body = new THREE.Mesh(geo, m); body.position.y = H * 0.42; body.castShadow = true; g.add(body);
  // 顶部：两根侧柱 + 顶梁（洞口）
  const zt = 34 * 0.28 / 2;
  for (const s of [-1, 1]) tower(g, m, 7, H * 0.16, zt * 2, s * 13.5, H * 0.84, 0);
  tower(g, m, 34, 6, zt * 2, 0, H - 6, 0);
  cy(g, K.c(0xc8d4e4), 26, 26, 8, 0, 0, 0, 4).rotation.y = PI / 4;
  return g;
}

/** 写字楼：玻璃幕墙透明，能看到每层工位 */
function officeTower(K, rng) {
  const g = grp();
  const W = 26, D = 20, FH = 4.2, NF = 18;
  const slab = K.c(0xf2f0ea), core = K.c(0xd8dce6);
  for (let f = 0; f <= NF; f++) bx(g, slab, W, 0.4, D, 0, f * FH, 0);
  bx(g, core, 6, NF * FH, 5, 0, 0, 0);
  for (const [x, z] of [[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]]) bx(g, K.c(0xe8eef4), 0.8, NF * FH, 0.8, x, 0, z);
  const glass = K.glass(0xbfe0f6, 0.28);
  for (const [w, x, z, ry] of [[W, 0, D / 2, 0], [W, 0, -D / 2, 0], [D, W / 2, 0, PI / 2], [D, -W / 2, 0, PI / 2]]) {
    const gp = plane(g, glass, w, NF * FH, x, NF * FH / 2, z, ry); gp.renderOrder = 2;
    for (let f = 1; f < NF; f++) bx(g, K.c(0xe8eef4), w, 0.25, 0.25, x, f * FH - 0.1, z, ry);
  }
  // 工位：实例化（桌、显示器、椅子）
  const desks = [], spots = [];
  for (let f = 0; f < NF; f++) for (let r = 0; r < 2; r++) for (let c = 0; c < 6; c++) {
    if (Math.abs(-W / 2 + 3 + c * 4) < 4.5 && Math.abs(-D / 2 + 3.5 + r * 13 - 0) < 4) continue;
    desks.push([-W / 2 + 3 + c * 4, f * FH + 0.4, -D / 2 + 3.5 + r * 13]);
  }
  const inst = (geo, mat, off) => {
    const im = new THREE.InstancedMesh(geo, mat, desks.length);
    const M = new THREE.Matrix4();
    desks.forEach((d, i) => { M.makeTranslation(d[0] + off[0], d[1] + off[1], d[2] + off[2]); im.setMatrixAt(i, M); });
    im.castShadow = true; im.userData.noInk = true; g.add(im);
  };
  inst(new THREE.BoxGeometry(1.6, 0.06, 0.8), K.c(0xfdfdfd), [0, 0.72, 0]);
  inst(new THREE.BoxGeometry(1.5, 0.7, 0.05), K.c(0xc8ccd8), [0, 0.36, -0.38]);
  inst(new THREE.BoxGeometry(0.6, 0.38, 0.04), K.c(0x3a4058), [0, 0.98, -0.2]);
  inst(new THREE.BoxGeometry(0.5, 0.08, 0.5), K.c(0x5a6a9a), [0, 0.48, 0.55]);
  // 低层坐几个人
  for (let i = 0; i < 6; i++) {
    const d = desks[i * 3 + 1];
    const ch = makeChar(randomLook(rng, { outfit: 'suit' }));
    place(ch, g, { pos: [d[0], 0, d[2] + 0.55], yaw: PI, pose: 'sit', surface: d[1] + 0.52 });
  }
  bx(g, K.c(0xdfe8f2), W + 1, 3, D + 1, 0, NF * FH, 0);
  return g;
}

/* --------------------------- 外滩 --------------------------- */
function bundBuilding(K, i, rng) {
  const g = grp();
  const stone = K.c(0xffffff, { map: facade(K, 'stone') });
  const cream = K.c(0xf2e8d2), trim = K.c(0xfdf8ec);
  const w = 18 + (i % 3) * 4, d = 20, h = 22 + ((i * 7) % 5) * 4;
  tower(g, stone, d, h, w, 0, 0, 0);
  bx(g, trim, d + 1.2, 1.2, w + 1.2, 0, h - 1.2, 0);                       // 檐口
  bx(g, cream, d + 0.6, 3.6, w + 0.6, 0, 0, 0);                            // 基座
  for (let k = 0; k < Math.floor(w / 3.2); k++) cy(g, trim, 0.55, 0.65, h * 0.42, d / 2 + 0.4, h * 0.3, -w / 2 + 1.6 + k * 3.2, 12);  // 立柱
  bx(g, trim, 1.2, 1.0, w * 0.9, d / 2 + 0.5, h * 0.72, 0);
  const kind = i % 5;
  if (kind === 1) {                                                         // 海关钟楼
    tower(g, stone, 9, 16, 9, 0, h, 0);
    for (const [x, z, ry] of [[4.55, 0, PI / 2], [-4.55, 0, -PI / 2], [0, 4.55, 0], [0, -4.55, PI]]) {
      const c = new THREE.Mesh(new THREE.CircleGeometry(2.8, 28), K.f(0xfdfaf2)); c.position.set(x, h + 10, z); c.rotation.y = ry; g.add(c);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.2, 0.1), K.f(0x2c3e5c)); hand.position.set(x * 1.01, h + 10.8, z * 1.01); hand.rotation.y = ry; hand.userData.noInk = true; g.add(hand);
    }
    const cap = new THREE.Mesh(new THREE.ConeGeometry(5.5, 6, 4), K.c(0x8fbca0)); cap.position.y = h + 19; cap.rotation.y = PI / 4; g.add(cap);
  } else if (kind === 3) {                                                  // 和平饭店：绿色金字塔顶
    tower(g, stone, 10, 8, 10, 0, h, 0);
    const pyr = new THREE.Mesh(new THREE.ConeGeometry(7.6, 9, 4), K.c(0x6fb59a, { steps: 3 })); pyr.position.y = h + 12.5; pyr.rotation.y = PI / 4; g.add(pyr);
  } else if (kind === 4) {                                                  // 汇丰：穹顶
    cy(g, trim, 6.5, 7, 4, 0, h, 0, 24);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(6.4, 32, 16, 0, PI * 2, 0, PI / 2), K.c(0xe8dcc4)); dome.position.y = h + 4; g.add(dome);
    sp(g, trim, 0.8, 0, h + 10.8, 0);
  } else {
    for (let k = 0; k < 3; k++) bx(g, trim, 1.2, 2.2, 1.2, d / 2 - 0.6, h, -w / 2 + 2 + k * (w - 4) / 2);  // 屋顶小亭
  }
  return { g, w, h };
}

/** 外滩一楼咖啡馆：拱形开口 + 室内桌椅 + 客人 */
function bundCafe(KC, rng) {
  const g = grp();
  const W = 18, D = 12, H = 4.2;
  const out = KC.c(0xf2e8d2), inn = KC.c(0xfdf2e2);
  const front = wall(KC, { len: W, h: H, t: 0.5, out, inn, openings: [-6, -2, 2, 6].map(x => ({ x, y: 0, w: 3, h: 3.4, kind: 'open' })) });
  at(front, 0, 0, D / 2, 0); g.add(front);
  for (const [len, x, z, ry] of [[W, 0, -D / 2, PI], [D, W / 2, 0, PI / 2], [D, -W / 2, 0, -PI / 2]]) {
    const wl = wall(KC, { len, h: H, t: 0.5, out, inn }); at(wl, x, 0, z, ry); g.add(wl);
  }
  bx(g, KC.c(0xfdf2e2), W, 0.3, D, 0, H, 0);
  for (const x of [-6, -2, 2, 6]) {
    const ar = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.18, 6, 16, PI), KC.c(0xfdf8ec)); ar.position.set(x, 3.4, D / 2 + 0.3); g.add(ar);
  }
  bx(g, KC.c(0xffffff, { map: KC.tex('cafefloor', 64, 64, (c) => {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { c.fillStyle = (x + y) % 2 ? '#2c3446' : '#f6f0e4'; c.fillRect(x * 8, y * 8, 8, 8); }
  }, [6, 4]) }), W, 0.1, D, 0, 0, 0).receiveShadow = true;
  const ct = counter(KC, { len: 5, color: 0x6a4a3a, top: 0xf2e6d0 }); at(ct, 4, 0.1, -3.5); g.add(ct);
  // 咖啡机
  bx(g, KC.c(0xc8ccd8), 0.8, 0.6, 0.5, 5.4, 1.15, -3.6);
  for (let i = 0; i < 3; i++) cy(g, KC.c(0xfdfaf2), 0.06, 0.05, 0.1, 3.4 + i * 0.4, 1.15, -3.3, 10);
  const pts = [[-6, 2], [-3, -1], [-6, -3], [0, 2.5], [1, -1.5]];
  const people = [];
  pts.forEach(([x, z], i) => {
    const t = table(KC, { w: 1.0, d: 1.0, color: 0xfdfaf2 }); at(t, x, 0.1, z); g.add(t);
    cy(g, KC.c(0xfdfaf2), 0.07, 0.06, 0.1, x + 0.2, 0.82, z, 10);
    sp(g, KC.c(0xf2a6c0), 0.12, x - 0.2, 0.9, z + 0.1, 1, 0.6, 1);
    for (const s of [-1, 1]) {
      const c = chair(KC, 0x6a4a3a); at(c, x, 0.1, z + s * 0.75, s > 0 ? PI : 0); g.add(c);
      if ((i + (s > 0 ? 0 : 1)) % 2 === 0) people.push({ pos: [x, 0, z + s * 0.7], yaw: s > 0 ? PI : 0, pose: i === 3 ? 'read' : 'sit', surface: 0.57 });
    }
  });
  for (const p of people) place(makeChar(randomLook(rng)), g, p);
  place(makeChar(randomLook(rng, { outfit: 'chef' })), g, { pos: [4, 0.1, -4.4], yaw: 0, pose: 'stand' });
  for (const x of [-6, -2, 2]) g.add(at(pendant(KC, { y: H, drop: 1.0, color: 0xf2c744 }), x, 0, 0));
  g.add(at(plant(KC, { h: 1.4 }), -8, 0.1, -5));
  // 招牌
  const sg = plane(g, KC.f(0xffffff, { map: KC.tex('cafesign', 256, 64, (c) => {
    c.fillStyle = '#2c4a3a'; c.fillRect(0, 0, 256, 64); c.fillStyle = '#f6e6c0'; c.textAlign = 'center';
    c.font = `800 34px ${FONT}`; c.fillText('外滩咖啡 · BUND CAFÉ', 128, 44);
  }) }), 8, 2, 0, 3.9 + 0.6, D / 2 + 0.3);
  return g;
}

/* --------------------------- 石库门弄堂 --------------------------- */
function shikumenRow(KS, rng, n, faceZ) {
  const g = grp();
  const brick = KS.c(0xffffff, { map: facade(KS, 'brick') }), inn = KS.c(0xfdf4e6);
  const stone = KS.c(0xe8e0d0), door = KS.c(0x2c2c34), roof = KS.c(0x5a5a68, { steps: 3 });
  const W = 5.2, D = 9, H1 = 3.4, H2 = 3.0;
  for (let i = 0; i < n; i++) {
    const h = grp(); at(h, -((n - 1) * W) / 2 + i * W, 0, 0); g.add(h);
    // 一楼：客堂 + 楼梯；二楼：卧室
    const ops1 = { s: [{ x: 0, y: 0, w: 1.4, h: 2.3, kind: 'door', open: 0.6, color: 0x2c2c34 }], n: [{ x: 1.2, y: 1.0, w: 1.0, h: 1.0, kind: 'window' }] };
    const ops2 = { s: [{ x: -1.2, y: 0.9, w: 1.1, h: 1.3, kind: 'window' }, { x: 1.2, y: 0.9, w: 1.1, h: 1.3, kind: 'window' }], n: [{ x: 0, y: 1.0, w: 1.2, h: 1.0, kind: 'window' }] };
    const mk = (y, hh, ops) => {
      const f = grp(); f.position.y = y; h.add(f);
      const sides = [['s', 0, D / 2, 0, W], ['n', 0, -D / 2, PI, W], ['e', W / 2, 0, PI / 2, D - 0.16], ['w', -W / 2, 0, -PI / 2, D - 0.16]];
      for (const [k, x, z, ry, len] of sides) {
        const wl = wall(KS, { len, h: hh, t: 0.16, out: brick, inn, openings: ops[k] || [], frame: 0xe8e0d0, curtain: 0xf2d6c0 });
        at(wl, x, 0, z, ry); f.add(wl);
      }
      return f;
    };
    const f1 = mk(0, H1, ops1), f2 = mk(H1 + 0.2, H2, ops2);
    bx(h, KS.c(0xffffff, { map: woodFloor(KS, '#b88a5a') }), W - 0.2, 0.1, D - 0.2, 0, 0, 0).receiveShadow = true;
    const fl2 = KS.c(0xffffff, { map: woodFloor(KS, '#c89a6a') });           // 二楼楼板，楼梯处留洞
    bx(h, fl2, 1.4 + W / 2 - 0.1, 0.2, D - 0.2, (-W / 2 + 0.1 + 1.4) / 2, H1, 0);
    bx(h, fl2, W / 2 - 0.1 - 1.4, 0.2, D / 2 - 0.4, (1.4 + W / 2 - 0.1) / 2, H1, (-D / 2 + 0.1 - 0.3) / 2);
    // 石门框 + 三角山花
    bx(h, stone, 2.2, 0.3, 0.3, 0, 2.35, D / 2 + 0.15);
    for (const s of [-1, 1]) bx(h, stone, 0.3, 2.4, 0.3, s * 0.85, 0, D / 2 + 0.15);
    const ped = new THREE.Mesh(new THREE.ConeGeometry(1.4, 0.8, 3), stone); ped.rotation.set(PI / 2, 0, 0); ped.scale.set(1, 1, 0.3);
    ped.position.set(0, 3.0, D / 2 + 0.2); ped.rotation.z = PI; h.add(ped);
    // 屋顶
    for (const s of [-1, 1]) {
      const r = bx(h, roof, W + 0.3, 0.2, D / 2 + 0.6, 0, H1 + H2 + 1.1, s * (D / 4)); r.rotation.x = s * 0.42;
    }
    for (const s of [-1, 1]) {
      const tri = new THREE.Shape(); tri.moveTo(-D / 2, 0); tri.lineTo(D / 2, 0); tri.lineTo(0, 2.0); tri.lineTo(-D / 2, 0);
      const gab = new THREE.Mesh(new THREE.ShapeGeometry(tri), brick); gab.position.set(s * W / 2, H1 + H2 + 0.2, 0); gab.rotation.y = s * PI / 2; h.add(gab);
    }
    // 一楼客堂：八仙桌 + 长凳 + 条案 + 楼梯
    const t = table(KS, { w: 1.1, d: 1.1, color: 0x8a5a3a }); at(t, -0.8, 0.1, 1.2); h.add(t);
    for (const s of [-1, 1]) { const c = chair(KS, 0x8a5a3a); at(c, -0.8 + s * 0.75, 0.1, 1.2, s * PI / 2 * -1); h.add(c); }
    bx(h, KS.c(0x6a4a3a), 2.0, 0.85, 0.45, -0.6, 0.1, -3.9);
    cy(h, KS.c(0x7ec4d8), 0.18, 0.12, 0.4, -1.2, 0.95, -3.9, 12);
    const stc = stairs(KS, { w: 0.9, rise: H1 + 0.1, run: 3.2, n: 14, color: 0x9a6a4a }); at(stc, 1.9, 0.1, 3.0); h.add(stc);
    // 二楼：床 + 衣柜 + 窗外竹竿晾衣
    const bd = bed(KS, { w: 1.2, l: 1.9, color: [0xf2c4d0, 0xb8d8f0, 0xf6e6a0][i % 3], frame: 0x8a5a3a }); at(bd, -1.3, H1 + 0.2, -2.6); h.add(bd);
    bx(h, KS.c(0x8a5a3a), 1.0, 1.9, 0.5, 1.6, H1 + 0.2, -3.9);
    h.add(at(pendant(KS, { y: H1, drop: 0.6 }), -0.8, 0, 1.2));
    const pole = cy(h, KS.c(0xc8b070), 0.04, 0.04, 3.2, 0, H1 + 1.9, D / 2 + 1.3, 6); pole.rotation.x = PI / 2;
    for (let k = 0; k < 3; k++) {
      const cl = bx(h, KS.c([0xf2a6c0, 0x9fd0f0, 0xfdfdfd][(i + k) % 3], { side: THREE.DoubleSide }), 0.5, 0.6, 0.02, 0, H1 + 1.3, D / 2 + 0.4 + k * 0.9, PI / 2);
      cl.userData.inkWidth = 0.0012;
    }
    // 住户
    const ppl = [];
    if (i % 2 === 0) ppl.push({ pos: [-0.8 - 0.7, 0, 1.2], yaw: PI / 2, pose: 'sit', surface: 0.57, look: { outfit: 'casual' } });
    if (i % 3 === 1) ppl.push({ pos: [-1.3, 0, -2.6 + 0.9], yaw: 0, pose: 'sleep', surface: H1 + 0.72, look: { outfit: 'pajama' } });
    if (i % 3 === 2) ppl.push({ pos: [0.2, H1 + 0.2, -1.0], yaw: 0.5, pose: 'stand', look: { outfit: 'dress' } });
    for (const p of ppl) place(makeChar(randomLook(rng, p.look)), h, p);
  }
  g.rotation.y = faceZ > 0 ? 0 : PI;
  return g;
}

function shikumenLane(KS, rng) {
  const g = grp();
  const a = shikumenRow(KS, rng, 6, 1); at(a, 0, 0, -9.5); g.add(a);
  const b = shikumenRow(KS, rng, 6, -1); at(b, 0, 0, 9.5, PI); g.add(b);
  // 弄堂地面 + 拱门 + 生活气息
  bx(g, KS.c(0xc8c0b0, { map: KS.tex('lanestone', 64, 64, (c) => {
    c.fillStyle = '#cdc5b4'; c.fillRect(0, 0, 64, 64); c.strokeStyle = 'rgba(120,110,100,.4)';
    for (let i = 0; i < 64; i += 16) { c.strokeRect(i, 0, 16, 32); c.strokeRect(i + 8, 32, 16, 32); }
  }, [8, 2]) }), 34, 0.08, 10, 0, 0, 0).receiveShadow = true;
  const arch = grp(); at(arch, 17.5, 0, 0); g.add(arch);
  for (const s of [-1, 1]) bx(arch, KS.c(0xe8e0d0), 1.0, 5.5, 1.0, 0, 0, s * 2.2);
  bx(arch, KS.c(0xe8e0d0), 1.2, 1.6, 5.6, 0, 5.5, 0);
  plane(arch, KS.f(0xffffff, { map: KS.tex('lanename', 128, 48, (c) => {
    c.fillStyle = '#e8e0d0'; c.fillRect(0, 0, 128, 48); c.fillStyle = '#8a3a3a'; c.textAlign = 'center';
    c.font = `900 30px ${FONT}`; c.fillText('樱 花 里', 64, 34);
  }) }), 3.2, 1.1, 0.62, 6.3, 0, PI / 2);
  for (let i = 0; i < 3; i++) g.add(at(bicycle(KS, [0x7ec4d8, 0xf2a6c0, 0xf2c744][i]), -10 + i * 9, 0.08, 3.6, 0.2));
  for (let i = 0; i < 5; i++) g.add(at(plant(KS, { h: 0.8 + (i % 2) * 0.4, pot: 0x8a6a5a }), -14 + i * 6.5, 0.08, -4.0));
  g.add(at(laundry(KS, 3.0, rng), 6, 0.08, 0));
  const ppl = [
    { pos: [-4, 0.08, 0.5], yaw: 0.8, pose: 'wave', look: { kid: true, outfit: 'hoodie' } },
    { pos: [-2.5, 0.08, -0.6], yaw: -2.2, pose: 'stand', look: { kid: true, outfit: 'dress', style: 'twin' } },
    { pos: [3, 0, -3.4], yaw: 0, pose: 'sit', surface: 0.5, look: { outfit: 'casual', hair: 0xe8e8e8, style: 'short' } },
  ];
  const stl = stool(KS, 0xc8a070); at(stl, 3, 0.08, -3.4); stl.scale.setScalar(0.75); g.add(stl);
  for (const p of ppl) place(makeChar(randomLook(rng, p.look)), g, p);
  return g;
}

/* --------------------------- 杨浦大桥 --------------------------- */
function bridge(K, len) {
  const g = grp();
  const red = K.c(0xf2f2f6), cab = K.c(0xf29bb6);
  bx(g, K.c(0xd8dce6), len, 1.6, 14, 0, 18, 0);
  bx(g, K.c(0x9aa2b6), len, 0.05, 11, 0, 19.62, 0).userData.noInk = true;
  for (const s of [-1, 1]) {
    const x = s * len * 0.28;
    for (const z of [-6, 6]) {
      const leg = cy(g, red, 1.0, 1.5, 70, x, 0, z, 10);
      leg.rotation.x = Math.sign(z) * 0.08;
    }
    bx(g, red, 2.5, 2, 13, x, 64, 0);
    bx(g, red, 2.5, 2, 13, x, 20, 0);
    for (let k = 1; k <= 8; k++) for (const dir of [-1, 1]) for (const z of [-6, 6]) {
      const a = new THREE.Vector3(x, 62 - k * 2.6, z * 0.9), b = new THREE.Vector3(x + dir * k * len * 0.03, 19.6, z);
      const c = cy(g, cab, 0.12, 0.12, a.distanceTo(b), 0, 0, 0, 4);
      c.position.copy(a).add(b).multiplyScalar(0.5);
      c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      c.userData.noInk = true;
    }
  }
  return g;
}

/* --------------------------- 渡轮 --------------------------- */
function ferry(K, color) {
  const g = grp();
  const hullG = new THREE.CylinderGeometry(2.6, 2.0, 16, 16, 1, false, PI, PI);
  const h = new THREE.Mesh(hullG, K.c(0xfdfdfd)); h.rotation.set(0, 0, PI / 2); h.rotation.order = 'ZYX'; h.scale.set(1, 1, 1); g.add(h);
  bx(g, K.c(color), 16, 0.4, 5.0, 0, -0.1, 0);
  bx(g, K.c(0xfdfdfd), 9, 2.4, 4.2, -1, 0.3, 0);
  bx(g, K.c(0x9fd0f0), 9.1, 0.8, 4.3, -1, 1.3, 0);
  bx(g, K.c(color), 9.4, 0.3, 4.6, -1, 2.7, 0);
  cy(g, K.c(0xe07a5a), 0.5, 0.6, 2.4, -3, 3.0, 0, 12);
  return g;
}

/* ============================== 总装 ============================== */
export function buildShanghai({ housePlane, pearlPlane }) {
  const root = new THREE.Group();
  root.position.copy(ORIGIN);
  const K = new Kit();
  const KS = new Kit({ planes: [housePlane] });     // 可剖切：石库门、咖啡馆
  const KP = new Kit({ planes: [pearlPlane] });     // 明珠下球体
  const rng = seeded(2025);
  const { puxi, pudong } = banks();

  // ---- 陆地 ----
  const toShape = (pts) => { const s = new THREE.Shape(); pts.forEach(([x, z], i) => i ? s.lineTo(x, -z) : s.moveTo(x, -z)); return s; };
  const landMat = [K.c(0xe8e4dc, { low: 0.88 }), K.c(0xd2ccc0, { steps: 3 })];
  const pxPts = [...puxi, [puxi[puxi.length - 1][0], -760], [-760, -760], [-760, 520], [puxi[0][0], 520]];
  const pdPts = [...pudong, [340, pudong[pudong.length - 1][1]], [340, 520], [pudong[0][0], 520]];
  for (const pts of [pxPts, pdPts]) {
    const geo = new THREE.ExtrudeGeometry(toShape(pts), { depth: 4.2, bevelEnabled: false, curveSegments: 4 });
    geo.rotateX(-PI / 2);
    const m = new THREE.Mesh(geo, landMat);
    m.position.y = TOP - 4.2; m.receiveShadow = true; m.userData.noInk = true;
    root.add(m);
  }
  const city = new THREE.Group(); root.add(city);
  const onLand = (x, z) => { // 简易判断是否在陆地上（远离江中线）
    let best = 1e9;
    for (let i = 0; i < 60; i++) { const p = riverAt(i / 59); best = Math.min(best, Math.hypot(p.x - x, p.z - z)); }
    return best > RW / 2 + 10 && x < 330;
  };

  // ---- 外滩（浦西沿江）----
  const prom = K.c(0xf2ece0, { low: 0.88 });
  const bundZ = [-140, 170];
  const bundX = (z) => {
    let bestP = puxi[0], bd = 1e9;
    for (const p of puxi) { const d = Math.abs(p[1] - z); if (d < bd) { bd = d; bestP = p; } }
    // 在两点间插值
    for (let i = 0; i < puxi.length - 1; i++) {
      const [x0, z0] = puxi[i], [x1, z1] = puxi[i + 1];
      if ((z - z0) * (z - z1) <= 0 && z0 !== z1) return x0 + (x1 - x0) * (z - z0) / (z1 - z0);
    }
    return bestP[0];
  };
  for (let z = bundZ[0]; z < bundZ[1]; z += 6) {
    const x = bundX(z);
    bx(city, prom, 10, 0.3, 6.2, x - 5, TOP, z);
    if (Math.round(z / 6) % 3 === 0) {                     // 路灯
      cy(city, K.c(0x5a6a7a), 0.12, 0.15, 5, x - 1.2, TOP + 0.3, z, 8);
      sp(city, K.f(0xfff6d8), 0.4, x - 1.2, TOP + 5.6, z);
    }
    bx(city, K.c(0xd8d0c0), 0.4, 1.1, 6.2, x - 0.3, TOP + 0.3, z);   // 江边矮墙
    if (Math.round(z / 6) % 2 === 0) sp(city, K.c(0x8fc46a, { low: 0.7, shadow: 0x5f86bb }), 2.4, x - 9, TOP + 5, z, 1, 0.85, 1);
    if (Math.round(z / 6) % 2 === 0) cy(city, K.c(0x8a6a5a), 0.25, 0.3, 4, x - 9, TOP, z, 6);
  }
  bx(city, K.c(0x9aa2b6, { low: 0.88 }), 12, 0.1, bundZ[1] - bundZ[0], bundX(0) - 20, TOP, (bundZ[0] + bundZ[1]) / 2).userData.noInk = true;
  let z = bundZ[0] + 10, bi = 0;
  const cafeAt = 3;
  while (z < bundZ[1] - 10) {
    const { g, w } = bundBuilding(K, bi, rng);
    const x = bundX(z) - 38;
    at(g, x, TOP + (bi === cafeAt ? 4.5 : 0), z + w / 2);
    city.add(g);
    if (bi === cafeAt) {                                   // 这栋的一楼是咖啡馆
      const cafe = bundCafe(KS, rng);
      clipChars(cafe, KS.planes);
      at(cafe, x + 3.6, TOP + 0.05, z + w / 2, PI / 2);
      city.add(cafe);
    }
    z += w + 2.5; bi++;
  }

  // ---- 浦西后排街区 + 石库门 ----
  const kinds = ['office', 'res', 'res2', 'stone'];
  for (let gx = -90; gx > -720; gx -= 34) for (let gz = -700; gz < 500; gz += 34) {
    const X = bundX(THREE.MathUtils.clamp(gz, -160, 460)) - 70 + gx + 90;
    if (!onLand(X, gz)) continue;
    if (Math.abs(X + 230) < 45 && Math.abs(gz - 40) < 30) continue;           // 给石库门让位
    const kind = kinds[Math.floor(rng() * kinds.length)];
    const h = 8 + rng() * (X < -400 ? 40 : 22);
    tower(city, K.c(0xffffff, { map: facade(K, kind) }), 20 + rng() * 8, h, 20 + rng() * 8, X, TOP, gz);
  }
  const lane = shikumenLane(KS, rng);
  clipChars(lane, KS.planes);
  at(lane, -230, TOP + 0.05, 40);
  root.userData.lane = lane;
  city.add(lane);

  // ---- 浦东 ----
  const pPearl = (() => { const p = pudong[3]; return [p[0] + 30, p[1] - 40]; })();
  const pearl = pearlTower(K, KP); at(pearl, pPearl[0], TOP, pPearl[1]); city.add(pearl);
  clipChars(pearl, KP.planes);
  root.userData.pearl = { pos: new THREE.Vector3(pPearl[0], TOP + 44, pPearl[1]).add(ORIGIN), group: pearl };
  const C = [pPearl[0] + 105, pPearl[1] + 70];
  const sht = shanghaiTower(K); at(sht, C[0], TOP, C[1]); city.add(sht);
  const jm = jinMao(K); at(jm, C[0] - 18, TOP, C[1] - 62); city.add(jm);
  const sw = swfc(K); at(sw, C[0] + 38, TOP, C[1] - 40); sw.rotation.y = 0.3; city.add(sw);
  const off = officeTower(K, rng); at(off, pPearl[0] + 60, TOP, pPearl[1] + 150); city.add(off);
  root.userData.landmarks = {
    pearl: new THREE.Vector3(pPearl[0], 0, pPearl[1]),
    tower: new THREE.Vector3(C[0], 0, C[1]),
    jinmao: new THREE.Vector3(C[0] - 18, 0, C[1] - 62),
    swfc: new THREE.Vector3(C[0] + 38, 0, C[1] - 40),
  };
  // 陆家嘴其他塔楼
  const avoid = [[pPearl[0], pPearl[1], 70], [C[0], C[1], 34], [C[0] - 18, C[1] - 62, 26], [C[0] + 38, C[1] - 40, 30], [pPearl[0] + 60, pPearl[1] + 150, 24]];
  for (let i = 0; i < 70; i++) {
    const x = pPearl[0] + 10 + rng() * 300, zz = pPearl[1] - 30 + rng() * 520;
    if (!onLand(x, zz)) continue;
    if (avoid.some(([ax, az, r]) => Math.hypot(ax - x, az - zz) < r + 14)) continue;
    avoid.push([x, zz, 14]);
    const near = Math.hypot(x - C[0], zz - C[1]);
    const h = near < 110 ? 60 + rng() * 110 : 20 + rng() * 45;
    const kind = ['glass', 'glass2', 'glass3', 'office'][Math.floor(rng() * 4)];
    const m = K.c(0xffffff, { map: facade(K, kind), steps: 3, low: 0.78 });
    if (rng() < 0.3) towerCyl(city, m, 9, 10, h, x, TOP, zz, 24);
    else {
      tower(city, m, 16 + rng() * 10, h, 16 + rng() * 10, x, TOP, zz);
      if (rng() < 0.5) tower(city, m, 10, 10, 10, x, TOP + h, zz);
    }
  }
  // 滨江绿地
  const green = K.c(0xb8e0a0, { low: 0.82, shadow: 0x7fa0c0 });
  for (let i = 0; i < 6; i++) {
    const p = pudong[i];
    bx(city, green, 24, 0.2, 40, p[0] + 16, TOP, p[1]).userData.noInk = true;
    for (let k = 0; k < 4; k++) {
      const tx = p[0] + 8 + k * 5, tz = p[1] - 14 + (k % 2) * 20;
      cy(city, K.c(0x8a6a5a), 0.3, 0.4, 3, tx, TOP, tz, 6);
      sp(city, K.c(k % 2 ? 0xffc8dc : 0x8fc46a, { low: 0.72, shadow: 0x8a86bb }), 2.6, tx, TOP + 4.8, tz, 1, 0.85, 1);
    }
  }
  // 北岸 + 大桥
  for (let gx = 0; gx < 330; gx += 30) for (let gz = -300; gz > -700; gz -= 32) {
    if (!onLand(gx, gz)) continue;
    tower(city, K.c(0xffffff, { map: facade(K, rng() < 0.5 ? 'res' : 'office') }), 20, 10 + rng() * 30, 20, gx, TOP, gz);
  }
  const br = bridge(K, 150); at(br, 250, 0, -226, PI / 2); city.add(br);

  // 合并：静态部分按材质并成少量网格
  bake(city, { keep: o => o === pearl });
  bake(pearl);

  // 渡轮（会动，不合并）
  const ferries = [];
  for (let i = 0; i < 4; i++) {
    const f = ferry(K, [0xf29bb6, 0x7ec4d8, 0xf2c744, 0x8fd09a][i]);
    f.userData.u = i / 4; f.userData.dir = i % 2 ? 1 : -1;
    root.add(f); ferries.push(f);
  }
  root.userData.ferries = ferries;
  root.userData.update = (t, dt) => {
    for (const f of ferries) {
      f.userData.u = (f.userData.u + dt * 0.006 * f.userData.dir + 1) % 1;
      const p = riverAt(f.userData.u), q = riverAt(f.userData.u + 0.002 * f.userData.dir);
      f.position.set(p.x + f.userData.dir * 10, -0.35 + Math.sin(t * 1.3 + f.userData.u * 30) * 0.12, p.z);
      f.rotation.y = Math.atan2(-(q.z - p.z), q.x - p.x);
      f.rotation.z = Math.sin(t * 0.9 + f.userData.u * 20) * 0.025;
    }
  };
  return root;
}
