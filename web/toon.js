/**
 * toon.js — 赛璐璐（Cel）渲染核心
 *
 * 目标：还原日系动画背景的观感，而不是「3D 模型打灯」。
 * 关键三点：
 *   1. 硬边色阶   —— 光照被量化成 2~3 段，没有平滑过渡
 *   2. 冷色阴影   —— 暗部不是「变黑」，而是偏蓝/紫（动画美术的通行做法）
 *   3. 轮廓描边   —— 背面外扩法，给出手绘线稿感
 */
import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * 1. 改写 three 内置的 toon 光照函数
 *    原版: return vec3( texture2D( gradientMap, coord ).r );  → 灰度衰减
 *    改为: mix( shadowTint, vec3(1.0), g );                   → 带色相的暗部
 *    这一步是「看起来像动画」与「看起来像 3D」的分水岭。
 * ------------------------------------------------------------------ */
THREE.ShaderChunk.gradientmap_pars_fragment = `
#ifdef USE_GRADIENTMAP
  uniform sampler2D gradientMap;
#endif
uniform vec3 shadowTint;
vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {
  float dotNL = dot( normal, lightDirection );
  vec2 coord = vec2( dotNL * 0.5 + 0.5, 0.0 );
  #ifdef USE_GRADIENTMAP
    float g = texture2D( gradientMap, coord ).r;
    return mix( shadowTint, vec3( 1.0 ), g );
  #else
    vec2 fw = fwidth( coord ) * 0.5;
    return mix( shadowTint, vec3( 1.0 ), smoothstep( 0.7 - fw.x, 0.7 + fw.x, coord.x ) );
  #endif
}`;

/** 阶梯渐变图：steps=2 硬二分，steps=3 含中间调 */
const rampCache = new Map();
export function ramp(steps = 3, low = 0.42, mid = 0.76) {
  const key = `${steps}|${low}|${mid}`;
  if (rampCache.has(key)) return rampCache.get(key);
  let arr;
  if (steps === 2) arr = [low, 1.0];
  else if (steps === 3) arr = [low, mid, 1.0];
  else arr = Array.from({ length: steps }, (_, i) => low + (1 - low) * (i / (steps - 1)));
  const tex = new THREE.DataTexture(
    new Uint8Array(arr.map(v => Math.round(v * 255))), arr.length, 1, THREE.RedFormat
  );
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  rampCache.set(key, tex);
  return tex;
}

/**
 * 卡通材质
 * @param {number|string} color  固有色
 * @param {object} o  { steps, shadow, emissive, transparent, opacity, side }
 */
export function cel(color, o = {}) {
  const {
    steps = 3,
    shadow = 0x8aa8d8,     // 默认冷蓝阴影
    low = 0.42, mid = 0.76,
    ...rest
  } = o;
  const m = new THREE.MeshToonMaterial({
    color: new THREE.Color(color),
    gradientMap: ramp(steps, low, mid),
    ...rest,
  });
  const tint = new THREE.Color(shadow);
  m.userData.shadowTint = tint;
  // 剖切：背面（被裁开后露出的内壁）用 capColor 作为固有色，照常受光
  m.userData.capColor = { value: new THREE.Color(0xfff4e6) };
  m.userData.capOn = { value: 0 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.shadowTint = { value: tint };
    sh.uniforms.capColor = m.userData.capColor;
    sh.uniforms.capOn = m.userData.capOn;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 capColor;\nuniform float capOn;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  if ( capOn > 0.5 && !gl_FrontFacing ) diffuseColor.rgb = capColor;');
  };
  // 让不同 shadowTint 的材质不会错误共用同一份编译结果
  m.customProgramCacheKey = () => `cel_${tint.getHexString()}_${steps}_${low}_${mid}`;
  return m;
}

/** 外壳材质：双面渲染，裁开后内壁显示 inner 色（舱内墙面） */
export function hull(color, inner, o = {}) {
  const m = cel(color, { ...o, side: THREE.DoubleSide });
  m.userData.capColor.value.set(inner);
  m.userData.capOn.value = 1;
  return m;
}

/** 纯色自发光（灯、霓虹、窗光）——不参与光照，永远是干净的平色 */
export function flat(color, o = {}) {
  return new THREE.MeshBasicMaterial({ color: new THREE.Color(color), ...o });
}

/* ------------------------------------------------------------------ *
 * 2. 描边：复制网格 → 法线外扩 → 只画背面
 *    比后期描边便宜，且线宽随模型走，接近手绘线稿。
 * ------------------------------------------------------------------ */
const inkCache = new Map();
let planesId = 0;
function inkMat(color, width, planes = null) {
  if (planes && planes.__id === undefined) planes.__id = ++planesId;
  const key = `${color}|${width}|${planes ? planes.__id : 0}`;
  if (inkCache.has(key)) return inkCache.get(key);
  const m = new THREE.ShaderMaterial({
    uniforms: {
      inkColor: { value: new THREE.Color(color) },
      inkWidth: { value: width },
    },
    vertexShader: `
      #include <common>
      #include <clipping_planes_pars_vertex>
      uniform float inkWidth;
      void main() {
        // 在裁剪空间按 w 缩放外扩量 → 线宽恒定于屏幕，不随距离塌陷
        vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
        vec4 clip = projectionMatrix * mvPosition;
        vec3 nView = normalize( normalMatrix * normal );
        vec2 nClip = normalize( ( projectionMatrix * vec4( nView, 0.0 ) ).xy );
        clip.xy += nClip * inkWidth * clip.w;
        gl_Position = clip;
        #include <clipping_planes_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <clipping_planes_pars_fragment>
      uniform vec3 inkColor;
      void main() {
        #include <clipping_planes_fragment>
        gl_FragColor = vec4( inkColor, 1.0 );
      }`,
    side: THREE.BackSide,
    clipping: !!planes,
    clippingPlanes: planes,
  });
  inkCache.set(key, m);
  return m;
}

/** 给单个 mesh 加描边（作为子节点，自动跟随变换）；被剖切的网格，描边也一起剖 */
export function ink(mesh, { color = 0x2d3a5c, width = 0.0035 } = {}) {
  if (!mesh.geometry) return null;
  const o = new THREE.Mesh(mesh.geometry, inkMat(color, width, mesh.material.clippingPlanes || null));
  o.userData.isInk = true;
  o.renderOrder = -1;
  mesh.add(o);
  return o;
}

/** 批量描边；skip 可跳过不需要线稿的对象（如海面、天空） */
export function inkAll(root, { color = 0x2d3a5c, width = 0.0035, skip = () => false } = {}) {
  const targets = [];
  root.traverse(m => {
    if (m.isMesh && !m.isInstancedMesh && !m.userData.isInk && !m.userData.noInk && !Array.isArray(m.material) && !m.children.some(c => c.userData.isInk) && !skip(m)) targets.push(m);
  });
  targets.forEach(m => ink(m, { color, width: m.userData.inkWidth ?? width }));
  return targets.length;
}

/* ------------------------------------------------------------------ *
 * 3. 二次元滤镜（后期，放在 OutputPass 之后 → 直接在 sRGB 空间调色）
 *    · 暗部推向冷紫、亮部微暖 —— 动画美术的分色习惯
 *    · 轻微提饱和、抬黑位 —— 保住「浅色系」
 *    · 右上角斜射光束 —— 参考图 2 车厢里的那种光条
 *    · 极淡纸纹颗粒 —— 去掉 CG 的塑料感
 * ------------------------------------------------------------------ */
export const AnimeFilterShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime:    { value: 0 },
    uAmount:  { value: 1 },
    uAspect:  { value: 1 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime, uAmount, uAspect;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec3 src = texture2D(tDiffuse, vUv).rgb;
      vec3 col = src;
      float lum = dot(col, vec3(0.299, 0.587, 0.114));

      // 分色：暗部冷紫 / 亮部暖白
      col = mix(col, col * vec3(0.9, 0.92, 1.1) + vec3(0.03, 0.02, 0.06), smoothstep(0.62, 0.18, lum) * 0.75);
      col += vec3(0.022, 0.014, -0.006) * smoothstep(0.55, 1.0, lum);
      // 饱和 + 抬黑位
      col = mix(vec3(lum), col, 1.08);
      col = col * 0.965 + 0.035;

      // 右上角斜射光束
      vec2 p = vUv - vec2(1.08, 1.12);
      p.x *= uAspect;
      float ang = atan(p.y, p.x);
      float r = length(p);
      float rays = pow(0.5 + 0.5 * sin(ang * 23.0 + 0.6), 5.0) * 0.55
                 + pow(0.5 + 0.5 * sin(ang * 11.0 + uTime * 0.07 + 2.1), 7.0) * 0.6;
      col += vec3(1.0, 0.98, 0.93) * rays * smoothstep(1.45, 0.15, r) * 0.07;
      // 顶部空气感
      col = mix(col, vec3(1.0, 0.99, 1.0), smoothstep(0.82, 1.0, vUv.y) * 0.05);

      // 纸纹颗粒（静态，不闪）
      col += (hash(floor(vUv * vec2(900.0 * uAspect, 900.0))) - 0.5) * 0.018;

      gl_FragColor = vec4(mix(src, clamp(col, 0.0, 1.0), uAmount), 1.0);
    }`,
};
