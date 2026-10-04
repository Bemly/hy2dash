/* hy2dash 流量控制台 —— RhineLabUI 覆盖层
 * 跑在上游 RhineLabUI 应用内部（见 rhine/README.md），复用它的 terminal-modal
 * 视觉与主题变量，只和本机 Go 后端的 /api/* 对话。
 * 与上游主流程完全隔离：独立容器 #traffic-root、自有键盘隔离、
 * 自有轮询计时器；未知 data-action 不会触发上游逻辑（另有 stopPropagation）。
 */
import "./traffic.css";

const BASE = location.pathname.replace(/\/[^/]*$/, "");
const PARAM = new URLSearchParams(location.search).get("console") === "traffic";
const STICKY = "hy.traffic.open"; // 同一标签页内记住控制台开着，刷新后自动恢复

type Conn = {
  k: string; u: string; a: string; s?: string; st: string;
  tx: number; rx: number; t0: number; t1: number; t2?: number; d?: number;
};
type LiveResp = {
  live: Conn[]; online: Record<string, boolean>;
  user_total: Record<string, { tx: number; rx: number }>;
  last_error: string; last_ok: number; uptime: number; count: number;
};
type DayStat = { day: string; count: number; tx: number; rx: number };
type DomainStat = { addr: string; count: number; tx: number; rx: number };
type SummaryResp = {
  days: DayStat[]; top_domains: DomainStat[];
  total_tx: number; total_rx: number; total_conn: number;
  today_tx: number; today_rx: number; today_conn: number;
};

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, { credentials: "same-origin", ...opts });
  if (r.status === 401) { location.href = BASE + "/login"; throw new Error("unauthorized"); }
  const ct = r.headers.get("content-type") || "";
  const body = (ct.includes("json") ? await r.json() : await r.text()) as T;
  if (!r.ok) throw new Error(((body as unknown as { error?: string })?.error) || ("HTTP " + r.status));
  return body;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T | null;

function fmtBytes(v: number): string {
  v = Number(v) || 0;
  if (v < 1024) return v + " B";
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + " " + u[i];
}
function fmtDur(sec: number): string {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  if (sec < 60) return sec + "s";
  if (sec < 3600) return Math.floor(sec / 60) + "m" + (sec % 60 ? (sec % 60) + "s" : "");
  return Math.floor(sec / 3600) + "h" + Math.floor((sec % 3600) / 60) + "m";
}
function fmtTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function ago(ts: number): string {
  if (!ts) return "—";
  const s = Math.floor(Date.now() / 1000 - ts);
  return s < 0 ? "刚刚" : fmtDur(s) + "前";
}
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

const state = {
  open: false,
  paused: false,
  live: [] as Conn[],
  liveTimer: 0,
  sumTimer: 0,
  hOffset: 0,
  hLimit: 100,
  hTotal: 0,
  tab: "live" as "live" | "history" | "overview",
};

function badge(count: number) {
  const b = document.querySelector<HTMLElement>("[data-traffic-count]");
  if (b) b.textContent = String(count);
}

/* ---------- 实时 ---------- */
function renderLive() {
  const body = $("tf-live-body");
  const q = ($("tf-filter") as HTMLInputElement | null)?.value.trim().toLowerCase() ?? "";
  const rows = state.live.filter((c) =>
    !q || (c.a || "").toLowerCase().includes(q) || (c.u || "").toLowerCase().includes(q));
  const meta = $("tf-live-meta");
  if (meta) meta.textContent = `${rows.length} / ${state.live.length} 条`;
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="tf-empty">${state.live.length ? "无匹配连接" : "当前没有活跃连接"}</td></tr>`;
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  body.innerHTML = rows.map((c) => {
    const total = (c.tx || 0) + (c.rx || 0);
    return `<tr>
      <td class="tf-addr">${esc(c.a || "—")}</td>
      <td>${esc(c.u || "-")}</td>
      <td><span class="tf-tag">${esc(c.st || "open")}</span></td>
      <td class="tf-num">${fmtBytes(c.tx)}</td>
      <td class="tf-num">${fmtBytes(c.rx)}</td>
      <td class="tf-num">${fmtBytes(total)}</td>
      <td class="tf-num">${fmtDur(now - (c.t0 || now))} · ${ago(c.t1)}</td>
    </tr>`;
  }).join("");
}

async function loadLive() {
  if (!state.open || state.paused) return;
  try {
    const d = await api<LiveResp>("/api/live");
    state.live = d.live || [];
    badge(d.count || 0);
    const set = (id: string, v: string) => { const e = $(id); if (e) e.textContent = v; };
    set("tf-live-count", String(d.count || 0));
    const online = Object.entries(d.online || {}).filter(([, v]) => v).map(([k]) => k);
    set("tf-live-users", online.length ? online.join(", ") : "—");
    const ok = !d.last_error && !!d.last_ok;
    set("tf-state", ok ? "正常" : "异常");
    set("tf-state-hint", ok ? `上次 ${ago(d.last_ok)} · 运行 ${fmtDur(d.uptime)}` : (d.last_error || "—"));
    renderLive();
  } catch { /* 下一轮重试 */ }
}

/* ---------- 概览 ---------- */
function drawChart(days: DayStat[]) {
  const cv = $("tf-chart") as HTMLCanvasElement | null;
  if (!cv) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const cssW = cv.clientWidth || 600, cssH = 150;
  cv.width = cssW * dpr; cv.height = cssH * dpr;
  const g = cv.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);
  const cs = getComputedStyle(document.documentElement);
  const accent = cs.getPropertyValue("--theme-accent").trim() || "#9b7247";
  const ink = cs.getPropertyValue("--theme-ink").trim() || "#080a08";
  const line = cs.getPropertyValue("--theme-line").trim() || "#aaa59a";
  const muted = cs.getPropertyValue("--theme-muted").trim() || "#77756d";
  g.font = "10px ui-monospace, monospace";
  if (!days.length) { g.fillStyle = muted; g.fillText("无数据", 10, 20); return; }
  const padL = 52, padB = 20, padT = 10;
  const w = (cssW - padL - 8) / days.length;
  const maxV = Math.max(1, ...days.map((d) => Math.max(d.tx || 0, d.rx || 0)));
  g.strokeStyle = line; g.fillStyle = muted; g.lineWidth = 1;
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
    g.fillStyle = ink;
    g.globalAlpha = 0.45;
    g.fillRect(x + bw + 2, cssH - padB - h2, bw, h2);
    g.globalAlpha = 1;
    if (days.length <= 16 || i % 2 === 0) { g.fillStyle = muted; g.fillText(d.day.slice(5), x - 2, cssH - 6); }
  });
}

async function loadSummary() {
  if (!state.open) return;
  try {
    const sel = $("tf-days") as HTMLSelectElement | null;
    const days = Number(sel?.value) || 7;
    const d = await api<SummaryResp>(`/api/summary?days=${days}`);
    const set = (id: string, v: string) => { const e = $(id); if (e) e.textContent = v; };
    set("tf-today", fmtBytes((d.today_tx || 0) + (d.today_rx || 0)));
    set("tf-today-hint", `↑ ${fmtBytes(d.today_tx)} ↓ ${fmtBytes(d.today_rx)} · ${d.today_conn} 条`);
    set("tf-week", fmtBytes((d.total_tx || 0) + (d.total_rx || 0)));
    set("tf-week-hint", `连接数 ${d.total_conn || 0} · ${days} 天`);
    drawChart(d.days || []);
    const body = $("tf-top-body");
    if (body) {
      const top = d.top_domains || [];
      body.innerHTML = top.length
        ? top.map((t) => `<tr><td class="tf-addr">${esc(t.addr)}</td><td class="tf-num">${t.count}</td>
          <td class="tf-num">${fmtBytes(t.tx)}</td><td class="tf-num">${fmtBytes(t.rx)}</td>
          <td class="tf-num">${fmtBytes((t.tx || 0) + (t.rx || 0))}</td></tr>`).join("")
        : `<tr><td colspan="5" class="tf-empty">暂无数据</td></tr>`;
    }
  } catch { /* 下一轮重试 */ }
}

/* ---------- 历史 ---------- */
async function loadHistory(reset: boolean) {
  if (!state.open) return;
  if (reset) state.hOffset = 0;
  const date = (($("tf-date") as HTMLInputElement | null)?.value) || new Date().toISOString().slice(0, 10);
  const q = encodeURIComponent(($("tf-q") as HTMLInputElement | null)?.value.trim() ?? "");
  const body = $("tf-hist-body");
  if (body) body.innerHTML = `<tr><td colspan="5" class="tf-empty">查询中…</td></tr>`;
  try {
    const d = await api<{ date: string; total: number; rows: Conn[] }>(
      `/api/history?date=${date}&q=${q}&limit=${state.hLimit}&offset=${state.hOffset}`);
    state.hTotal = d.total || 0;
    const meta = $("tf-hist-meta");
    if (meta) meta.textContent = `${d.date} · ${d.total} 条 · 第 ${Math.floor(state.hOffset / state.hLimit) + 1} 页`;
    if (body) {
      const rows = d.rows || [];
      body.innerHTML = rows.length
        ? rows.map((c) => `<tr><td>${fmtTime(c.t2 ?? 0)}</td><td class="tf-addr">${esc(c.a || "—")}</td>
          <td class="tf-num">${fmtBytes(c.tx)}</td><td class="tf-num">${fmtBytes(c.rx)}</td>
          <td class="tf-num">${fmtDur(c.d || 0)}</td></tr>`).join("")
        : `<tr><td colspan="5" class="tf-empty">该条件下没有记录</td></tr>`;
    }
  } catch (e) {
    if (body) body.innerHTML = `<tr><td colspan="5" class="tf-empty">查询失败：${esc((e as Error).message)}</td></tr>`;
  }
}

/* ---------- 打开 / 关闭 ---------- */
function ensureRoot(): HTMLElement {
  let root = document.getElementById("traffic-root");
  if (root) return root;
  const stage = document.getElementById("stage") ?? document.body;
  root = document.createElement("div");
  root.id = "traffic-root";
  stage.appendChild(root);
  // 键盘隔离：控制台内的按键不向上传递到档案导航
  root.addEventListener("keydown", (e) => e.stopPropagation(), true);
  // 点击隔离：未知 data-action 不触发上游委托
  root.addEventListener("click", (e) => e.stopPropagation());
  return root;
}

function openConsole() {
  if (state.open) return;
  state.open = true;
  try { sessionStorage.setItem(STICKY, "1"); } catch { /* 忽略 */ }
  const root = ensureRoot();
  const today = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  root.innerHTML = `
  <div class="modal-backdrop" id="traffic-backdrop">
    <section class="terminal-modal traffic-modal" role="dialog" aria-modal="true" aria-label="流量监控">
      <div class="modal-top"><span>RHINE LAB / TRAFFIC CONSOLE</span>
        <button data-tf="close" aria-label="关闭">CLOSE <span>×</span></button></div>
      <div class="tf-cards">
        <div class="tf-card"><div class="tf-k">今日流量</div><div class="tf-v" id="tf-today">—</div><div class="tf-h" id="tf-today-hint">—</div></div>
        <div class="tf-card"><div class="tf-k">实时连接</div><div class="tf-v" id="tf-live-count">0</div><div class="tf-h" id="tf-live-users">—</div></div>
        <div class="tf-card"><div class="tf-k">累计流量</div><div class="tf-v" id="tf-week">—</div><div class="tf-h" id="tf-week-hint">—</div></div>
        <div class="tf-card"><div class="tf-k">采集状态</div><div class="tf-v" id="tf-state">—</div><div class="tf-h" id="tf-state-hint">—</div></div>
      </div>
      <div class="tf-tabs" role="tablist">
        <button role="tab" data-tf-tab="live" aria-selected="true">实时连接</button>
        <button role="tab" data-tf-tab="history" aria-selected="false">历史记录</button>
        <button role="tab" data-tf-tab="overview" aria-selected="false">概览</button>
        <span class="tf-sp"></span>
        <button data-tf="pause">暂停刷新</button>
        <button data-tf="password">修改密码</button>
        <button data-tf="logout">退出</button>
      </div>
      <div class="tf-pane" data-tf-pane="live">
        <div class="tf-bar"><input id="tf-filter" placeholder="过滤：域名 / IP / 用户…"><span id="tf-live-meta">—</span></div>
        <div class="tf-scroll"><table><thead><tr>
          <th>目标地址</th><th>用户</th><th>状态</th>
          <th class="tf-num">上行</th><th class="tf-num">下行</th><th class="tf-num">合计</th><th class="tf-num">持续 · 活跃</th>
        </tr></thead><tbody id="tf-live-body"></tbody></table></div>
      </div>
      <div class="tf-pane" data-tf-pane="history" hidden>
        <div class="tf-bar"><input type="date" id="tf-date" value="${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}">
          <input id="tf-q" placeholder="搜索域名 / IP / 用户…">
          <button data-tf="search">查询</button>
          <button data-tf="prev">上一页</button><button data-tf="next">下一页</button>
          <span id="tf-hist-meta">—</span></div>
        <div class="tf-scroll"><table><thead><tr>
          <th>结束时间</th><th>目标地址</th><th class="tf-num">上行</th><th class="tf-num">下行</th><th class="tf-num">时长</th>
        </tr></thead><tbody id="tf-hist-body"></tbody></table></div>
      </div>
      <div class="tf-pane" data-tf-pane="overview" hidden>
        <div class="tf-bar"><select id="tf-days">
          <option value="7">最近 7 天</option><option value="14">最近 14 天</option><option value="30">最近 30 天</option>
        </select><button data-tf="refresh">刷新</button></div>
        <div class="tf-chart"><canvas id="tf-chart"></canvas></div>
        <div class="tf-scroll tf-short"><table><thead><tr>
          <th>目标（Top 20）</th><th class="tf-num">连接数</th><th class="tf-num">上行</th><th class="tf-num">下行</th><th class="tf-num">合计</th>
        </tr></thead><tbody id="tf-top-body"></tbody></table></div>
      </div>
      <div class="tf-pass" hidden>
        <label>原密码<input type="password" id="tf-old"></label>
        <label>新密码（≥8 位）<input type="password" id="tf-new"></label>
        <button data-tf="save-pass">保存</button><span id="tf-pass-msg"></span>
      </div>
    </section>
  </div>`;

  const on = (sel: string, fn: (e: Event) => void) =>
    root.querySelector(`[data-tf="${sel}"]`)?.addEventListener("click", fn);
  on("close", () => closeConsole());
  root.querySelector("#traffic-backdrop")?.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id === "traffic-backdrop") closeConsole();
  });
  root.querySelectorAll<HTMLButtonElement>("[data-tf-tab]").forEach((b) => {
    b.addEventListener("click", () => {
      state.tab = b.dataset.tfTab as typeof state.tab;
      root.querySelectorAll("[data-tf-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      root.querySelectorAll("[data-tf-pane]").forEach((x) =>
        (x as HTMLElement).hidden = (x as HTMLElement).dataset.tfPane !== state.tab);
      if (state.tab === "overview") void loadSummary();
      if (state.tab === "history") void loadHistory(true);
    });
  });
  on("pause", (e) => {
    state.paused = !state.paused;
    (e.target as HTMLElement).textContent = state.paused ? "继续刷新" : "暂停刷新";
    if (!state.paused) void loadLive();
  });
  on("search", () => loadHistory(true));
  on("prev", () => {
    if (state.hOffset > 0) { state.hOffset = Math.max(0, state.hOffset - state.hLimit); void loadHistory(false); }
  });
  on("next", () => {
    if (state.hOffset + state.hLimit < state.hTotal) { state.hOffset += state.hLimit; void loadHistory(false); }
  });
  on("refresh", () => loadSummary());
  ($("tf-filter") as HTMLInputElement | null)?.addEventListener("input", renderLive);
  ($("tf-q") as HTMLInputElement | null)?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void loadHistory(true);
  });
  ($("tf-days") as HTMLSelectElement | null)?.addEventListener("change", () => loadSummary());
  on("password", () => {
    const f = root.querySelector<HTMLElement>(".tf-pass");
    if (f) f.hidden = !f.hidden;
  });
  on("save-pass", async () => {
    const msg = $("tf-pass-msg");
    const oldP = ($("tf-old") as HTMLInputElement | null)?.value ?? "";
    const newP = ($("tf-new") as HTMLInputElement | null)?.value ?? "";
    if (newP.length < 8) { if (msg) msg.textContent = "新密码至少 8 位"; return; }
    try {
      await api("/api/password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old: oldP, new: newP }),
      });
      if (msg) msg.textContent = "已更新";
    } catch (e) { if (msg) msg.textContent = (e as Error).message; }
  });
  on("logout", async () => {
    await fetch(BASE + "/api/logout", { method: "POST" });
    location.href = BASE + "/login";
  });

  void loadLive();
  void loadSummary();
  window.clearInterval(state.liveTimer);
  window.clearInterval(state.sumTimer);
  state.liveTimer = window.setInterval(() => loadLive(), 1000);
  state.sumTimer = window.setInterval(() => loadSummary(), 30000);
}

function closeConsole() {
  state.open = false;
  try { sessionStorage.removeItem(STICKY); } catch { /* 忽略 */ }
  window.clearInterval(state.liveTimer);
  window.clearInterval(state.sumTimer);
  document.getElementById("traffic-root")?.replaceChildren();
}

/* ---------- 导航入口 ---------- */
function mountNav() {
  const nav = document.querySelector(".system-nav");
  if (!nav || nav.querySelector("[data-traffic-btn]")) return;
  const btn = document.createElement("button");
  btn.dataset.trafficBtn = "1";
  btn.title = "流量监控";
  btn.setAttribute("aria-label", "打开流量监控");
  btn.innerHTML = `<span class="nav-glyph">◉</span> TRAFFIC <span class="key" data-traffic-count>0</span>`;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.open) closeConsole();
    else openConsole();
  });
  nav.appendChild(btn);
}

function autoOpen() {
  let want = PARAM;
  try { want = want || sessionStorage.getItem(STICKY) === "1"; } catch { /* 忽略 */ }
  if (!want || state.open) return;
  const stage = document.getElementById("stage");
  // 上游 StartupGate 需要一次点击进入；等阵列就绪后再弹控制台
  if (stage && (stage.dataset.mode === "archive" || stage.dataset.mode === "detail" || stage.dataset.boot === "done")) {
    openConsole();
    return;
  }
  const ob = new MutationObserver(() => {
    const m = stage?.dataset.mode;
    if (m === "archive" || m === "detail") { ob.disconnect(); openConsole(); }
  });
  if (stage) ob.observe(stage, { attributes: true, attributeFilter: ["data-mode", "data-boot"] });
  window.setTimeout(() => ob.disconnect(), 120000);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.open) { e.stopPropagation(); closeConsole(); }
}, true);

mountNav();
autoOpen();
