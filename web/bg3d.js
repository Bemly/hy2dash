/* hy2dash 3D 背景 —— RhineLabUI 轻量致敬版
 * 上游: https://github.com/LBEILC/RhineLabUI (MIT, Copyright (c) 2026 LBEILC)
 * 完整版是 TypeScript + Three.js + Vite + 34MB GLB 模型，本面板为了保持
 * Go 单二进制 ~6MB / 常驻 12MB / 零构建，做了一个无构建、CDN 懒加载的轻量版：
 * 透明档案盒 5列×8列阵列 + 选中波浪 + 呼吸 + 鼠标视差 + 雾效。
 * 2D/3D 可切换，偏好存 localStorage("hy2dash_bg")，离线/CDN失败自动回落 2D。
 */
(() => {
  const KEY = "hy2dash_bg";
  const canvas = document.getElementById("bg3d");
  const btn = document.getElementById("bgBtn");
  if (!canvas) return;

  const getMode = () => {
    const v = localStorage.getItem(KEY);
    return v === "2d" || v === "3d" ? v : "3d";
  };
  const applyMode = (m) => {
    document.body.dataset.bg = m;
    localStorage.setItem(KEY, m);
    if (btn) {
      btn.textContent = m === "3d" ? "2D" : "3D";
      btn.title = m === "3d" ? "切换到 2D 平面" : "切换到 3D 档案阵列";
    }
  };

  let mode = getMode();
  // 登录页 body 已预设 data-bg，首页还没有，这里统一
  if (!document.body.dataset.bg) document.body.dataset.bg = mode;
  else mode = document.body.dataset.bg;
  applyMode(mode);

  if (btn) {
    btn.onclick = async () => {
      mode = getMode() === "3d" ? "2d" : "3d";
      applyMode(mode);
      if (mode === "3d") await start();
      else stop();
    };
  }

  // ---- 3D 场景（懒加载 three.js） ----
  let renderer = null, raf = 0, disposed = false;
  let scene = null, camera = null, group = null, boxes = [];
  let mx = 0, my = 0;

  const onMouse = (e) => {
    mx = (e.clientX / innerWidth - 0.5) * 2;
    my = (e.clientY / innerHeight - 0.5) * 2;
  };
  const onResize = () => {
    if (!renderer || !camera) return;
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
  };
  const themeColors = () => {
    const light = document.documentElement.dataset.theme === "light";
    return {
      fog: light ? 0xe8e5e1 : 0x171713,
      edge: light ? 0x946b3c : 0xa67d48,
      face: light ? 0x946b3c : 0xddb788,
    };
  };

  async function start() {
    if (mode !== "3d") return;
    if (renderer) { // 已经在跑（主题切换等情况不重建）
      canvas.style.display = "block";
      return;
    }
    let THREE;
    try {
      THREE = await import("three");
    } catch (e) {
      // CDN 不可达 / 离线：静默回落 2D，不影响面板使用
      console.warn("[bg3d] three.js 加载失败，回落 2D:", e);
      mode = "2d";
      applyMode(mode);
      return;
    }
    if (getMode() !== "3d") return; // 用户在加载过程中又切回 2D
    if (!window.WebGLRenderingContext) { mode = "2d"; applyMode(mode); return; }

    disposed = false;
    const C = themeColors();
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    renderer.setSize(innerWidth, innerHeight, false);

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(C.fog, 18, 46);
    camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 120);
    camera.position.set(0, 3.4, 17);

    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const key = new THREE.DirectionalLight(0xfff1dd, 1.35);
    key.position.set(-8, 14, 6);
    scene.add(key);
    const fill = new THREE.HemisphereLight(0xffffff, 0x444444, 0.45);
    scene.add(fill);

    // 档案阵列：5 列 × 8 行 = 40（致敬上游 40 份档案），卡片比例约 5:3.7
    group = new THREE.Group();
    const geo = new THREE.BoxGeometry(2.6, 1.85, 0.16);
    const edgeGeo = new THREE.EdgesGeometry(geo);
    boxes = [];
    for (let col = 0; col < 5; col++) {
      for (let row = 0; row < 8; row++) {
        const faceMat = new THREE.MeshPhysicalMaterial({
          color: C.face, transparent: true, opacity: 0.10,
          roughness: 0.42, metalness: 0.05,
        });
        const m = new THREE.Mesh(geo, faceMat);
        const edge = new THREE.LineSegments(
          edgeGeo,
          new THREE.LineBasicMaterial({ color: C.edge, transparent: true, opacity: 0.55 })
        );
        m.add(edge);
        const x = (col - 2) * 3.4;
        const y = (row - 3.5) * 2.35;
        const z = -Math.abs(col - 2) * 0.9 - Math.abs(row - 3.5) * 0.25;
        m.position.set(x, y, z);
        m.userData = { bx: x, by: y, col, row };
        group.add(m);
        boxes.push(m);
      }
    }
    // 阵列整体后仰 + 斜俯视，贴近上游 27-32s 镜头
    group.rotation.x = -0.18;
    group.rotation.y = 0.32;
    group.position.y = 0.4;
    scene.add(group);

    // 主题切换时更新雾/边框颜色（不重建场景）
    new MutationObserver(() => {
      if (!scene) return;
      const nc = themeColors();
      scene.fog.color.setHex(nc.fog);
      group.children.forEach((m) => {
        m.material.color.setHex(nc.face);
        m.children[0].material.color.setHex(nc.edge);
      });
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    addEventListener("resize", onResize);
    addEventListener("pointermove", onMouse, { passive: true });
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

    const t0 = performance.now();
    const tick = (now) => {
      if (disposed || getMode() !== "3d") return;
      // 页面隐藏时停绘（省电 + 省内存）
      if (document.hidden) { raf = requestAnimationFrame(tick); return; }
      const t = (now - t0) / 1000;
      const speed = reduced ? 0.15 : 1;
      for (const m of boxes) {
        const { bx, by, col, row } = m.userData;
        // 选中波浪（正向波峰，无负波谷）+ 呼吸（8s/13s 叠加，上游规范）
        const wave = Math.max(0, Math.cos((col * 0.9 + row * 0.55) - t * 0.9 * speed)) * 0.5;
        const breath = Math.sin(t * (Math.PI * 2 / 8) * speed + col * 0.4) * 0.05
          + Math.sin(t * (Math.PI * 2 / 13) * speed + row * 0.3) * 0.05;
        m.position.y = by + wave + breath;
        m.rotation.y = Math.sin(t * 0.25 * speed + col) * 0.06;
      }
      // 鼠标视差（镜头轻移）
      camera.position.x += (mx * 1.4 - camera.position.x) * 0.03;
      camera.position.y += ((3.4 - my * 0.9) - camera.position.y) * 0.03;
      camera.lookAt(0, 0.4, 0);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    canvas.style.display = "block";
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    disposed = true;
    cancelAnimationFrame(raf);
    canvas.style.display = "none";
    if (renderer) {
      removeEventListener("resize", onResize);
      removeEventListener("pointermove", onMouse);
      scene?.traverse((o) => {
        o.geometry?.dispose?.();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.());
      });
      renderer.dispose();
      renderer = null; scene = null; camera = null; group = null; boxes = [];
    }
  }

  document.addEventListener("visibilitychange", () => {
    // hidden 时 tick 内部已跳过渲染，visible 后自动继续，无需重建
  });

  if (mode === "3d") start();
})();
