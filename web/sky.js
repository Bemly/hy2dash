/* hy2dash 空港：mihomoui 的全屏 3D 空港（场景模块原样复用）+ hy2dash 数据。
 * 一台飞船 = 一个机位 = 一位乘客；在线的人先上船（坐不下/离线的进候机名单），谁在线谁的飞船就起飞，
 * 在飞数量 = 在线人数。右侧「搭乗口」面板和场景里的出发牌都显示 飞船 ↔ 乘客。
 * 数据来自 /api/fleet：身份（昵称/头像/Steam 状态）大家互相可见；用量和流量只有本人和管理员能看。
 * 3D 起不来（无 WebGL 等）时退回控制台抽屉，面板功能不受影响。 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { inkAll, AnimeFilterShader } from './toon.js';
import { PALETTE, buildSky, buildSea, buildBeach, buildPalms } from './world.js';
import { buildStation, utilityPole, wire, signPost, MAT } from './airport.js';
import { buildCherryTree, buildPetalPatches, buildFallingPetals } from './cherry.js';
import { FLEET } from './craft.js';
import { buildSkyport, buildRailway, buildSkyDecor, buildRouteRing, STATE_TXT } from './skyport.js';
import { Flight } from './flight.js';
import { buildRoutes } from './routes.js';
import { buildShanghai, ORIGIN } from './shanghai.js';
import { buildTown, CUT_LEVELS } from './town.js';
import { buildBeachLife } from './beach.js';
import { Kit } from './interior.js';
import { bake } from './bake.js';

const $ = id => document.getElementById(id);
const BASE = location.pathname.replace(/\/[^/]*$/, '');
const frame = () => new Promise(r => setTimeout(r, 16));
async function step(txt, p) { $('load-t').textContent = txt; $('load-p').style.width = p + '%'; await frame(); }

const toastEl = $('toast');
let toastT;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.remove('show'), 2200);
}
window.hy2toast = toast;

function fail3d(e) {
  console.warn('[sky] 3D disabled:', e);
  $('load')?.remove();
  document.body.classList.add('no3d');
  $('err').textContent = '3D 场景没能启动：' + ((e && e.message) || e);
  window.hy2console?.open();
}
window.addEventListener('unhandledrejection', e => console.warn('[sky]', e.reason));

try {
  await boot();
} catch (e) {
  fail3d(e);
}

async function boot() {
  /* ======================== 渲染器 ======================== */
  const app = $('app');
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xd8eef9, 380, 2600);        // 空气透视（远处的上海会发蓝发白）

  const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.3, 6000);
  const VIEWS = {
    port: { pos: new THREE.Vector3(-14, 40, 70), tgt: new THREE.Vector3(-72, 8, -18) },
    town: { pos: new THREE.Vector3(-18, 30, 18), tgt: new THREE.Vector3(52, 2, -52) },
    sh:   { pos: ORIGIN.clone().add(new THREE.Vector3(420, 170, 300)), tgt: ORIGIN.clone().add(new THREE.Vector3(40, 50, -60)) },
  };
  const homePos = (v = VIEWS.port) => v.tgt.clone().add(v.pos.clone().sub(v.tgt).multiplyScalar(innerWidth < 760 ? 1.35 : 1));
  camera.position.copy(homePos());

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.localClippingEnabled = true;                    // 剖切内饰
  app.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.target.copy(VIEWS.port.tgt);
  controls.minDistance = 3;
  controls.maxDistance = 1400;
  controls.maxPolarAngle = Math.PI * 0.49;

  /* ======================== 光照（阴影跟着视线走） ======================== */
  const sun = new THREE.DirectionalLight(0xfff6e2, 2.5);
  const SUN_OFF = new THREE.Vector3(60, 90, 66).normalize().multiplyScalar(260);
  scene.add(sun.target);
  sun.castShadow = true;
  const shadowPx = Math.min(innerWidth < 760 ? 2048 : 4096, renderer.capabilities.maxTextureSize);
  sun.shadow.mapSize.set(shadowPx, shadowPx);
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 620;
  const SH = 110;
  sun.shadow.camera.left = -SH; sun.shadow.camera.right = SH;
  sun.shadow.camera.top = SH;  sun.shadow.camera.bottom = -SH;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.04;
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xc4e6fa, 0xf0e6d0, 0.8));

  /* ======================== 剖切平面 ======================== */
  const housePlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
  const pearlPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
  const houseKit = new Kit({ planes: [housePlane] });

  /* ======================== 场景装配 ======================== */
  await step('天空与大海…', 5);
  const { sky, clouds } = buildSky(scene);
  const { mat: seaMat } = buildSea(scene, scene.fog);
  const beach = buildBeach(scene);
  const palms = buildPalms(scene, 12);
  const decor = buildSkyDecor(scene);

  await step('车站与空港…', 12);
  const station = buildStation();
  const found = new THREE.Mesh(new THREE.BoxGeometry(46, 3, 11), MAT.concrete());
  found.position.y = -1.5; found.receiveShadow = true; station.add(found);
  scene.add(station);
  const port = buildSkyport(FLEET);
  scene.add(port.group);
  const rail = buildRailway();
  scene.add(rail.group);

  await step('海边小镇（每家都有内饰）…', 24);
  const town = buildTown(houseKit);
  scene.add(town.group);
  scene.add(town.trees);
  await step('海滩上的人们…', 40);
  const beachLife = buildBeachLife({ houseKit });
  scene.add(beachLife.group);

  await step('隔壁的上海…', 52);
  const sh = buildShanghai({ housePlane, pearlPlane });
  scene.add(sh);

  // 樱花：沿铁路一排
  const cherries = new THREE.Group();
  for (let x = 32; x < 170; x += 11) {
    const t = buildCherryTree(8 + ((x / 11) % 3) * 1.4, 5.2 + ((x / 11) % 2) * 0.8);
    t.position.set(x, 0, 15.5 + ((x / 11) % 2) * 4);
    t.rotation.y = x * 0.37;
    cherries.add(t);
  }
  scene.add(cherries);
  scene.add(buildPetalPatches(26));
  const petals = buildFallingPetals(900, { x: [-70, 110], y: [0, 28], z: [-120, 90] });
  scene.add(petals.points);

  const poles = [];
  for (let i = 0; i < 12; i++) {
    const p = utilityPole(11 + (i % 2));
    p.position.set(50, 0, -120 + i * 17);
    if (Math.abs(p.position.z - 7.6) < 6) continue;
    scene.add(p); poles.push(p);
  }
  for (let i = 0; i < poles.length - 1; i++) {
    const a = poles[i].position, b = poles[i + 1].position;
    const h = 11 + (i % 2);
    for (const dx of [-1.1, 0, 1.1]) scene.add(wire(new THREE.Vector3(a.x + dx, h - 0.5, a.z), new THREE.Vector3(b.x + dx, h - 0.5, b.z), 1.8));
  }
  const s1 = signPost(); s1.position.set(46.5, 0, -6); scene.add(s1);

  /* ======================== 机队 ======================== */
  await step('机体与乘客…', 66);
  const routes = buildRoutes(FLEET, sh.userData.landmarks);
  const thumbR = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  thumbR.setSize(128, 128); thumbR.setPixelRatio(1); thumbR.outputColorSpace = THREE.SRGBColorSpace;
  const thumbS = new THREE.Scene();
  const tl = new THREE.DirectionalLight(0xfff6e2, 2.5); tl.position.set(3, 6, 5); thumbS.add(tl);
  thumbS.add(new THREE.HemisphereLight(0xc4e6fa, 0xf0e6d0, 0.8));
  const thumbCam = new THREE.PerspectiveCamera(30, 1, 0.1, 400);
  const thumbs = [];
  const flights = [];
  for (let i = 0; i < FLEET.length; i++) {
    const def = FLEET[i];
    const g = def.build();
    inkAll(g, { color: PALETTE.ink, width: 0.0034 });
    g.traverse(o => { if (o.isMesh && !o.userData.isInk && !o.material.transparent) o.castShadow = true; });
    // 缩略图
    g.rotation.y = -0.6; thumbS.add(g);
    const sph = new THREE.Box3().setFromObject(g).getBoundingSphere(new THREE.Sphere());
    thumbCam.position.copy(sph.center).add(new THREE.Vector3(0.5, 0.42, 1).normalize().multiplyScalar(sph.radius * 3.3));
    thumbCam.lookAt(sph.center);
    thumbR.render(thumbS, thumbCam);
    thumbs.push(thumbR.domElement.toDataURL());
    thumbS.remove(g); g.rotation.y = 0;

    g.userData.craftId = i;
    scene.add(g);
    const f = new Flight(def, g, port.pads[i], i, scene, routes[i]);
    port.pads[i].group.userData.craftId = i;
    const ring = buildRouteRing(def.color);
    const P = new THREE.Vector3(), T = new THREE.Vector3();
    routes[i].sample(routes[i].nearest(routes[i].anchor), P, T);
    ring.position.copy(P); ring.lookAt(P.clone().add(T)); ring.scale.setScalar(1.6);
    inkAll(ring, { color: PALETTE.ink, width: 0.0022 });
    scene.add(ring);
    f.ring = ring;
    flights.push(f);
    await step(`机体与乘客… ${def.name}`, 66 + i * 3);
  }
  thumbR.dispose();
  thumbR.forceContextLoss();

  /* ======================== 合并静态网格（面数不变，只减 draw call） ======================== */
  await step('合并静态网格…', 93);
  const keep = o => !!o.userData.keep;
  bake(station);
  port.pads.forEach(p => bake(p.group, { keep }));
  bake(port.group, { keep: o => keep(o) || port.pads.some(p => p.group === o) });
  bake(rail.group, { keep });
  beach.children.forEach(c => { if (c.userData.sway) bake(c); });
  bake(beach, { keep: o => !!o.userData.sway });
  clouds.children.forEach(c => bake(c));
  palms.children.forEach(c => bake(c));
  cherries.children.forEach(c => bake(c));
  town.trees.children.forEach(c => bake(c));
  decor.islands.children.forEach(c => bake(c));
  poles.forEach(p => bake(p));

  /* ======================== 描边 ======================== */
  await step('描线稿…', 95);
  inkAll(station, { color: PALETTE.ink, width: 0.0026 });
  inkAll(port.group, { color: PALETTE.ink, width: 0.0024 });
  inkAll(rail.group, { color: PALETTE.ink, width: 0.0022 });
  inkAll(beach, { color: 0x6f7f9c, width: 0.002 });
  inkAll(palms, { color: 0x4a5f78, width: 0.0028 });
  inkAll(cherries, { color: 0x8a6a94, width: 0.0026 });
  inkAll(town.trees, { color: 0x8a6a94, width: 0.0026 });
  inkAll(decor.islands, { color: 0x6a6f98, width: 0.0018 });
  inkAll(town.group, { color: PALETTE.ink, width: 0.0022 });
  inkAll(beachLife.group, { color: PALETTE.ink, width: 0.0024 });
  inkAll(sh, { color: 0x4a5878, width: 0.0016 });
  poles.forEach(p => inkAll(p, { color: PALETTE.ink, width: 0.0022 }));
  inkAll(s1, { color: PALETTE.ink, width: 0.0022 });

  /* ======================== 后期：泛光 + 二次元滤镜 ======================== */
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.18, 0.45, 0.985);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const anime = new ShaderPass(AnimeFilterShader);
  composer.addPass(anime);

  /* ======================== 数据：机位 ↔ 乘客 ======================== */
  const N = flights.length;
  const gates = new Array(N).fill(null);     // gates[i] = 乘客 | null
  const rate = new Map();                    // 乘客 key -> { rx, t, bps }
  let waiting = [], mePax = null;            // 候机名单 / 我自己
  let isAdmin = false, onlineN = 0, paxN = 0, dataVer = 0, firstSync = true, lastFleetOK = 0;

  const paxKey = p => p.hy_user || 'n' + p.n;
  const paxName = p => !p ? '' : (p.nick || p.hy_user || '乘客') + (p.guest && p.hy_user ? ' · 直连' : '');
  const fmtBytes = v => {
    v = Number(v) || 0;
    if (v < 1024) return v + ' B';
    const u = ['K', 'M', 'G', 'T'];
    let i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
    return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + u[i];
  };
  const fmtRate = b => b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB/s' : b >= 1e3 ? (b / 1e3).toFixed(0) + ' KB/s' : Math.round(b) + ' B/s';
  const steamTxt = p => !p ? '' : p.steam_state === 'in-game' ? `Steam 游戏中 · ${p.game || '游戏'}`
    : p.steam_state === 'online' ? 'Steam 在线' : p.steam_state === 'offline' ? 'Steam 离线' : '';
  const flying = p => !!(p && p.enabled && p.online > 0);
  const bps = p => (p && p.full && flying(p) && rate.get(paxKey(p))?.bps) || 0;

  function syncFlights() {
    let k = 0;
    flights.forEach((f, i) => {
      const want = flying(gates[i]);
      if (want && !f.outbound) {
        // 依次起飞，别一窝蜂
        setTimeout(() => { if (flying(gates[i]) && !f.outbound) { f.launch(); port.pads[i].pingT = 0; } }, k++ * 420);
        if (!firstSync) toast(`${paxName(gates[i])} 上线 · ${f.def.name} 从 GATE ${i + 1} 起飞`);
      } else if (!want && f.outbound) {
        f.recall();
        if (!firstSync) toast(`${f.def.name} 返航，回 GATE ${i + 1}`);
      }
    });
    firstSync = false;
  }

  async function loadFleet(force) {
    if (document.hidden && !force) return;
    let d;
    try {
      const r = await fetch(BASE + '/api/fleet', { credentials: 'same-origin' });
      if (r.status === 401) { location.href = BASE + '/login'; return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      d = await r.json();
    } catch (e) { return; }                 // 下一轮重试
    const now = performance.now() / 1000;
    isAdmin = d.role === 'admin';
    const list = d.pax || [];
    // 累计流量后端 30s 才刷新一次：用"上次变化到这次变化"的间隔算平均速率
    for (const p of list) {
      if (!p.full) continue;
      const k = paxKey(p), rx = p.rx || 0, o = rate.get(k);
      if (!o) rate.set(k, { rx, t: now, bps: 0 });
      else if (rx !== o.rx) { o.bps = rx > o.rx ? (rx - o.rx) / Math.max(1, now - o.t) : 0; o.rx = rx; o.t = now; }
      else if (now - o.t > 75) o.bps = 0;
    }
    // 机位由后端排（在线优先，可自选），这里只按 gate 摆放；gate=0 的在候机
    for (let i = 0; i < N; i++) gates[i] = list.find(p => p.gate === i + 1) || null;
    waiting = list.filter(p => !(p.gate >= 1 && p.gate <= N));
    mePax = list.find(p => p.me) || null;
    paxN = list.filter(p => !p.guest).length;
    onlineN = list.filter(flying).length;
    lastFleetOK = now;
    dataVer++;
    syncFlights();
    refreshUI(true);
  }

  /* ======================== 交互状态 ======================== */
  let selected = 0;
  let filter = 'all';            // all | fly | park
  let camMode = 'free';          // free | follow | cabin
  let camTween = null;
  const followOff = new THREE.Vector3();

  function tweenTo(pos, tgt, dur = 1.4) {
    camTween = { t: 0, dur, fp: camera.position.clone(), ft: controls.target.clone(), tp: pos.clone(), tgt: tgt.clone() };
  }
  function setCam(mode) {
    if (camMode === 'cabin' && mode !== 'cabin') {
      camera.near = 0.3; camera.fov = innerWidth < 760 ? 56 : 38; camera.updateProjectionMatrix();
      controls.enabled = true;
      const f = flights[selected];
      tweenTo(f.mesh.position.clone().add(new THREE.Vector3(20, 12, 24)), f.mesh.position);
    }
    camMode = mode;
    $('i-follow').classList.toggle('on', mode === 'follow');
    $('i-cabin').classList.toggle('on', mode === 'cabin');
    if (mode === 'follow') {
      const f = flights[selected];
      const d = Math.max(18, f.length * 2.2);
      followOff.set(d * 0.8, d * 0.45, d * 0.8);
    }
    if (mode === 'cabin') {
      camTween = null;
      controls.enabled = false;
      camera.near = 0.05; camera.fov = 62; camera.updateProjectionMatrix();
      toast(`坐进 ${flights[selected].def.name} 的舱里`);
      if (gates[selected]?.full) openCabin(true);              // 进自己的机舱就能看到流量
    }
  }

  // 机舱流量：自己的飞船（管理员任意一艘有乘客的）
  function openCabin(quiet) {
    const P = gates[selected];
    if (!P || !P.full) {
      if (!quiet) toast(P ? '只能查看自己飞船的流量' : '这个机位还没有乘客');
      window.hy2cabin?.close();
      return;
    }
    window.hy2cabin?.open({ user: isAdmin ? P.hy_user : '', title: `${paxName(P)} · ${flights[selected].def.name}` });
  }

  function select(i, focus = true) {
    const changed = i !== selected;
    selected = i;
    const f = flights[i];
    $('i-thumb').innerHTML = `<img src="${thumbs[i]}" alt="">`;
    $('i-thumb').style.setProperty('--c', '#' + f.def.color.toString(16).padStart(6, '0'));
    if (camMode === 'cabin') setCam('cabin');
    else if (focus && camMode === 'free') {
      const off = camera.position.clone().sub(controls.target);
      off.setLength(THREE.MathUtils.clamp(off.length(), f.length * 2 + 10, 70));
      tweenTo(f.mesh.position.clone().add(off), f.mesh.position);
    }
    refreshUI(true);
    if (changed && window.hy2cabin?.isOpen) openCabin(true);   // 面板跟着换到新选中的飞船
  }

  function setCut(level) {
    document.querySelectorAll('#cut button').forEach(b => b.classList.toggle('on', +b.dataset.c === level));
    housePlane.constant = CUT_LEVELS[level];
    pearlPlane.constant = level ? sh.userData.pearl.pos.y + 2.4 : 1e6;
    flights.forEach(f => f.setCut(level > 0));
    if (level) toast(level === 1 ? '揭顶：屋顶和机舱顶盖拿掉了，看二楼和舱内' : '剖面：切到一楼，看客厅和厨房');
  }
  function setFilter(m) {
    filter = m;
    document.querySelectorAll('#seg button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
    refreshUI(true);
  }

  /* ======================== 搭乗口面板 ======================== */
  const list = $('list');
  const rows = flights.map((f, i) => {
    const row = document.createElement('div');
    row.className = 'gate';
    row.innerHTML = `
      <div class="thumb" style="--c:#${f.def.color.toString(16).padStart(6, '0')}"><img src="${thumbs[i]}" alt=""><i>G${i + 1}</i></div>
      <div class="mid">
        <div class="nm"><img class="av" alt="" hidden><span></span><em hidden>我</em></div>
        <div class="meta"><span class="st">停泊中</span><span class="craft"></span></div>
      </div>
      <div class="right"><div class="lat">—</div><div class="use"></div></div>`;
    row.onclick = () => select(i);
    list.appendChild(row);
    return {
      row, av: row.querySelector('.av'), nm: row.querySelector('.nm span'), mine: row.querySelector('.nm em'),
      st: row.querySelector('.st'), craft: row.querySelector('.craft'),
      lat: row.querySelector('.lat'), use: row.querySelector('.use'),
    };
  });
  const empty = document.createElement('div');
  empty.className = 'list-empty';
  list.appendChild(empty);
  const waitBox = document.createElement('div');
  waitBox.className = 'waiting';
  list.appendChild(waitBox);
  let waitVer = -1;
  function renderWaiting() {
    if (waitVer === dataVer) return;
    waitVer = dataVer;
    waitBox.textContent = '';
    waitBox.hidden = !waiting.length;
    if (!waiting.length) return;
    const h = document.createElement('div');
    h.className = 'wait-h';
    h.textContent = `候机 · ${waiting.length} 人`;
    waitBox.appendChild(h);
    for (const p of waiting) {
      const el = document.createElement('div');
      el.className = 'wait';
      if (/^https:\/\//.test(p.avatar || '')) {
        const im = document.createElement('img');
        im.className = 'av ' + (p.steam_state || '');
        im.alt = ''; im.src = p.avatar;
        el.appendChild(im);
      }
      const nm = document.createElement('span');
      nm.className = 'wn';
      nm.textContent = paxName(p) + (p.me ? '（我）' : '');
      const st = document.createElement('span');
      st.className = 'ws' + (flying(p) ? ' live' : '');
      st.textContent = !p.enabled ? '已停用' : flying(p) ? '在线 · 等空位' : p.steam_state === 'in-game' ? '正在玩 ' + (p.game || '游戏') : '离线';
      el.append(nm, st);
      waitBox.appendChild(el);
    }
  }
  // 自选机位：我在线，且这艘船空着或船上的人离线
  const canSit = i => !!(mePax && flying(mePax) && mePax.gate !== i + 1 && !flying(gates[i]));
  async function sitHere() {
    const i = selected;
    try {
      const r = await fetch(BASE + '/api/my/gate', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gate: i + 1 }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
      toast(`换乘 ${flights[i].def.name} · GATE ${i + 1}`);
      await loadFleet(true);
    } catch (e) { toast(e.message); }
  }

  const ST_CLS = { park: '', up: 'up', go: 'fly', cruise: 'fly', back: 'ret', down: 'ret' };
  function stateOf(f, p) {
    if (!p) return ['空位', 'off'];
    if (!p.enabled) return ['已停用', 'off'];
    if (f.mode === 'park' && p.full && p.state === 'monthly') return ['月额已满', 'off'];
    if (f.mode === 'park' && p.full && p.state === 'daily') return ['待续额', 'up'];
    return [STATE_TXT[f.mode][0], ST_CLS[f.mode]];
  }

  let lastSig = '';
  function refreshUI(force) {
    const sig = flights.map(f => f.mode).join() + selected + filter + dataVer;
    if (!force && sig === lastSig) return;
    lastSig = sig;
    let n = 0, shown = 0;
    flights.forEach((f, i) => {
      const r = rows[i], p = gates[i];
      const [txt, cls] = stateOf(f, p);
      r.row.classList.toggle('on', i === selected);
      r.row.classList.toggle('vacant', !p);
      r.nm.textContent = p ? paxName(p) : f.def.name;
      r.mine.hidden = !(p && p.me);
      const av = p && /^https:\/\//.test(p.avatar || '') ? p.avatar : '';
      if (av && r.av.getAttribute('src') !== av) r.av.src = av;
      r.av.hidden = !av;
      r.av.className = 'av ' + ((p && p.steam_state) || '');
      r.st.textContent = txt;
      r.st.className = 'st ' + cls;
      r.craft.textContent = p
        ? [p.steam_state === 'in-game' ? '正在玩 ' + (p.game || '游戏') : '', f.def.name,
          p.full && p.hy_user && p.nick ? p.hy_user : '', p.online > 1 ? p.online + ' 台设备' : ''].filter(Boolean).join(' · ')
        : '等待乘客';
      const b = bps(p);
      r.lat.textContent = !p ? '—' : flying(p) ? (p.full ? '↓ ' + fmtRate(b) : '在线') : '离线';
      r.lat.className = 'lat' + (flying(p) ? ' live' : '');
      r.use.textContent = p && p.full && !p.guest ? `今日 ${fmtBytes(p.day_used)}` : '';
      if (f.airborne) n++;
      const vis = filter === 'all' || (filter === 'fly' ? f.airborne : !f.airborne);
      r.row.hidden = !vis;
      if (vis) shown++;
    });
    renderWaiting();
    $('i-sit').hidden = !canSit(selected);
    $('i-sit').textContent = `坐这艘 · ${flights[selected].def.name}`;
    empty.hidden = shown > 0;
    empty.textContent = filter === 'fly' ? '现在没有人在线，飞船都停在机位上' : '所有飞船都在天上';
    $('b-fly').textContent = `${n} / ${N} 在飞`;
    $('b-fly').classList.toggle('hot', n > 0);
    $('g-meta').textContent = lastFleetOK
      ? `${onlineN} 人在线 · ${paxN} 位乘客 · ${N} 个机位` + (waiting.length ? ` · ${waiting.length} 人候机` : '')
      : '正在联络塔台…';

    const F = flights[selected], P = gates[selected];
    $('i-name').textContent = P ? paxName(P) : F.def.name;
    $('i-sub').textContent = `GATE ${selected + 1} · ${F.def.name}${P ? '' : ' · 空位'} · → ${F.def.dest}`;
    $('i-day').textContent = P && P.full && !P.guest ? `${fmtBytes(P.day_used)} / ${fmtBytes(P.daily_quota)}` : '—';
    $('i-mon').textContent = P && P.full && !P.guest ? `${fmtBytes(P.mon_used)} / ${fmtBytes(P.mon_quota)}` : '—';
    $('i-dn').textContent = P && P.full ? fmtRate(bps(P)) : '—';
    const stm = steamTxt(P);
    $('i-steam').textContent = stm;
    $('i-steam').hidden = !stm;
    $('i-steam').className = 'i-steam ' + ((P && P.steam_state) || '');
    const bio = (P && P.summary) || '';
    $('i-bio').textContent = bio;
    $('i-bio').hidden = !bio;
    $('i-traffic').classList.toggle('dim', !(P && P.full));
  }

  document.querySelectorAll('#seg button').forEach(b => b.onclick = () => setFilter(b.dataset.m));
  document.querySelectorAll('#cut button').forEach(b => b.onclick = () => setCut(+b.dataset.c));
  document.querySelectorAll('#loc button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#loc button').forEach(x => x.classList.toggle('on', x === b));
    if (camMode !== 'free') setCam('free');
    const v = VIEWS[b.dataset.l];
    tweenTo(homePos(v), v.tgt, b.dataset.l === 'sh' ? 2.6 : 1.6);
  });
  $('i-sit').onclick = sitHere;
  $('i-traffic').onclick = () => (window.hy2cabin?.isOpen ? window.hy2cabin.close() : openCabin());
  $('i-follow').onclick = () => setCam(camMode === 'follow' ? 'free' : 'follow');
  $('i-cabin').onclick = () => setCam(camMode === 'cabin' ? 'free' : 'cabin');
  $('i-view').onclick = () => {
    setCam('free');
    document.querySelectorAll('#loc button').forEach(x => x.classList.toggle('on', x.dataset.l === 'port'));
    tweenTo(homePos(), VIEWS.port.tgt, 1.6);
  };
  $('i-fx').onclick = () => {
    anime.enabled = !anime.enabled;
    $('i-fx').classList.toggle('on', anime.enabled);
    toast(anime.enabled ? '二次元滤镜：开' : '二次元滤镜：关（原始渲染）');
  };
  $('a-mine').onclick = () => {
    const i = gates.findIndex(p => p && p.me);
    if (i >= 0) select(i);
  };
  controls.addEventListener('start', () => { camTween = null; controls.__dragging = true; });
  controls.addEventListener('end', () => { controls.__dragging = false; });

  /* ---------- 点击场景里的机体 / 停机坪 ---------- */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downXY = null;
  renderer.domElement.addEventListener('pointerdown', e => { downXY = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!downXY || Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 5) return;
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([...flights.map(f => f.mesh), ...port.pads.map(p => p.group)], true)[0];
    if (!hit) return;
    let o = hit.object;
    while (o && o.userData.craftId === undefined) o = o.parent;
    if (o) select(o.userData.craftId);
  });

  setFilter('all');
  await loadFleet(true);
  // 默认看自己的船；管理员看第一艘在飞的
  const mine = gates.findIndex(p => p && p.me);
  const firstUp = gates.findIndex(flying);
  select(mine >= 0 ? mine : firstUp >= 0 ? firstUp : 0, false);
  $('a-mine').hidden = mine < 0;
  setInterval(() => loadFleet(), 3000);
  document.addEventListener('visibilitychange', () => loadFleet());

  /* ======================== 循环 ======================== */
  function fitView() {
    const W = innerWidth, H = innerHeight, mobile = W < 760;
    camera.aspect = W / H;
    if (camMode !== 'cabin') camera.fov = mobile ? 56 : 38;
    if (mobile) camera.setViewOffset(W, H, 0, H * 0.24, W, H);
    else camera.setViewOffset(W, H, Math.min(180, W * 0.1), 0, W, H);
    camera.updateProjectionMatrix();
    renderer.setSize(W, H);
    composer.setSize(W, H);
    anime.uniforms.uAspect.value = W / H;
  }
  addEventListener('resize', fitView);
  fitView();

  const timer = new THREE.Timer();
  let lastT = 0, uiClock = 0;
  const pad2 = n => String(n).padStart(2, '0');
  const _p = new THREE.Vector3(), _l = new THREE.Vector3(), _y = new THREE.Vector3(0, 1, 0);

  function tick() {
    timer.update();
    const t = timer.getElapsed();
    const dt = Math.min(0.05, t - lastT || 0.016);
    lastT = t;

    seaMat.uniforms.t.value = t;
    anime.uniforms.uTime.value = t;
    petals.update(dt, t);
    rail.update(t, dt);
    beachLife.update(t);
    sh.userData.update(t, dt);

    clouds.children.forEach(c => {
      c.position.x += c.userData.drift * dt * 2.2;
      if (c.position.x > 1500) c.position.x = -2300;
    });
    const sway = (grp, amp) => grp.children.forEach(o => { if (o.userData.sway) o.rotation.z = Math.sin(t * o.userData.sway) * amp; });
    sway(beach, 0.045);
    sway(palms, 0.026);
    cherries.children.forEach((tr, i) => { tr.rotation.z = Math.sin(t * 0.5 + i * 1.3) * 0.006; });
    decor.islands.children.forEach(is => {
      is.position.y = is.userData.bob.y + Math.sin(t * 0.4 + is.userData.bob.ph) * 1.6;
      is.rotation.y += dt * 0.02;
    });
    port.tower.halo.rotation.z += dt * 0.5;
    port.tower.radar.rotation.y += dt * 1.4;

    flights.forEach((f, i) => {
      f.update(dt, t);
      const pad = port.pads[i];
      pad.sel.visible = i === selected;
      pad.sel.rotation.y += dt * 0.5;
      const on = Math.floor(t * (f.airborne ? 9 : 3) + i) % pad.bulbs.length;
      pad.bulbs.forEach((b, k) => b.scale.setScalar(k === on ? 1.7 : 1));
      if (pad.pingT >= 0) {
        pad.pingT += dt;
        const k = pad.pingT / 0.9;
        pad.ping.scale.setScalar(1 + k * 1.3);
        pad.ping.material.opacity = Math.max(0, 1 - k) * 0.85;
        if (k >= 1) { pad.pingT = -1; pad.ping.material.opacity = 0; }
      }
      const ringOn = f.mode === 'cruise' ? 1 : 0;
      f.ring.userData.spin.rotation.z += dt * (0.4 + ringOn * 2.2);
      const rs = f.ring.scale.x + ((1.45 + ringOn * 0.4) - f.ring.scale.x) * Math.min(1, dt * 3);
      f.ring.scale.setScalar(rs);
    });

    // ---- 镜头 ----
    const F = flights[selected];
    if (camMode === 'cabin') {
      F.cabinPose(_p, _l);
      camera.position.copy(_p);
      camera.up.copy(_y.set(0, 1, 0).applyQuaternion(F.mesh.quaternion).lerp(new THREE.Vector3(0, 1, 0), 0.6).normalize());
      camera.lookAt(_l);
      controls.target.copy(_l);
    } else {
      camera.up.set(0, 1, 0);
      if (camTween) {
        camTween.t += dt / camTween.dur;
        const k = camTween.t >= 1 ? 1 : 1 - Math.pow(1 - camTween.t, 3);
        if (camMode === 'follow') { camTween.tgt.copy(F.mesh.position); }
        camera.position.lerpVectors(camTween.fp, camTween.tp, k);
        controls.target.lerpVectors(camTween.ft, camTween.tgt, k);
        if (camTween.t >= 1) camTween = null;
      } else if (camMode === 'follow') {
        // 追尾机位：偏移量跟着机头转，用户拖拽时更新偏移
        const yaw = F.yaw.x;
        if (controls.__dragging) followOff.copy(camera.position).sub(controls.target).applyAxisAngle(_y, -yaw);
        const want = _p.copy(followOff).applyAxisAngle(_y, yaw).add(F.mesh.position);
        const k = 1 - Math.exp(-dt * 3);
        controls.target.lerp(F.mesh.position, 1 - Math.exp(-dt * 8));
        if (!controls.__dragging) camera.position.lerp(want, k);
      }
      controls.update();
    }
    // 天空跟着相机；阴影视锥跟着视线目标
    sky.position.copy(camera.position);
    decor.moons.position.copy(camera.position);
    const tg = controls.target;
    sun.target.position.set(Math.round(tg.x / 16) * 16, 0, Math.round(tg.z / 16) * 16);
    sun.position.copy(sun.target.position).add(SUN_OFF);

    uiClock += dt;
    if (uiClock > 0.2) {
      uiClock = 0;
      refreshUI();
      const P = gates[selected];
      $('i-state').textContent = stateOf(F, P)[0];
      $('i-alt').textContent = Math.max(0, Math.round((F.mesh.position.y - F.home.y) * 1.1)) + ' m';
      $('i-spd').textContent = Math.round(F.speed * 3.6 * 1.1) + ' km/h';
      const now = new Date();
      // 出发牌：GATE / 机体 / 乘客 / 状态 / 下行
      port.board.draw(flights.map((o, i) => {
        const p = gates[i], b = bps(p);
        return {
          gate: i + 1, name: o.def.name, dest: p ? paxName(p) : '— 空位 —', mode: o.mode,
          color: '#' + o.def.color.toString(16).padStart(6, '0'),
          tail: !p ? '' : !flying(p) ? '—' : p.full ? (b >= 1e6 ? (b / 1e6).toFixed(1) + 'M/s' : Math.round(b / 1e3) + 'K/s') : '在线',
          tailColor: flying(p) ? '#7ee8a8' : '#6c7f9c',
        };
      }), pad2(now.getHours()) + ':' + pad2(now.getMinutes()));
    }

    composer.render();
    requestAnimationFrame(tick);
  }
  await step('完成', 100);
  tick();

  const load = $('load');
  load.style.opacity = '0';
  setTimeout(() => load.remove(), 700);
}
