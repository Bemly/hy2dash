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

  const savedTheme = localStorage.getItem("hy2dash_theme");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $("themeBtn").onclick = () => {
    const cur = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = cur;
    localStorage.setItem("hy2dash_theme", cur);
  };
  $("logoutBtn").onclick = async () => { await fetch(BASE + "/api/logout", { method: "POST" }); location.href = BASE + "/login"; };
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

  async function loadUsers() {
    try {
      const d = await api(BASE + "/api/users");
      const list = d.users || [];
      $("uMeta").textContent = `${list.length} / ${d.slots_total || 0} 通道已用`;
      const stName = (s) => s === "monthly" ? "月满" : s === "daily" ? "待续" : "正常";
      $("uBody").innerHTML = list.length
        ? list.map((u) => `<tr><td>${esc(u.nick || u.name)}${u.enabled ? "" : ' <span class="tag">停用</span>'}<br><span class="hide-sm mono" style="font-size:10.5px;color:var(--muted)">${esc(u.name)}</span></td>
          <td class="mono">${esc(u.hy_user)}</td>
          <td>${stName(u.state)}</td>
          <td class="num">${fmtBytes(u.day_used)} / ${fmtBytes(u.daily_quota)}</td>
          <td class="num">${fmtBytes(u.mon_used)} / ${fmtBytes(u.mon_quota)}</td>
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
    $("subline").textContent = `user · ${nick} (${me.hy_user})`;
    const av = $("myAvatar");
    if (av && me.avatar) { av.src = me.avatar; av.hidden = false; }
    const link = location.origin + BASE + "/" + me.sub_token;
    $("subLink").value = link;
    $("copySub").onclick = async () => {
      try { await navigator.clipboard.writeText(link); $("copySub").textContent = "已复制"; }
      catch (e) { $("subLink").select(); document.execCommand("copy"); }
      setTimeout(() => { $("copySub").textContent = "复制链接"; }, 1500);
    };
    $("clashSub").onclick = () => {
      location.href = "clash://install-config?url=" + encodeURIComponent(link);
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
        $("myDayHint").textContent = `日配额 ${fmtBytes(d.daily_quota)}`;
        $("myMon").textContent = `${fmtBytes(d.mon_used)} / ${fmtBytes(d.monthly_quota)}`;
        $("myQuota").textContent = `月配额 ${fmtBytes(d.monthly_quota)}`;
        const st = d.state === "monthly" ? ["月限额已满", "本月额度用完，等下月"]
          : d.state === "daily" ? ["待续额", "今日额度用完，点续额"] : ["正常", `通道 ${me.hy_user}`];
        $("myState").textContent = st[0];
        $("myStateHint").textContent = st[1];
        $("renewBtn").disabled = d.state === "monthly";
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
