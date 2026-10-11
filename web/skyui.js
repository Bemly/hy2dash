/* hy2dash 空港 UI：mihomoui chrome 接线 + 用户↔飞船映射（经典 script，依赖 window.__sky）。
 * 机位映射：hy_user u0k → 第 k-1 艘（GATE k），槽位≤8 机队 9 机恒有空位。
 * 在线人数变化 → 对应飞船起降；登机牌每行显示 GATE↔用户；测速为控制面实测往返。
 * 非 admin 只看自己那艘（他人信息不下发）。 */
(() => {
  const $ = (id) => document.getElementById(id);
  const BASE = location.pathname.replace(/\/[^/]*$/, '');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtBytes = (v) => {
    v = Number(v) || 0;
    if (v < 1024) return v + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
    return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + u[i];
  };
  const fmtRate = (b) => b > 1e6 ? (b / 1e6).toFixed(1) + ' MB/s'
    : b > 1e3 ? (b / 1e3).toFixed(0) + ' KB/s' : Math.round(b) + ' B/s';

  async function api(path, opts) {
    const r = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts || {}));
    if (r.status === 401) { location.href = BASE + '/login'; throw new Error('unauthorized'); }
    const ct = r.headers.get('content-type') || '';
    const body = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
    return body;
  }

  const toastEl = $('toast');
  let toastT;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => toastEl.classList.remove('show'), 1900);
  }

  const sky = () => window.__sky || null;
  function whenSky(fn) {
    if (window.__sky) { fn(window.__sky); return; }
    const h = () => { document.removeEventListener('skyready', h); if (window.__sky) fn(window.__sky); };
    document.addEventListener('skyready', h);
    setTimeout(() => { if (window.__sky) fn(window.__sky); }, 8000);
  }
  document.addEventListener('skyfailed', () => {
    const l = $('load'); if (l) l.remove();
    toast('3D 背景加载失败，仅控制台可用');
  });

  const S = {
    role: null, me: null, users: [], online: {}, totals: {},
    prevTotals: {}, prevT: 0, apiMs: null, craftUser: [],
    lastOnlineKey: null, selected: 0, testing: false,
  };
  const NCRAFT = 9;

  function sortedUsers() {
    return S.users.slice().sort((a, b) => String(a.hy_user || '').localeCompare(String(b.hy_user || '')));
  }
  function rebuildMapping() {
    const list = sortedUsers().slice(0, NCRAFT);
    S.craftUser = new Array(NCRAFT).fill(null);
    list.forEach((u, i) => { S.craftUser[i] = u; });
  }
  function onlineKey() {
    return sortedUsers().map((u) => (S.online[u.hy_user] ? '1' : '0')).join('');
  }
  function userRate(hy) {
    const t = S.totals[hy];
    const p = S.prevTotals[hy];
    const now = Date.now() / 1000;
    if (!t || !p || now <= S.prevT) return 0;
    return Math.max(0, ((t.rx || 0) - (p.rx || 0)) / (now - S.prevT));
  }

  function ensureRows() {
    const list = $('list');
    if (!list || list.children.length === NCRAFT) return;
    list.innerHTML = '';
    for (let i = 0; i < NCRAFT; i++) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<div class="thumb"><img alt=""><i>G${i + 1}</i></div>
        <div class="mid"><div class="nm">—</div>
        <div class="meta"><span class="pill">停泊中</span><span class="seat"></span><span class="dst"></span></div></div>
        <div class="right"><div class="lat">— ms</div><button class="fly-btn">起飞</button></div>`;
      row.onclick = () => selectCraft(i);
      row.querySelector('.fly-btn').onclick = (e) => { e.stopPropagation(); toggleCraft(i); };
      list.appendChild(row);
    }
  }

  function craftName(i) {
    const u = S.craftUser[i];
    return u ? (u.nick || u.name) : null;
  }

  function selectCraft(i) {
    S.selected = i;
    const sk = sky();
    if (sk) sk.select(i, true);
    refreshFlights(true);
  }
  window.__skysel = (i) => selectCraft(i);

  async function toggleCraft(i) {
    if (S.role !== 'admin') return;
    const u = S.craftUser[i];
    if (!u) return;
    try {
      await api(BASE + '/api/user/enable', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: u.name, on: !u.enabled }) });
      toast(`${craftName(i)} 已${u.enabled ? '停用' : '启用'}`);
      await loadUsers();
    } catch (e) { toast(e.message); }
  }

  async function bulkEnable(on) {
    if (S.role !== 'admin') return;
    if (!confirm(on ? '启用全部用户？' : '停用全部用户？其会话会被断开')) return;
    for (const u of S.users) {
      if (!!u.enabled === on) continue;
      try {
        await api(BASE + '/api/user/enable', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user: u.name, on }) });
      } catch (e) { toast(e.message); break; }
    }
    toast(on ? '已全部启用' : '已全部停用');
    await loadUsers();
  }

  async function speedTest() {
    if (S.testing) return;
    S.testing = true;
    const sk = sky();
    toast('从控制塔发出测速波…');
    try {
      const t0 = performance.now();
      if (sk) sk.pingAllPads();
      if (S.role === 'admin') await api(BASE + '/api/live');
      else await api(BASE + '/api/my/summary');
      S.apiMs = Math.round(performance.now() - t0);
      toast(`控制面往返 ${S.apiMs} ms`);
    } catch (e) { toast(e.message); }
    S.testing = false;
    refreshFlights(true);
  }

  function setMode(m) {
    const sk = sky();
    if (sk) sk.setMode(m);
    document.querySelectorAll('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    $('seg-tip').textContent = {
      rule: '规则：飞船跟随用户在线状态自动起降',
      global: '全局：全部飞船展示起飞（仅展示，不改用户状态）',
      direct: '直连：全部飞船停放展示（仅展示，不改用户状态）',
    }[m] || '';
    if (m === 'rule') resyncFlights();
    refreshFlights(true);
  }

  function resyncFlights() {
    const sk = sky();
    if (!sk || sk.netMode !== 'rule') return;
    for (let i = 0; i < NCRAFT; i++) {
      const u = S.craftUser[i];
      const on = !!(u && u.enabled && S.online[u.hy_user]);
      const f = sk.flights[i];
      if (on && !f.outbound) sk.launch(i, true);
      else if (!on && f.outbound) sk.recall(i, true);
    }
  }

  function refreshFlights(force) {
    const sk = sky();
    if (!sk) return;
    const myKey = S.craftUser.map((u) => (u ? u.hy_user + S.online[u.hy_user] : '')).join()
      + sk.flights.map((f) => f.mode).join() + S.selected + sk.netMode + (S.apiMs || '');
    if (!force && refreshFlights._sig === myKey) return;
    refreshFlights._sig = myKey;
    const rows = $('list') ? $('list').children : [];
    let n = 0;
    for (let i = 0; i < NCRAFT; i++) {
      const f = sk.flights[i];
      const u = S.craftUser[i];
      const row = rows[i];
      if (row) {
        row.classList.toggle('on', i === S.selected);
        const img = row.querySelector('.thumb img');
        if (img && !img.src) img.src = sk.thumbs[i];
        const nm = row.querySelector('.nm');
        const pill = row.querySelector('.pill');
        const seat = row.querySelector('.seat');
        const dst = row.querySelector('.dst');
        const lat = row.querySelector('.lat');
        const btn = row.querySelector('.fly-btn');
        nm.textContent = u ? (u.nick || u.name) : f.def.name;
        const modeTxt = { park: '停泊中', up: '离场', go: '起飞', cruise: '巡航', back: '返航', down: '降落' }[f.mode] || f.mode;
        pill.textContent = u && !u.enabled ? '已停用' : modeTxt;
        pill.className = 'pill ' + (!u || !u.enabled ? '' : { up: 'up', go: 'fly', cruise: 'fly', back: 'ret', down: 'ret', park: '' }[f.mode] || '');
        seat.textContent = u ? `${u.hy_user} · ${fmtBytes(u.day_used || 0)}` : '空位';
        dst.textContent = u ? `→ ${fmtBytes(u.mon_used || 0)}/月` : `→ ${f.def.dest}`;
        lat.textContent = S.apiMs == null ? '— ms' : S.apiMs + ' ms';
        btn.textContent = !u ? '—' : u.enabled ? (f.outbound ? '返航' : '起飞') : '启用';
        btn.classList.toggle('ret', !!(u && u.enabled && f.outbound));
        btn.disabled = S.role !== 'admin' || !u || sk.netMode === 'direct';
        btn.style.display = S.role === 'admin' ? '' : 'none';
        btn.onclick = (e) => { e.stopPropagation(); toggleCraft(i); };
      }
      if (f.airborne) n++;
    }
    const badge = $('b-fly');
    if (badge) {
      badge.textContent = `${n} / ${NCRAFT} 在飞`;
      badge.classList.toggle('hot', n > 0);
    }
    // 信息卡
    const f = sk.flights[S.selected];
    const u = S.craftUser[S.selected];
    const thumb = $('i-thumb');
    if (thumb && thumb.dataset.idx !== String(S.selected)) {
      thumb.dataset.idx = String(S.selected);
      thumb.innerHTML = `<img src="${sk.thumbs[S.selected]}" alt="">`;
      thumb.style.setProperty('--c', '#' + f.def.color.toString(16).padStart(6, '0'));
    }
    if ($('i-name')) $('i-name').textContent = u ? (u.nick || u.name) : f.def.name;
    if ($('i-sub')) $('i-sub').textContent = u
      ? `GATE ${S.selected + 1} · ${u.hy_user} · ${fmtBytes(u.day_used || 0)} / ${fmtBytes(u.daily_quota || 0)}`
      : `GATE ${S.selected + 1} · ${f.def.sub} · → ${f.def.dest}`;
    if ($('i-state')) $('i-state').textContent = !u ? '空位' : !u.enabled ? '已停用' : (u.state === 'monthly' ? '月满' : u.state === 'daily' ? '待续' : '在线');
    if ($('i-alt')) $('i-alt').textContent = Math.max(0, Math.round((f.mesh.position.y - f.home.y) * 1.1)) + ' m';
    if ($('i-spd')) $('i-spd').textContent = Math.round(f.speed * 3.6 * 1.1) + ' km/h';
    if ($('i-lat')) $('i-lat').textContent = S.apiMs == null ? '—' : S.apiMs + ' ms';
    if ($('i-pax')) $('i-pax').textContent = u ? fmtBytes(u.mon_used || 0) : '—';
    if ($('i-dn')) $('i-dn').textContent = u ? fmtRate(userRate(u.hy_user)) : '0 B/s';
    const go = $('i-go');
    if (go) {
      go.textContent = !u ? '—' : u.enabled ? (f.outbound ? '返 航' : '起 飞') : '启 用';
      go.classList.toggle('ret', !!(u && u.enabled && f.outbound));
      go.disabled = S.role !== 'admin' || !u || sk.netMode === 'direct';
    }
    // 登机牌：飞船↔人
    sk.drawBoard(sk.flights.map((o, i) => {
      const uu = S.craftUser[i];
      return {
        gate: i + 1,
        name: uu ? (uu.nick || uu.name) : o.def.name,
        dest: uu ? uu.hy_user : o.def.dest,
        mode: o.mode,
        color: '#' + o.def.color.toString(16).padStart(6, '0'),
        lat: S.apiMs,
      };
    }));
  }

  async function loadUsers() {
    try {
      const d = await api(BASE + '/api/users');
      S.users = d.users || [];
    } catch (e) { /* 下一轮重试 */ }
  }

  async function loadLive() {
    try {
      const t0 = performance.now();
      const d = await api(BASE + '/api/live');
      S.apiMs = S.apiMs == null ? Math.round(performance.now() - t0) : S.apiMs;
      S.online = d.online || {};
      S.totals = d.user_total || {};
      const key = onlineKey();
      if (key !== S.lastOnlineKey) {
        S.lastOnlineKey = key;
        rebuildMapping();
        resyncFlights();
      }
      S.prevTotals = S.totals;
      S.prevT = Date.now() / 1000;
      refreshFlights(false);
    } catch (e) { /* 下一轮重试 */ }
  }

  async function loadMine() {
    try {
      const d = await api(BASE + '/api/my/summary');
      const me = S.me || {};
      const u = { hy_user: d.hy_user || me.hy_user, nick: me.nick || me.user, name: me.user,
        enabled: true, day_used: d.day_used, daily_quota: d.daily_quota,
        mon_used: d.mon_used, state: d.state };
      S.users = [u];
      const idx = Math.max(0, (parseInt(String(u.hy_user || 'u01').slice(1), 10) || 1) - 1);
      const ordered = new Array(NCRAFT).fill(null);
      if (idx < NCRAFT) ordered[idx] = u;
      S.craftUser = ordered;
      const on = d.state !== 'monthly';
      const sk = sky();
      if (sk && sk.netMode === 'rule') {
        const f = sk.flights[idx];
        if (on && !f.outbound) sk.launch(idx, true);
        else if (!on && f.outbound) sk.recall(idx, true);
      }
      S.totals = {}; S.prevTotals = {}; S.prevT = Date.now() / 1000;
      refreshFlights(false);
    } catch (e) { /* 下一轮重试 */ }
  }

  function bindChrome() {
    document.querySelectorAll('#seg button').forEach((b) => { b.onclick = () => setMode(b.dataset.m); });
    document.querySelectorAll('#cut button').forEach((b) => { b.onclick = () => {
      const sk = sky(); if (!sk) return;
      const level = +b.dataset.c;
      document.querySelectorAll('#cut button').forEach((x) => x.classList.toggle('on', +x.dataset.c === level));
      sk.setCut(level);
      toast(level === 0 ? '外观' : level === 1 ? '揭顶：屋顶和机舱顶盖拿掉' : '剖面：切到一楼');
    }; });
    document.querySelectorAll('#loc button').forEach((b) => { b.onclick = () => {
      const sk = sky(); if (!sk) return;
      document.querySelectorAll('#loc button').forEach((x) => x.classList.toggle('on', x === b));
      sk.goView(b.dataset.l);
    }; });
    const hideActs = S.role !== 'admin';
    if ($('a-test')) $('a-test').onclick = speedTest;
    if ($('a-all')) { $('a-all').onclick = () => bulkEnable(true); if (hideActs) $('a-all').style.display = 'none'; }
    if ($('a-home')) { $('a-home').onclick = () => bulkEnable(false); if (hideActs) $('a-home').style.display = 'none'; }
    if ($('i-go')) $('i-go').onclick = () => { toggleCraft(S.selected); };
    if ($('i-follow')) $('i-follow').onclick = () => {
      const sk = sky(); if (!sk) return;
      sk.setCam(sk.camModePublic() === 'follow' ? 'free' : 'follow');
      $('i-follow').classList.toggle('on', sk.camModePublic() === 'follow');
    };
    if ($('i-cabin')) $('i-cabin').onclick = () => {
      const sk = sky(); if (!sk) return;
      sk.setCam(sk.camModePublic() === 'cabin' ? 'free' : 'cabin');
      $('i-cabin').classList.toggle('on', sk.camModePublic() === 'cabin');
    };
    if ($('i-view')) $('i-view').onclick = () => { const sk = sky(); if (sk) sk.resetView(); };
    if ($('i-fx')) $('i-fx').onclick = () => {
      const sk = sky(); if (!sk) return;
      const on = sk.toggleFilter();
      $('i-fx').classList.toggle('on', on);
      toast(on ? '二次元滤镜：开' : '二次元滤镜：关');
    };
    const pt = $('panelToggle');
    if (pt) pt.onclick = () => document.body.classList.toggle('panel-closed');
    if (window.innerWidth < 1400) document.body.classList.add('panel-closed');
  }

  async function boot() {
    try {
      const me = await api(BASE + '/api/me');
      S.role = me.role;
      S.me = me;
    } catch (e) { return; }
    whenSky(() => {
      const sk = window.__sky;
      sk.toast(toast);
      ensureRows();
      rebuildMapping();
      bindChrome();
      setMode('rule');
      selectCraft(0);
      if (S.role === 'admin') {
        loadUsers().then(() => { rebuildMapping(); loadLive(); refreshFlights(true); });
        loadLive();
        setInterval(loadLive, 5000);
        setInterval(async () => { await loadUsers(); rebuildMapping(); refreshFlights(false); }, 30000);
      } else {
        loadMine();
        setInterval(loadMine, 30000);
      }
    });
  }
  boot();
})();
