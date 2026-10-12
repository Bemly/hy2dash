/* hy2dash console —— 原生 JS，无框架、无构建；按 /api/me 角色渲染管理端/用户端 */
(() => {
  const $ = (id) => document.getElementById(id);
  const BASE = location.pathname.replace(/\/[^/]*$/, "");

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

  const logout = async () => { await fetch(BASE + "/api/logout", { method: "POST" }); location.href = BASE + "/login"; };
  $("logoutBtn").onclick = logout;
  $("a-out").onclick = logout;

  // ---------- 控制台抽屉（空港之上的一层；3D 起不来时它就是全部界面） ----------
  const con = $("console");
  const openConsole = (tab) => {
    con.hidden = false;
    document.body.classList.add("console-open");
    if (tab) { const b = document.querySelector(`#view-admin .tabs button[data-tab="${tab}"]`); if (b) b.click(); }
    else if (!$("tab-overview").hidden) loadSummary(); // 画布此前隐藏时宽度为 0，重画一次
  };
  const closeConsole = () => {
    if (document.body.classList.contains("no3d")) return;
    con.hidden = true;
    document.body.classList.remove("console-open");
  };
  window.hy2console = { open: openConsole, close: closeConsole };
  $("a-console").onclick = () => openConsole();
  $("consoleClose").onclick = closeConsole;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || $("pwModal").hasAttribute("open")) return;
    if (!con.hidden) closeConsole(); else if (window.hy2cabin && window.hy2cabin.isOpen) window.hy2cabin.close();
  });
  setInterval(() => {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    const c = $("clock"); if (c) c.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }, 1000);

  // ---------- 修改密码 ----------
  $("pwBtn").onclick = () => { $("pwModal").setAttribute("open", ""); $("pwMsg").textContent = ""; };
  $("pwCancel").onclick = () => $("pwModal").removeAttribute("open");
  $("pwSave").onclick = async () => {
    const oldP = $("pwOld").value, newP = $("pwNew").value;
    $("pwMsg").style.color = "var(--err)";
    if (newP.length < 8) { $("pwMsg").textContent = "新密码至少 8 位"; return; }
    try {
      await api(BASE + "/api/password", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old: oldP, new: newP }) });
      $("pwMsg").style.color = "var(--ok)";
      $("pwMsg").textContent = "已更新";
      $("pwOld").value = $("pwNew").value = "";
      setTimeout(() => $("pwModal").removeAttribute("open"), 1200);
    } catch (e) { $("pwMsg").textContent = e.message; }
  };

  // ---------- 机舱流量：某位乘客的活动连接 + 按域名历史统计 ----------
  // 用户只能看自己的（后端强制）；管理员传 user=<通道名> 看任意一人。
  const fmtRate = (b) => b >= 1e6 ? (b / 1e6).toFixed(1) + " MB/s" : b >= 1e3 ? (b / 1e3).toFixed(0) + " KB/s" : Math.round(b) + " B/s";
  const cab = { user: "", tab: "live", days: 7, timer: 0, seq: 0, prev: new Map(), prevT: 0 };
  const cabQ = (extra) => {
    const q = [];
    if (cab.user) q.push("user=" + encodeURIComponent(cab.user));
    if (extra) q.push(extra);
    return q.length ? "?" + q.join("&") : "";
  };
  const cabEmpty = (msg, cols) => { $("cb-body").innerHTML = `<tr><td colspan="${cols}" class="cb-empty">${esc(msg)}</td></tr>`; };
  async function cabLive() {
    const seq = cab.seq;
    let d;
    try { d = await api(BASE + "/api/my/live" + cabQ()); } catch (e) { if (seq === cab.seq) $("cb-meta").textContent = e.message; return; }
    if (seq !== cab.seq || cab.tab !== "live") return;
    const now = performance.now() / 1000, dt = cab.prevT ? Math.max(0.5, now - cab.prevT) : 0;
    const next = new Map();
    let sum = 0;
    const rows = (d.live || []).map((c) => {
      const o = cab.prev.get(c.k);
      const bps = o != null && dt ? Math.max(0, (c.rx - o) / dt) : 0;
      next.set(c.k, c.rx);
      sum += bps;
      return { c, bps };
    });
    cab.prev = next; cab.prevT = now;
    $("cb-meta").textContent = `${rows.length} 条活动连接 · ↓ ${fmtRate(sum)}`;
    if (!rows.length) { cabEmpty("现在没有活动连接", 5); return; }
    const t = Math.floor(Date.now() / 1000);
    $("cb-body").innerHTML = rows.slice(0, 200).map(({ c, bps }) => `<tr>
      <td class="cb-addr" title="${esc(c.a || "")}">${esc(c.s || c.a || "—")}</td>
      <td class="num${bps > 0 ? " hot" : ""}">${fmtRate(bps)}</td>
      <td class="num">${fmtBytes(c.tx)}</td><td class="num">${fmtBytes(c.rx)}</td>
      <td class="num">${fmtDur(t - (c.t0 || t))}</td></tr>`).join("");
  }
  async function cabDomains() {
    const seq = cab.seq;
    cabEmpty("统计中…", 5);
    let d;
    try { d = await api(BASE + "/api/my/domains" + cabQ("days=" + cab.days)); } catch (e) { if (seq === cab.seq) cabEmpty("查询失败：" + e.message, 5); return; }
    if (seq !== cab.seq || cab.tab !== "dom") return;
    const list = d.domains || [];
    $("cb-meta").textContent = `${cab.days === 1 ? "今日" : cab.days + " 天"} · ${d.hosts || 0} 个域名 · ${d.conns || 0} 条连接 · 合计 ${fmtBytes((d.total_tx || 0) + (d.total_rx || 0))}`;
    if (!list.length) { cabEmpty("这段时间没有记录", 5); return; }
    const top = Math.max(1, (list[0].tx || 0) + (list[0].rx || 0));
    $("cb-body").innerHTML = list.map((x) => {
      const tot = (x.tx || 0) + (x.rx || 0);
      return `<tr><td class="cb-addr" title="${esc(x.addr)}"><i class="cb-bar" style="width:${(tot / top * 100).toFixed(1)}%"></i><span>${esc(x.addr)}</span></td>
        <td class="num">${x.count}</td><td class="num">${fmtBytes(x.tx)}</td><td class="num">${fmtBytes(x.rx)}</td>
        <td class="num strong">${fmtBytes(tot)}</td></tr>`;
    }).join("");
  }
  function cabRender() {
    cab.seq++;
    clearInterval(cab.timer);
    cab.prev = new Map(); cab.prevT = 0;
    document.querySelectorAll("#cb-tab button").forEach((b) => b.classList.toggle("on", b.dataset.t === cab.tab));
    document.querySelectorAll("#cb-days button").forEach((b) => b.classList.toggle("on", +b.dataset.d === cab.days));
    $("cb-days").hidden = cab.tab !== "dom";
    $("cb-meta").textContent = "…";
    if (cab.tab === "live") {
      $("cb-head").innerHTML = `<tr><th>目标</th><th class="num">速率</th><th class="num">上行</th><th class="num">下行</th><th class="num">已持续</th></tr>`;
      cabEmpty("加载中…", 5);
      cabLive();
      cab.timer = setInterval(() => { if (!document.hidden) cabLive(); }, 2000);
    } else {
      $("cb-head").innerHTML = `<tr><th>域名</th><th class="num">连接</th><th class="num">上行</th><th class="num">下行</th><th class="num">合计</th></tr>`;
      cabDomains();
    }
  }
  const cabin = {
    get isOpen() { return !$("cabin").hidden; },
    open(o) {
      o = o || {};
      cab.user = o.user || "";
      $("cb-title").textContent = (o.title || "我的飞船") + " · 机舱流量";
      $("cabin").hidden = false;
      document.body.classList.add("cabin-open");
      cabRender();
    },
    close() {
      cab.seq++;
      clearInterval(cab.timer);
      $("cabin").hidden = true;
      document.body.classList.remove("cabin-open");
    },
  };
  window.hy2cabin = cabin;
  $("cb-close").onclick = cabin.close;
  document.querySelectorAll("#cb-tab button").forEach((b) => { b.onclick = () => { cab.tab = b.dataset.t; cabRender(); }; });
  document.querySelectorAll("#cb-days button").forEach((b) => { b.onclick = () => { cab.days = +b.dataset.d; cabRender(); }; });

  // ================= 管理端 =================
  const adm = { paused: false, live: [], hOffset: 0, hLimit: 200, hTotal: 0 };

  function renderLive() {
    const q = $("liveFilter").value.trim().toLowerCase();
    const rows = adm.live.filter((c) =>
      !q || (c.a || "").toLowerCase().includes(q) || (c.u || "").toLowerCase().includes(q) || (c.srv || "").toLowerCase().includes(q));
    $("liveMeta").textContent = `${rows.length} / ${adm.live.length} 条`;
    if (!rows.length) {
      $("liveBody").innerHTML = `<tr><td colspan="9" class="empty">${adm.live.length ? "无匹配连接" : "当前没有活跃连接"}</td></tr>`;
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    $("liveBody").innerHTML = rows.map((c) => {
      const total = (c.tx || 0) + (c.rx || 0);
      return `<tr><td>${esc(c.srv || "-")}</td>
        <td class="addr">${esc(c.a || "—")}</td>
        <td>${esc(c.u || "-")}</td>
        <td><span class="tag live">${esc(c.st || "open")}</span></td>
        <td class="num">${fmtBytes(c.tx)}</td><td class="num">${fmtBytes(c.rx)}</td>
        <td class="num">${fmtBytes(total)}</td>
        <td class="num hide-sm">${fmtDur(now - (c.t0 || now))}</td>
        <td class="num hide-sm">${ago(c.t1)}</td></tr>`;
    }).join("");
  }

  async function loadLive() {
    if (adm.paused) return;
    try {
      const d = await api(BASE + "/api/live");
      adm.live = d.live || [];
      $("liveCount").textContent = d.count || 0;
      const online = Object.entries(d.online || {}).filter(([, v]) => v).map(([k]) => k);
      $("liveHint").textContent = `在线用户 ${online.length ? online.join(", ") : "—"}`;
      const ok = !d.last_error && d.last_ok;
      $("statusDot").className = "dot " + (ok ? "ok" : "err");
      $("statusText").textContent = ok ? "采集正常" : "采集异常";
      $("collectState").textContent = ok ? "正常" : "异常";
      $("collectHint").textContent = ok ? `上次 ${ago(d.last_ok)} · 运行 ${fmtDur(d.uptime)}` : (d.last_error || "—");
      renderLive();
    } catch (e) {
      $("statusDot").className = "dot err";
      $("statusText").textContent = "离线";
    }
  }

  function drawChart(days) {
    const cv = $("chart");
    if (!cv.clientWidth) return; // 抽屉收起时不画
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
    g.fillStyle = muted; g.strokeStyle = line; g.lineWidth = 1;
    if (!days || !days.length) { g.fillText("无数据", 10, 20); return; }
    const padL = 52, padB = 22, padT = 12;
    const w = (cssW - padL - 8) / days.length;
    const maxV = Math.max(1, ...days.map((d) => Math.max(d.tx || 0, d.rx || 0)));
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
      if (days.length <= 16 || i % 2 === 0) { g.fillStyle = muted; g.fillText(d.day.slice(5), x - 2, cssH - 6); }
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
        ? top.map((t) => `<tr><td class="addr">${esc(t.addr)}</td><td class="num">${t.count}</td>
          <td class="num">${fmtBytes(t.tx)}</td><td class="num">${fmtBytes(t.rx)}</td>
          <td class="num">${fmtBytes((t.tx || 0) + (t.rx || 0))}</td></tr>`).join("")
        : `<tr><td colspan="5" class="empty">暂无数据</td></tr>`;
    } catch (e) { /* 下一轮重试 */ }
  }

  async function loadHistory(reset) {
    if (reset) adm.hOffset = 0;
    const date = $("hDate").value;
    const q = encodeURIComponent($("hQuery").value.trim());
    $("hBody").innerHTML = `<tr><td colspan="8" class="empty">查询中…</td></tr>`;
    try {
      const d = await api(`${BASE}/api/history?date=${date}&q=${q}&limit=${adm.hLimit}&offset=${adm.hOffset}`);
      adm.hTotal = d.total || 0;
      $("hMeta").textContent = `${d.date} · 命中 ${d.total} 条 · 第 ${Math.floor(adm.hOffset / adm.hLimit) + 1} 页`;
      const rows = d.rows || [];
      $("hBody").innerHTML = rows.length
        ? rows.map((c) => `<tr><td>${fmtTime(c.t2)}</td><td>${esc(c.srv || "-")}</td>
          <td class="addr">${esc(c.a || "—")}</td><td>${esc(c.u || "-")}</td>
          <td class="num">${fmtBytes(c.tx)}</td><td class="num">${fmtBytes(c.rx)}</td>
          <td class="num">${fmtBytes((c.tx || 0) + (c.rx || 0))}</td>
          <td class="num">${fmtDur(c.d || 0)}</td></tr>`).join("")
        : `<tr><td colspan="8" class="empty">该条件下没有记录</td></tr>`;
    } catch (e) {
      $("hBody").innerHTML = `<tr><td colspan="8" class="empty">查询失败：${esc(e.message)}</td></tr>`;
    }
  }

  const steamTag = (u) => u.steam_state === "in-game" ? ` <span class="tag live">正在玩 ${esc(u.game || "游戏")}</span>`
    : u.steam_state === "online" ? ' <span class="tag live">Steam 在线</span>'
    : u.steam_state === "offline" ? ' <span class="tag">Steam 离线</span>' : "";
  async function loadUsers() {
    try {
      const d = await api(BASE + "/api/users");
      const list = d.users || [];
      $("uMeta").textContent = `${list.length} / ${d.slots_total || 0} 通道已用`;
      const stName = (s) => s === "monthly" ? "月满" : s === "daily" ? "待续" : "正常";
      $("uBody").innerHTML = list.length
        ? list.map((u) => `<tr><td title="${esc(u.summary || "")}">${u.avatar ? `<img class="avatar sm" src="${esc(u.avatar)}" alt=""> ` : ""}${esc(u.nick || u.name)}${u.enabled ? "" : ' <span class="tag">停用</span>'}${steamTag(u)}<br><span class="hide-sm mono" style="font-size:10.5px;color:var(--muted)">${esc(u.name)}</span></td>
          <td class="mono">${esc(u.hy_user)}</td>
          <td>${stName(u.state)}</td>
          <td class="num">${fmtBytes(u.day_used)} / ${fmtBytes(u.daily_quota)}${u.vless_mon ? `<br><span class="sub2">VLESS ${fmtBytes(u.vless_day)}</span>` : ""}</td>
          <td class="num">${fmtBytes(u.mon_used)} / ${fmtBytes(u.mon_quota)}${u.vless_mon ? `<br><span class="sub2">VLESS ${fmtBytes(u.vless_mon)}</span>` : ""}</td>
          <td class="num">${(u.daily_quota / 1073741824).toFixed(0)}G / ${(u.mon_quota / 1073741824).toFixed(0)}G</td>
          <td><button data-u="toggle" data-n="${esc(u.name)}">${u.enabled ? "停用" : "启用"}</button>
          <button data-u="quota" data-n="${esc(u.name)}">配额</button>
          <button data-u="rotate" data-n="${esc(u.name)}">换链接</button>
          <button data-u="del" data-n="${esc(u.name)}">删除</button></td></tr>`).join("")
        : `<tr><td colspan="7" class="empty">暂无注册用户</td></tr>`;
      $("uBody").querySelectorAll("button").forEach((b) => {
        b.onclick = async () => {
          const n = b.dataset.n, act = b.dataset.u;
          if (act === "del" && !confirm(`删除用户 ${n}？其订阅链接立即失效`)) return;
          if (act === "rotate" && !confirm(`重置 ${n} 的订阅链接？旧链接立即失效`)) return;
          if (act === "quota") {
            const dg = prompt(`设置 ${n} 的日配额 GB（0=默认10G）：`, "0");
            if (dg === null) return;
            const mg = prompt(`设置 ${n} 的月配额 GB（0=默认100G）：`, "0");
            if (mg === null) return;
            try {
              await api(BASE + "/api/user/quota", { method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user: n, daily_gb: Number(dg), monthly_gb: Number(mg) }) });
              loadUsers();
            } catch (e) { alert(e.message); }
            return;
          }
          const ep = act === "toggle" ? "/api/user/enable" : act === "rotate" ? "/api/user/rotate" : "/api/user/delete";
          const body = act === "toggle"
            ? { user: n, on: b.textContent === "启用" }
            : { user: n };
          try {
            await api(BASE + ep, { method: "POST",
              headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            if (act === "rotate") alert("已生成新链接，旧链接立即失效（用户去自己面板复制）");
            loadUsers();
          } catch (e) { alert(e.message); }
        };
      });
    } catch (e) {
      $("uBody").innerHTML = `<tr><td colspan="7" class="empty">加载失败：${esc(e.message)}</td></tr>`;
    }
    try {
      const o = await api(BASE + "/api/overview");
      let dev = "设备总额 未配置";
      if (o.device && o.device.servers) {
        let tu = 0, td = 0;
        o.device.servers.forEach((s) => { tu += s.up_mib || 0; td += s.down_mib || 0; });
        dev = `设备总额 ↑${tu.toFixed(0)}M ↓${td.toFixed(0)}M`;
      }
      $("devMeta").textContent = `${dev} · 用户合计 ${fmtBytes((o.users_tx || 0) + (o.users_rx || 0))}`;
    } catch (e) { /* 忽略 */ }
  }

  async function loadSettings() {
    try {
      const d = await api(BASE + "/api/settings");
      $("basePath").value = d.base_path || "";
    } catch (e) { /* 忽略 */ }
  }
  async function saveBase(restart) {
    const p = $("basePath").value.trim();
    if (!/^\/[A-Za-z0-9_\-/]{1,64}$/.test(p.replace(/\/$/, ""))) { alert("路径需以 / 开头，仅字母数字/_/-"); return; }
    try {
      const d = await api(BASE + "/api/base_path", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p }) });
      if (!restart) { alert("已保存" + (d.changed ? "" : "（未变化）")); return; }
      if (!confirm(`保存为 ${d.base_path} 并重启面板？重启约3秒，之后需用新地址+重登`)) return;
      await api(BASE + "/api/restart", { method: "POST" });
      alert("重启中，10秒后用新地址访问");
    } catch (e) { alert(e.message); }
  }
  function initAdmin() {
    $("liveFilter").oninput = renderLive;
    $("pauseBtn").onclick = () => {
      adm.paused = !adm.paused;
      $("pauseBtn").textContent = adm.paused ? "继续刷新" : "暂停刷新";
      if (!adm.paused) loadLive();
    };
    $("oRefresh").onclick = loadSummary;
    $("oDays").onchange = loadSummary;
    $("hSearch").onclick = () => loadHistory(true);
    $("hQuery").onkeydown = (e) => { if (e.key === "Enter") loadHistory(true); };
    $("hDate").onchange = () => loadHistory(true);
    $("hNext").onclick = () => { if (adm.hOffset + adm.hLimit < adm.hTotal) { adm.hOffset += adm.hLimit; loadHistory(false); } };
    $("hPrev").onclick = () => { if (adm.hOffset > 0) { adm.hOffset = Math.max(0, adm.hOffset - adm.hLimit); loadHistory(false); } };
    $("uRefresh").onclick = loadUsers;
    $("hkRefresh").onclick = async () => {
      try {
        await api(BASE + "/api/hostker/refresh", { method: "POST" });
        loadUsers();
      } catch (e) { alert(e.message); }
    };
    $("baseSave").onclick = () => saveBase(false);
    $("baseRestart").onclick = () => saveBase(true);
    document.querySelectorAll("#view-admin .tabs button").forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll("#view-admin .tabs button").forEach((x) => x.setAttribute("aria-selected", "false"));
        b.setAttribute("aria-selected", "true");
        const t = b.dataset.tab;
        ["live", "history", "overview", "users", "settings"].forEach((k) => { $("tab-" + k).hidden = k !== t; });
        if (t === "overview") loadSummary();
        if (t === "history") loadHistory(true);
        if (t === "users") loadUsers();
        if (t === "settings") loadSettings();
      };
    });
    const today = new Date(), p = (n) => String(n).padStart(2, "0");
    $("hDate").value = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
    loadLive(); loadSummary();
    setInterval(loadLive, 1000);
    setInterval(loadSummary, 30000);
    setInterval(() => { if (!$("tab-users").hidden) loadUsers(); }, 30000);
  }

  // ================= 用户端 =================
  async function initUser(me) {
    $("pwBtn").style.display = "none"; // 用户无密码，用 Steam 登录
    const nick = me.nick || me.user;
    $("subline").textContent = `user · ${nick} (${me.hy_user})` + (me.steam_state === "in-game" ? ` · 正在玩 ${me.game || "游戏"}` : "");
    $("myTraffic").onclick = () => { closeConsole(); cabin.open({ title: nick }); };
    const av = $("myAvatar");
    if (av && me.avatar) { av.src = me.avatar; av.hidden = false; }
    let link = location.origin + "/" + me.sub_token;
    const refreshLink = (tok) => {
      link = location.origin + "/" + tok;
      $("subLink").value = link;
    };
    refreshLink(me.sub_token);
    const copyLink = async (btn, label) => {
      try { await navigator.clipboard.writeText(link); }
      catch (e) { $("subLink").select(); document.execCommand("copy"); }
      btn.textContent = "已复制";
      setTimeout(() => { btn.textContent = label; }, 1500);
    };
    $("copySub").onclick = () => copyLink($("copySub"), "复制链接");
    $("a-sub").hidden = false;
    $("a-sub").onclick = () => copyLink($("a-sub"), "复制订阅");
    $("clashSub").onclick = () => {
      location.href = "clash://install-config?url=" + encodeURIComponent(link);
    };
    $("rotSub").onclick = async () => {
      try {
        const d = await api(BASE + "/api/my/rotate", { method: "POST" });
        refreshLink(d.sub_token);
        $("rotMsg").textContent = d.nodes_reset ? "已换新链接：旧链接和旧 hy2 节点都已失效，请在客户端更新订阅" : "已换新链接，旧链接已失效";
      } catch (e) { $("rotMsg").textContent = e.message; }
    };
    $("renewBtn").onclick = async () => {
      try {
        await api(BASE + "/api/my/renew", { method: "POST" });
        $("renewMsg").textContent = "续额成功";
        loadMine();
      } catch (e) { $("renewMsg").textContent = e.message; }
    };
    async function loadMine() {
      try {
        const d = await api(BASE + "/api/my/summary");
        $("myDay").textContent = `${fmtBytes(d.day_used)} / ${fmtBytes(d.day_granted)}`;
        $("myDayHint").textContent = `日配额 ${fmtBytes(d.daily_quota)}` + (d.vless_mon ? ` · VLESS 今日 ${fmtBytes(d.vless_day)} / 本月 ${fmtBytes(d.vless_mon)}（不计配额）` : "");
        $("myMon").textContent = `${fmtBytes(d.mon_used)} / ${fmtBytes(d.monthly_quota)}`;
        $("myQuota").textContent = `月配额 ${fmtBytes(d.monthly_quota)}`;
        const st = d.state === "monthly" ? ["月限额已满", "本月额度用完，等下月"]
          : d.state === "daily" ? ["待续额", "今日额度用完，点续额"] : ["正常", `通道 ${me.hy_user}`];
        $("myState").textContent = st[0];
        $("myStateHint").textContent = st[1];
        $("renewBtn").disabled = d.state !== "daily";
        $("statusDot").className = "dot " + (d.state === "ok" ? "ok" : "err");
        $("statusText").textContent = st[0];
      } catch (e) {
        $("statusDot").className = "dot err";
        $("statusText").textContent = "离线";
      }
    }
    loadMine();
    setInterval(loadMine, 30000);
  }

  // ================= 入口 =================
  (async () => {
    try {
      const me = await api(BASE + "/api/me");
      $("a-console").textContent = me.role === "admin" ? "控制台" : "我的订阅";
      if (me.role === "admin") {
        $("view-admin").hidden = false;
        initAdmin();
      } else {
        $("view-user").hidden = false;
        initUser(me);
      }
    } catch (e) { /* api() 已跳登录 */ }
  })();
})();
