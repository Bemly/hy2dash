/* hy2dash 3D 空港：mihomoui 场景装配（天空/海/沙滩/棕榈/樱/车站/空港/铁路/小镇/上海/人物），
 * 底座文件原样拷贝、此处只做装配接线。场景逻辑与主站同构；数据层（用户↔飞船映射、
 * 面板、信息卡）由 skyui.js 负责，本文件只暴露 window.__sky 原语。
 * WebGL 失败则移除 canvas，回落 CSS 背景。 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { inkAll, AnimeFilterShader } from './toon.js';
import { PALETTE, buildSky, buildSea, buildBeach, buildPalms, shoreX, groundY } from './world.js';
import { buildStation, utilityPole, wire, signPost, MAT } from './airport.js';
import { buildCherryTree, buildPetalPatches, buildFallingPetals } from './cherry.js';
import { FLEET } from './craft.js';
import { buildSkyport, buildRailway, buildSkyDecor, buildRouteRing, STATE_TXT, latColor } from './skyport.js';
import { Flight } from './flight.js';
import { buildRoutes } from './routes.js';
import { buildShanghai, ORIGIN } from './shanghai.js';
import { buildTown, CUT_LEVELS } from './town.js';
import { buildBeachLife } from './beach.js';
import { Kit } from './interior.js';
import { bake } from './bake.js';

const canvas = document.getElementById('bg3d');
const loadT = document.getElementById('load-t');
const loadP = document.getElementById('load-p');
const frame = () => new Promise((r) => setTimeout(r, 16));
async function step(txt, p) {
  if (loadT) loadT.textContent = txt;
  if (loadP) loadP.style.width = p + '%';
  await frame();
}

try {
  await boot();
} catch (e) {
  console.warn('[bg3d] disabled:', (e && e.message) || e);
  canvas.remove();
  document.dispatchEvent(new Event('skyfailed'));
}

async function boot() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xd8eef9, 380, 2600);

  const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.3, 6000);
  const VIEWS = {
    port: { pos: new THREE.Vector3(-14, 40, 70), tgt: new THREE.Vector3(-72, 8, -18) },
    town: { pos: new THREE.Vector3(-18, 30, 18), tgt: new THREE.Vector3(52, 2, -52) },
    sh: { pos: ORIGIN.clone().add(new THREE.Vector3(420, 170, 300)), tgt: ORIGIN.clone().add(new THREE.Vector3(40, 50, -60)) },
  };
  const homePos = (v = VIEWS.port) => v.tgt.clone().add(v.pos.clone().sub(v.tgt).multiplyScalar(window.innerWidth < 760 ? 1.35 : 1));
  camera.position.copy(homePos());

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.localClippingEnabled = true;

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.target.copy(VIEWS.port.tgt);
  controls.minDistance = 3;
  controls.maxDistance = 1400;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.enableZoom = false; // 滚轮留给页面滚动
  controls.enablePan = false;

  const sun = new THREE.DirectionalLight(0xfff6e2, 2.5);
  const SUN_OFF = new THREE.Vector3(60, 90, 66).normalize().multiplyScalar(260);
  scene.add(sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 620;
  const SH = 110;
  sun.shadow.camera.left = -SH; sun.shadow.camera.right = SH;
  sun.shadow.camera.top = SH; sun.shadow.camera.bottom = -SH;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.04;
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xc4e6fa, 0xf0e6d0, 0.8));

  const housePlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
  const pearlPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
  const houseKit = new Kit({ planes: [housePlane] });

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

  await step('海边小镇…', 24);
  const town = buildTown(houseKit);
  scene.add(town.group);
  scene.add(town.trees);
  await step('海滩上的人们…', 40);
  const beachLife = buildBeachLife({ houseKit });
  scene.add(beachLife.group);

  await step('隔壁的上海…', 52);
  const sh = buildShanghai({ housePlane, pearlPlane });
  scene.add(sh);

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
    g.traverse((o) => { if (o.isMesh && !o.userData.isInk && !o.material.transparent) o.castShadow = true; });
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
    f.ring = ring; f.lat = null;
    flights.push(f);
    await step(`机体与乘客… ${def.name}`, 66 + i * 3);
  }
  thumbR.dispose();

  await step('合并静态网格…', 93);
  const keep = (o) => !!o.userData.keep;
  bake(station);
  port.pads.forEach((p) => bake(p.group, { keep }));
  bake(port.group, { keep: (o) => keep(o) || port.pads.some((p) => p.group === o) });
  bake(rail.group, { keep });
  beach.children.forEach((c) => { if (c.userData.sway) bake(c); });
  bake(beach, { keep: (o) => !!o.userData.sway });
  clouds.children.forEach((c) => bake(c));
  palms.children.forEach((c) => bake(c));
  cherries.children.forEach((c) => bake(c));
  town.trees.children.forEach((c) => bake(c));
  decor.islands.children.forEach((c) => bake(c));
  poles.forEach((p) => bake(p));

  await step('描线稿…', 95);
  inkAll(station, { color: PALETTE.ink, width: 0.0026 });
  inkAll(port.group, { color: PALETTE.ink, width: 0.0024 });
  inkAll(rail.group, { color: 0x8a6f98, width: 0.0022 });
  inkAll(beach, { color: 0x6f7f9c, width: 0.002 });
  inkAll(palms, { color: 0x4a5f78, width: 0.0028 });
  inkAll(cherries, { color: 0x8a6a94, width: 0.0026 });
  inkAll(town.trees, { color: 0x8a6a94, width: 0.0026 });
  inkAll(decor.islands, { color: 0x6a6f98, width: 0.0018 });
  inkAll(town.group, { color: PALETTE.ink, width: 0.0022 });
  inkAll(beachLife.group, { color: PALETTE.ink, width: 0.0024 });
  inkAll(sh, { color: 0x4a5878, width: 0.0016 });
  poles.forEach((p) => inkAll(p, { color: PALETTE.ink, width: 0.0022 }));
  inkAll(s1, { color: PALETTE.ink, width: 0.0022 });

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.18, 0.45, 0.985);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const anime = new ShaderPass(AnimeFilterShader);
  composer.addPass(anime);

  // ---- 对外原语（skyui.js 数据层调用） ----
  let selected = 0;
  let netMode = 'rule';
  let camMode = 'free';
  let camTween = null;
  const followOff = new THREE.Vector3();
  const toastFn = { fn: null };

  function tweenTo(pos, tgt, dur = 1.4) {
    camTween = { t: 0, dur, fp: camera.position.clone(), ft: controls.target.clone(), tp: pos.clone(), tgt: tgt.clone() };
  }
  const api = {
    flights, port, thumbs, FLEET, STATE_TXT, latColor, VIEWS, CUT_LEVELS,
    get selected() { return selected; },
    get netMode() { return netMode; },
    get camMode() { return camMode; },
    toast(fn) { toastFn.fn = fn; },
    say(msg) { if (toastFn.fn) toastFn.fn(msg); },
    select(i, focus = true) {
      selected = i;
      const f = flights[i];
      if (camMode === 'cabin') api.setCam('cabin');
      else if (focus && camMode === 'free') {
        const off = camera.position.clone().sub(controls.target);
        off.setLength(THREE.MathUtils.clamp(off.length(), f.length * 2 + 10, 70));
        tweenTo(f.mesh.position.clone().add(off), f.mesh.position);
      }
    },
    launch(i, quiet) {
      const f = flights[i];
      if (netMode === 'direct') { api.say('直连模式：今天走路去～'); return; }
      if (netMode === 'global') flights.forEach((o, k) => { if (k !== i) o.recall(); });
      if (!f.outbound) { f.launch(); if (!quiet) api.say(`${f.def.name} 从 GATE ${i + 1} 起飞`); }
    },
    recall(i, quiet) {
      const f = flights[i];
      if (f.outbound) { f.recall(); if (!quiet) api.say(`${f.def.name} 返航中，回 GATE ${i + 1}`); }
    },
    setMode(m) {
      netMode = m;
      if (m === 'direct') flights.forEach((f) => f.recall());
      if (m === 'global') flights.forEach((f) => { if (!f.outbound) f.launch(); });
    },
    setCut(level) {
      housePlane.constant = CUT_LEVELS[level];
      pearlPlane.constant = level ? sh.userData.pearl.pos.y + 2.4 : 1e6;
      flights.forEach((f) => f.setCut(level > 0));
    },
    goView(name) {
      const v = VIEWS[name];
      if (!v) return;
      if (api.camModePublic() !== 'free') api.setCam('free');
      tweenTo(homePos(v), v.tgt, name === 'sh' ? 2.6 : 1.6);
    },
    camModePublic() { return camMode; },
    setCam(mode) {
      if (camMode === 'cabin' && mode !== 'cabin') {
        camera.near = 0.3; camera.fov = window.innerWidth < 760 ? 56 : 38; camera.updateProjectionMatrix();
        controls.enabled = true;
        const f = flights[selected];
        tweenTo(f.mesh.position.clone().add(new THREE.Vector3(20, 12, 24)), f.mesh.position);
      }
      camMode = mode;
      if (mode === 'follow') {
        const f = flights[selected];
        const d = Math.max(18, f.length * 2.2);
        followOff.set(d * 0.8, d * 0.45, d * 0.8);
      }
      if (mode === 'cabin') {
        camTween = null;
        controls.enabled = false;
        camera.near = 0.05; camera.fov = 62; camera.updateProjectionMatrix();
        api.say(`坐进 ${flights[selected].def.name} 的舱里`);
      }
    },
    resetView() {
      api.setCam('free');
      tweenTo(homePos(), VIEWS.port.tgt, 1.6);
    },
    toggleFilter() {
      anime.enabled = !anime.enabled;
      return anime.enabled;
    },
    drawBoard(rows) {
      const now = new Date();
      const pad2 = (n) => String(n).padStart(2, '0');
      port.board.draw(rows, pad2(now.getHours()) + ':' + pad2(now.getMinutes()));
    },
    pingAllPads() { flights.forEach((_, i) => setTimeout(() => { port.pads[i].pingT = 0; }, i * 110)); },
    pingPad(i) { port.pads[i].pingT = 0; },
  };
  window.__sky = api;
  document.dispatchEvent(new Event('skyready'));

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downXY = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downXY = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downXY || Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 5) return;
    ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([...flights.map((f) => f.mesh), ...port.pads.map((p) => p.group)], true)[0];
    if (!hit) return;
    let o = hit.object;
    while (o && o.userData.craftId === undefined) o = o.parent;
    if (o && window.__skysel) window.__skysel(o.userData.craftId);
  });
  controls.addEventListener('start', () => { camTween = null; });

  function fitView() {
    const W = window.innerWidth, H = window.innerHeight, mobile = W < 760;
    camera.aspect = W / H;
    if (camMode !== 'cabin') camera.fov = mobile ? 56 : 38;
    if (mobile) camera.setViewOffset(W, H, 0, H * 0.24, W, H);
    else camera.setViewOffset(W, H, Math.min(180, W * 0.1), 0, W, H);
    camera.updateProjectionMatrix();
    renderer.setSize(W, H);
    composer.setSize(W, H);
    anime.uniforms.uAspect.value = W / H;
  }
  window.addEventListener('resize', fitView);
  fitView();

  const timer = new THREE.Timer();
  let lastT = 0, firstFrame = true;
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

    clouds.children.forEach((c) => {
      c.position.x += c.userData.drift * dt * 2.2;
      if (c.position.x > 1500) c.position.x = -2300;
    });
    const sway = (grp, amp) => grp.children.forEach((o) => { if (o.userData.sway) o.rotation.z = Math.sin(t * o.userData.sway) * amp; });
    sway(beach, 0.045);
    sway(palms, 0.026);
    cherries.children.forEach((tr, i) => { tr.rotation.z = Math.sin(t * 0.5 + i * 1.3) * 0.006; });
    decor.islands.children.forEach((is) => {
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
        const yaw = F.yaw.x;
        if (controls.__dragging) followOff.copy(camera.position).sub(controls.target).applyAxisAngle(_y, -yaw);
        const want = _p.copy(followOff).applyAxisAngle(_y, yaw).add(F.mesh.position);
        const k = 1 - Math.exp(-dt * 3);
        controls.target.lerp(F.mesh.position, 1 - Math.exp(-dt * 8));
        if (!controls.__dragging) camera.position.lerp(want, k);
      }
      controls.update();
    }
    sky.position.copy(camera.position);
    decor.moons.position.copy(camera.position);
    const tg = controls.target;
    sun.target.position.set(Math.round(tg.x / 16) * 16, 0, Math.round(tg.z / 16) * 16);
    sun.position.copy(sun.target.position).add(SUN_OFF);

    composer.render();
    if (firstFrame) {
      firstFrame = false;
      const l = document.getElementById('load');
      if (l) { l.style.opacity = '0'; setTimeout(() => l.remove(), 700); }
    }
    requestAnimationFrame(tick);
  }
  controls.addEventListener('start', () => { controls.__dragging = true; });
  controls.addEventListener('end', () => { controls.__dragging = false; });
  await step('完成', 100);
  tick();
}
