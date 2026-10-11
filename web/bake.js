/**
 * bake.js — 静态网格按材质合并
 *
 * 面数一个不降，只把「同材质、不会动」的网格并成一个 draw call。
 * 房屋内饰、城市、沙滩小物动辄上万个零件，不合并的话 GPU 会被调用次数拖死。
 *   keep(o) 返回 true 的节点（及其子树）原样保留 —— 用于会动的部件、角色关节。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();

function prep(geo, matrix, wantUv, wantColor) {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  for (const k of Object.keys(g.attributes)) {
    if (k !== 'position' && k !== 'normal' && !(k === 'uv' && wantUv) && !(k === 'color' && wantColor)) g.deleteAttribute(k);
  }
  if (wantColor && !g.attributes.color) g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
  if (!g.attributes.normal) g.computeVertexNormals();
  if (wantUv && !g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  g.morphAttributes = {};
  g.clearGroups();
  g.applyMatrix4(matrix);
  // 负缩放会翻转绕序：交换每个三角形的后两个顶点
  if (matrix.determinant() < 0) {
    for (const a of Object.values(g.attributes)) {
      const n = a.itemSize, arr = a.array;
      for (let t = 0; t < a.count; t += 3) {
        for (let k = 0; k < n; k++) {
          const i1 = (t + 1) * n + k, i2 = (t + 2) * n + k;
          const tmp = arr[i1]; arr[i1] = arr[i2]; arr[i2] = tmp;
        }
      }
    }
  }
  return g;
}

export function bake(root, { keep = () => false } = {}) {
  root.updateMatrixWorld(true);
  _inv.copy(root.matrixWorld).invert();
  const buckets = new Map();
  const victims = [];

  const walk = (o, kept) => {
    for (const c of o.children) {
      if (!c.visible) continue;                    // 隐藏的子树（比如闭眼）原样留着
      const k = kept || keep(c);
      if (!k && c.isMesh && !c.isInstancedMesh && !c.isSkinnedMesh && !c.userData.isInk &&
          !Array.isArray(c.material) && !c.userData.noBake) {
        const mat = c.material;
        const key = [mat.uuid, c.userData.noInk ? 'n' : (c.userData.inkWidth ?? 'd'),
          c.castShadow ? 1 : 0, c.receiveShadow ? 1 : 0].join('|');
        let b = buckets.get(key);
        if (!b) {
          b = { mat, geos: [], noInk: !!c.userData.noInk, inkWidth: c.userData.inkWidth, cast: c.castShadow, recv: c.receiveShadow };
          buckets.set(key, b);
        }
        _m.multiplyMatrices(_inv, c.matrixWorld);
        b.geos.push(prep(c.geometry, _m, !!(mat.map || mat.alphaMap), !!mat.vertexColors));
        victims.push(c);
      }
      walk(c, k);
    }
  };
  walk(root, false);

  for (const v of victims) {
    const p = v.parent;
    for (const ch of [...v.children]) if (!ch.userData.isInk) p.attach(ch);
    p.remove(v);
  }
  let n = 0;
  for (const b of buckets.values()) {
    const g = mergeGeometries(b.geos, false);
    b.geos.forEach(x => x.dispose());
    if (!g) continue;
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, b.mat);
    m.castShadow = b.cast; m.receiveShadow = b.recv;
    if (b.noInk) m.userData.noInk = true;
    if (b.inkWidth !== undefined) m.userData.inkWidth = b.inkWidth;
    m.userData.baked = true;
    root.add(m);
    n++;
  }
  return n;
}
