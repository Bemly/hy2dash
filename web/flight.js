/**
 * flight.js — 飞行动画（让它「像在飞」，而不是「沿线滑」）
 *
 * 1. 路径：Catmull-Rom（centripetal，不打结）按弧长重采样，匀速可控
 * 2. 速度曲线：弯道限速 v ≤ √(a_lat/κ)，再做前向/后向加减速约束
 *    → 进弯前自然减速、出弯加速，起步/刹停平滑（同赛车游戏的速度规划）
 * 3. 姿态：协调转弯 bank = atan(a_lat / g)；俯仰来自爬升角 + 加速前倾；
 *    三个角都走二阶弹簧（欠阻尼一点点 → 有「跟随与重叠」的余韵）
 * 4. 动画原则：起飞前「预备」下蹲、离地「拉伸」、落地「挤压」回弹
 * 5. 个性：纸飞机滑翔起伏、水母一张一缩地推进、猫巴士奔跑颠簸、
 *    汽水火箭直线段偶尔来个桶滚、金鱼摆尾游、蒲公英随风飘、鲸鱼缓慢起伏
 * 6. 吊挂物（灯笼、吊篮）是真摆锤：加减速时会荡
 *
 *   park ─launch→ spool ─→ depart ─→ cruise
 *     ↑                                 │ recall
 *     └──── land ←────── return ←───────┘
 */
import * as THREE from 'three';
import { cel } from './toon.js';

const G = 9.8, TAU = Math.PI * 2;
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = THREE.MathUtils.clamp;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _q = new THREE.Quaternion();

/* ---------------------------- 弹簧 ---------------------------- */
class Spring {
  constructor(x = 0, w = 4, z = 0.8) { this.x = x; this.v = 0; this.w = w; this.z = z; }
  step(target, dt, angle = false) {
    const n = Math.max(1, Math.ceil(dt * this.w / 0.25));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const err = angle ? wrap(target - this.x) : target - this.x;
      const acc = this.w * this.w * err - 2 * this.z * this.w * this.v;
      this.v += acc * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

/* ---------------------------- 路径 ---------------------------- */
export class Path {
  /**
   * @param pts 控制点
   * @param o   { closed, vmax, aLat, aAcc, aDec, v0, v1 }
   */
  constructor(pts, o) {
    this.closed = !!o.closed;
    const curve = new THREE.CatmullRomCurve3(pts, this.closed, 'centripetal');
    let est = 0;
    for (let i = 1; i < pts.length; i++) est += pts[i].distanceTo(pts[i - 1]);
    curve.arcLengthDivisions = Math.max(300, Math.ceil(est * 1.2));
    this.curve = curve;
    this.L = curve.getLength();
    const n = this.n = Math.max(24, Math.ceil(this.L / 1.2));
    this.ds = this.L / n;
    this.P = []; this.T = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      this.P.push(curve.getPointAt(Math.min(u, 1)));
      this.T.push(curve.getTangentAt(Math.min(u, 1)).normalize());
    }
    // 弯道限速
    const cap = this.cap = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) {
      const k = this.curv(i).length();
      cap[i] = Math.min(o.vmax, Math.sqrt(o.aLat / Math.max(k, 1e-5)));
    }
    if (!this.closed) {
      if (o.v0 != null) cap[0] = Math.min(cap[0], o.v0);
      if (o.v1 != null) cap[n] = Math.min(cap[n], o.v1);
    }
    const passes = this.closed ? 3 : 1;
    for (let p = 0; p < passes; p++) {
      for (let i = n - 1; i >= 0; i--) cap[i] = Math.min(cap[i], Math.sqrt(cap[i + 1] ** 2 + 2 * o.aDec * this.ds));
      if (this.closed) cap[n] = cap[0] = Math.min(cap[0], cap[n]);
      for (let i = 1; i <= n; i++) cap[i] = Math.min(cap[i], Math.sqrt(cap[i - 1] ** 2 + 2 * o.aAcc * this.ds));
      if (this.closed) cap[0] = cap[n] = Math.min(cap[0], cap[n]);
    }
  }
  idx(i) {
    if (this.closed) return ((i % this.n) + this.n) % this.n;
    return clamp(i, 0, this.n);
  }
  /** 曲率向量 dT/ds（指向弯心，长度 = 曲率） */
  curv(i, out = new THREE.Vector3()) {
    const a = this.T[this.idx(i - 2)], b = this.T[this.idx(i + 2)];
    return out.subVectors(b, a).divideScalar(4 * this.ds);
  }
  norm(s) { return this.closed ? ((s % this.L) + this.L) % this.L : clamp(s, 0, this.L); }
  sample(s, P, T) {
    s = this.norm(s);
    const f = s / this.ds, i = Math.floor(f), t = f - i;
    const i1 = this.idx(i + 1), i0 = this.idx(i);
    P.lerpVectors(this.P[i0], this.P[i1], t);
    if (T) T.lerpVectors(this.T[i0], this.T[i1], t).normalize();
    return P;
  }
  curvAt(s, out) {
    s = this.norm(s);
    const f = s / this.ds, i = Math.floor(f), t = f - i;
    this.curv(i, out);
    return out.lerp(this.curv(i + 1, _c), t);
  }
  speedAt(s) {
    s = this.norm(s);
    const f = s / this.ds, i = Math.floor(f), t = f - i;
    return THREE.MathUtils.lerp(this.cap[this.idx(i)], this.cap[this.idx(i + 1)], t);
  }
  nearest(p, from = 0, to = this.L) {
    let best = 0, bd = Infinity;
    for (let i = 0; i <= this.n; i++) {
      const s = i * this.ds;
      if (s < from || s > to) continue;
      const d = this.P[i].distanceToSquared(p);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }
}

/* ---------------------------- 个性 ---------------------------- */
const STYLE = {
  glide:  { bank: 1.45, pitch: 1.0, tilt: 0.0, maxBank: 0.85 },
  rock:   { bank: 0.8,  pitch: 0.6, tilt: 0.45, maxBank: 0.4 },
  pulse:  { bank: 0.35, pitch: 0.3, tilt: 0.25, maxBank: 0.25 },
  gallop: { bank: 0.9,  pitch: 0.7, tilt: 0.35, maxBank: 0.45 },
  rail:   { bank: 0.7,  pitch: 0.8, tilt: 0.15, maxBank: 0.4 },
  swim:   { bank: 1.0,  pitch: 0.8, tilt: 0.2, maxBank: 0.55 },
  drift:  { bank: 0.25, pitch: 0.2, tilt: 0.3, maxBank: 0.15 },
  rocket: { bank: 1.25, pitch: 1.0, tilt: 0.0, maxBank: 1.0 },
  whale:  { bank: 0.55, pitch: 0.7, tilt: 0.15, maxBank: 0.3 },
};

/* ---------------------------- 尾迹 ---------------------------- */
const puffGeo = new THREE.IcosahedronGeometry(0.6, 2);
const puffMat = cel(0xffffff, { steps: 2, shadow: 0xc8d6f4, low: 0.88, emissive: 0x30343c });
const TRAIL_N = 140;

/* ============================== Flight ============================== */
export class Flight {
  /**
   * @param loop 这台机体的巡航环线（Path, closed）
   */
  constructor(def, mesh, pad, idx, scene, loop) {
    this.def = def; this.mesh = mesh; this.pad = pad; this.idx = idx; this.loop = loop;
    this.st = STYLE[def.style] || STYLE.rail;
    this.phase = 'park';
    this.t = 0; this.time = 0;

    mesh.rotation.order = 'YZX';
    mesh.scale.setScalar(def.scale);
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3();
    mesh.traverse(o => { if (o.isMesh && !o.userData.isInk && !o.userData.tentacleMesh) box.expandByObject(o); });
    this.hover = -(box.min.y - mesh.position.y) + 0.35;
    this.length = box.max.x - box.min.x;
    this.home = pad.top.clone().add(new THREE.Vector3(0, this.hover, 0));
    this.pos = this.home.clone();
    this.vel = new THREE.Vector3();
    this.fwd = new THREE.Vector3(-1, 0, 0);

    const m = Math.sqrt(def.mass || 1), ag = def.agility || 1;
    this.yaw = new Spring(pad.yaw, 2.6 * ag / m, 1.0);
    this.pitch = new Spring(0, 3.0 / m, 0.62);
    this.roll = new Spring(0, 2.8 / m, 0.55);
    this.sq = new Spring(1, 13, 0.32);           // 挤压/拉伸
    this.yawT = pad.yaw;
    this.v = 0; this.s = 0; this.aF = 0;
    this.e = new Spring(0, 3, 1);
    this.extraRoll = 0; this.rollTimer = 6 + idx;
    this.landV = new THREE.Vector3();

    this.kin = { vmax: def.speed, aLat: 7 * ag, aAcc: 2.6 * ag / m, aDec: 3.2 * ag / m };

    // 动画部件
    this.parts = []; this.swings = [];
    mesh.traverse(o => {
      const u = o.userData;
      if (u.swing) this.swings.push({ o, x: new Spring(0, 2.1, 0.18), z: new Spring(0, 2.1, 0.18), k: u.swing.k });
      if (u.jet || u.steam || u.tentacle || u.leg || u.flap !== undefined || u.tailwag || u.bubble || u.spin ||
          u.fluke || u.spout || u.pulse || u.wheel) this.parts.push(o);
    });
    this.chars = mesh.userData.chars || [];
    this.cut = mesh.userData.cut;
    this.cutOn = false;

    // 尾迹
    this.trail = new THREE.InstancedMesh(puffGeo, puffMat, TRAIL_N);
    this.trail.frustumCulled = false;
    this.trail.userData.noInk = true;
    const tint = new THREE.Color(def.color).lerp(new THREE.Color(0xffffff), 0.82);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this.puffs = [];
    for (let k = 0; k < TRAIL_N; k++) {
      this.trail.setMatrixAt(k, zero);
      this.trail.setColorAt(k, tint);
      this.puffs.push({ p: new THREE.Vector3(), age: 1e9, life: 1, s: 1, d: new THREE.Vector3() });
    }
    this.puffIdx = 0; this.dist = 0;
    scene.add(this.trail);
    this._m4 = new THREE.Matrix4();

    this._place(0);
  }

  get airborne() { return this.phase !== 'park'; }
  get outbound() { return this.phase === 'spool' || this.phase === 'depart' || this.phase === 'cruise'; }
  get mode() {                                        // 给 UI / 出发标
    return { park: 'park', spool: 'up', depart: 'go', cruise: 'cruise', return: 'back', land: 'down' }[this.phase];
  }
  get speed() { return this.phase === 'land' ? this.landV.length() : this.v; }

  /* ---------------- 指令 ---------------- */
  launch() {
    if (this.outbound) return;
    if (this.phase === 'park' || (this.phase === 'land' && this.pos.y - this.home.y < 0.6)) {
      this.phase = 'spool'; this.t = 0;
      return;
    }
    // 返航/降落途中改主意：从当前位置直接回航线
    const dir = this.phase === 'land' ? _a.set(0, 1, 0) : this._tan.clone();
    this._buildDepart(this.pos.clone(), dir.clone(), this.v);
  }
  recall() {
    if (this.phase === 'spool') { this.phase = 'park'; return; }
    if (this.phase !== 'depart' && this.phase !== 'cruise') return;
    const P0 = this.pos.clone(), T0 = this._tan.clone();
    const H = this.home.clone().add(new THREE.Vector3(0, 9, 0));
    const dir = _a.copy(P0).sub(H).setY(0);
    const far = dir.length();
    dir.normalize();
    const pts = [P0, P0.clone().addScaledVector(T0, Math.max(28, this.v * 2.2))];
    if (far > 110) pts.push(H.clone().addScaledVector(dir, 75).add(new THREE.Vector3(0, 20, 0)));
    pts.push(H.clone().addScaledVector(dir, 26).add(new THREE.Vector3(0, 4, 0)), H);
    this.path = new Path(pts, { ...this.kin, aDec: this.kin.aDec * 0.6, v0: this.v + 1, v1: 0 });
    this.s = 0;
    this.phase = 'return';
  }
  toggle() { this.outbound ? this.recall() : this.launch(); }

  _buildDepart(P0, D0, v0) {
    const fromPad = this.phase === 'spool';
    const fwd = _b.set(Math.cos(this.yaw.x), 0, -Math.sin(this.yaw.x));
    const pts = fromPad
      ? [P0, P0.clone().add(new THREE.Vector3(0, 3, 0)), P0.clone().add(new THREE.Vector3(0, 8, 0)).addScaledVector(fwd, 4),
         P0.clone().add(new THREE.Vector3(0, 14, 0)).addScaledVector(fwd, 28)]
      : [P0, P0.clone().addScaledVector(D0, Math.max(16, v0 * 1.6))];
    const last = pts[pts.length - 1];
    const q = last.clone().addScaledVector(fromPad ? fwd : D0.setY(0).normalize(), 60).add(new THREE.Vector3(0, 12, 0));
    const sJ = this.loop.nearest(q);
    for (const k of [0, 30, 60]) pts.push(this.loop.sample(sJ + k, new THREE.Vector3()));
    this.path = new Path(pts, { ...this.kin, v0: fromPad ? 0 : v0 + 1 });
    // 切换点 = 控制点 loop(sJ+30) 在新路径上的弧长
    this.switchS = this.path.nearest(pts[pts.length - 2], this.path.L * 0.5);
    this.joinS = sJ + 30;
    this.s = 0;
    if (fromPad) this.v = 0;
    this.phase = 'depart';
  }

  /* ---------------- 每帧 ---------------- */
  update(dt, time) {
    this.time = time;
    const st = this.st, d = this.def;
    this._tan = this._tan || new THREE.Vector3(-1, 0, 0);
    const prev = _c.copy(this.pos);
    let k = null;                                          // 曲率向量
    let speedMul = 1;

    if (d.style === 'pulse') {                            // 水母：一张一缩
      const p = (0.5 + 0.5 * Math.sin(time * 2.4)) ** 2;
      speedMul = 0.5 + 1.4 * p;
      this._pulse = p;
    }

    switch (this.phase) {
      case 'park': {
        this.pos.copy(this.home);
        this.yawT = this.pad.yaw + Math.sin(time * 0.3 + this.idx) * 0.03;
        this.v = 0; this.aF = 0;
        break;
      }
      case 'spool': {                                     // 预备：下蹲蓄力
        this.t += dt;
        this.pos.copy(this.home);
        this.pos.y -= Math.sin(Math.min(1, this.t / 0.9) * Math.PI) * 0.18;
        if (this.t >= 1.0) {
          this.sq.v += 1.1;                                // 离地拉伸
          this._buildDepart(this.home.clone(), null, 0);
        }
        break;
      }
      case 'depart':
      case 'cruise':
      case 'return': {
        const path = this.phase === 'cruise' ? this.loop : this.path;
        const look = Math.max(2, this.v * 0.7);
        const target = path.speedAt(this.s + look) * speedMul;
        const a = clamp((target - this.v) * 1.6, -this.kin.aDec * 1.4, this.kin.aAcc * 1.4);
        this.v = Math.max(0, this.v + a * dt);
        if (this.phase === 'return') this.v = Math.max(this.v, Math.min(1.2, (path.L - this.s) * 0.8));
        if (this.phase === 'depart' && this.s < 1) this.v = Math.max(this.v, 0.8);
        this.aF += (a - this.aF) * (1 - Math.exp(-dt * 3));
        this.s += this.v * dt;
        path.sample(this.s, this.pos, this._tan);
        k = path.curvAt(this.s, _a);
        if (this.phase === 'depart' && this.s >= this.switchS) {
          this.phase = 'cruise';
          this.s = this.loop.norm(this.joinS);
        } else if (this.phase === 'return' && (this.s >= path.L - 0.05 || (path.L - this.s < 0.4 && this.v < 0.5))) {
          this.phase = 'land';
          this.landV.set(0, -this.v * 0.3, 0);
          this.landFrom = this.pos.clone();
          this.landYaw0 = this.yaw.x;
          this.landD0 = Math.max(0.5, this.pos.distanceTo(this.home));
        }
        break;
      }
      case 'land': {                                      // 悬停后缓降（临界阻尼）
        const w = 1.5;
        _b.subVectors(this.home, this.pos).multiplyScalar(w * w).addScaledVector(this.landV, -2 * w);
        this.landV.addScaledVector(_b, dt);
        this.pos.addScaledVector(this.landV, dt);
        // 机头在整段下降里慢慢转回朝海（而不是悬停瞬间猛转）
        const prog = 1 - Math.min(1, this.pos.distanceTo(this.home) / (this.landD0 || 1));
        const y0 = this.landYaw0 ?? this.pad.yaw;
        this.yawT = y0 + wrap(this.pad.yaw - y0) * smooth(0.05, 0.9, prog);
        this.v = this.landV.length();
        this.aF *= 0.9;
        if (this.pos.distanceTo(this.home) < 0.04 && this.landV.length() < 0.08) {
          this.phase = 'park';
          this.sq.v -= 0.9;                                // 落地挤压
        }
        break;
      }
    }

    // 速度向量 / 前向
    this.vel.subVectors(this.pos, prev).divideScalar(Math.max(dt, 1e-4));
    const T = this._tan;
    const th = Math.hypot(T.x, T.z);
    if ((this.phase === 'depart' || this.phase === 'cruise' || this.phase === 'return') && th > 0.25 && this.v > 0.8) {
      this.yawT = Math.atan2(-T.z, T.x);
    }

    // 姿态目标
    let rollT = 0, pitchT = 0;
    if (k && this.v > 0.5) {
      const acc = _b.copy(k).multiplyScalar(this.v * this.v).addScaledVector(T, this.aF);
      const yaw = this.yaw.x;
      const latA = acc.x * Math.sin(yaw) + acc.z * Math.cos(yaw);
      rollT = clamp(Math.atan(latA / G) * st.bank, -st.maxBank, st.maxBank);
      const w = smooth(1.5, 7, this.v * th);
      pitchT = w * Math.atan2(T.y, Math.max(th, 1e-3)) * st.pitch;
    }
    pitchT -= st.tilt * clamp(this.aF / G, -0.6, 0.6);
    if (this.phase === 'return') pitchT += clamp(-this.aF / G, 0, 0.3) * 0.6;   // 刹车拉平（flare）

    // 个性叠加
    const e = this.e.step(this.phase === 'park' ? 0 : this.phase === 'spool' ? 0.55 : this.phase === 'land' ? 0.35 : 1, dt);
    const off = _a.set(0, 0, 0);
    let pAdd = 0, rAdd = 0, yAdd = 0;
    const bob = Math.sin(time * 1.1 + this.idx * 1.7);
    off.y += bob * (this.phase === 'park' ? 0.08 : 0.25);
    switch (d.style) {
      case 'glide': off.y += Math.sin(time * 0.9) * 0.7 * e; pAdd += Math.cos(time * 0.9) * 0.05 * e; break;
      case 'rock': rAdd += Math.sin(time * 1.3 + 1) * 0.06; pAdd += Math.sin(time * 0.85) * 0.035; break;
      case 'pulse': off.y -= (this._pulse || 0) * 0.35 * (0.3 + e); break;
      case 'gallop': off.y += Math.abs(Math.sin(time * 6.5)) * 0.4 * e; pAdd += Math.sin(time * 13) * 0.025 * e; break;
      case 'rail': rAdd += Math.sin(time * 2.1) * 0.012 * e; break;
      case 'swim': yAdd += Math.sin(time * 3.2) * 0.08 * (0.3 + e); rAdd += Math.sin(time * 3.2 + 1.2) * 0.035 * e; break;
      case 'drift':
        off.x += (Math.sin(time * 0.31) * 1.4 + Math.sin(time * 0.73) * 0.6) * e;
        off.z += (Math.cos(time * 0.27) * 1.4 + Math.sin(time * 0.61 + 2) * 0.6) * e;
        off.y += Math.sin(time * 0.5) * 0.8 * e;
        rAdd += Math.sin(time * 0.7) * 0.05 * e;
        break;
      case 'whale': pAdd += Math.sin(time * 0.6) * 0.04 * (0.4 + e); off.y += Math.sin(time * 0.6 - 0.8) * 0.5 * e; break;
      case 'rocket':
        // 直线段时偶尔来个桶滚
        if (this.phase === 'cruise') {
          this.rollTimer -= dt;
          const straight = k ? k.length() < 0.004 : false;
          if (this.rollTimer < 0 && straight && this.extraRollT === undefined) this.extraRollT = 0;
        }
        if (this.extraRollT !== undefined) {
          this.extraRollT += dt / 1.4;
          const x = Math.min(1, this.extraRollT);
          this.extraRoll = TAU * x * x * x * (x * (x * 6 - 15) + 10);
          if (this.extraRollT >= 1) { this.extraRollT = undefined; this.extraRoll = 0; this.rollTimer = 10 + Math.random() * 8; }
        }
        break;
    }

    this.yaw.step(this.yawT, dt, true);
    this.pitch.step(pitchT, dt);
    this.roll.step(rollT, dt);
    const sq = this.sq.step(this.phase === 'spool' ? 0.94 : 1, dt);

    const m = this.mesh;
    m.position.copy(this.pos).add(off);
    m.rotation.set(this.roll.x + rAdd + this.extraRoll, this.yaw.x + yAdd, this.pitch.x + pAdd);
    const sc = this.def.scale;
    m.scale.set(sc / Math.sqrt(sq), sc * sq, sc / Math.sqrt(sq));
    m.updateMatrixWorld();

    this._animParts(time, dt, e);
    this._swing(dt);
    for (const ch of this.chars) {
      if (ch.leanable) ch.lean = -this.roll.x * 0.35;
      ch.update(time);
    }
    this._updateCut();
    this._updateTrail(dt);
  }

  _swing(dt) {
    for (const s of this.swings) {
      const tx = -this.pitch.x - clamp(this.aF / G, -0.5, 0.5) * 1.2;
      const tz = (Math.sin(this.time * 0.9 + this.idx) * 0.03) * (this.phase === 'park' ? 0.3 : 1);
      s.o.rotation.z = s.x.step(tx * 0.85, dt);
      s.o.rotation.x = s.z.step(tz - this.roll.v * 0.08, dt);
    }
  }

  _animParts(t, dt, e) {
    for (const o of this.parts) {
      const u = o.userData;
      if (u.jet) { const s = 0.35 + e * (1.2 + Math.sin(t * 18) * 0.22); o.scale.set(s, 0.6 + e * 0.6, s); }
      if (u.steam) {
        const ph = (t * 0.6 + u.steam.i * 0.2) % 1;
        o.position.set(u.steam.x + ph * 2.0, u.steam.y + ph * 2.4, Math.sin(ph * 6 + u.steam.i) * 0.3);
        o.scale.setScalar(0.6 + ph * 1.0);
      }
      if (u.tentacle) {
        const ph = u.tentacle.ph;
        o.rotation.x = Math.sin(t * 1.5 + ph) * (0.15 + e * 0.1) + this.pitch.x * 0.2;
        o.rotation.z = Math.cos(t * 1.2 + ph) * (0.12 + e * 0.1) + clamp(this.aF / G, -0.3, 0.3) * 1.5 + e * 0.25;
      }
      if (u.leg) {
        const run = this.def.style === 'gallop' ? 6.5 : 5;
        o.rotation.z = Math.sin(t * run * (0.4 + e) + u.leg.ph) * 0.6 * (0.2 + e);
      }
      if (u.flap !== undefined) o.rotation.x = u.flap * (0.12 + Math.sin(t * (3 + e * 5)) * (0.15 + e * 0.35) + clamp(this.vel.y * 0.05, -0.2, 0.3));
      if (u.tailwag) o.rotation.y = Math.sin(t * (2.2 + e * 2)) * 0.38;
      if (u.bubble) {
        const b = u.bubble;
        if (b.float) { o.position.y += Math.sin(t * 1.3 + b.ph) * 0.003; o.rotation.y += dt * 0.4; o.rotation.x += dt * 0.25; }
        else o.position.y = b.y0 + (((t * (0.25 + e * 0.35)) + b.ph) % 1) * (b.y1 - b.y0);
      }
      if (u.spin) o.rotation.y += u.spin * (0.3 + e) * dt * 2;
      if (u.wheel) o.rotation.y += dt * (2 + e * 10);
      if (u.fluke) o.rotation.z = Math.sin(t * 1.3) * 0.32 * (0.4 + e);
      if (u.pulse) { const p = this._pulse || 0; o.scale.set(1 + p * 0.06, 1.05 * (1 - p * 0.1), 1 + p * 0.06); }
      if (u.spout && !u.spout.root) {
        const ph = ((t * 0.8 + u.spout.i * 0.12) % 1);
        const on = this.phase === 'cruise' ? 1 : 0.4;
        o.position.set(-ph * 0.6, Math.sin(ph * Math.PI) * 2.6 * on, Math.sin(u.spout.i * 2.3) * ph * 0.8);
        o.scale.setScalar((1 - ph) * on + 0.01);
      }
    }
  }

  setCut(on) {
    this.cutOn = on;
    for (const ch of this.chars) if (ch.upper) ch.root.visible = !on;
  }
  _updateCut() {
    if (!this.cut) return;
    const pl = this.cut.plane;
    if (!this.cutOn) { pl.normal.set(0, -1, 0); pl.constant = 1e6; return; }
    const n = _b.set(0, -1, 0).applyQuaternion(this.mesh.getWorldQuaternion(_q));
    const p = this.mesh.localToWorld(_c.set(0, this.cut.y, 0));
    pl.setFromNormalAndCoplanarPoint(n, p);
  }

  /** 舱内机位：返回世界坐标 */
  cabinPose(pos, look) {
    const c = this.mesh.userData.cabin;
    const node = c.node || this.mesh;
    node.updateWorldMatrix(true, false);
    node.localToWorld(pos.set(...c.pos));
    node.localToWorld(look.set(...c.look));
  }

  _updateTrail(dt) {
    const emit = (this.phase === 'depart' || this.phase === 'cruise' || this.phase === 'return') && this.v > 3;
    if (emit) {
      this.dist += this.v * dt;
      const gap = 1.6;
      const fwd = _b.set(Math.cos(this.yaw.x), 0, -Math.sin(this.yaw.x));
      while (this.dist > gap) {
        this.dist -= gap;
        const p = this.puffs[this.puffIdx];
        this.puffIdx = (this.puffIdx + 1) % TRAIL_N;
        p.p.copy(this.mesh.position).addScaledVector(fwd, -(this.length * 0.5 + 0.8));
        p.p.x += (Math.random() - 0.5) * 0.8; p.p.y += (Math.random() - 0.5) * 0.8; p.p.z += (Math.random() - 0.5) * 0.8;
        p.d.set((Math.random() - 0.5) * 0.4, 0.35 + Math.random() * 0.3, (Math.random() - 0.5) * 0.4);
        p.age = 0; p.life = 3.0 + Math.random() * 1.2;
        p.s = (0.7 + Math.random() * 0.6) * clamp(this.length / 8, 0.7, 1.6);
      }
    }
    const M = this._m4;
    for (let k = 0; k < TRAIL_N; k++) {
      const p = this.puffs[k];
      p.age += dt;
      const f = p.age / p.life;
      let s = 0;
      if (f < 1) {
        s = (f < 0.15 ? f / 0.15 : 1 - smooth(0.35, 1, f)) * p.s * (1 + f * 1.4);
        p.p.addScaledVector(p.d, dt);
      }
      M.makeScale(s, s * 0.85, s).setPosition(p.p);
      this.trail.setMatrixAt(k, M);
    }
    this.trail.instanceMatrix.needsUpdate = true;
  }

  /** 初始放置 */
  _place() {
    this.mesh.position.copy(this.home);
    this.mesh.rotation.set(0, this.pad.yaw, 0);
    this.mesh.updateMatrixWorld();
  }
}
