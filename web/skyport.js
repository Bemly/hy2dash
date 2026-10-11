/**
 * skyport.js — 多泊位空港 + 海上电车 + 天空布景
 *
 * 机场 ≈ mihomo：
 *   每个停机坪 = 一个节点位（GATE 1~9），各自独立起降；
 *   出发标 = 节点状态面板；控制塔 = 测速源，发出 ping 波纹。
 * 参考图元素：改札口、发车标、黄色站台号牌、踏切、架空线、樱花行道树。
 */
import * as THREE from 'three';
import { cel, flat } from './toon.js';
import { railing, MAT } from './airport.js';
import { tram } from './craft.js';
import { buildCherryTree } from './cherry.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const hex = c => '#' + new THREE.Color(c).getHexString();
const FONT = '"Hiragino Sans","PingFang SC",sans-serif';

function canvasTex(w, h, draw) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.userData.ctx = ctx;
  return t;
}

/* ============================ 布局常量 ============================ */
export const LAYOUT = {
  walkZ: -17,          // 主栈桥中线
  walkW: 5,
  walkX0: -36,         // 栈桥起点（改札口）
  walkX1: -114,        // 栈桥终点（塔台圆台）
  padR: 7,             // 机体按真人比例做大了，停机坪也跟着放大
  towerPadR: 9,
  padY: 0.95,          // 停机坪顶面高度
  padX0: -52, padDX: 18, padDZ: 15,
  towerX: -124,
  towerTop: 15.6,
  trackZ: 7.6,
};

/** 第 i 号泊位中心：0~7 沿栈桥两侧交错，8 号是控制塔顶 */
function padCenter(i) {
  const L = LAYOUT;
  if (i === 8) return new THREE.Vector3(L.towerX, L.towerTop, L.walkZ);
  const col = Math.floor(i / 2);
  const side = i % 2 === 0 ? 1 : -1;         // 奇数号 GATE 在近海（靠镜头）一侧
  return new THREE.Vector3(L.padX0 - col * L.padDX, L.padY, L.walkZ + side * L.padDZ);
}

/* ------------------------- 贴图小件 ------------------------- */
function padMarkTex(num, color) {
  return canvasTex(512, 512, (c) => {
    c.lineCap = 'round';
    c.strokeStyle = '#fdfaf2'; c.lineWidth = 14;
    c.beginPath(); c.arc(256, 256, 232, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = hex(color); c.lineWidth = 22;          // 节点色分段环
    for (let k = 0; k < 6; k++) {
      c.beginPath(); c.arc(256, 256, 200, k * Math.PI / 3 + 0.12, (k + 1) * Math.PI / 3 - 0.12); c.stroke();
    }
    c.setLineDash([26, 20]);
    c.strokeStyle = '#f2c744'; c.lineWidth = 12;
    c.beginPath(); c.arc(256, 256, 150, 0, Math.PI * 2); c.stroke();
    c.setLineDash([]);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `900 190px ${FONT}`;
    c.lineWidth = 14; c.strokeStyle = '#33415f';
    c.strokeText(String(num), 256, 270);
    c.fillStyle = '#fdfaf2';
    c.fillText(String(num), 256, 270);
    c.font = `800 34px ${FONT}`;
    c.fillStyle = '#33415f';
    c.fillText('GATE', 256, 140);
  });
}

let _stripe;
function stripeTex() {
  if (_stripe) return _stripe;
  _stripe = canvasTex(64, 64, (c) => {
    c.fillStyle = '#f2c744'; c.fillRect(0, 0, 64, 64);
    c.fillStyle = '#2c3446';
    for (let i = -2; i < 4; i++) {
      c.beginPath();
      c.moveTo(i * 32, 64); c.lineTo(i * 32 + 16, 64); c.lineTo(i * 32 + 48, 0); c.lineTo(i * 32 + 32, 0);
      c.fill();
    }
  });
  _stripe.wrapS = _stripe.wrapT = THREE.RepeatWrapping;
  _stripe.repeat.set(2, 3);
  return _stripe;
}

function plankTex() {
  const t = canvasTex(256, 256, (c) => {
    c.fillStyle = '#e8d6b8'; c.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 8; i++) {
      c.fillStyle = i % 2 ? '#e2cfae' : '#ecdcc0';
      c.fillRect(i * 32, 0, 30, 256);
      c.fillStyle = '#b9a07e';
      c.fillRect(i * 32 + 30, 0, 2, 256);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** 黄色站台号牌（参考图 2 的「2」） */
function numberSign(num) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.2, 6), MAT.metal());
  pole.position.y = 1.1; g.add(pole);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.7, 8),
    cel(0xffffff, { steps: 2, low: 0.8, map: stripeTex() }));
  base.position.y = 0.35; g.add(base);
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.08), cel(0xf2c744, { steps: 2, shadow: 0xb09a5e, low: 0.84 }));
  plate.position.y = 2.55; g.add(plate);
  const t = canvasTex(128, 128, (c) => {
    c.fillStyle = '#f2c744'; c.fillRect(0, 0, 128, 128);
    c.strokeStyle = '#2c3e5c'; c.lineWidth = 8; c.strokeRect(6, 6, 116, 116);
    c.fillStyle = '#2c3e5c'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `900 92px ${FONT}`; c.fillText(String(num), 64, 70);
  });
  for (const s of [1, -1]) {
    const f = new THREE.Mesh(new THREE.PlaneGeometry(0.74, 0.74), new THREE.MeshBasicMaterial({ map: t }));
    f.position.set(0, 2.55, s * 0.045); f.rotation.y = s > 0 ? 0 : Math.PI;
    f.userData.noInk = true; g.add(f);
  }
  return g;
}

/* ============================ 单个停机坪 ============================ */
function buildPad(num, color, center, { tower = false } = {}) {
  const R = tower ? LAYOUT.towerPadR : LAYOUT.padR;
  const g = new THREE.Group();
  g.position.copy(center);

  const disc = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.36, 40),
    cel(0xebe4d4, { steps: 2, shadow: 0xa0aecc, low: 0.84 }));
  disc.position.y = -0.18; disc.receiveShadow = true; disc.castShadow = true; g.add(disc);
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.18, R + 0.18, 0.22, 40, 1, true),
    cel(color, { steps: 2, shadow: 0x8f9cc8, low: 0.78, side: THREE.DoubleSide }));
  rim.position.y = -0.14; g.add(rim);

  const mark = new THREE.Mesh(new THREE.CircleGeometry(R * 0.97, 40).rotateX(-Math.PI / 2),
    cel(0xffffff, { steps: 2, shadow: 0xb8c4dc, low: 0.86, map: padMarkTex(num, color), alphaTest: 0.4 }));
  mark.position.y = 0.012; mark.rotation.y = Math.PI / 2;   // 字头朝海，从岸上看是正的
  mark.receiveShadow = true; mark.userData.noInk = true; g.add(mark);

  const bulbs = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), flat(i % 2 ? 0x7ee8f2 : 0xffd98a));
    b.position.set(Math.cos(a) * (R - 0.35), 0.1, Math.sin(a) * (R - 0.35));
    b.userData.noInk = true; b.userData.keep = true;
    g.add(b); bulbs.push(b);
  }

  if (!tower) {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 3.2, 8), MAT.dark());
      leg.position.set(Math.cos(a) * (R - 1.4), -1.9, Math.sin(a) * (R - 1.4));
      g.add(leg);
    }
  }

  // 选中光环：一圈虚线弧慢慢转
  const sel = new THREE.Group();
  for (let k = 0; k < 8; k++) {
    const arc = new THREE.Mesh(new THREE.TorusGeometry(R + 0.9, 0.13, 6, 12, Math.PI / 6), flat(0xf2a6c0));
    arc.rotation.x = -Math.PI / 2;
    arc.rotation.z = (k / 8) * Math.PI * 2;
    arc.userData.noInk = true;
    sel.add(arc);
  }
  sel.position.y = 0.25; sel.visible = false; sel.userData.keep = true;
  g.add(sel);

  // 测速波纹
  const ping = new THREE.Mesh(new THREE.RingGeometry(R * 0.6, R * 0.74, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }));
  ping.position.y = 0.3; ping.userData.noInk = true; ping.userData.keep = true; g.add(ping);

  return { group: g, num, color, bulbs, sel, ping, top: center.clone(), yaw: Math.PI, pingT: -1 };
}

/* ============================ 出发标 ============================ */
export const STATE_TXT = {
  park:   ['停泊中', '#9fb3cc'],
  up:     ['搭乗·上昇', '#ffd166'],
  go:     ['离港', '#7ee8a8'],
  cruise: ['巡航中', '#7ee8a8'],
  back:   ['返航中', '#f2a6c0'],
  down:   ['着陆中', '#f2a6c0'],
};

export function latColor(lat) {
  return lat == null ? '#6c7f9c' : lat < 0 ? '#ff7a8a' : lat < 150 ? '#5fd98a' : lat < 300 ? '#f2b544' : '#ff8a6a';
}

function buildDepartureBoard() {
  const W = 1024, H = 660;
  const tex = canvasTex(W, H, () => {});
  const ctx = tex.userData.ctx;
  const g = new THREE.Group();

  const frame = new THREE.Mesh(new THREE.BoxGeometry(8.0, 5.3, 0.3), cel(0x3a4660, { steps: 2, shadow: 0x2e3a52, low: 0.8 }));
  frame.position.y = 5.2; frame.castShadow = true; g.add(frame);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(7.7, 4.96), new THREE.MeshBasicMaterial({ map: tex }));
  face.position.set(0, 5.2, 0.16); face.userData.noInk = true; g.add(face);
  // 顶部蓝色横匾（参考图 3 的「改札口」牌）
  const head = new THREE.Mesh(new THREE.BoxGeometry(8.0, 0.9, 0.34), cel(0x27508c, { steps: 2, shadow: 0x3d5e94, low: 0.84 }));
  head.position.y = 8.3; g.add(head);
  const headTex = canvasTex(1024, 116, (c) => {
    c.fillStyle = '#27508c'; c.fillRect(0, 0, 1024, 116);
    c.fillStyle = '#f2a6c0'; c.fillRect(0, 106, 1024, 10);
    c.fillStyle = '#fff'; c.textBaseline = 'middle';
    c.font = `800 56px ${FONT}`; c.fillText('搭乗口', 34, 50);
    c.font = `600 22px ${FONT}`; c.fillText('Boarding Gate', 40, 90);
    const chip = (x, n, txt) => {
      c.fillStyle = '#fff'; c.beginPath(); c.arc(x, 54, 26, 0, 7); c.fill();
      c.fillStyle = '#27508c'; c.textAlign = 'center'; c.font = `800 36px ${FONT}`; c.fillText(n, x, 56);
      c.fillStyle = '#fff'; c.textAlign = 'left'; c.font = `800 36px ${FONT}`; c.fillText(txt, x + 40, 56);
    };
    chip(330, '1', '奇数 · 近岸侧');
    chip(690, '2', '偶数 · 外海侧');
  });
  const hp = new THREE.Mesh(new THREE.PlaneGeometry(7.9, 0.86), new THREE.MeshBasicMaterial({ map: headTex }));
  hp.position.set(0, 8.3, 0.18); hp.userData.noInk = true; g.add(hp);
  for (const x of [-3.6, 3.6]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.22, 8.8, 0.22), MAT.dark());
    leg.position.set(x, 4.4, -0.1); g.add(leg);
  }

  let last = '';
  function draw(rows, clock) {
    const key = JSON.stringify(rows) + clock;
    if (key === last) return;
    last = key;
    const c = ctx;
    c.fillStyle = '#1d2740'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#243154'; c.fillRect(0, 0, W, 86);
    c.textBaseline = 'middle';
    c.fillStyle = '#fff'; c.font = `800 44px ${FONT}`; c.textAlign = 'left';
    c.fillText('出発', 30, 44);
    c.font = `600 24px ${FONT}`; c.fillStyle = '#c8d6ec';
    c.fillText('Departures · 桜ヶ浜スカイポート', 140, 46);
    c.textAlign = 'right'; c.font = `800 40px ui-monospace,Menlo,monospace`; c.fillStyle = '#ffb347';
    c.fillText(clock, W - 30, 44);
    c.fillStyle = '#f2a6c0'; c.fillRect(0, 86, W, 5);

    const cols = [30, 150, 360, 640, 990];
    c.textAlign = 'left'; c.font = `700 22px ${FONT}`; c.fillStyle = '#8fa4bd';
    ['GATE', '机体', '行先', '状态'].forEach((s, i) => c.fillText(s, cols[i], 118));
    c.textAlign = 'right'; c.fillText('延迟', cols[4], 118);

    rows.forEach((r, i) => {
      const y = 166 + i * 53;
      if (i % 2) { c.fillStyle = 'rgba(255,255,255,.045)'; c.fillRect(0, y - 26, W, 53); }
      c.textAlign = 'left';
      c.font = `800 30px ui-monospace,Menlo,monospace`; c.fillStyle = '#ffb347';
      c.fillText(String(r.gate).padStart(2, '0'), cols[0] + 10, y);
      c.fillStyle = r.color; c.fillRect(cols[1] - 18, y - 13, 8, 26);
      c.font = `800 30px ${FONT}`; c.fillStyle = '#ffffff';
      c.fillText(r.name, cols[1], y);
      c.font = `700 27px ${FONT}`; c.fillStyle = '#a8e6ff';
      c.fillText(r.dest, cols[2], y);
      const [st, sc] = STATE_TXT[r.mode];
      c.fillStyle = sc; c.font = `800 27px ${FONT}`;
      c.fillText(st, cols[3], y);
      c.textAlign = 'right'; c.font = `800 28px ui-monospace,Menlo,monospace`;
      c.fillStyle = r.lat == null ? '#6c7f9c' : r.lat < 0 ? '#ff7a8a' : r.lat < 150 ? '#7ee8a8' : r.lat < 300 ? '#ffd166' : '#ff9a7a';
      c.fillText(r.lat == null ? '—' : r.lat < 0 ? '超时' : r.lat + 'ms', cols[4], y);
    });
    tex.needsUpdate = true;
  }
  return { group: g, draw };
}

/* ============================ 改札机 ============================ */
function ticketGate(ok = true) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.05, 0.46), cel(0xc9ced8, { steps: 3, shadow: 0x8294bc }));
  body.position.y = 0.52; body.castShadow = true; g.add(body);
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.04, 0.1, 0.5), MAT.dark());
  top.position.y = 1.08; g.add(top);
  const reader = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.34), flat(0x6fc4e8));
  reader.position.set(0.6, 1.15, 0); reader.userData.noInk = true; g.add(reader);
  const t = canvasTex(64, 64, (c) => {
    c.fillStyle = '#2c3446'; c.fillRect(0, 0, 64, 64);
    c.strokeStyle = ok ? '#5fd98a' : '#ff6b7a'; c.lineWidth = 9; c.lineCap = 'round';
    c.beginPath();
    if (ok) { c.moveTo(32, 50); c.lineTo(32, 14); c.moveTo(18, 28); c.lineTo(32, 14); c.lineTo(46, 28); }
    else { c.moveTo(18, 18); c.lineTo(46, 46); c.moveTo(46, 18); c.lineTo(18, 46); }
    c.stroke();
  });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), new THREE.MeshBasicMaterial({ map: t }));
  face.position.set(1.01, 0.75, 0); face.rotation.y = Math.PI / 2; face.userData.noInk = true; g.add(face);
  const flap = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.06), flat(ok ? 0xf2a6c0 : 0xd8dce4));
  flap.position.set(-0.3, 0.78, 0.3); flap.userData.noInk = true; g.add(flap);
  return g;
}

/* ============================ 控制塔 ============================ */
function buildTower() {
  const L = LAYOUT;
  const g = new THREE.Group();
  const white = cel(0xfbf6ee, { steps: 3, shadow: 0xa4b2d6 });
  const pink = cel(0xf2a6c0, { steps: 2, shadow: 0xa98ac0, low: 0.76 });
  const glass = cel(0xc4e9f4, { steps: 2, shadow: 0x8fb8dd, low: 0.82 });

  const base = new THREE.Mesh(new THREE.CylinderGeometry(8, 8.3, 0.4, 40), cel(0xebe4d4, { steps: 2, shadow: 0xa0aecc, low: 0.84 }));
  base.position.y = 0.75; base.receiveShadow = true; g.add(base);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 3.2, 8), MAT.dark());
    leg.position.set(Math.cos(a) * 6.6, -0.9, Math.sin(a) * 6.6); g.add(leg);
  }
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.7, 12.6, 18), white);
  stem.position.y = 7.2; stem.castShadow = true; g.add(stem);
  for (const y of [3.2, 5.0]) {
    const r = 1.7 - (y - 0.9) * (0.45 / 12.6) + 0.03;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(r - 0.02, r, 0.5, 18), pink);
    band.position.y = y; g.add(band);
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const w = new THREE.Mesh(new THREE.CircleGeometry(0.26, 12), flat(0x5b6f96));
    const y = 6.6 + (i % 2) * 1.1;
    const r = 1.7 - (y - 0.9) * (0.45 / 12.6) + 0.02;
    w.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    w.lookAt(w.position.x * 2, y, w.position.z * 2);
    w.userData.noInk = true; g.add(w);
  }
  const cab = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 2.4, 2.0, 18), glass);
  cab.position.y = 10.6; g.add(cab);
  const cabRoof = new THREE.Mesh(new THREE.CylinderGeometry(3.3, 3.1, 0.35, 18), white);
  cabRoof.position.y = 11.75; g.add(cabRoof);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.0, 0.1), white);
    m.position.set(Math.cos(a) * 2.75, 10.6, Math.sin(a) * 2.75);
    m.userData.inkWidth = 0.001; g.add(m);
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 3.6, 6), white);
    br.position.set(Math.cos(a) * 2.6, 13.1, Math.sin(a) * 2.6);
    br.rotation.set(Math.sin(a) * 0.55, 0, -Math.cos(a) * 0.55);
    g.add(br);
  }
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.3, 2.2, 18), white);
  neck.position.y = 14.4; g.add(neck);
  // 环绕光环
  const halo = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(4.4, 0.09, 6, 64), flat(0x9ff0ff));
  ring.userData.noInk = true; halo.add(ring);
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), flat([0xf2a6c0, 0xffd98a, 0x9ff0ff][i]));
    const a = (i / 3) * Math.PI * 2;
    b.position.set(Math.cos(a) * 4.4, Math.sin(a) * 4.4, 0);
    b.userData.noInk = true; halo.add(b);
  }
  halo.rotation.x = Math.PI / 2 - 0.35;
  halo.position.y = 7.5; halo.userData.keep = true;
  g.add(halo);

  // 樱花形雷达
  const radar = new THREE.Group();
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 3.2, 6), MAT.metal());
  mast.position.y = 1.6; radar.add(mast);
  const flower = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.6, 10, 8), cel(0xffd6e6, { steps: 2, shadow: 0xd08ab8, low: 0.8 }));
    const a = (i / 5) * Math.PI * 2;
    p.scale.set(1, 0.22, 0.62);
    p.position.set(Math.cos(a) * 0.62, 0, Math.sin(a) * 0.62);
    p.rotation.y = -a;
    flower.add(p);
  }
  const ctr = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 6), flat(0xffd98a));
  ctr.userData.noInk = true; flower.add(ctr);
  flower.position.y = 3.3;
  radar.add(flower);
  radar.position.set(5.0, 0.95, 3.5); flower.userData.keep = true;
  g.add(radar);

  g.position.set(L.towerX, 0, L.walkZ);
  return { group: g, halo, radar: flower };
}

/* ============================ 空港总装 ============================ */
export function buildSkyport(fleet) {
  const L = LAYOUT;
  const G = new THREE.Group();

  // ---- 站台西端广场：接站台 → 过改札 → 上栈桥 ----
  const plaza = new THREE.Mesh(new THREE.BoxGeometry(13, 2.7, 23), MAT.concrete());
  plaza.position.set(-29.5, -0.65, -8.5);
  plaza.receiveShadow = true; plaza.castShadow = true;
  G.add(plaza);
  const tact = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.05, 15), flat(0xf2c744));
  tact.position.set(-31.5, 0.73, -8.5); tact.userData.noInk = true; G.add(tact);
  const tact2 = new THREE.Mesh(new THREE.BoxGeometry(9, 0.05, 0.62), flat(0xf2c744));
  tact2.position.set(-27.3, 0.73, -1.3); tact2.userData.noInk = true; G.add(tact2);
  const pr2 = railing(12.4, { h: 1.05 }); pr2.position.set(-29.5, 0.7, -19.85); G.add(pr2);
  const pr3 = railing(10, { h: 1.05 }); pr3.rotation.y = Math.PI / 2; pr3.position.set(-35.85, 0.7, -2.5); G.add(pr3);

  // ---- 改札口：横跨栈桥入口 ----
  for (let i = 0; i < 4; i++) {
    const tg = ticketGate(i !== 0);
    tg.position.set(-34.6, 0.7, L.walkZ - 2.2 + i * 1.45);
    G.add(tg);
  }

  // ---- 出发标 ----
  const board = buildDepartureBoard();
  board.group.position.set(-29, 0.7, -7.5);
  board.group.rotation.y = 0.5;
  G.add(board.group);

  // ---- 主栈桥 ----
  const deckTex = plankTex(); deckTex.repeat.set(16, 1);
  const deckMat = cel(0xffffff, { steps: 2, shadow: 0xa0aecc, low: 0.84, map: deckTex });
  const walkLen = L.walkX0 - L.walkX1;
  const walk = new THREE.Mesh(new THREE.BoxGeometry(walkLen, 0.32, L.walkW), deckMat);
  walk.position.set((L.walkX0 + L.walkX1) / 2, 0.79, L.walkZ);
  walk.receiveShadow = true; walk.castShadow = true;
  G.add(walk);
  for (let x = L.walkX0 - 2; x > L.walkX1; x -= 4.5) {
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 3, 8), MAT.dark());
      leg.position.set(x, -0.8, L.walkZ + s * 2.1); G.add(leg);
    }
  }
  // 栏杆：在每条廊桥处断开
  const gapXs = [0, 1, 2, 3].map(c => L.padX0 - c * L.padDX);
  for (const s of [-1, 1]) {
    let x0 = L.walkX0;
    const cuts = [...gapXs.map(x => [x + 1.9, x - 1.9]), [L.walkX1, L.walkX1]];
    for (const [a, b] of cuts) {
      const len = x0 - a;
      if (len > 1) {
        const r = railing(len, { h: 1.05 });
        r.position.set((x0 + a) / 2, 0.95, L.walkZ + s * (L.walkW / 2 - 0.08));
        G.add(r);
      }
      x0 = b;
    }
  }
  // 栈桥路灯
  for (let x = L.walkX0 - 6; x > L.walkX1; x -= 14) {
    const lamp = new THREE.Group();
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 3.6, 6), MAT.metal());
    p.position.y = 1.8; lamp.add(p);
    const hd = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), flat(0xfffce8));
    hd.position.y = 3.7; hd.userData.noInk = true; lamp.add(hd);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.3, 10), cel(0xf2a6c0, { steps: 2, shadow: 0xa98ac0 }));
    cap.position.y = 4.05; lamp.add(cap);
    lamp.position.set(x, 0.95, L.walkZ + 2.3);
    G.add(lamp);
  }

  // ---- 泊位 ----
  const pads = [];
  fleet.forEach((f, i) => {
    const c = padCenter(i);
    const pad = buildPad(i + 1, f.color, c, { tower: i === 8 });
    G.add(pad.group);
    pads.push(pad);
    if (i < 8) {
      const side = Math.sign(c.z - L.walkZ);
      const z0 = L.walkZ + side * L.walkW / 2;
      const z1 = c.z - side * (L.padR - 0.3);
      const len = Math.abs(z1 - z0);
      const br = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.28, len), deckMat);
      br.position.set(c.x, 0.82, (z0 + z1) / 2);
      br.receiveShadow = true; G.add(br);
      for (const sx of [-1, 1]) {
        const r = railing(len, { h: 1.0, step: 0.5 });
        r.rotation.y = Math.PI / 2;
        r.position.set(c.x + sx * 1.62, 0.96, (z0 + z1) / 2);
        G.add(r);
      }
      const ns = numberSign(i + 1);
      ns.position.set(c.x + 2.3, 0.95, z0 + side * 0.4);
      G.add(ns);
    }
  });

  const tower = buildTower();
  G.add(tower.group);

  return { group: G, pads, board, tower };
}

/* ============================ 海上电车 ============================ */
export function buildRailway() {
  const L = LAYOUT;
  const G = new THREE.Group();
  const X0 = -520, X1 = 520;

  // 海上路堤（水上铁路）+ 陆上道床
  const emb = new THREE.Mesh(new THREE.BoxGeometry(14 - X0, 2.3, 4.4), cel(0xd9d4cc, { steps: 2, shadow: 0x9aa8c8, low: 0.82 }));
  emb.position.set((X0 + 14) / 2, -1.0, L.trackZ); emb.receiveShadow = true; G.add(emb);
  const bal = new THREE.Mesh(new THREE.BoxGeometry(X1 - X0, 0.22, 3.4), cel(0xc9c2b8, { steps: 2, shadow: 0x9aa8c8, low: 0.84 }));
  bal.position.set(0, 0.11, L.trackZ); bal.receiveShadow = true; bal.userData.noInk = true; G.add(bal);

  const n = Math.floor((X1 - X0) / 0.9);
  const sleepers = new THREE.InstancedMesh(new THREE.BoxGeometry(0.32, 0.14, 2.5),
    cel(0xa89a88, { steps: 2, shadow: 0x8a8cb0, low: 0.8 }), n);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    m4.makeTranslation(X0 + i * 0.9, 0.27, L.trackZ);
    sleepers.setMatrixAt(i, m4);
  }
  sleepers.receiveShadow = true;
  sleepers.userData.noInk = true;
  G.add(sleepers);
  for (const dz of [-0.72, 0.72]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(X1 - X0, 0.14, 0.1), MAT.metal());
    rail.position.set(0, 0.4, L.trackZ + dz); rail.userData.noInk = true; G.add(rail);
  }

  // 架空线杆 + 接触网（参考图 1/2）
  const poleMat = cel(0xb9c2cc, { steps: 3, shadow: 0x8294bc });
  for (let x = -300; x <= 360; x += 24) {
    if (x > -24 && x < 24) continue;
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.28, 7.6, 0.28), poleMat);
    p.position.set(x, 3.8, L.trackZ + 2.6); p.castShadow = true; G.add(p);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 3.6), poleMat);
    arm.position.set(x, 7.0, L.trackZ + 0.9); G.add(arm);
    const arm2 = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 3.0), poleMat);
    arm2.position.set(x, 6.3, L.trackZ + 1.2); arm2.rotation.x = 0.22; G.add(arm2);
  }
  for (const [y, dz] of [[6.55, 0], [7.15, 0], [7.55, 2.6]]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(660, 0.04, 0.04), flat(0x3c4660));
    w.position.set(30, y, L.trackZ + dz); w.userData.noInk = true; G.add(w);
  }

  // 列车：三节编组
  const train = new THREE.Group();
  const carL = 10.5;
  for (let i = 0; i < 3; i++) {
    const car = tram({ L: carL, wings: false, dest: '各停 海の上 行', cab: i !== 1, crowd: 5, seed: 100 + i });
    car.position.x = (i - 1) * (carL + 0.5);
    if (i === 2) car.rotation.y = Math.PI;
    train.add(car);
  }
  train.position.set(400, 2.75, L.trackZ); train.userData.keep = true;
  G.add(train);

  // 踏切：道路在 x=CX 处横穿铁路
  const CX = 44;
  const road = new THREE.Mesh(new THREE.PlaneGeometry(7, 220).rotateX(-Math.PI / 2), cel(0x9aa2b6, { steps: 2, shadow: 0x7f8cb0, low: 0.86 }));
  road.position.set(CX, 0.035, -20); road.receiveShadow = true; road.userData.noInk = true; G.add(road);
  const cl = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 220).rotateX(-Math.PI / 2), flat(0xf2b544));
  cl.position.set(CX, 0.05, -20); cl.userData.noInk = true; G.add(cl);
  for (const s of [-1, 1]) {
    const edge = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 220).rotateX(-Math.PI / 2), flat(0xfdfaf2));
    edge.position.set(CX + s * 3.2, 0.05, -20); edge.userData.noInk = true; G.add(edge);
  }
  const armTex = stripeTex().clone(); armTex.repeat.set(6, 0.3); armTex.needsUpdate = true;
  const lamps = [], arms = [];
  for (const s of [-1, 1]) {
    const sg = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4.4, 8), cel(0xffffff, { steps: 2, low: 0.8, map: stripeTex() }));
    pole.position.y = 2.2; sg.add(pole);
    for (const r of [0.6, -0.6]) {          // ✕ 标志
      const x = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.22, 0.06), cel(0xf2c744, { steps: 2, shadow: 0xb09a5e }));
      x.position.y = 4.1; x.rotation.z = r; sg.add(x);
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.2, 0.1), MAT.dark());
    bar.position.y = 3.25; sg.add(bar);
    for (const lx of [-0.55, 0.55]) {
      const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.2, 12), MAT.dark());
      hood.rotation.x = Math.PI / 2; hood.position.set(lx, 3.25, 0.12); sg.add(hood);
      const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.2, 12), flat(0x6b2a35));
      lamp.position.set(lx, 3.25, 0.23);
      lamp.userData.noInk = true; lamp.userData.keep = true; sg.add(lamp); lamps.push(lamp);
    }
    const pivot = new THREE.Group();          // 遮断杆
    pivot.userData.keep = true;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.16, 0.16), cel(0xffffff, { steps: 2, low: 0.8, map: armTex }));
    arm.position.x = -3.1;
    pivot.add(arm);
    pivot.position.y = 1.1;
    sg.add(pivot); arms.push(pivot);
    sg.position.set(CX + 3.9 * s, 0, L.trackZ + 4.0 * s);
    sg.rotation.y = s > 0 ? 0 : Math.PI;
    G.add(sg);
  }

  // 运行图：进站减速 → 停站 → 出站 → 驶向海平线 → 间隔
  const v = 16, d = 60, cruiseD = 340;
  const tCr = cruiseD / v, tBr = 2 * d / v, tDw = 9, tGap = 12;
  const cycle = 2 * tCr + 2 * tBr + tDw + tGap;
  function xAt(t) {
    t %= cycle;
    if (t < tCr) return (d + cruiseD) - v * t;
    t -= tCr;
    if (t < tBr) { const k = t / tBr; return d * (1 - (2 * k - k * k)); }
    t -= tBr;
    if (t < tDw) return 0;
    t -= tDw;
    if (t < tBr) { const k = t / tBr; return -d * k * k; }
    t -= tBr;
    if (t < tCr) return -d - v * t;
    return 1e4;
  }
  let gate = 0;
  function update(time, dt) {
    const x = xAt(time + 4);
    train.visible = x < 1e3;
    train.position.x = x;
    const near = train.visible && Math.abs(x - CX) < 55;
    gate += ((near ? 1 : 0) - gate) * Math.min(1, dt * 1.6);
    arms.forEach(p => { p.rotation.z = -(1 - gate) * (Math.PI / 2 - 0.08); });
    const blink = Math.floor(time * 2.4) % 2;
    lamps.forEach((l, i) => l.material.color.setHex(near && ((i % 2) ^ blink) ? 0xff4a5a : 0x6b2a35));
    return x;
  }
  return { group: G, train, update };
}

/* ============================ 天空布景 ============================ */
function floatingIsland(r) {
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.94, 1.2, 16), cel(0xa6d98a, { steps: 2, shadow: 0x6f9cc0, low: 0.72 }));
  top.castShadow = true; g.add(top);
  const soil = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.94, r * 0.72, 1.8, 16), cel(0xe8d2b0, { steps: 2, shadow: 0xa8a0c8, low: 0.8 }));
  soil.position.y = -1.5; g.add(soil);
  const rock = new THREE.Mesh(new THREE.ConeGeometry(r * 0.72, r * 1.7, 9), cel(0xd8cce4, { steps: 3, shadow: 0x9a92c4 }));
  rock.rotation.x = Math.PI; rock.position.y = -2.4 - r * 0.85; g.add(rock);
  for (let i = 0; i < 4; i++) {
    const cr = new THREE.Mesh(new THREE.OctahedronGeometry(rnd(0.5, 1.1)), flat([0xb8f4ff, 0xffd6e6, 0xfff2b8][i % 3]));
    const a = rnd(0, 6.28);
    cr.position.set(Math.cos(a) * r * 0.4, -2.6 - rnd(0.5, r * 0.9), Math.sin(a) * r * 0.4);
    cr.scale.y = 1.8;
    g.add(cr);
  }
  const tree = buildCherryTree(r * 0.9, r * 0.6);
  tree.scale.setScalar(0.7);
  tree.position.set(rnd(-r * 0.3, r * 0.3), 0.6, rnd(-r * 0.3, r * 0.3));
  g.add(tree);
  const fallH = r * 2.4;                        // 小瀑布
  const fall = new THREE.Mesh(new THREE.PlaneGeometry(1.4, fallH),
    new THREE.MeshBasicMaterial({ color: 0xe6f8ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
  fall.position.set(r * 0.98, -fallH / 2 + 0.4, 0); fall.rotation.y = Math.PI / 2;
  fall.userData.noInk = true; g.add(fall);
  const torii = new THREE.Group();              // 迷你鸟居
  const red = cel(0xe8604c, { steps: 2, shadow: 0xa86a98, low: 0.76 });
  for (const s of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 2.2, 8), red);
    p.position.set(s * 0.9, 1.1, 0); torii.add(p);
  }
  const kasagi = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.22, 0.32), red);
  kasagi.position.y = 2.25; torii.add(kasagi);
  const nuki = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.14, 0.2), red);
  nuki.position.y = 1.8; torii.add(nuki);
  torii.position.set(-r * 0.5, 0.6, r * 0.3);
  torii.rotation.y = 0.8;
  g.add(torii);
  return g;
}

export function buildSkyDecor(scene) {
  const islands = new THREE.Group();
  [[-190, 52, -150, 9], [-70, 68, -210, 7], [60, 84, -190, 6], [-280, 40, 30, 8], [-150, 90, 80, 5]].forEach(([x, y, z, r], i) => {
    const is = floatingIsland(r);
    is.position.set(x, y, z);
    is.rotation.y = i * 1.3;
    is.userData.bob = { y, ph: i * 1.7 };
    islands.add(is);
  });
  scene.add(islands);

  // 白昼双月 + 行星环
  const moons = new THREE.Group();
  const big = new THREE.Group();
  big.add(new THREE.Mesh(new THREE.CircleGeometry(52, 48), new THREE.MeshBasicMaterial({ color: 0xf4eefb, fog: false })));
  [[14, 10, 9], [-18, -8, 6], [6, -22, 5], [-8, 20, 4]].forEach(([x, y, r]) => {
    const c = new THREE.Mesh(new THREE.CircleGeometry(r, 20), new THREE.MeshBasicMaterial({ color: 0xe6def4, fog: false }));
    c.position.set(x, y, 0.3); big.add(c);
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(70, 80, 64),
    new THREE.MeshBasicMaterial({ color: 0xffe6f0, fog: false, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
  ring.rotation.x = 1.15; ring.rotation.y = 0.3; big.add(ring);
  big.position.set(-330, 190, -300);
  big.lookAt(0, 20, 0);
  moons.add(big);
  const small = new THREE.Mesh(new THREE.CircleGeometry(16, 32), new THREE.MeshBasicMaterial({ color: 0xe6f4ff, fog: false }));
  small.position.set(-130, 250, -400);
  small.lookAt(0, 20, 0);
  moons.add(small);
  moons.traverse(o => { o.userData.noInk = true; });
  scene.add(moons);
  return { islands, moons };
}

/** 航线上的「节点环」：飞行器巡航时会从中间穿过 */
export function buildRouteRing(color) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.TorusGeometry(4.6, 0.14, 8, 48), flat(color));
  base.userData.noInk = true; g.add(base);
  const spin = new THREE.Group();
  for (let k = 0; k < 3; k++) {
    const arc = new THREE.Mesh(new THREE.TorusGeometry(5.3, 0.34, 8, 16, Math.PI / 3.2),
      cel(0xffffff, { steps: 2, shadow: 0xb8c4e8, low: 0.84 }));
    arc.rotation.z = (k / 3) * Math.PI * 2;
    spin.add(arc);
  }
  g.add(spin);
  g.userData.spin = spin;
  return g;
}
