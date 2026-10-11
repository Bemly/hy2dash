/**
 * cherry.js — 二次元樱花系统
 * 
 * 还原参考图 1/2/4/5 的核心灵魂：
 * 1. 蓬松的赛璐璐粉白樱花树（多层交错的球冠，亮粉白 + 冷紫阴影）
 * 2. 扭曲苍劲的深棕树干与分支
 * 3. 地面的落樱花瓣堆
 * 4. 空中常态飘落的樱花花瓣粒子（带自旋与风向扰动）
 */
import * as THREE from 'three';
import { cel, flat } from './toon.js';

const rnd = (a, b) => a + Math.random() * (b - a);

// 樱花材质：赛璐璐两阶，亮面粉白(0xffebf3)，阴影偏冷淡紫(0xc9a8d4)
const blossomMat1 = cel(0xffd6e6, { steps: 2, shadow: 0xefa8c8, low: 0.86 });
const blossomMat2 = cel(0xffb8d4, { steps: 2, shadow: 0xe08cb8, low: 0.84 });
const blossomMat3 = cel(0xffeaf3, { steps: 2, shadow: 0xf2bcd6, low: 0.88 });

// 树干材质：老树深褐带紫灰阴影
const barkMat = cel(0x5a443a, { steps: 3, shadow: 0x3d304a });
const branchMat = cel(0x4a372e, { steps: 2, shadow: 0x33253b, low: 0.75 });

/** 单棵日系樱花大树 */
export function buildCherryTree(h = 8, spread = 6) {
  const tree = new THREE.Group();

  // 主树干（分段微弯）
  const segs = 5;
  let currY = 0;
  let currX = 0;
  let currZ = 0;
  let r = 0.55;

  for (let i = 0; i < segs; i++) {
    const nextR = r * 0.78;
    const nextY = currY + (h * 0.45) / segs;
    const nextX = currX + rnd(-0.25, 0.25);
    const nextZ = currZ + rnd(-0.25, 0.25);

    const len = (h * 0.45) / segs;
    const seg = new THREE.Mesh(
      new THREE.CylinderGeometry(nextR, r, len, 8),
      barkMat
    );
    seg.position.set((currX + nextX) / 2, (currY + nextY) / 2, (currZ + nextZ) / 2);
    // 朝向
    seg.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(nextX - currX, nextY - currY, nextZ - currZ).normalize()
    );
    seg.castShadow = true;
    tree.add(seg);

    currX = nextX; currY = nextY; currZ = nextZ; r = nextR;
  }

  // 大分支（2~3 根朝四周伸展）
  const numBranches = 3;
  const branchTips = [];
  for (let b = 0; b < numBranches; b++) {
    const angle = (b / numBranches) * Math.PI * 2 + rnd(-0.3, 0.3);
    const bLen = spread * rnd(0.55, 0.85);
    const tipX = currX + Math.cos(angle) * bLen;
    const tipZ = currZ + Math.sin(angle) * bLen;
    const tipY = currY + rnd(1.2, 2.6);

    const bSeg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, r, bLen, 6),
      branchMat
    );
    bSeg.position.set((currX + tipX) / 2, (currY + tipY) / 2, (currZ + tipZ) / 2);
    bSeg.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(tipX - currX, tipY - currY, tipZ - currZ).normalize()
    );
    bSeg.castShadow = true;
    tree.add(bSeg);

    branchTips.push(new THREE.Vector3(tipX, tipY, tipZ));
  }

  // 樱花花冠云团（由 14~20 个大小不一的球体堆叠成蓬松云团，赛璐璐精髓）
  const mats = [blossomMat1, blossomMat2, blossomMat3];
  
  // 中心顶部花团
  const centerPuffs = 5;
  for (let i = 0; i < centerPuffs; i++) {
    const s = rnd(1.8, 3.2);
    const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 1), mats[i % mats.length]);
    puff.position.set(currX + rnd(-1.2, 1.2), currY + rnd(0.8, 2.8), currZ + rnd(-1.2, 1.2));
    puff.scale.set(rnd(0.9, 1.2), rnd(0.7, 1.0), rnd(0.9, 1.2));
    puff.castShadow = true;
    puff.receiveShadow = true;
    puff.userData.inkWidth = 0.003;
    tree.add(puff);
  }

  // 每个树枝末端的花团
  branchTips.forEach((tip, idx) => {
    const n = 4 + (idx % 2);
    for (let j = 0; j < n; j++) {
      const s = rnd(1.4, 2.6);
      const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 1), mats[(idx + j) % mats.length]);
      puff.position.set(
        tip.x + rnd(-1.0, 1.0),
        tip.y + rnd(-0.6, 1.2),
        tip.z + rnd(-1.0, 1.0)
      );
      puff.scale.set(rnd(0.9, 1.25), rnd(0.75, 1.05), rnd(0.9, 1.25));
      puff.castShadow = true;
      puff.receiveShadow = true;
      puff.userData.inkWidth = 0.003;
      tree.add(puff);
    }
  });

  return tree;
}

/** 树下与路面的落樱花瓣堆 */
export function buildPetalPatches(count = 18) {
  const grp = new THREE.Group();
  const patchMat = cel(0xffd8ea, { steps: 2, shadow: 0xd4a8d6, low: 0.85 });

  for (let i = 0; i < count; i++) {
    const rx = rnd(0.8, 2.4);
    const rz = rnd(0.8, 2.4);
    const patch = new THREE.Mesh(
      new THREE.CircleGeometry(1, 12).rotateX(-Math.PI / 2),
      patchMat
    );
    patch.scale.set(rx, 1, rz);
    patch.position.set(rnd(25, 75), 0.03, rnd(-50, 40));
    patch.rotation.y = rnd(0, Math.PI * 2);
    patch.userData.noInk = true;
    grp.add(patch);
  }
  return grp;
}

/**
 * 漫天飘舞的樱花花瓣粒子系统
 * 参考图 1/2 里空气中浮动、带粉白高光的落樱
 */
export function buildFallingPetals(count = 600, bounds = { x: [-10, 80], y: [0, 24], z: [-70, 60] }) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const vels = new Float32Array(count * 3);
  const rot = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    pos[i * 3]     = rnd(bounds.x[0], bounds.x[1]);
    pos[i * 3 + 1] = rnd(bounds.y[0], bounds.y[1]);
    pos[i * 3 + 2] = rnd(bounds.z[0], bounds.z[1]);

    // 下落速度 + 沿微风向 (+X, +Z) 飘
    vels[i * 3]     = rnd(0.4, 1.2);    // 风向 X
    vels[i * 3 + 1] = -rnd(0.35, 0.9);  // 下落速度
    vels[i * 3 + 2] = rnd(-0.3, 0.4);   // 左右扰动

    rot[i * 3]     = rnd(0, Math.PI * 2);
    rot[i * 3 + 1] = rnd(0.8, 2.4);     // 自旋速度
    rot[i * 3 + 2] = rnd(0.5, 1.8);     // 摇摆幅度
  }

  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

  // 圆形柔边花瓣贴片：解决方形粒子问题
  const petalCanvas = document.createElement('canvas');
  petalCanvas.width = petalCanvas.height = 64;
  const ctx = petalCanvas.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.55, 'rgba(255,226,238,0.95)');
  grad.addColorStop(1, 'rgba(255,226,238,0)');
  ctx.fillStyle = grad;
  // 画成小椭圆花瓣形
  ctx.save();
  ctx.translate(32, 32);
  ctx.scale(1, 0.72);
  ctx.beginPath();
  ctx.arc(0, 0, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  const petalTex = new THREE.CanvasTexture(petalCanvas);

  // 用 Points + 粉白材质
  const mat = new THREE.PointsMaterial({
    color: 0xffd9e8,
    size: 0.55,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.9,
    map: petalTex,
    depthWrite: false,
  });

  const points = new THREE.Points(geo, mat);
  points.userData.noInk = true;

  return {
    points,
    update(dt = 0.016, t = 0) {
      const p = geo.attributes.position.array;
      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        // 风力随时间轻微波动
        const windX = vels[i3] * (1.0 + Math.sin(t * 0.8 + i) * 0.3);
        const swayZ = Math.sin(t * rot[i3 + 1] + rot[i3]) * rot[i3 + 2];

        p[i3]     += (windX + swayZ * 0.4) * dt * 2.5;
        p[i3 + 1] += vels[i3 + 1] * dt * 2.5;
        p[i3 + 2] += (vels[i3 + 2] + swayZ) * dt * 2.0;

        // 触底循环重置到上方
        if (p[i3 + 1] < bounds.y[0]) {
          p[i3 + 1] = bounds.y[1];
          p[i3]     = rnd(bounds.x[0], bounds.x[1] - 15);
          p[i3 + 2] = rnd(bounds.z[0], bounds.z[1]);
        }
        if (p[i3] > bounds.x[1]) p[i3] = bounds.x[0];
        if (p[i3 + 2] > bounds.z[1]) p[i3 + 2] = bounds.z[0];
        if (p[i3 + 2] < bounds.z[0]) p[i3 + 2] = bounds.z[1];
      }
      geo.attributes.position.needsUpdate = true;
    }
  };
}
