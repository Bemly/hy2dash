/**
 * world.js — 天空 / 海 / 沙滩地形
 *
 * 海岸线是一条函数 shoreX(z)，沙滩高度 groundY(x,z) 由它决定；
 * 海面着色器用同一个函数算「水深」：浅水青绿、白浪拍岸、离岸第二道浪、焦散纹、闪光点。
 * 天空球跟着相机走（半径 3000），所以去上海也不会飞出天空。
 */
import * as THREE from 'three';
import { cel } from './toon.js';

export const PALETTE = {
  skyTop:    0x6fc4f0,
  skyLow:    0xd8f0fb,
  seaFar:    0x3a9ed2,
  seaNear:   0x7fd4e6,
  seaShallow:0xa8f0e0,
  foam:      0xffffff,
  sandLit:   0xf6e8cc,
  sandWet:   0xdcc39c,
  shadow:    0x8aa8d8,
  ink:       0x33415f,
};
export const SEA_Y = -0.3;

const rnd = (a, b) => a + Math.random() * (b - a);

/* ============================ 海岸线 ============================ */
export const shoreX = z => 12 + 4 * Math.sin(z * 0.021) + 2 * Math.sin(z * 0.057 + 1);
const dune = (x, z) => 0.38 * (Math.sin(x * 0.31 + z * 0.11) * 0.5 + 0.5) * (Math.sin(z * 0.07) * 0.5 + 0.5);
/** 地面高度：海里缓坡下沉，沙滩缓升到 0（小镇地坪），中段有沙丘 */
export function groundY(x, z) {
  const d = x - shoreX(z);
  if (d < 0) return Math.max(SEA_Y + d * 0.08, -9);
  if (d < 26) return SEA_Y + d * 0.0115 + dune(x, z) * THREE.MathUtils.smoothstep(d, 8, 14) * (1 - THREE.MathUtils.smoothstep(d, 21, 26));
  return 0;
}
const GLSL_GROUND = `
  float shoreX(float z){ return 12.0 + 4.0*sin(z*0.021) + 2.0*sin(z*0.057 + 1.0); }
  float groundAt(vec2 p){
    float d = p.x - shoreX(p.y);
    if (d < 0.0) return max(-0.3 + d*0.08, -9.0);
    if (d < 26.0) return -0.3 + d*0.0115;
    return 0.0;
  }`;

/* ============================== 天空 ============================== */
export function buildSky(scene) {
  const R = 3000;
  const sky = new THREE.Group();
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(PALETTE.skyTop) },
      bot: { value: new THREE.Color(PALETTE.skyLow) },
    },
    vertexShader: `varying float vH;
      void main(){ vH = normalize(position).y; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
    fragmentShader: `uniform vec3 top; uniform vec3 bot; varying float vH;
      void main(){ float t = clamp(vH*1.6+0.06,0.0,1.0); gl_FragColor = vec4(mix(bot,top,t),1.0);} `,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(R, 40, 24), m);
  dome.userData.noInk = true;
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  sky.add(dome);
  scene.add(sky);

  // 卡通积云：几团球叠成一坨，平涂白
  const clouds = new THREE.Group();
  const cloudMat = cel(0xffffff, { steps: 2, shadow: 0xc8dcf2, low: 0.84, emissive: 0x202428 });
  const geo = new THREE.SphereGeometry(1, 16, 12);
  for (let i = 0; i < 46; i++) {
    const puff = new THREE.Group();
    const n = 3 + (i % 4);
    const S = rnd(9, 22);
    for (let j = 0; j < n; j++) {
      const s = S * rnd(0.7, 1.1);
      const b = new THREE.Mesh(geo, cloudMat);
      b.scale.set(s, s * rnd(0.5, 0.7), s * rnd(0.8, 1.1));
      b.position.set(j * S * 0.95 - n * S * 0.45, rnd(-2, 4), rnd(-6, 6));
      b.userData.noInk = true;
      puff.add(b);
    }
    const a = rnd(0, Math.PI * 2), r = rnd(200, 1700);
    puff.position.set(-400 + Math.cos(a) * r, rnd(90, 260), Math.sin(a) * r);
    puff.userData.drift = rnd(0.15, 0.4);
    clouds.add(puff);
  }
  scene.add(clouds);
  return { sky, clouds };
}

/* ============================== 海 ============================== */
export function buildSea(scene, fog) {
  const geo = new THREE.PlaneGeometry(7000, 7000, 320, 320);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      t:        { value: 0 },
      cDeep:    { value: new THREE.Color(PALETTE.seaFar) },
      cMid:     { value: new THREE.Color(PALETTE.seaNear) },
      cShallow: { value: new THREE.Color(PALETTE.seaShallow) },
      cFoam:    { value: new THREE.Color(PALETTE.foam) },
      fogColor: { value: fog.color },
      fogNear:  { value: fog.near },
      fogFar:   { value: fog.far },
    },
    vertexShader: `
      uniform float t;
      varying vec3 vW; varying float vWave;
      ${GLSL_GROUND}
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        float depth = -0.3 - groundAt(w.xz);
        float amp = mix(0.08, 0.55, smoothstep(0.3, 8.0, depth));
        float wv = sin(w.x*0.055 + t*1.1)*0.5 + sin(w.z*0.075 - t*0.85)*0.42 + sin((w.x+w.z)*0.03 + t*0.6)*0.3;
        w.y += wv * amp;
        vWave = wv; vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform vec3 cDeep, cMid, cShallow, cFoam, fogColor;
      uniform float t, fogNear, fogFar;
      varying vec3 vW; varying float vWave;
      ${GLSL_GROUND}
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main(){
        float g = groundAt(vW.xz);
        if (g > 0.05) discard;                         // 陆地下面不画
        float depth = -0.3 - g;
        float far = max(0.0, -vW.x - 60.0) * 0.02;
        vec3 col = mix(cShallow, cMid, smoothstep(0.15, 2.8, depth));
        col = mix(col, cDeep, smoothstep(3.0, 9.0, depth + far));
        // 波峰亮带 / 波谷暗带（色阶化）
        col = mix(col, mix(col, cFoam, 0.4), smoothstep(0.86, 1.05, vWave));
        col = mix(col, mix(col, cDeep, 0.35), smoothstep(-0.4, -0.85, vWave));
        // 浅水焦散纹
        float ca = step(0.8, sin(vW.x*1.3 + t*1.2 + sin(vW.z*0.7))*sin(vW.z*1.1 - t*0.9 + sin(vW.x*0.5)));
        col = mix(col, vec3(1.0), ca * 0.16 * (1.0 - smoothstep(0.2, 2.2, depth)));
        // 拍岸白浪：随时间涨落
        float lap = 0.5 + 0.5 * sin(t * 0.8 + vW.z * 0.04);
        float edge = smoothstep(0.16 + lap * 0.22, 0.04 + lap * 0.22, depth);
        float line2 = 1.0 - smoothstep(0.0, 0.06, abs(depth - (0.7 + 0.35 * sin(t * 0.6 + vW.z * 0.025))));
        float line3 = (1.0 - smoothstep(0.0, 0.05, abs(depth - (1.6 + 0.4 * sin(t * 0.45 + vW.z * 0.02 + 1.0))))) * 0.6;
        col = mix(col, cFoam, clamp(max(edge, max(line2 * 0.8, line3)), 0.0, 1.0));
        // 闪光点
        vec2 cell = floor(vW.xz * 0.5);
        float h = hash(cell);
        float glint = step(0.986, h) * step(0.55, sin(t * 2.6 + h * 60.0)) * smoothstep(0.55, 1.0, vWave);
        col = mix(col, vec3(1.0), glint);
        float dist = distance(cameraPosition, vW);
        col = mix(col, fogColor, smoothstep(fogNear, fogFar, dist));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sea = new THREE.Mesh(geo, mat);
  sea.position.set(-600, SEA_Y, 0);
  sea.userData.noInk = true;
  scene.add(sea);
  return { sea, mat };
}

/* ============================== 沙滩地形 ============================== */
export function buildBeach(scene) {
  const grp = new THREE.Group();
  // 沙滩高度场：x ∈ [-40, 62]，1 单位一格
  const X0 = -40, X1 = 62, Z0 = -700, Z1 = 700;
  const geo = new THREE.PlaneGeometry(X1 - X0, Z1 - Z0, (X1 - X0), (Z1 - Z0) / 2);
  geo.rotateX(-Math.PI / 2);
  geo.translate((X0 + X1) / 2, 0, (Z0 + Z1) / 2);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const wet = new THREE.Color(PALETTE.sandWet), dry = new THREE.Color(PALETTE.sandLit), town = new THREE.Color(0xeae4d6), deep = new THREE.Color(0xc8b48c);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const y = groundY(x, z);
    pos.setY(i, y);
    const d = x - shoreX(z);
    if (d < 0) c.copy(deep).lerp(wet, THREE.MathUtils.smoothstep(d, -3, 0));
    else c.copy(wet).lerp(dry, THREE.MathUtils.smoothstep(d, 1.5, 5));
    if (d > 20) c.lerp(town, THREE.MathUtils.smoothstep(d, 22, 28));
    const n = (Math.sin(x * 3.1 + z * 1.7) * Math.sin(x * 1.3 - z * 2.9)) * 0.025;
    col[i * 3] = c.r + n; col[i * 3 + 1] = c.g + n; col[i * 3 + 2] = c.b + n;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, 128, 128);
  cx.strokeStyle = 'rgba(190,160,120,.22)'; cx.lineWidth = 2;
  for (let y = 6; y < 128; y += 11) { cx.beginPath(); for (let x = 0; x <= 128; x += 8) cx.lineTo(x, y + Math.sin(x * 0.1 + y) * 2.5); cx.stroke(); }
  for (let i = 0; i < 120; i++) { cx.fillStyle = `rgba(${150 + (i % 3) * 30},${130 + (i % 4) * 20},110,.35)`; cx.fillRect((i * 53) % 128, (i * 97) % 128, 1.5, 1.5); }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(26, 350);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sand = new THREE.Mesh(geo, cel(0xffffff, { steps: 2, shadow: 0xd0c0b0, low: 0.88, vertexColors: true, map: tex }));
  sand.receiveShadow = true; sand.userData.noInk = true;
  grp.add(sand);
  // 小镇地坪（远处一大片平地）
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000).rotateX(-Math.PI / 2), cel(0xeae4d6, { steps: 2, shadow: 0xc0bcd0, low: 0.9 }));
  ground.position.set(X1 + 1500 - 0.5, -0.01, 0);
  ground.receiveShadow = true; ground.userData.noInk = true;
  grp.add(ground);

  // 防波堤消波块
  const blockMat = cel(0xd9d4cb, { steps: 3, shadow: 0x92a4c4 });
  for (let i = 0; i < 34; i++) {
    const z = -140 - i * 9 + rnd(-3, 3), x = rnd(-6, 2);
    const b = new THREE.Mesh(new THREE.DodecahedronGeometry(rnd(1.2, 2.0), 0), blockMat);
    b.position.set(x, groundY(x, z) + rnd(0.6, 1.4), z);
    b.rotation.set(rnd(0, 3), rnd(0, 3), rnd(0, 3));
    b.castShadow = b.receiveShadow = true;
    grp.add(b);
  }
  // 贝壳、海星、小石头、海草
  const shellMat = cel(0xfff1f3, { steps: 2, shadow: 0xc8b6d0, low: 0.8 });
  const starMat = cel(0xffb3a0, { steps: 2, shadow: 0xc08aa0, low: 0.74 });
  const rockMat = cel(0xb8b2a6, { steps: 3, shadow: 0x8294b4 });
  const weedMat = cel(0x7aa86a, { steps: 2, shadow: 0x5f86a0, low: 0.7 });
  for (let i = 0; i < 260; i++) {
    const z = rnd(-400, 300);
    if (z > -10 && z < 14) continue;
    const x = shoreX(z) + rnd(-1, 22);
    const kind = Math.random();
    let m;
    if (kind < 0.35) { m = new THREE.Mesh(new THREE.SphereGeometry(rnd(0.14, 0.28), 10, 6, 0, Math.PI), shellMat); m.rotation.x = -Math.PI / 2; }
    else if (kind < 0.5) {
      m = new THREE.Group();
      for (let k = 0; k < 5; k++) {
        const arm = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.3, 5), starMat);
        arm.rotation.z = -Math.PI / 2; arm.position.x = 0.13;
        const p = new THREE.Group(); p.rotation.y = k / 5 * Math.PI * 2; p.add(arm); m.add(p);
      }
    }
    else if (kind < 0.85) { m = new THREE.Mesh(new THREE.DodecahedronGeometry(rnd(0.14, 0.4), 0), rockMat); m.rotation.set(rnd(0, 3), rnd(0, 3), rnd(0, 3)); }
    else { m = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.04, 4, 10, 2.5), weedMat); m.rotation.x = -Math.PI / 2; m.rotation.z = rnd(0, 6); }
    m.position.set(x, groundY(x, z) + 0.06, z);
    m.traverse(o => { if (o.isMesh) { o.castShadow = true; o.userData.inkWidth = 0.006; } });
    grp.add(m);
  }
  // 沙丘草
  const grassMat = cel(0x9fcf7a, { steps: 2, shadow: 0x6f94b8, low: 0.66, side: THREE.DoubleSide });
  for (let cI = 0; cI < 70; cI++) {
    const z = rnd(-420, 320);
    if (z > -12 && z < 16) continue;
    const x = shoreX(z) + rnd(17, 25);
    const clump = new THREE.Group();
    for (let k = 0; k < 9; k++) {
      const h = rnd(0.7, 1.6);
      const bl = new THREE.Mesh(new THREE.PlaneGeometry(0.14, h), grassMat);
      bl.position.set(rnd(-0.6, 0.6), h / 2, rnd(-0.6, 0.6));
      bl.rotation.set(rnd(-0.22, 0.22), rnd(0, Math.PI), rnd(-0.28, 0.28));
      bl.userData.noInk = true;
      clump.add(bl);
    }
    clump.position.set(x, groundY(x, z), z);
    clump.userData.sway = rnd(0.6, 1.3);
    grp.add(clump);
  }
  scene.add(grp);
  return grp;
}

/* ====================== 棕榈树（沙滩后排） ====================== */
export function buildPalms(scene, count = 12) {
  const grp = new THREE.Group();
  const trunkMat = cel(0xc9a271, { steps: 3, shadow: 0x8a7fb0 });
  const leafMat  = cel(0x86c96b, { steps: 2, shadow: 0x5f86bb, low: 0.62, side: THREE.DoubleSide });
  const leafDark = cel(0x6fb257, { steps: 2, shadow: 0x587ab0, low: 0.6,  side: THREE.DoubleSide });
  let placed = 0, guard = 0;
  while (placed < count && guard++ < 200) {
    const z = rnd(-300, 260);
    if (z > -16 && z < 22) continue;
    const x = shoreX(z) + rnd(16, 24);
    const palm = new THREE.Group();
    const H = rnd(7, 12), segs = 8, bend = rnd(-0.9, 0.9);
    for (let s = 0; s < segs; s++) {
      const f = s / segs, r = 0.42 * (1 - f * 0.5);
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.88, r, H / segs, 10), trunkMat);
      seg.position.set(bend * f * f * 3.2, (f + 0.5 / segs) * H, 0);
      seg.rotation.z = -bend * f * 0.32;
      seg.castShadow = true;
      palm.add(seg);
    }
    const topX = bend * 3.2, topY = H;
    for (let l = 0; l < 10; l++) {
      const a = (l / 10) * Math.PI * 2 + rnd(-0.2, 0.2);
      const len = rnd(3.4, 5.2);
      const leaf = new THREE.Mesh(new THREE.PlaneGeometry(1.5, len, 2, 6), l % 2 ? leafMat : leafDark);
      const p = leaf.geometry.attributes.position;
      for (let v = 0; v < p.count; v++) { const f = (p.getY(v) + len / 2) / len; p.setZ(v, -f * f * len * 0.42 - Math.abs(p.getX(v)) * 0.3); }
      p.needsUpdate = true;
      leaf.geometry.computeVertexNormals();
      leaf.position.set(topX, topY, 0);
      leaf.rotation.set(-Math.PI / 2 + rnd(0.25, 0.65), a, 0, 'YXZ');
      leaf.castShadow = true; leaf.userData.noInk = true;
      palm.add(leaf);
    }
    for (let k = 0; k < 3; k++) {
      const co = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), cel(0x8d6a45, { steps: 2, shadow: 0x6a6aa0 }));
      co.position.set(topX + rnd(-0.5, 0.5), topY - 0.5, rnd(-0.5, 0.5));
      palm.add(co);
    }
    palm.position.set(x, groundY(x, z), z);
    palm.rotation.y = rnd(0, Math.PI * 2);
    palm.userData.sway = rnd(0.5, 1.0);
    grp.add(palm);
    placed++;
  }
  scene.add(grp);
  return grp;
}
