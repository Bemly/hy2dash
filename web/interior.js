/**
 * interior.js — 内饰工具箱
 *
 *   Kit   ：材质工厂（同色复用 → 方便 bake 合并；可挂剖切平面）
 *   wall  ：真正开洞的墙（窗洞/门洞由实体块围出来，不是贴图）
 *   家具库：沙发、被炉、书架、床、厨房、餐桌、电视、绿植、吊灯……
 * 所有家具原点在地面中心、正面朝 +Z。
 */
import * as THREE from 'three';
import { cel, flat, hull } from './toon.js';

const FONT = '"Hiragino Sans","PingFang SC",sans-serif';

export class Kit {
  constructor({ planes = null } = {}) {
    this.planes = planes;
    this.mats = new Map();
    this.texs = new Map();
  }
  _clip(m) { if (this.planes) { m.clippingPlanes = this.planes; m.clipShadows = true; } return m; }
  _key(p, color, o) { return p + color + JSON.stringify(o, (_, v) => (v && v.isTexture ? v.uuid : v)); }
  /** 卡通材质（默认两阶，亮） */
  c(color, o = {}) {
    const k = this._key('c', color, o);
    if (!this.mats.has(k)) this.mats.set(k, this._clip(cel(color, { steps: 2, low: 0.8, shadow: 0x9aa8cc, ...o })));
    return this.mats.get(k);
  }
  /** 平涂自发光 */
  f(color, o = {}) {
    const k = this._key('f', color, o);
    if (!this.mats.has(k)) this.mats.set(k, this._clip(flat(color, o)));
    return this.mats.get(k);
  }
  glass(color = 0xd4f0fa, opacity = 0.35) {
    return this.c(color, { transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, low: 0.92 });
  }
  /** 外壳：双面，剖开后内壁显示 inner 色 */
  hull(color, inner, o = {}) {
    const k = this._key('h', color + '|' + inner, o);
    if (!this.mats.has(k)) this.mats.set(k, this._clip(hull(color, inner, { steps: 3, shadow: 0x9aa8d0, ...o })));
    return this.mats.get(k);
  }
  /** 画布贴图（缓存） */
  tex(key, w, h, draw, repeat) {
    if (!this.texs.has(key)) {
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      draw(cv.getContext('2d'), w, h);
      const t = new THREE.CanvasTexture(cv);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      if (repeat) t.repeat.set(...repeat);
      this.texs.set(key, t);
    }
    return this.texs.get(key);
  }
}

/* ------------------------------ 几何缓存 ------------------------------ */
const GC = new Map();
const g = (k, make) => { if (!GC.has(k)) GC.set(k, make()); return GC.get(k); };
export const boxG = (w, h, d) => g(`b${w}|${h}|${d}`, () => new THREE.BoxGeometry(w, h, d));
export const cylG = (a, b, h, s = 16, open = false) => g(`c${a}|${b}|${h}|${s}|${open}`, () => new THREE.CylinderGeometry(a, b, h, s, 1, open));
/** 球的细分随半径增加：大球不出棱角（不降面数） */
export const sphG = (r, w = Math.max(14, Math.min(64, Math.round(r * 14))), h = Math.max(10, Math.round(w * 0.66))) =>
  g(`s${r}|${w}|${h}`, () => new THREE.SphereGeometry(r, w, h));

/** 方块：y 是底面高度 */
export function bx(p, m, w, h, d, x = 0, y = 0, z = 0, ry = 0) {
  const o = new THREE.Mesh(boxG(w, h, d), m);
  o.position.set(x, y + h / 2, z);
  o.rotation.y = ry;
  o.castShadow = o.receiveShadow = true;
  p.add(o);
  return o;
}
/** 圆柱：y 是底面高度 */
export function cy(p, m, rt, rb, h, x = 0, y = 0, z = 0, seg = 16) {
  const o = new THREE.Mesh(cylG(rt, rb, h, seg), m);
  o.position.set(x, y + h / 2, z);
  o.castShadow = o.receiveShadow = true;
  p.add(o);
  return o;
}
export function sp(p, m, r, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) {
  const o = new THREE.Mesh(sphG(r), m);
  o.position.set(x, y, z);
  o.scale.set(sx, sy, sz);
  o.castShadow = true;
  p.add(o);
  return o;
}
export function plane(p, m, w, h, x, y, z, ry = 0, rx = 0) {
  const o = new THREE.Mesh(g(`p${w}|${h}`, () => new THREE.PlaneGeometry(w, h)), m);
  o.position.set(x, y, z);
  o.rotation.set(rx, ry, 0, 'YXZ');
  o.userData.noInk = true;
  p.add(o);
  return o;
}
export const G = () => new THREE.Group();
export function at(o, x, y, z, ry = 0) { o.position.set(x, y, z); o.rotation.y = ry; return o; }

/* ------------------------------ 常用贴图 ------------------------------ */
export function woodFloor(K, tone = '#e6c79c') {
  return K.tex('wood' + tone, 256, 256, (c) => {
    c.fillStyle = tone; c.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 8; i++) {
      const off = (i * 97) % 256;
      c.fillStyle = `rgba(150,100,60,${0.06 + (i % 3) * 0.03})`;
      c.fillRect(0, i * 32, 256, 31);
      c.fillStyle = 'rgba(120,80,50,.35)';
      c.fillRect(0, i * 32 + 31, 256, 1.5);
      c.fillRect(off, i * 32, 1.5, 32);
    }
  }, [2, 2]);
}
export function tatami(K) {
  return K.tex('tatami', 256, 256, (c) => {
    c.fillStyle = '#d8dca0'; c.fillRect(0, 0, 256, 256);
    c.strokeStyle = 'rgba(150,150,90,.35)'; c.lineWidth = 1;
    for (let y = 0; y < 256; y += 4) { c.beginPath(); c.moveTo(0, y); c.lineTo(256, y); c.stroke(); }
    c.fillStyle = '#5a6a4a';
    c.fillRect(0, 0, 256, 10); c.fillRect(0, 128, 256, 10);
    c.fillRect(0, 0, 10, 256); c.fillRect(128, 128, 10, 128);
  }, [1, 1]);
}
export function siding(K, base = '#f6efe2') {
  return K.tex('siding' + base, 128, 128, (c) => {
    c.fillStyle = base; c.fillRect(0, 0, 128, 128);
    c.fillStyle = 'rgba(80,90,120,.12)';
    for (let y = 0; y < 128; y += 16) c.fillRect(0, y + 14, 128, 2);
  }, [2, 4]);
}
export function shoji(K) {
  return K.tex('shoji', 128, 128, (c) => {
    c.fillStyle = '#fbf7ec'; c.fillRect(0, 0, 128, 128);
    c.fillStyle = '#b08a60';
    for (let i = 0; i <= 4; i++) { c.fillRect(i * 32 - 2, 0, 4, 128); c.fillRect(0, i * 32 - 2, 128, 4); }
  }, [1, 1]);
}
export function poster(K, key, bg, fg, text, sub = '') {
  return K.tex('poster' + key, 128, 180, (c) => {
    c.fillStyle = bg; c.fillRect(0, 0, 128, 180);
    c.fillStyle = 'rgba(255,255,255,.5)'; c.beginPath(); c.arc(90, 50, 34, 0, 7); c.fill();
    c.fillStyle = fg; c.textAlign = 'center';
    c.font = `900 34px ${FONT}`; c.fillText(text, 64, 112);
    c.font = `700 16px ${FONT}`; c.fillText(sub, 64, 146);
  });
}

/* ================================ 墙 ================================ */
/**
 * 沿 X 的墙，底面 y=0，厚度沿 Z；+Z 面是 out（外墙面），-Z 面是 inn（室内面）
 * openings: [{x, y, w, h, kind:'window'|'door'|'open'|'slide', open:0~1}]
 */
export function wall(K, { len, h, t = 0.16, out, inn, openings = [], frame = 0xfdfaf2, curtain = null, glass = true }) {
  const W = G();
  const xs = [-len / 2, len / 2];
  openings.forEach(o => xs.push(o.x - o.w / 2, o.x + o.w / 2));
  xs.sort((a, b) => a - b);
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i], b = xs[i + 1], w = b - a;
    if (w < 1e-3) continue;
    const mid = (a + b) / 2;
    const op = openings.find(o => mid > o.x - o.w / 2 && mid < o.x + o.w / 2);
    const segs = op ? [[0, op.y], [op.y + op.h, h]] : [[0, h]];
    for (const [y0, y1] of segs) {
      if (y1 - y0 < 1e-3) continue;
      bx(W, out, w, y1 - y0, t / 2, mid, y0, t / 4);
      bx(W, inn, w, y1 - y0, t / 2, mid, y0, -t / 4);
    }
  }
  const fm = K.c(frame);
  for (const o of openings) {
    const ft = 0.06;
    if (o.kind !== 'open') {
      bx(W, fm, o.w + ft * 2, ft, t + 0.04, o.x, o.y + o.h, 0);
      bx(W, fm, ft, o.h, t + 0.04, o.x - o.w / 2 - ft / 2, o.y, 0);
      bx(W, fm, ft, o.h, t + 0.04, o.x + o.w / 2 + ft / 2, o.y, 0);
      if (o.y > 0.01) bx(W, fm, o.w + ft * 2, ft, t + 0.04, o.x, o.y - ft, 0);
    }
    if (o.kind === 'window' || o.kind === 'slide') {
      bx(W, fm, 0.05, o.h, 0.05, o.x, o.y, 0);                              // 中梃
      if (glass) {
        const gl = plane(W, K.glass(), o.w, o.h, o.x, o.y + o.h / 2, 0);
        gl.renderOrder = 2;
      }
      if (o.kind === 'window' && o.y > 0.2) bx(W, K.c(0xe8e2d6), o.w + 0.24, 0.05, 0.2, o.x, o.y - 0.06, t / 2 + 0.06); // 窗台
      if (curtain) {
        for (const s of [-1, 1]) {
          const cu = bx(W, K.c(curtain, { side: THREE.DoubleSide }), o.w * 0.24, o.h + 0.25, 0.04, o.x + s * (o.w / 2 - o.w * 0.1), o.y - 0.05, -t / 2 - 0.08);
          cu.userData.inkWidth = 0.0015;
        }
        bx(W, K.c(0xc8b8a0), o.w + 0.4, 0.04, 0.04, o.x, o.y + o.h + 0.12, -t / 2 - 0.08);
      }
    }
    if (o.kind === 'door') {
      const leaf = G();
      bx(leaf, K.c(o.color ?? 0xa87a52), o.w - 0.04, o.h - 0.02, 0.05, (o.w - 0.04) / 2, 0, 0);
      sp(leaf, K.c(0xd8b860), 0.035, o.w - 0.16, 1.0, 0.05);
      if (o.window) bx(leaf, K.glass(), 0.3, 0.5, 0.06, (o.w - 0.04) / 2, 1.2, 0);
      leaf.position.set(o.x - o.w / 2 + 0.02, o.y, -t / 2 + 0.03);
      leaf.rotation.y = -(o.open ?? 0) * 1.4;
      W.add(leaf);
    }
  }
  return W;
}

/** 四面墙围成的房间外壳（不含地板），返回 group；sides: {n,s,e,w} 各自的开口 */
export function room(K, { w, d, h, out, inn, open = {}, t = 0.16, curtain }) {
  const R = G();
  const mk = (len, ops, x, z, ry) => { const wl = wall(K, { len, h, t, out, inn, openings: ops || [], curtain }); at(wl, x, 0, z, ry); R.add(wl); };
  mk(w + t, open.s, 0, d / 2, 0);                      // +Z 前
  mk(w + t, open.n, 0, -d / 2, Math.PI);               // -Z 后
  mk(d - t, open.e, w / 2, 0, Math.PI / 2);            // +X
  mk(d - t, open.w, -w / 2, 0, -Math.PI / 2);          // -X
  return R;
}

/* ================================ 家具 ================================ */
export function sofa(K, { w = 1.9, color = 0x8fb8e0 } = {}) {
  const o = G(), m = K.c(color), m2 = K.c(new THREE.Color(color).offsetHSL(0, 0, 0.06).getHex());
  bx(o, m, w, 0.3, 0.85, 0, 0.08, 0);
  const n = Math.max(2, Math.round(w / 0.75));
  for (let i = 0; i < n; i++) {
    const cw = (w - 0.36) / n;
    bx(o, m2, cw - 0.03, 0.14, 0.62, -w / 2 + 0.18 + cw * (i + 0.5), 0.38, 0.07);
    bx(o, m2, cw - 0.04, 0.4, 0.18, -w / 2 + 0.18 + cw * (i + 0.5), 0.5, -0.27).rotation.x = -0.12;
  }
  bx(o, m, w, 0.55, 0.18, 0, 0.38, -0.34);
  for (const s of [-1, 1]) bx(o, m, 0.18, 0.32, 0.85, s * (w / 2 - 0.09), 0.38, 0);
  for (const s of [-1, 1]) for (const z of [-0.33, 0.33]) cy(o, K.c(0x6a5040), 0.03, 0.03, 0.08, s * (w / 2 - 0.08), 0, z, 6);
  sp(o, K.c(0xffd98a), 0.14, -w / 2 + 0.38, 0.62, -0.12, 1, 1, 0.45).rotation.z = 0.3;  // 抱枕
  o.userData.seatY = 0.45;
  return o;
}
export function armchair(K, color = 0xf2a6c0) { return sofa(K, { w: 0.95, color }); }

export function coffeeTable(K, { w = 1.0, d = 0.55, color = 0xc49a6c } = {}) {
  const o = G();
  bx(o, K.c(color), w, 0.05, d, 0, 0.36, 0);
  bx(o, K.c(color), w - 0.1, 0.03, d - 0.1, 0, 0.1, 0);
  for (const x of [-1, 1]) for (const z of [-1, 1]) bx(o, K.c(0x8a6a4a), 0.05, 0.36, 0.05, x * (w / 2 - 0.06), 0, z * (d / 2 - 0.06));
  cy(o, K.c(0xfdfaf2), 0.05, 0.04, 0.09, 0.2, 0.41, 0.05, 10);            // 马克杯
  bx(o, K.c(0xe07a8a), 0.22, 0.03, 0.3, -0.2, 0.41, 0);                  // 杂志
  return o;
}

export function table(K, { w = 1.2, d = 0.8, h = 0.72, color = 0xd8b88a } = {}) {
  const o = G();
  bx(o, K.c(color), w, 0.05, d, 0, h - 0.05, 0);
  for (const x of [-1, 1]) for (const z of [-1, 1]) bx(o, K.c(0x9a7a5a), 0.06, h - 0.05, 0.06, x * (w / 2 - 0.08), 0, z * (d / 2 - 0.08));
  o.userData.topY = h;
  return o;
}
export function chair(K, color = 0xd8b88a) {
  const o = G(), m = K.c(color);
  bx(o, m, 0.44, 0.05, 0.42, 0, 0.42, 0);
  bx(o, K.c(0xfdf0f4), 0.38, 0.04, 0.36, 0, 0.47, 0.01);
  for (const x of [-1, 1]) for (const z of [-1, 1]) bx(o, m, 0.04, 0.42, 0.04, x * 0.18, 0, z * 0.17);
  for (const x of [-1, 1]) bx(o, m, 0.04, 0.5, 0.04, x * 0.18, 0.47, -0.19);
  bx(o, m, 0.4, 0.12, 0.03, 0, 0.82, -0.19);
  o.userData.seatY = 0.47;
  return o;
}
export function stool(K, color = 0xe07a8a) {
  const o = G();
  cy(o, K.c(color), 0.18, 0.18, 0.07, 0, 0.55, 0, 14);
  cy(o, K.c(0xb9c2cc), 0.03, 0.04, 0.55, 0, 0, 0, 8);
  cy(o, K.c(0xb9c2cc), 0.2, 0.2, 0.03, 0, 0, 0, 14);
  o.userData.seatY = 0.62;
  return o;
}
/** 餐桌 + 椅子；返回 {group, seats:[{x,z,yaw}]} */
export function diningSet(K, { n = 4, color = 0xd8b88a, chairColor = 0xe0c49a } = {}) {
  const o = G();
  o.add(table(K, { color }));
  const seats = [];
  const pos = [[-0.32, 0.62, Math.PI], [0.32, 0.62, Math.PI], [-0.32, -0.62, 0], [0.32, -0.62, 0]].slice(0, n);
  for (const [x, z, ry] of pos) {
    const c = chair(K, chairColor);
    at(c, x, 0, z, ry); o.add(c);
    seats.push({ x, z, yaw: ry, seatY: 0.47 });
  }
  // 桌上：饭碗、盘子、筷子
  for (const [x, z] of [[-0.32, 0.22], [0.32, 0.22], [-0.32, -0.22], [0.32, -0.22]]) {
    cy(o, K.c(0xfdfaf2), 0.09, 0.09, 0.015, x, 0.72, z, 14);
    cy(o, K.c(0xf2e6d0), 0.06, 0.045, 0.05, x + 0.05, 0.735, z, 12);
    bx(o, K.c(0x8a5a3a), 0.01, 0.01, 0.2, x - 0.11, 0.73, z);
  }
  cy(o, K.c(0xf2a6c0), 0.12, 0.08, 0.08, 0, 0.72, 0, 14);
  sp(o, K.c(0xff9a5a), 0.04, -0.03, 0.82, 0.02); sp(o, K.c(0xff9a5a), 0.04, 0.04, 0.82, -0.02); sp(o, K.c(0xffcf4a), 0.04, 0.0, 0.85, 0.0);
  return { group: o, seats };
}

/** 被炉：日式冬天的灵魂，上面放一碗橘子 */
export function kotatsu(K, { color = 0xe07a8a } = {}) {
  const o = G();
  bx(o, K.c(color), 1.15, 0.36, 1.15, 0, 0.02, 0);
  bx(o, K.c(new THREE.Color(color).offsetHSL(0, -0.1, 0.12).getHex()), 1.0, 0.04, 1.0, 0, 0.38, 0);
  bx(o, K.c(0xc49a6c), 0.9, 0.04, 0.9, 0, 0.42, 0);
  cy(o, K.c(0xfdfaf2), 0.15, 0.11, 0.07, 0, 0.46, 0, 14);
  for (let i = 0; i < 4; i++) sp(o, K.c(0xff9a3a), 0.045, Math.cos(i * 1.6) * 0.06, 0.55 + (i === 3 ? 0.05 : 0), Math.sin(i * 1.6) * 0.06);
  cy(o, K.c(0x7ec4d8), 0.04, 0.035, 0.09, 0.28, 0.46, 0.2, 10);
  return o;
}
export function zabuton(K, color = 0xd96a7a) {
  const o = G();
  bx(o, K.c(color), 0.55, 0.08, 0.55, 0, 0, 0);
  sp(o, K.c(0xf2c744), 0.025, 0, 0.085, 0);
  o.userData.seatY = 0.08;
  return o;
}
export function chabudai(K) {
  const o = G();
  cy(o, K.c(0xb07a4a), 0.62, 0.62, 0.05, 0, 0.3, 0, 24);
  for (let i = 0; i < 4; i++) bx(o, K.c(0x8a5a3a), 0.06, 0.3, 0.06, Math.cos(i * Math.PI / 2 + 0.78) * 0.4, 0, Math.sin(i * Math.PI / 2 + 0.78) * 0.4);
  return o;
}
export function teaSet(K) {
  const o = G();
  sp(o, K.c(0x7ec4d8), 0.09, 0, 0.08, 0, 1, 0.8, 1);
  cy(o, K.c(0x7ec4d8), 0.025, 0.035, 0.08, 0.1, 0.06, 0, 8).rotation.z = -0.8;
  sp(o, K.c(0x6aa8c0), 0.025, 0, 0.16, 0);
  for (let i = 0; i < 3; i++) cy(o, K.c(0xfdfaf2), 0.04, 0.03, 0.06, Math.cos(i * 2.1) * 0.24, 0, Math.sin(i * 2.1) * 0.24, 10);
  bx(o, K.c(0xe8b8c8), 0.18, 0.04, 0.1, 0.05, 0, -0.26);   // 和果子盘
  return o;
}

export function tv(K) {
  const o = G();
  bx(o, K.c(0xf2ece0), 1.4, 0.45, 0.42, 0, 0, 0);
  for (const x of [-0.35, 0.35]) bx(o, K.c(0xe0d4c0), 0.62, 0.32, 0.02, x, 0.06, 0.21);
  bx(o, K.c(0x3a4058), 1.15, 0.68, 0.06, 0, 0.62, 0);
  bx(o, K.c(0x3a4058), 0.25, 0.17, 0.12, 0, 0.45, 0);
  const scr = plane(o, K.f(0xffffff, { map: K.tex('tvimg', 160, 96, (c) => {
    const gr = c.createLinearGradient(0, 0, 0, 96); gr.addColorStop(0, '#8fd0f6'); gr.addColorStop(1, '#fde6f0');
    c.fillStyle = gr; c.fillRect(0, 0, 160, 96);
    c.fillStyle = '#ffffff'; c.beginPath(); c.arc(40, 30, 14, 0, 7); c.arc(54, 32, 12, 0, 7); c.fill();
    c.fillStyle = '#f2a6c0'; c.beginPath(); c.arc(110, 62, 18, 0, 7); c.fill();
    c.fillStyle = '#2c3e5c'; c.beginPath(); c.arc(104, 58, 3, 0, 7); c.arc(116, 58, 3, 0, 7); c.fill();
    c.fillStyle = '#3a8a4a'; c.fillRect(0, 80, 160, 16);
  }) }), 1.07, 0.6, 0, 0.96, 0.035);
  scr.userData.noInk = true;
  return o;
}

export function bookshelf(K, { w = 0.9, h = 1.8, rng = Math.random } = {}) {
  const o = G(), m = K.c(0xd8b88a);
  bx(o, m, w, h, 0.04, 0, 0, -0.15);
  for (const s of [-1, 1]) bx(o, m, 0.04, h, 0.32, s * (w / 2 - 0.02), 0, 0);
  const n = Math.round(h / 0.36);
  const cols = [0xe07a8a, 0x7ec4d8, 0xf2c744, 0x8fd09a, 0xb8a0e0, 0xfdfaf2, 0x5a6a9a, 0xf2a6c0];
  for (let i = 0; i <= n; i++) {
    const y = i * (h - 0.04) / n;
    bx(o, m, w - 0.08, 0.03, 0.3, 0, y, 0);
    if (i === n) break;
    let x = -w / 2 + 0.07;
    while (x < w / 2 - 0.12) {
      const bw = 0.03 + rng() * 0.04, bh = 0.2 + rng() * 0.1;
      if (rng() < 0.12) { x += 0.08; continue; }
      const b = bx(o, K.c(cols[Math.floor(rng() * cols.length)]), bw, bh, 0.22, x + bw / 2, y + 0.03, 0.02);
      b.userData.inkWidth = 0.001;
      if (rng() < 0.1) b.rotation.z = 0.2;
      x += bw + 0.005;
    }
  }
  return o;
}

/** 床：返回 group，userData.top=床面高度，userData.len=床长（枕头在 -Z 端） */
export function bed(K, { w = 1.0, l = 2.0, color = 0xb8d8f0, frame = 0xd8b88a } = {}) {
  const o = G();
  bx(o, K.c(frame), w + 0.08, 0.25, l + 0.08, 0, 0.05, 0);
  bx(o, K.c(frame), w + 0.08, 0.75, 0.06, 0, 0.05, -l / 2 - 0.02);
  bx(o, K.c(0xfdfaf6), w, 0.2, l, 0, 0.3, 0);
  bx(o, K.c(color), w + 0.04, 0.08, l * 0.62, 0, 0.47, l * 0.18);
  bx(o, K.c(new THREE.Color(color).offsetHSL(0, 0, 0.08).getHex()), w + 0.06, 0.25, 0.04, 0, 0.3, l * 0.18 + l * 0.31);
  sp(o, K.c(0xffffff), 0.22, 0, 0.58, -l / 2 + 0.28, 1.6, 0.45, 0.9);
  for (const x of [-1, 1]) for (const z of [-1, 1]) bx(o, K.c(frame), 0.06, 0.05, 0.06, x * w / 2, 0, z * l / 2);
  sp(o, K.c(0xf2d27a), 0.12, w / 2 - 0.2, 0.62, -l / 2 + 0.35, 1, 1, 1);   // 布偶
  sp(o, K.c(0xf2d27a), 0.07, w / 2 - 0.2, 0.78, -l / 2 + 0.35);
  o.userData.top = 0.5; o.userData.len = l;
  return o;
}
export function futon(K, color = 0xf2c4d0) {
  const o = G();
  bx(o, K.c(0xfdfaf2), 1.0, 0.1, 2.0, 0, 0, 0);
  bx(o, K.c(color), 1.05, 0.08, 1.3, 0, 0.1, 0.3);
  sp(o, K.c(0xffffff), 0.2, 0, 0.18, -0.72, 1.6, 0.4, 0.9);
  o.userData.top = 0.12; o.userData.len = 2.0;
  return o;
}
export function desk(K, { color = 0xfdfaf2 } = {}) {
  const o = G();
  bx(o, K.c(color), 1.1, 0.04, 0.55, 0, 0.7, 0);
  for (const s of [-1, 1]) bx(o, K.c(color), 0.04, 0.7, 0.55, s * 0.53, 0, 0);
  bx(o, K.c(0xd8c8b0), 0.4, 0.5, 0.5, 0.3, 0.18, 0);
  // 笔记本电脑
  bx(o, K.c(0xc8ccd8), 0.34, 0.02, 0.24, -0.1, 0.74, 0.05);
  const lid = bx(o, K.c(0xc8ccd8), 0.34, 0.24, 0.015, -0.1, 0.74, -0.07); lid.rotation.x = -0.25;
  plane(o, K.f(0x9fd8f6), 0.3, 0.2, -0.1, 0.87, -0.055, 0, -0.25);
  // 台灯
  cy(o, K.c(0xf2a6c0), 0.07, 0.08, 0.02, 0.4, 0.74, -0.15, 12);
  cy(o, K.c(0xf2a6c0), 0.012, 0.012, 0.35, 0.4, 0.74, -0.15, 6);
  cy(o, K.c(0xf2a6c0), 0.05, 0.11, 0.12, 0.4, 1.06, -0.1, 12);
  bx(o, K.c(0x8fd09a), 0.12, 0.16, 0.1, 0.15, 0.74, -0.18);     // 笔筒/书
  return o;
}
export function officeChair(K, color = 0x5a6a9a) {
  const o = G();
  cy(o, K.c(color), 0.22, 0.22, 0.08, 0, 0.42, 0, 14);
  bx(o, K.c(color), 0.4, 0.45, 0.06, 0, 0.52, -0.2);
  cy(o, K.c(0x8a94a8), 0.03, 0.03, 0.4, 0, 0.04, 0, 8);
  for (let i = 0; i < 5; i++) bx(o, K.c(0x8a94a8), 0.04, 0.03, 0.26, Math.sin(i * 1.256) * 0.12, 0.02, Math.cos(i * 1.256) * 0.12, i * 1.256);
  o.userData.seatY = 0.5;
  return o;
}
export function wardrobe(K, color = 0xf2ece0) {
  const o = G();
  bx(o, K.c(color), 1.0, 1.9, 0.55, 0, 0, 0);
  bx(o, K.c(0xc8b8a0), 0.02, 1.8, 0.02, 0, 0.05, 0.28);
  for (const s of [-1, 1]) cy(o, K.c(0xc8a050), 0.015, 0.015, 0.2, s * 0.06, 0.9, 0.29, 6);
  return o;
}
/** 一字型厨房：地柜 + 台面 + 水槽 + 灶台 + 吊柜 + 抽油烟机 */
export function kitchen(K, { len = 2.6, color = 0xfdfaf2, accent = 0x9fd0e8 } = {}) {
  const o = G();
  bx(o, K.c(color), len, 0.82, 0.6, 0, 0, 0);
  const n = Math.round(len / 0.6);
  for (let i = 0; i < n; i++) {
    const x = -len / 2 + (i + 0.5) * len / n;
    bx(o, K.c(accent), len / n - 0.04, 0.7, 0.02, x, 0.06, 0.3);
    bx(o, K.c(0xc8b8a0), 0.14, 0.02, 0.03, x, 0.66, 0.32);
  }
  bx(o, K.c(0xe8e4dc), len + 0.04, 0.05, 0.64, 0, 0.82, 0);
  // 水槽
  bx(o, K.c(0xb9c2cc), 0.55, 0.02, 0.4, -len / 4, 0.87, 0);
  bx(o, K.c(0x8a94a8), 0.5, 0.01, 0.35, -len / 4, 0.875, 0);
  cy(o, K.c(0xb9c2cc), 0.02, 0.02, 0.3, -len / 4, 0.87, -0.22, 8);
  bx(o, K.c(0xb9c2cc), 0.03, 0.03, 0.18, -len / 4, 1.15, -0.14);
  // 灶台
  bx(o, K.c(0x3a3e4a), 0.6, 0.02, 0.45, len / 4, 0.87, 0);
  for (const [x, z] of [[-0.14, 0.08], [0.14, -0.08]]) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.012, 6, 16), K.c(0x8a94a8));
    r.rotation.x = Math.PI / 2; r.position.set(len / 4 + x, 0.9, z); r.userData.noInk = true; o.add(r);
  }
  // 锅
  cy(o, K.c(0xe07a5a), 0.13, 0.12, 0.12, len / 4 - 0.14, 0.9, 0.08, 14);
  cy(o, K.c(0x5a4a4a), 0.02, 0.02, 0.2, len / 4 - 0.14 + 0.2, 0.98, 0.08, 6).rotation.z = 1.4;
  // 吊柜 + 油烟机
  bx(o, K.c(color), len, 0.6, 0.35, 0, 1.6, -0.12);
  for (let i = 0; i < n; i++) bx(o, K.c(accent), len / n - 0.04, 0.54, 0.02, -len / 2 + (i + 0.5) * len / n, 1.63, 0.06);
  bx(o, K.c(0xc8ccd8), 0.65, 0.25, 0.45, len / 4, 1.4, -0.05);
  // 台面小物：砧板、调料瓶、水果
  bx(o, K.c(0xe6c79c), 0.35, 0.02, 0.22, 0, 0.87, 0.05);
  for (let i = 0; i < 3; i++) cy(o, K.c([0xe07a8a, 0xf2c744, 0x8fd09a][i]), 0.03, 0.03, 0.12, -len / 2 + 0.15 + i * 0.08, 0.87, -0.18, 8);
  return o;
}
export function fridge(K, color = 0xfdfdfd) {
  const o = G();
  bx(o, K.c(color), 0.68, 1.75, 0.66, 0, 0, 0);
  bx(o, K.c(0xc8ccd8), 0.66, 0.02, 0.02, 0, 1.1, 0.34);
  for (const y of [0.5, 1.4]) bx(o, K.c(0xc8ccd8), 0.03, 0.3, 0.03, 0.27, y, 0.35);
  bx(o, K.c(0xf2a6c0), 0.12, 0.12, 0.01, -0.12, 1.4, 0.335);    // 冰箱贴
  bx(o, K.c(0x9fd0e8), 0.15, 0.1, 0.01, 0.06, 1.25, 0.335);
  return o;
}
export function washer(K) {
  const o = G();
  bx(o, K.c(0xfdfdfd), 0.6, 0.85, 0.6, 0, 0, 0);
  cy(o, K.c(0x9fd8f6), 0.2, 0.2, 0.02, 0, 0.45, 0.3, 18).rotation.x = Math.PI / 2;
  return o;
}
export function plant(K, { h = 1.0, pot = 0xe0905a, leaf = 0x7cc46a } = {}) {
  const o = G();
  cy(o, K.c(pot), 0.16, 0.12, 0.3, 0, 0, 0, 12);
  cy(o, K.c(0x6a4a3a), 0.15, 0.15, 0.02, 0, 0.28, 0, 12);
  cy(o, K.c(0x6a8a4a), 0.02, 0.025, h * 0.6, 0, 0.28, 0, 6);
  const lm = K.c(leaf, { low: 0.7, shadow: 0x5f86bb });
  for (let i = 0; i < 6; i++) {
    const a = i * 1.1;
    const l = new THREE.Mesh(sphG(0.17, 8, 6), lm);
    l.position.set(Math.cos(a) * 0.15, 0.3 + h * (0.45 + (i % 3) * 0.15), Math.sin(a) * 0.15);
    l.scale.set(1.2, 0.6, 1);
    l.castShadow = true;
    o.add(l);
  }
  return o;
}
export function pendant(K, { y = 2.5, drop = 0.6, color = 0xfdf0d0 } = {}) {
  const o = G();
  const cord = cy(o, K.c(0x5a5a6a), 0.008, 0.008, drop, 0, y - drop, 0, 4); cord.userData.noInk = true;
  cy(o, K.c(color), 0.08, 0.26, 0.2, 0, y - drop - 0.2, 0, 16);
  const b = sp(o, K.f(0xfff8d8), 0.07, 0, y - drop - 0.18, 0); b.userData.noInk = true;
  return o;
}
export function floorLamp(K) {
  const o = G();
  cy(o, K.c(0x8a94a8), 0.15, 0.15, 0.03, 0, 0, 0, 12);
  cy(o, K.c(0x8a94a8), 0.015, 0.015, 1.4, 0, 0, 0, 6);
  cy(o, K.c(0xfdf0d0), 0.14, 0.22, 0.28, 0, 1.35, 0, 14);
  return o;
}
export function rug(K, { w = 1.8, d = 1.3, color = 0xf2c4d0 } = {}) {
  const o = G();
  bx(o, K.c(color), w, 0.015, d, 0, 0, 0).userData.noInk = true;
  bx(o, K.c(new THREE.Color(color).offsetHSL(0, 0, 0.08).getHex()), w - 0.2, 0.017, d - 0.2, 0, 0, 0).userData.noInk = true;
  return o;
}
export function frame(K, key, colors) {
  const o = G();
  bx(o, K.c(0xc49a6c), 0.62, 0.48, 0.03, 0, 0, 0);
  plane(o, K.f(0xffffff, { map: K.tex('pic' + key, 64, 48, (c) => {
    c.fillStyle = colors[0]; c.fillRect(0, 0, 64, 48);
    c.fillStyle = colors[1]; c.beginPath(); c.moveTo(0, 48); c.lineTo(22, 20); c.lineTo(40, 36); c.lineTo(64, 14); c.lineTo(64, 48); c.fill();
    c.fillStyle = '#fff6d0'; c.beginPath(); c.arc(48, 12, 6, 0, 7); c.fill();
  }) }), 0.54, 0.4, 0, 0.24, 0.02);
  return o;
}
export function wallClock(K) {
  const o = G();
  cy(o, K.c(0xfdfaf2), 0.18, 0.18, 0.04, 0, 0, 0, 20).rotation.x = Math.PI / 2;
  bx(o, K.c(0x2c3e5c), 0.015, 0.12, 0.01, 0, 0.0, 0.03);
  bx(o, K.c(0x2c3e5c), 0.1, 0.015, 0.01, 0.04, 0.0, 0.03);
  return o;
}
export function shoeRack(K) {
  const o = G();
  bx(o, K.c(0xd8b88a), 0.9, 0.9, 0.35, 0, 0, 0);
  for (let i = 0; i < 3; i++) sp(o, K.c([0xe07a8a, 0x5a6a9a, 0xf6f6f6][i]), 0.07, -0.25 + i * 0.25, 0.95, 0.03, 1, 0.6, 1.6);
  cy(o, K.c(0x7ec4d8), 0.08, 0.08, 0.5, 0.6, 0, 0, 10);        // 伞桶
  cy(o, K.c(0xf26a8a), 0.015, 0.015, 0.75, 0.6, 0.1, 0, 6);
  return o;
}
export function counter(K, { len = 2.4, color = 0xc49a6c, top = 0xe8d8b8 } = {}) {
  const o = G();
  bx(o, K.c(color), len, 1.0, 0.55, 0, 0, 0);
  bx(o, K.c(top), len + 0.1, 0.05, 0.7, 0, 1.0, 0.05);
  return o;
}
export function bicycle(K, color = 0x7ec4d8) {
  const o = G();
  const tm = K.c(0x3a3e4a);
  for (const x of [-0.5, 0.5]) {
    const w = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.025, 6, 20), tm);
    w.position.set(x, 0.32, 0); w.castShadow = true; o.add(w);
    cy(o, K.c(0xb9c2cc), 0.02, 0.02, 0.05, x, 0.3, 0, 6).rotation.x = Math.PI / 2;
  }
  const fm = K.c(color);
  const bar = (x1, y1, x2, y2) => {
    const l = Math.hypot(x2 - x1, y2 - y1);
    const m = cy(o, fm, 0.02, 0.02, l, (x1 + x2) / 2, (y1 + y2) / 2 - l / 2, 0, 6);
    m.rotation.z = Math.atan2(x1 - x2, y2 - y1);
    m.position.y = (y1 + y2) / 2;
  };
  bar(-0.5, 0.32, 0.0, 0.32); bar(0.0, 0.32, -0.15, 0.72); bar(-0.5, 0.32, -0.15, 0.72); bar(-0.15, 0.72, 0.42, 0.75); bar(0.5, 0.32, 0.42, 0.85);
  bx(o, K.c(0x3a3e4a), 0.22, 0.05, 0.1, -0.18, 0.78, 0);
  bx(o, K.c(0x3a3e4a), 0.04, 0.04, 0.5, 0.42, 0.88, 0);
  bx(o, K.c(0xb9c2cc), 0.25, 0.15, 0.22, 0.55, 0.72, 0);       // 车篮
  return o;
}
export function acUnit(K) {
  const o = G();
  bx(o, K.c(0xf2f2ee), 0.8, 0.6, 0.3, 0, 0, 0);
  cy(o, K.c(0x8a94a8), 0.22, 0.22, 0.02, -0.12, 0.3, 0.15, 16).rotation.x = Math.PI / 2;
  return o;
}
export function laundry(K, len = 2.4, rng = Math.random) {
  const o = G();
  for (const s of [-1, 1]) cy(o, K.c(0xb9c2cc), 0.025, 0.025, 1.8, s * len / 2, 0, 0, 6);
  cy(o, K.c(0xb9c2cc), 0.02, 0.02, len, 0, 1.75, 0, 6).rotation.z = Math.PI / 2;
  const cols = [0xf2a6c0, 0x9fd0f0, 0xfdfdfd, 0xffd98a, 0xb8e6a0];
  for (let x = -len / 2 + 0.3; x < len / 2 - 0.2; x += 0.45) {
    const c = K.c(cols[Math.floor(rng() * cols.length)], { side: THREE.DoubleSide });
    const sh = bx(o, c, 0.36, 0.5, 0.02, x, 1.22, 0);
    sh.userData.inkWidth = 0.0015;
    bx(o, c, 0.1, 0.12, 0.02, x - 0.2, 1.58, 0).userData.inkWidth = 0.001;
    bx(o, c, 0.1, 0.12, 0.02, x + 0.2, 1.58, 0).userData.inkWidth = 0.001;
  }
  return o;
}
export function stairs(K, { w = 0.9, rise = 2.8, run = 3.0, n = 13, color = 0xd8b88a } = {}) {
  const o = G();
  for (let i = 0; i < n; i++) {
    bx(o, K.c(color), w, rise / n, run / n + 0.02, 0, i * rise / n, -i * run / n);
    bx(o, K.c(0xc49a6c), w, 0.02, run / n + 0.04, 0, (i + 1) * rise / n - 0.01, -i * run / n + 0.01);
  }
  bx(o, K.c(0xc49a6c), 0.05, 0.05, Math.hypot(rise, run), w / 2 - 0.05, rise / 2 + 0.6, -run / 2).rotation.x = Math.atan2(rise, run);
  return o;
}
export function toyBox(K) {
  const o = G();
  bx(o, K.c(0xf2c744), 0.6, 0.4, 0.4, 0, 0, 0);
  sp(o, K.c(0xe07a8a), 0.12, -0.1, 0.48, 0);
  sp(o, K.c(0x7ec4d8), 0.1, 0.15, 0.46, 0.05);
  bx(o, K.c(0x8fd09a), 0.14, 0.14, 0.14, 0.4, 0, 0.2).rotation.y = 0.5;
  return o;
}
/** 小猫：趴着睡觉 */
export function cat(K, color = 0xf2c48a) {
  const o = G();
  sp(o, K.c(color), 0.17, 0, 0.12, 0, 1.3, 0.75, 0.9);
  sp(o, K.c(color), 0.11, 0.2, 0.16, 0);
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.08, 4), K.c(color));
    e.position.set(0.22, 0.27, s * 0.06); o.add(e);
  }
  const t = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.03, 6, 12, Math.PI), K.c(color));
  t.rotation.x = Math.PI / 2; t.position.set(-0.2, 0.06, 0); o.add(t);
  return o;
}
