/**
 * airport.js — 海滨异世界机场
 *
 * 造型参考日系海边小站（江ノ電那种）：
 *   站台雨棚 / 黄色盲道 / 站名牌 / 候车木长椅 / 售票窗口 /
 *   自动贩卖机 / 圆时钟 / 反光镜 / 电线杆 / 立式灯箱
 * 细节靠「小构件密度」堆出来，而不是贴图。
 */
import * as THREE from 'three';
import { cel, flat } from './toon.js';

const rnd = (a, b) => a + Math.random() * (b - a);

/** 日文招牌文字贴图：站名牌/灯箱的字全靠它 */
export function textPlate(lines, { w = 1024, h = 160, bg = '#27508c', fg = '#ffffff', sub = null } = {}) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${sub ? 84 : 96}px "Hiragino Sans","PingFang SC",sans-serif`;
  ctx.fillText(lines, w / 2, sub ? h / 2 - 18 : h / 2);
  if (sub) {
    ctx.font = `600 40px "Hiragino Sans","PingFang SC",sans-serif`;
    ctx.fillText(sub, w / 2, h / 2 + 52);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export const MAT = {
  wall:    () => cel(0xfbf3e4, { steps: 3, shadow: 0x9db0d4 }),
  wall2:   () => cel(0xeae0cc, { steps: 3, shadow: 0x95a8cc }),
  roof:    () => cel(0x9cc4dc, { steps: 3, shadow: 0x8fa8cc }),
  roofRed: () => cel(0xe09a88, { steps: 3, shadow: 0xa88cc0 }),
  metal:   () => cel(0xb9c2cc, { steps: 3, shadow: 0x8294bc }),
  dark:    () => cel(0x5d6b84, { steps: 2, shadow: 0x4a5878, low: 0.7 }),
  glass:   () => cel(0xc4e9f4, { steps: 2, shadow: 0x8fb8dd, low: 0.82, transparent: true, opacity: 0.5 }),
  wood:    () => cel(0xc49a6c, { steps: 3, shadow: 0x8d84b4 }),
  tile:    () => cel(0xe4e7ea, { steps: 2, shadow: 0x9fb2d2, low: 0.82 }),
  accent:  () => cel(0xf2a6c0, { steps: 2, shadow: 0xa98ac0, low: 0.74 }),
  concrete:() => cel(0xd9d4cc, { steps: 2, shadow: 0x9aa8c8, low: 0.82 }),
};

/** 带竖条的栏杆（密集竖条是动画背景的标志性密度来源） */
export function railing(len, { h = 1.1, step = 0.42, mat, postMat } = {}) {
  const g = new THREE.Group();
  const m = mat || MAT.metal();
  const pm = postMat || m;
  [h, h * 0.52].forEach((y, i) => {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(len, i ? 0.05 : 0.09, 0.09), m);
    bar.position.y = y;
    bar.castShadow = true;
    g.add(bar);
  });
  const n = Math.max(2, Math.floor(len / step));
  for (let i = 0; i <= n; i++) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.055, h, 0.055), pm);
    p.position.set(-len / 2 + (i / n) * len, h / 2, 0);
    p.userData.inkWidth = 0.0012;
    g.add(p);
  }
  return g;
}

/** 日式电线杆 */
export function utilityPole(h = 11) {
  const g = new THREE.Group();
  const cm = cel(0xcfcabc, { steps: 3, shadow: 0x8fa0c4 });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.23, h, 8), cm);
  pole.position.y = h / 2;
  pole.castShadow = true;
  g.add(pole);
  const armMat = MAT.dark();
  for (let i = 0; i < 2; i++) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(2.6 - i * 0.6, 0.11, 0.13), armMat);
    arm.position.y = h - 0.7 - i * 0.95;
    g.add(arm);
    for (const s of [-1, 1]) {
      const ins = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.26, 6), cel(0x8fa8bf, { steps: 2, shadow: 0x7088b8 }));
      ins.position.set(s * (1.2 - i * 0.3), h - 0.52 - i * 0.95, 0);
      ins.userData.inkWidth = 0.001;
      g.add(ins);
    }
  }
  const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.8, 8), cel(0xa8b0b8, { steps: 3, shadow: 0x8294bc }));
  tr.position.set(0.42, h - 2.6, 0);
  g.add(tr);
  return g;
}

/** 下垂电线（悬链线近似） */
export function wire(a, b, sag = 1.6, color = 0x3c4660) {
  const pts = [];
  const N = 22;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    pts.push(new THREE.Vector3(
      a.x + (b.x - a.x) * t,
      a.y + (b.y - a.y) * t - Math.sin(Math.PI * t) * sag,
      a.z + (b.z - a.z) * t
    ));
  }
  const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), N, 0.035, 4, false);
  const m = new THREE.Mesh(geo, flat(color));
  m.userData.noInk = true;
  return m;
}

/** 立式灯箱招牌（参考图里的蓝黄竖牌） */
export function signPost(text = '', { h = 3.6, w = 0.75, body = 0x3f6fb5, head = 0xf2c744 } = {}) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, h, 6), MAT.metal());
  pole.position.y = h / 2; g.add(pole);
  const panel = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.62, 0.1), cel(body, { steps: 2, shadow: 0x5f7ab5, low: 0.82 }));
  panel.position.y = h * 0.6; panel.castShadow = true; g.add(panel);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(w * 1.02, h * 0.17, 0.11), cel(head, { steps: 2, shadow: 0xb09a5e, low: 0.84 }));
  cap.position.y = h * 0.6 + h * 0.31 - h * 0.085; g.add(cap);
  return g;
}

/** 圆形站钟 */
export function stationClock() {
  const g = new THREE.Group();
  const face = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.14, 24), cel(0xfdfaf2, { steps: 2, shadow: 0xa8b8d8, low: 0.86 }));
  face.rotation.x = Math.PI / 2; g.add(face);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.07, 8, 26), cel(0x8a94a8, { steps: 3, shadow: 0x6b7a9c }));
  g.add(rim);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const tick = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.13, 0.03), flat(0x3a4660));
    tick.position.set(Math.cos(a) * 0.46, Math.sin(a) * 0.46, 0.08);
    tick.rotation.z = a - Math.PI / 2;
    tick.userData.noInk = true; g.add(tick);
  }
  const hh = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.34, 0.03), flat(0x2c3e5c));
  hh.position.set(0, 0.14, 0.1); g.add(hh);
  const mm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.46, 0.03), flat(0x2c3e5c));
  mm.position.set(0, 0.18, 0.11); mm.rotation.z = -1.1; g.add(mm);
  const ctr = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), flat(0xe0738f));
  ctr.position.z = 0.13; ctr.userData.noInk = true; g.add(ctr);
  return g;
}

/** 自动贩卖机 */
export function vendingMachine(kind = 0) {
  const g = new THREE.Group();
  const bodyCol = [0xe8697a, 0x4f9fd4, 0xf2f2f2][kind % 3];
  const b = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.95, 0.72), cel(bodyCol, { steps: 3, shadow: 0x8fa0c8 }));
  b.position.y = 0.98; b.castShadow = true; g.add(b);
  // 展示窗
  const win = new THREE.Mesh(new THREE.PlaneGeometry(0.82, 1.12), flat(0xfff8e0));
  win.position.set(0, 1.28, 0.37); win.userData.noInk = true; g.add(win);
  // 一排排饮料
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.16, 6),
      flat([0x6fc4e8, 0xf2c744, 0x5fd98a, 0xe8697a][(r + c) % 4]));
    can.position.set(-0.27 + c * 0.18, 0.92 + r * 0.28, 0.38);
    can.userData.noInk = true; g.add(can);
  }
  // 取物口
  const slot = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.22, 0.06), MAT.dark());
  slot.position.set(0, 0.42, 0.37); g.add(slot);
  return g;
}

/** 候车木长椅 */
export function bench() {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.09, 0.16), MAT.wood());
    slat.position.set(0, 0.46, -0.22 + i * 0.22);
    slat.castShadow = true; g.add(slat);
  }
  for (let i = 0; i < 2; i++) {
    const back = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.14, 0.08), MAT.wood());
    back.position.set(0, 0.72 + i * 0.22, -0.32); g.add(back);
  }
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.46, 0.52), MAT.dark());
    leg.position.set(s * 1.1, 0.23, -0.04); g.add(leg);
  }
  return g;
}

/**
 * 海边小站站台：这是场景的视觉主体
 * 布局：水泥站台 + 雨棚 + 盲道 + 站名牌 + 长椅 + 贩卖机 + 时钟 + 售票窗
 */
export function buildStation() {
  const S = new THREE.Group();
  const L = 46;          // 站台长
  const W = 11;          // 站台宽
  const H = 3.6;         // 雨棚高

  // ---- 站台基座 ----
  const deck = new THREE.Mesh(new THREE.BoxGeometry(L, 0.7, W), MAT.concrete());
  deck.position.y = 0.35;
  deck.receiveShadow = true;
  deck.castShadow = true;
  S.add(deck);

  // 站台边缘白线
  const edgeLine = new THREE.Mesh(new THREE.BoxGeometry(L, 0.02, 0.3), flat(0xfdfaf2));
  edgeLine.position.set(0, 0.715, W / 2 - 0.35);
  edgeLine.userData.noInk = true;
  S.add(edgeLine);

  // ---- 黄色盲道（参考图 3/4 最抢眼的元素）----
  const tactileMat = flat(0xf2c744);
  const tactile = new THREE.Mesh(new THREE.BoxGeometry(L - 4, 0.05, 0.62), tactileMat);
  tactile.position.set(0, 0.735, W / 2 - 1.5);
  tactile.userData.noInk = true;
  S.add(tactile);
  // 盲道上的凸点阵列
  for (let i = 0; i < 60; i++) {
    const dot = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.04, 6), flat(0xe0b431));
    dot.position.set(-L / 2 + 2 + i * 0.7, 0.765, W / 2 - 1.5);
    dot.userData.noInk = true;
    S.add(dot);
  }

  // ---- 雨棚支柱 ----
  const colMat = cel(0x9aa6b4, { steps: 3, shadow: 0x7f90b8 });
  for (let i = 0; i < 7; i++) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, H, 10), colMat);
    col.position.set(-L / 2 + 3 + i * 6.6, H / 2 + 0.7, -1.6);
    col.castShadow = true;
    S.add(col);
    // 柱础
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.22, 10), MAT.dark());
    base.position.set(col.position.x, 0.81, -1.6);
    S.add(base);
  }

  // ---- 雨棚顶（微微起坡，日式站台感）----
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(L + 1.5, 0.22, W * 0.72), MAT.roof());
  canopy.position.set(0, H + 0.85, -1.0);
  canopy.rotation.x = -0.055;
  canopy.castShadow = true;
  S.add(canopy);
  // 吊顶白板：遮住雨棚底面的暗部
  const ceiling = new THREE.Mesh(
    new THREE.BoxGeometry(L + 1.2, 0.06, W * 0.7),
    cel(0xf6f2e8, { steps: 2, shadow: 0xb8c4dc, low: 0.88 })
  );
  ceiling.position.set(0, H + 0.72, -1.0);
  ceiling.rotation.x = -0.055;
  S.add(ceiling);
  // 雨棚檐口
  const fascia = new THREE.Mesh(new THREE.BoxGeometry(L + 1.7, 0.34, 0.16), cel(0xfdfaf2, { steps: 2, shadow: 0xa8b8d8, low: 0.86 }));
  fascia.position.set(0, H + 0.72, W * 0.36 - 1.0);
  S.add(fascia);
  // 檐下桁架（细密横梁，增加细节密度）
  for (let i = 0; i < 15; i++) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, W * 0.7), colMat);
    beam.position.set(-L / 2 + 1.6 + i * 3.1, H + 0.62, -1.0);
    beam.userData.inkWidth = 0.0012;
    S.add(beam);
  }
  // 吊灯
  for (let i = 0; i < 8; i++) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.11, 0.3), flat(0xfffce8));
    lamp.position.set(-L / 2 + 3 + i * 5.8, H + 0.42, -1.0);
    lamp.userData.noInk = true;
    S.add(lamp);
  }

  // ---- 站名牌（蓝底白字横匾）----
  const signBody = new THREE.Mesh(new THREE.BoxGeometry(7.2, 1.15, 0.14), cel(0x27508c, { steps: 2, shadow: 0x3d5e94, low: 0.84 }));
  signBody.position.set(0, H + 0.1, 2.6);
  S.add(signBody);
  // 站名文字（两面）
  const signTex = textPlate('桜ヶ浜', { sub: 'さくらがはま Skyport' });
  for (const s of [1, -1]) {
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(6.9, 1.0),
      new THREE.MeshBasicMaterial({ map: signTex, transparent: false })
    );
    plate.position.set(0, H + 0.1, 2.6 + s * 0.08);
    plate.rotation.y = s > 0 ? 0 : Math.PI;
    plate.userData.noInk = true;
    S.add(plate);
  }
  const signStripe = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.09, 0.16), MAT.accent());
  signStripe.position.set(0, H - 0.42, 2.62);
  S.add(signStripe);
  for (const sx of [-3.1, 3.1]) {
    const rod = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.5, 0.07), MAT.dark());
    rod.position.set(sx, H + 0.9, 2.6);
    S.add(rod);
  }
  // 圆形站钟挂在站名牌旁
  const clock = stationClock();
  clock.position.set(-5.4, H + 0.15, 2.6);
  S.add(clock);

  // ---- 售票窗口小屋 ----
  const booth = new THREE.Group();
  const bw = 5.2, bh = 2.9, bd = 3.4;
  const bb = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), MAT.wall());
  bb.position.y = bh / 2 + 0.7; bb.castShadow = true; bb.receiveShadow = true; booth.add(bb);
  const broof = new THREE.Mesh(new THREE.BoxGeometry(bw + 0.9, 0.24, bd + 0.9), MAT.roofRed());
  broof.position.y = bh + 0.82; broof.castShadow = true; booth.add(broof);
  // 窗口
  const winHole = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.2, 0.1), cel(0x3a4660, { steps: 2, shadow: 0x2e3a52, low: 0.8 }));
  winHole.position.set(0, 1.85, bd / 2 + 0.01); booth.add(winHole);
  const winGlass = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.05), MAT.glass());
  winGlass.position.set(0, 1.85, bd / 2 + 0.07); winGlass.userData.noInk = true; booth.add(winGlass);
  // 售票台面
  const counter = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.12, 0.5), MAT.wood());
  counter.position.set(0, 1.2, bd / 2 + 0.22); booth.add(counter);
  // 屋顶招牌
  const bs = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.7, 0.12), cel(0xfdfaf2, { steps: 2, shadow: 0xa8b8d8, low: 0.88 }));
  bs.position.set(0, bh + 1.35, bd / 2 - 0.1); booth.add(bs);
  const bsTex = textPlate('きっぷ', { w: 512, h: 128, bg: '#fdfaf2', fg: '#2c3e5c' });
  const bsPlate = new THREE.Mesh(new THREE.PlaneGeometry(3.3, 0.6),
    new THREE.MeshBasicMaterial({ map: bsTex }));
  bsPlate.position.set(0, bh + 1.35, bd / 2 - 0.03);
  bsPlate.userData.noInk = true;
  booth.add(bsPlate);
  booth.position.set(-14, 0.7, -3.4);
  S.add(booth);

  // ---- 长椅 ----
  for (let i = 0; i < 4; i++) {
    const b = bench();
    b.position.set(-13 + i * 8.5, 0.7, -0.3);
    b.rotation.y = Math.PI;
    S.add(b);
  }

  // ---- 自动贩卖机（靠站台内侧排一排）----
  for (let i = 0; i < 3; i++) {
    const v = vendingMachine(i);
    v.position.set(15 + i * 1.25, 0.7, -4.2);
    S.add(v);
  }

  // ---- 反光镜（路口那种圆镜）----
  const mirrorG = new THREE.Group();
  const mpole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.0, 8), MAT.metal());
  mpole.position.y = 1.5; mirrorG.add(mpole);
  const mface = new THREE.Mesh(new THREE.CircleGeometry(0.62, 20), flat(0xd8ecf8));
  mface.position.set(0, 3.0, 0.06); mface.userData.noInk = true; mirrorG.add(mface);
  const mrim = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.06, 8, 22), cel(0xf08a4b, { steps: 2, shadow: 0xb07ab0, low: 0.78 }));
  mrim.position.set(0, 3.0, 0.06); mirrorG.add(mrim);
  mirrorG.position.set(20, 0.7, 2.4);
  S.add(mirrorG);

  return S;
}
