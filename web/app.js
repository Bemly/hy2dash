/* hy2dash dashboard —— 原生 JS，无框架、无构建 */
(() => {
  const $ = (id) => document.getElementById(id);
  // 页面可能挂在子路径下（如 /dash/），所有请求按当前路径推导前缀
  const BASE = location.pathname.replace(/\/[^/]*$/, "");
  const state = {
    paused: false,
    live: [],
    liveTimer: null,
    sumTimer: null,
    hOffset: 0,
    hLimit: 200,
    hLastTotal: 0,
  };

  // ---------- 工具 ----------
  function fmtBytes(v) {
    v = Number(v) || 0;
    if (v < 1024) return v + " B";
    const u = ["KB", "MB", "GB", "TB"];
    let i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
    return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + " " + u[i];
  }
  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    if (sec < 60) return sec + "s";
    if (sec < 3600) return Math.floor(sec / 60) + "m" + (sec % 60 ? (sec % 60) + "s" : "");
    return Math.floor(sec / 3600) + "h" + Math.floor((sec % 3600) / 60) + "m";
  }
  function fmtTime(ts) {
    if (!ts) return "—";
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function ago(ts) {
    if (!ts) return "—";
    const s = Math.floor(Date.now() / 1000 - ts);
    return s < 0 ? "刚刚" : fmtDur(s) + "前";
  }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function api(path, opts) {
    const r = await fetch(path, Object.assign({ credentials: "same-origin" }, opts || {}));
    if (r.status === 401) { location.href = BASE + "/login"; throw new Error("unauthorized"); }
    const ct = r.headers.get("content-type") || "";
    const body = ct.includes("json") ? await r.json() : await r.text();
    if (!r.ok) throw new Error((body && body.error) || ("HTTP " + r.status));
    return body;
  }

  // ---------- 主题 ----------
  const savedTheme = localStorage.getItem("hy2dash_theme");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $("themeBtn").onclick = () => {
    const cur = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = cur;
    localStorage.setItem("hy2dash_theme", cur);
  };
  $("logoutBtn").onclick = async () => { await fetch(BASE + "/api/logout", { method: "POST" }); location.href = BASE + "/login"; };

  // ---------- 时钟 ----------
  setInterval(() => {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    $("clock").textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }, 1000);

  // ---------- 实时连接 ----------
  function renderLive() {
    const q = $("liveFilter").value.trim().toLowerCase();
    const rows = state.live.filter((c) =>
      !q || (c.a || "").toLowerCase().includes(q) || (c.u || "").toLowerCase().includes(q));
    $("liveMeta").textContent = `${rows.length} / ${state.live.length} 条`;
    if (!rows.length) {
      $("liveBody").innerHTML = `<tr><td colspan="8" class="empty">${state.live.length ? "无匹配连接" : "当前没有活跃连接"}</td></tr>`;
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    let html = "";
    for (const c of rows) {
      const total = (c.tx || 0) + (c.rx || 0);
      const dur = now - (c.t0 || now);
      html += `<tr>
        <td class="addr">${esc(c.a || "—")}${c.s && c.s !== c.a ? `<span class="tag" style="margin-left:6px">sniff ${esc(c.s)}</span>` : ""}</td>
        <td class="hide-sm">${esc(c.u || "-")}</td>
        <td><span class="tag live">${esc(c.st || "open")}</span></td>
        <td class="num">${fmtBytes(c.tx)}</td>
        <td class="num">${fmtBytes(c.rx)}</td>
        <td class="num">${fmtBytes(total)}</td>
        <td class="num hide-sm">${fmtDur(dur)}</td>
        <td class="num hide-sm">${ago(c.t1)}</td>
      </tr>`;
    }
    $("liveBody").innerHTML = html;
  }

  async function loadLive() {
    if (state.paused) return;
    try {
      const d = await api(BASE + "/api/live");
      state.live = d.live || [];
      $("liveCount").textContent = d.count || 0;
      const online = Object.entries(d.online || {}).filter(([, v]) => v).map(([k]) => k);
      $("liveHint").textContent = `在线用户 ${online.length ? online.join(", ") : "—"}`;
      const ok = !d.last_error && d.last_ok;
      $("statusDot").className = "dot " + (ok ? "ok" : "err");
      $("statusText").textContent = ok ? "采集正常" : "采集异常";
      $("collectState").textContent = ok ? "正常" : "异常";
      $("collectHint").textContent = ok
        ? `上次 ${ago(d.last_ok)} · 运行 ${fmtDur(d.uptime)}`
        : (d.last_error || "—");
      renderLive();
    } catch (e) {
      $("statusDot").className = "dot err";
      $("statusText").textContent = "离线";
      $("collectHint").textContent = e.message;
    }
  }
  $("liveFilter").oninput = renderLive;
  $("pauseBtn").onclick = () => {
    state.paused = !state.paused;
    $("pauseBtn").textContent = state.paused ? "继续刷新" : "暂停刷新";
    if (!state.paused) loadLive();
  };

  // ---------- 概览 ----------
  function drawChart(days) {
    const cv = $("chart");
    const dpr = window.devicePixelRatio || 1;
    const cssW = cv.clientWidth || 1200, cssH = 180;
    cv.width = cssW * dpr; cv.height = cssH * dpr;
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);

    const cs = getComputedStyle(document.documentElement);
    const line = cs.getPropertyValue("--line").trim() || "#333";
    const accent = cs.getPropertyValue("--accent").trim() || "#a67d48";
    const accent2 = cs.getPropertyValue("--accent-2").trim() || "#ddb788";
    const muted = cs.getPropertyValue("--muted").trim() || "#888";

    g.font = "10px ui-monospace, monospace";
    g.fillStyle = muted;
    g.strokeStyle = line;
    g.lineWidth = 1;

    if (!days || !days.length) {
      g.fillText("无数据", 10, 20);
      return;
    }
    const padL = 52, padB = 22, padT = 12;
    const w = (cssW - padL - 8) / days.length;
    const maxV = Math.max(1, ...days.map((d) => Math.max(d.tx || 0, d.rx || 0)));

    // 网格 + Y 轴
    for (let i = 0; i <= 4; i++) {
      const y = padT + ((cssH - padT - padB) * i) / 4;
      g.beginPath(); g.moveTo(padL, y); g.lineTo(cssW - 8, y); g.stroke();
      g.fillText(fmtBytes((maxV * (4 - i)) / 4), 6, y + 3);
    }
    const bw = Math.max(3, w * 0.3);
    days.forEach((d, i) => {
      const x = padL + i * w + w * 0.16;
      const h1 = ((cssH - padT - padB) * (d.tx || 0)) / maxV;
      const h2 = ((cssH - padT - padB) * (d.rx || 0)) / maxV;
      g.fillStyle = accent;
      g.fillRect(x, cssH - padB - h1, bw, h1);
      g.fillStyle = accent2;
      g.fillRect(x + bw + 2, cssH - padB - h2, bw, h2);
      if (days.length <= 16 || i % 2 === 0) {
        g.fillStyle = muted;
        g.fillText(d.day.slice(5), x - 2, cssH - 6);
      }
    });
  }

  async function loadSummary() {
    try {
      const days = Number($("oDays").value) || 7;
      const d = await api(BASE + "/api/summary?days=" + days);
      $("todayTotal").textContent = fmtBytes((d.today_tx || 0) + (d.today_rx || 0));
      $("todayHint").textContent = `↑ ${fmtBytes(d.today_tx)}  ↓ ${fmtBytes(d.today_rx)}`;
      $("weekTotal").textContent = fmtBytes((d.total_tx || 0) + (d.total_rx || 0));
      $("weekHint").textContent = `连接数 ${d.total_conn || 0} · ${days} 天`;
      $("oMeta").textContent = `${days} 天 · ${d.total_conn || 0} 条`;
      drawChart(d.days || []);
      const top = d.top_domains || [];
      $("oBody").innerHTML = top.length
        ? top.map((t) => `<tr>
            <td class="addr">${esc(t.addr)}</td>
            <td class="num">${t.count}</td>
            <td class="num">${fmtBytes(t.tx)}</td>
            <td class="num">${fmtBytes(t.rx)}</td>
            <td class="num">${fmtBytes((t.tx || 0) + (t.rx || 0))}</td>
          </tr>`).join("")
        : `<tr><td colspan="5" class="empty">暂无数据</td></tr>`;
    } catch (e) { /* 静默，下一轮重试 */ }
  }
  $("oRefresh").onclick = loadSummary;
  $("oDays").onchange = loadSummary;

  // ---------- 历史 ----------
  async function loadHistory(reset) {
    if (reset) state.hOffset = 0;
    const date = $("hDate").value;
    const q = encodeURIComponent($("hQuery").value.trim());
    $("hBody").innerHTML = `<tr><td colspan="7" class="empty">查询中…</td></tr>`;
    try {
      const d = await api(`${BASE}/api/history?date=${date}&q=${q}&limit=${state.hLimit}&offset=${state.hOffset}`);
      state.hLastTotal = d.total || 0;
      const rows = d.rows || [];
      $("hMeta").textContent = `${d.date} · 命中 ${d.total} 条 · 第 ${Math.floor(state.hOffset / state.hLimit) + 1} 页`;
      $("hBody").innerHTML = rows.length
        ? rows.map((c) => `<tr>
            <td class="hide-sm">${fmtTime(c.t2)}</td>
            <td class="addr">${esc(c.a || "—")}</td>
            <td class="hide-sm">${esc(c.u || "-")}</td>
            <td class="num">${fmtBytes(c.tx)}</td>
            <td class="num">${fmtBytes(c.rx)}</td>
            <td class="num">${fmtBytes((c.tx || 0) + (c.rx || 0))}</td>
            <td class="num">${fmtDur(c.d || 0)}</td>
          </tr>`).join("")
        : `<tr><td colspan="7" class="empty">该条件下没有记录</td></tr>`;
    } catch (e) {
      $("hBody").innerHTML = `<tr><td colspan="7" class="empty">查询失败：${esc(e.message)}</td></tr>`;
    }
  }
  $("hSearch").onclick = () => loadHistory(true);
  $("hQuery").onkeydown = (e) => { if (e.key === "Enter") loadHistory(true); };
  $("hDate").onchange = () => loadHistory(true);
  $("hNext").onclick = () => {
    if (state.hOffset + state.hLimit < state.hLastTotal) { state.hOffset += state.hLimit; loadHistory(false); }
  };
  $("hPrev").onclick = () => {
    if (state.hOffset > 0) { state.hOffset = Math.max(0, state.hOffset - state.hLimit); loadHistory(false); }
  };

  // ---------- 页签 ----------
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", "false"));
      b.setAttribute("aria-selected", "true");
      const t = b.dataset.tab;
      $("tab-live").hidden = t !== "live";
      $("tab-history").hidden = t !== "history";
      $("tab-overview").hidden = t !== "overview";
      if (t === "overview") loadSummary();
      if (t === "history") { if (!$("hBody").dataset.loaded) { loadHistory(true); $("hBody").dataset.loaded = "1"; } }
    };
  });

  // ---------- 修改密码 ----------
  $("pwBtn").onclick = () => { $("pwModal").setAttribute("open", ""); $("pwMsg").textContent = ""; };
  $("pwCancel").onclick = () => $("pwModal").removeAttribute("open");
  $("pwSave").onclick = async () => {
    const oldP = $("pwOld").value, newP = $("pwNew").value;
    $("pwMsg").style.color = "var(--err)";
    if (newP.length < 8) { $("pwMsg").textContent = "新密码至少 8 位"; return; }
    try {
      await api(BASE + "/api/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old: oldP, new: newP }),
      });
      $("pwMsg").style.color = "var(--ok)";
      $("pwMsg").textContent = "已更新（已写入服务端配置）";
      $("pwOld").value = $("pwNew").value = "";
      setTimeout(() => $("pwModal").removeAttribute("open"), 1200);
    } catch (e) {
      $("pwMsg").textContent = e.message;
    }
  };

  // ---------- 启动 ----------
  const today = new Date();
  const p = (n) => String(n).padStart(2, "0");
  $("hDate").value = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  loadLive(); loadSummary();
  state.liveTimer = setInterval(loadLive, 1000);
  state.sumTimer = setInterval(loadSummary, 30000);
})();
