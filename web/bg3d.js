/* hy2dash 3D 背景：复用 mihomoui 场景文件（天空/海/沙滩/棕榈/樱瓣/空港/铁路），纯环境展示。
 * 底座文件原样拷贝、此处不修改；只有天空、海、沙滩、棕榈、樱、空港、铁路，不含人物/内饰/小镇。
 * WebGL 失败则静默移除 canvas，回落到 CSS 渐变背景。 */
import * as THREE from 'three';
import { buildSky, buildSea, buildBeach, buildPalms } from './world.js';
import { buildPetalPatches, buildFallingPetals } from './cherry.js';
import { buildSkyport, buildRailway, buildSkyDecor } from './skyport.js';
import { FLEET } from './craft.js';
import { bake } from './bake.js';

const canvas = document.getElementById('bg3d');
if (!canvas) throw new Error('no bg canvas');

try {
  init();
} catch (e) {
  console.warn('[bg3d] disabled:', e && e.message);
  canvas.remove();
}

function init() {
  const reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xd8eef9, 380, 2600);

  const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.3, 6000);
  const tgt = new THREE.Vector3(-72, 8, -18);
  const basePos = new THREE.Vector3(-14, 40, 70);
  const pull = window.innerWidth < 760 ? 1.35 : 1;
  camera.position.copy(tgt).add(basePos.clone().sub(tgt).multiplyScalar(pull));
  camera.lookAt(tgt);

  const sun = new THREE.DirectionalLight(0xfff6e2, 2.5);
  sun.position.set(60, 90, 66).normalize().multiplyScalar(260);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 620;
  const SH = 110;
  sun.shadow.camera.left = -SH;
  sun.shadow.camera.right = SH;
  sun.shadow.camera.top = SH;
  sun.shadow.camera.bottom = -SH;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.04;
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xc4e6fa, 0xf0e6d0, 0.8));

  const { clouds } = buildSky(scene);
  const { mat: seaMat } = buildSea(scene, scene.fog);
  const beach = buildBeach(scene);
  const palms = buildPalms(scene, 12);
  buildSkyDecor(scene);
  const keep = () => false;
  const port = buildSkyport(FLEET);
  scene.add(port.group);
  const rail = buildRailway();
  scene.add(rail.group);
  scene.add(buildPetalPatches(18));
  const petals = buildFallingPetals(450, { x: [-70, 110], y: [0, 28], z: [-120, 90] });
  scene.add(petals.points);

  // 静态合并（摇摆部件保留），与 mihomoui 主站同策略
  beach.children.forEach((c) => { if (c.userData.sway) bake(c); });
  bake(beach, { keep: (o) => !!o.userData.sway });
  bake(port.group, { keep });
  bake(rail.group, { keep });
  clouds.children.forEach((c) => bake(c));
  palms.children.forEach((c) => bake(c));

  const clock = new THREE.Clock();
  let angle = 0;
  const orbitR = basePos.clone().sub(tgt).length();
  const orbitH = basePos.y;
  const baseAng = Math.atan2(basePos.x - tgt.x, basePos.z - tgt.z);

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;
    seaMat.uniforms.t.value = t;
    petals.update(dt, t);
    clouds.children.forEach((c) => { c.position.x += c.userData.drift * dt * 2.2; });
    const sway = (grp, amp) => grp.children.forEach((o) => {
      if (o.userData.sway) o.rotation.z = Math.sin(t * o.userData.sway) * amp;
    });
    sway(palms, 0.03);
    sway(beach, 0.05);
    if (!reduceMotion) {
      angle += dt * 0.018;
      const a = baseAng + angle;
      camera.position.set(
        tgt.x + Math.sin(a) * orbitR * pull,
        orbitH * pull,
        tgt.z + Math.cos(a) * orbitR * pull,
      );
      camera.lookAt(tgt);
    }
    renderer.render(scene, camera);
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  if (reduceMotion) {
    frame();
    return;
  }
  renderer.setAnimationLoop(frame);
}
