/**
 * routes.js — 每台机体一条「空港 ⇄ 上海」观光环线
 *
 * 环线 = 空港外侧锚点 → 海上去程 → 上海城区段（各有主题）→ 海上回程 → 闭合
 * 城区段（上海本地坐标）：
 *   外滩低空滑翔 / 陆家嘴环绕 / 绕东方明珠 / 石库门上空 / 沿黄浦江 /
 *   江面灯会低飞 / 浦东上空随风 / 冲上上海中心顶 / 环城巡游
 */
import * as THREE from 'three';
import { Path } from './flight.js';
import { ORIGIN } from './shanghai.js';

export function buildRoutes(fleet, landmarks) {
  const { pearl: P, tower: T } = landmarks;
  const ring = (c, r, h, n = 7, a0 = 0, dir = 1) =>
    Array.from({ length: n }, (_, i) => { const a = a0 + dir * i / n * Math.PI * 2; return [c.x + Math.cos(a) * r, h, c.z + Math.sin(a) * r]; });
  const CITY = {
    paper:     [[300, 60, 200], [-40, 34, 300], [-95, 26, 120], [-92, 24, -60], [-60, 30, -200], [80, 42, -250], [300, 55, -120]],
    teapot:    [[320, 90, 140], ...ring(T, 168, 95, 6, 0.6, 1), [320, 90, -60]],
    jelly:     [[300, 70, 60], ...ring(P, 55, 62, 8, 0.2, -1), [300, 70, -40]],
    catbus:    [[300, 55, 260], [-60, 46, 220], [-200, 46, 110], [-260, 42, 40], [-205, 46, -40], [-80, 44, -160], [300, 55, -150]],
    tram:      [[320, 40, 300], [-40, 26, 330], [-64, 22, 120], [-52, 22, -60], [-20, 24, -150], [70, 26, -208], [330, 32, -215]],
    goldfish:  [[330, 42, -205], [190, 34, -222], [110, 22, -220], [20, 16, -190], [-40, 16, -110], [-58, 16, 60], [-62, 18, 260], [300, 30, 260]],
    dandelion: [[320, 85, 200], [160, 90, 260], [20, 95, 120], [60, 100, -60], [240, 90, -120]],
    ramune:    [[330, 120, 160], [T.x + 90, 230, T.z + 40], [T.x + 20, 320, T.z + 10], [T.x - 40, 300, T.z - 20], [T.x - 90, 180, T.z - 60], [P.x - 40, 90, P.z - 20], [300, 80, -100]],
    whale:     [[330, 110, 120], ...ring(new THREE.Vector3(0, 0, 0), 300, 115, 8, 0.3, 1), [330, 110, -40]],
  };
  return fleet.map((def, i) => {
    const h0 = 30 + i * 3.5;
    const zOff = (i - 4) * 16;
    const pts = [
      new THREE.Vector3(-215 - (i % 3) * 22, h0, -20 + zOff),             // 空港外锚点（节点环在这里）
      new THREE.Vector3(-420, h0 + 14, -70 + zOff * 1.4),                // 去程
      ...CITY[def.id].map(([x, y, z]) => new THREE.Vector3(x, y, z).add(ORIGIN)),
      new THREE.Vector3(-430, h0 + 22, 60 + zOff * 1.2),                 // 回程
      new THREE.Vector3(-300, h0 + 8, 30 + zOff),
    ];
    const ag = def.agility || 1, m = Math.sqrt(def.mass || 1);
    const path = new Path(pts, { closed: true, vmax: def.speed, aLat: 7 * ag, aAcc: 2.6 * ag / m, aDec: 3.2 * ag / m });
    path.anchor = pts[0];
    return path;
  });
}
