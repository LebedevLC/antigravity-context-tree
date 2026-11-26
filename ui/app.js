import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "context-tree-monitor", version: "1.0.0" }, {});

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const state = {
  connected: false,
  capabilities: {},
  hostContext: null,
  snapshot: null,
  viewMode: "simple", // "simple" | "detailed"
  groupBy: "project", // "project" | "context" | "date"
  collapsedGroups: new Set(),
  selectedId: null,
  userSelected: false, // keeps user's pick stable during background polling
  accordionOpenId: null, // for detailed aux_pane inline breakdown
  detailById: new Map(),
  loadingDetailId: null,
  expandedIds: new Set(),
  search: "",
  simpleSearchOpen: false,
  simpleChartOpen: false,
  simpleLimit: 20,
  renamingId: null,
  renameDraft: "",
  chipFilter: "all", // "all" | "branches" | "warn"
  settingsOpen: false,
  newChatOpen: false,
  newChatPrompt: "",
  inFlightSnapshot: false,
  pollTimer: null,
  lastError: null,
};

// ---------- Formatting Helpers ----------

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTokens(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(num >= 10_000_000 ? 1 : 2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(num >= 100_000 ? 0 : 1)}K`;
  return String(num);
}

function fmtExact(n) {
  return (Number(n) || 0).toLocaleString("ru-RU");
}

function fmtAgo(iso) {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return "сейчас";
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}м`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}ч`;
  const days = Math.floor(hr / 24);
  if (days === 1) return "вчера";
  return `${days}д`;
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("visible");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 2200);
}

async function copyText(text, label = "Скопировано") {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      showToast(label);
      return;
    }
  } catch {
    // fallback below
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    showToast(label);
  } catch {
    showToast("Не удалось скопировать");
  }
}

// ---------- Host-context UUID detection ----------

function extractUuids(val, out = new Set(), depth = 0) {
  if (depth > 4 || val == null) return out;
  if (typeof val === "string") {
    const m = val.match(UUID_RE);
    if (m) m.forEach((u) => out.add(u.toLowerCase()));
    return out;
  }
  if (Array.isArray(val)) {
    val.forEach((x) => extractUuids(x, out, depth + 1));
    return out;
  }
  if (typeof val === "object") {
    Object.values(val).forEach((v) => extractUuids(v, out, depth + 1));
  }
  return out;
}

function detectHostConversationId(tree) {
  if (!tree || tree.length === 0) return null;
  const cands = extractUuids({
    hostContext: state.hostContext,
    href: typeof window !== "undefined" ? window.location?.href : "",
  });
  for (const cand of cands) {
    if (findNodeInTree(tree, cand)) return cand;
  }
  return null;
}

// ---------- Tree helpers ----------

function findNodeInTree(nodes, id) {
  if (!id || !Array.isArray(nodes)) return null;
  const target = id.toLowerCase();
  for (const n of nodes) {
    if ((n.id || "").toLowerCase() === target) return n;
    const found = findNodeInTree(n.children, target);
    if (found) return found;
  }
  return null;
}

function findPathToNode(nodes, id, acc = []) {
  if (!id || !Array.isArray(nodes)) return null;
  const target = id.toLowerCase();
  for (const n of nodes) {
    if ((n.id || "").toLowerCase() === target) return [...acc, n.id];
    const sub = findPathToNode(n.children, target, [...acc, n.id]);
    if (sub) return sub;
  }
  return null;
}

function branchHasWarning(node) {
  if (node.severity === "yellow" || node.severity === "red") return true;
  return (node.children || []).some(branchHasWarning);
}

function branchMatchesLocalSearch(node, q) {
  if (!q) return true;
  if (
    (node.title || "").toLowerCase().includes(q) ||
    (node.id || "").toLowerCase().includes(q) ||
    (node.modelName || "").toLowerCase().includes(q) ||
    (node.projectLabel || "").toLowerCase().includes(q) ||
    (node.role || "").toLowerCase().includes(q)
  ) {
    return true;
  }
  return (node.children || []).some((ch) => branchMatchesLocalSearch(ch, q));
}

function getFilteredRoots() {
  const roots = state.snapshot?.tree || [];
  const q = state.search.trim().toLowerCase();
  return roots.filter((r) => {
    if (state.viewMode === "detailed") {
      if (state.chipFilter === "branches" && (r.descendantCount || 0) === 0) return false;
      if (state.chipFilter === "warn" && !branchHasWarning(r)) return false;
    }
    if (q && !branchMatchesLocalSearch(r, q)) return false;
    return true;
  });
}

function getBranchMaxContext(node) {
  let mx = node.contextTokens || 0;
  for (const ch of node.children || []) {
    const c = getBranchMaxContext(ch);
    if (c > mx) mx = c;
  }
  return mx;
}

function getBranchLatestMs(node) {
  let mx = Date.parse(node.updatedAt || "") || 0;
  for (const ch of node.children || []) {
    const c = getBranchLatestMs(ch);
    if (c > mx) mx = c;
  }
  return mx;
}

function sortTreeForMode(nodes, groupBy) {
  if (!Array.isArray(nodes) || nodes.length === 0) return [];
  const cloned = nodes.map((n) => ({
    ...n,
    children: sortTreeForMode(n.children || [], groupBy),
  }));
  if (groupBy === "context") {
    cloned.sort((a, b) => (b.contextTokens || 0) - (a.contextTokens || 0));
  } else {
    cloned.sort((a, b) => getBranchLatestMs(b) - getBranchLatestMs(a));
  }
  return cloned;
}

function normalizeProjectGroup(label) {
  if (!label || typeof label !== "string") return "Без проекта";
  const top = label.split("/")[0].trim();
  return top || "Без проекта";
}

function getDateBucket(iso) {
  const ms = Date.parse(iso || "");
  if (!Number.isFinite(ms)) return { key: "date:older", label: "Ранее", order: 3 };
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYesterday = startToday - 86_400_000;
  const startWeek = startToday - 6 * 86_400_000;
  if (ms >= startToday) return { key: "date:today", label: "Сегодня", order: 0 };
  if (ms >= startYesterday) return { key: "date:yesterday", label: "Вчера", order: 1 };
  if (ms >= startWeek) return { key: "date:week", label: "Последние 7 дней", order: 2 };
  return { key: "date:older", label: "Ранее", order: 3 };
}

function getContextBucket(node) {
  const maxCtx = Math.max(node.contextTokens || 0, getBranchMaxContext(node));
  const hasWarn = branchHasWarning(node);
  if (hasWarn || node.severity === "red" || node.severity === "yellow") {
    return { key: "ctx:high", label: "Высокий / близко к порогу", order: 0 };
  }
  if (maxCtx >= 100_000) {
    return { key: "ctx:medium", label: "Средний (≥ 100K)", order: 1 };
  }
  return { key: "ctx:light", label: "Лёгкий (< 100K)", order: 2 };
}

function buildGroupedRoots(roots, groupBy) {
  const sorted = sortTreeForMode(roots, groupBy);
  const buckets = new Map();

  for (const r of sorted) {
    let key;
    let label;
    let order = 0;

    if (groupBy === "project") {
      label = normalizeProjectGroup(r.projectLabel);
      key = `proj:${label}`;
      order = label === "Без проекта" ? 1 : 0;
    } else if (groupBy === "context") {
      const b = getContextBucket(r);
      key = b.key;
      label = b.label;
      order = b.order;
    } else {
      const latestMs = getBranchLatestMs(r);
      const b = getDateBucket(latestMs ? new Date(latestMs).toISOString() : r.updatedAt);
      key = b.key;
      label = b.label;
      order = b.order;
    }

    if (!buckets.has(key)) {
      buckets.set(key, { key, label, order, items: [], maxCtx: 0, latestMs: 0, running: 0 });
    }
    const g = buckets.get(key);
    g.items.push(r);
    g.maxCtx = Math.max(g.maxCtx, getBranchMaxContext(r));
    g.latestMs = Math.max(g.latestMs, getBranchLatestMs(r));
    if (r.runState === "running") g.running++;
  }

  const list = Array.from(buckets.values());
  if (groupBy === "project") {
    list.sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return b.latestMs - a.latestMs;
    });
  } else {
    list.sort((a, b) => a.order - b.order);
  }

  // Ensure inside context groups items are strictly sorted by highest context descending
  if (groupBy === "context") {
    for (const g of list) {
      g.items.sort((a, b) => getBranchMaxContext(b) - getBranchMaxContext(a));
    }
  }

  return list;
}

function renderGroupSwitcher() {
  const g = state.groupBy;
  return `
    <div class="group-pills" role="tablist" aria-label="Группировка списка">
      <button class="group-pill ${g === "project" ? "active" : ""}" data-action="set-group" data-group="project">Проекты</button>
      <button class="group-pill ${g === "context" ? "active" : ""}" data-action="set-group" data-group="context">Контекст</button>
      <button class="group-pill ${g === "date" ? "active" : ""}" data-action="set-group" data-group="date">Дата</button>
    </div>
  `;
}

function renderGroupedList(roots, renderItemFn) {
  if (roots.length === 0) {
    return `<div class="empty-note">Ничего не найдено</div>`;
  }
  const groups = buildGroupedRoots(roots, state.groupBy);
  const isSearching = state.search.trim().length > 0;

  return groups
    .map((g) => {
      const isCollapsed = !isSearching && state.collapsedGroups.has(g.key);
      const totalSub = g.items.reduce((acc, it) => acc + (it.descendantCount || 0), 0);
      const countLabel = totalSub > 0 ? `${g.items.length} · +${totalSub}` : `${g.items.length}`;
      const rightMeta =
        g.running > 0
          ? `<span style="color:var(--fg-ok)">● ${g.running}</span>`
          : g.maxCtx > 0
          ? `макс ${fmtTokens(g.maxCtx)}`
          : "";

      return `
        <div class="group-section">
          <button class="group-header" data-action="toggle-group" data-group-key="${esc(g.key)}" aria-expanded="${!isCollapsed}">
            <span class="group-header-left">
              ${isCollapsed ? ICON_CHEVRON_RIGHT : ICON_CHEVRON_DOWN}
              <span class="group-header-name">${esc(g.label)}</span>
              <span class="group-header-count mono">(${countLabel})</span>
            </span>
            <span class="group-header-meta mono">${rightMeta}</span>
          </button>
          ${
            isCollapsed
              ? ""
              : `<div class="group-body">${g.items.map((item) => renderItemFn(item, false)).join("")}</div>`
          }
        </div>
      `;
    })
    .join("");
}

function getCurrentNode() {
  const snap = state.snapshot;
  if (!snap) return null;
  return (
    findNodeInTree(snap.tree, state.selectedId) ||
    snap.active ||
    snap.tree?.[0] ||
    null
  );
}

// ---------- Icons ----------

const ICON_TREE = `<svg class="brand-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="5" cy="4.5" r="2"/><circle cx="15" cy="10" r="2"/><circle cx="15" cy="15.5" r="2"/><path d="M5 6.5V15.5H13M5 10H13"/></svg>`;
const ICON_CHEVRON_DOWN = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5L6 7.5L9 4.5"/></svg>`;
const ICON_CHEVRON_RIGHT = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3L7.5 6L4.5 9"/></svg>`;
const ICON_REFRESH = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.4-3.7"/><path d="M13.5 2.5v2.8h-2.8"/></svg>`;
const ICON_SEARCH = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>`;
const ICON_COPY = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5h-.8A1.2 1.2 0 0 1 1.5 9.3V2.7A1.2 1.2 0 0 1 2.7 1.5h6.6a1.2 1.2 0 0 1 1.2 1.2v.8"/></svg>`;
const ICON_EDIT = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.3 2.3a1.6 1.6 0 0 1 2.3 2.3L6 12.2l-3.2.8.8-3.2 7.7-7.5z"/></svg>`;

// ---------- SVG Charts (Detailed Mode) ----------

function renderSparklineSvg(points, contextLimit, compactionThreshold) {
  if (!Array.isArray(points) || points.length === 0) {
    return `<div class="empty-note" style="padding:8px 0">Недостаточно шагов для графика</div>`;
  }
  const w = 320;
  const h = 54;
  const padX = 4;
  const padY = 6;
  const maxVal = Math.max(
    compactionThreshold * 1.15,
    ...points.map((p) => p.t || 0),
    10_000
  );
  const scaleMax = Math.min(contextLimit, maxVal);
  const gw = w - padX * 2;
  const gh = h - padY * 2;

  const coords = points.map((p, i) => {
    const x = padX + (points.length === 1 ? gw : (gw * i) / (points.length - 1));
    const y = padY + gh - gh * Math.min((p.t || 0) / scaleMax, 1);
    return { x, y, cp: Boolean(p.cp) };
  });

  const pathD = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const areaD = `${pathD} L${coords[coords.length - 1].x.toFixed(1)},${(padY + gh).toFixed(1)} L${coords[0].x.toFixed(1)},${(padY + gh).toFixed(1)} Z`;

  const thY = padY + gh - gh * Math.min(compactionThreshold / scaleMax, 1);
  const cpLines = coords
    .filter((c) => c.cp)
    .map(
      (c) =>
        `<line x1="${c.x.toFixed(1)}" y1="${padY}" x2="${c.x.toFixed(1)}" y2="${padY + gh}" stroke="var(--fg-warn)" stroke-width="1.5" stroke-dasharray="3,2" />` +
        `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3" fill="var(--fg-warn)" />`
    )
    .join("");
  const last = coords[coords.length - 1];

  return `
    <svg class="spark-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <line x1="${padX}" y1="${thY.toFixed(1)}" x2="${w - padX}" y2="${thY.toFixed(1)}" stroke="var(--fg-warn)" stroke-opacity="0.55" stroke-width="1" stroke-dasharray="4,3" />
      <path d="${areaD}" fill="var(--fg-ok)" fill-opacity="0.14" />
      <path d="${pathD}" fill="none" stroke="var(--fg-ok)" stroke-width="1.8" stroke-linejoin="round" />
      ${cpLines}
      <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="3" fill="var(--fg-info)" />
    </svg>
  `;
}

function renderDetailedChartSvg(history, contextLimit, compactionThreshold, { compact = false } = {}) {
  if (!Array.isArray(history) || history.length === 0) {
    return `<div class="empty-note">Нет завершённых шагов модели для построения графика</div>`;
  }
  const w = compact ? 360 : 640;
  const h = compact ? 138 : 190;
  const padL = compact ? 40 : 46;
  const padR = compact ? 10 : 14;
  const padT = compact ? 12 : 14;
  const padB = compact ? 20 : 24;
  const gw = w - padL - padR;
  const gh = h - padT - padB;
  const axisFont = compact ? 9.5 : 10;

  const peak = Math.max(...history.map((p) => p.t || 0), compactionThreshold * 1.15, 50_000);
  const scaleMax =
    peak > contextLimit * 0.65
      ? contextLimit
      : Math.min(contextLimit, Math.ceil(peak / 100_000) * 100_000);

  const gridLevels = compact ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const gridSvg = gridLevels
    .map((f) => {
      const y = padT + gh - gh * f;
      const val = Math.round(scaleMax * f);
      return (
        `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="var(--bd-2)" stroke-width="1" />` +
        `<text x="3" y="${(y + 3.5).toFixed(1)}" fill="var(--fg-3)" font-size="${axisFont}" font-family="var(--font-mono)">${esc(fmtTokens(val))}</text>`
      );
    })
    .join("");

  const coords = history.map((p, i) => {
    const x = padL + (history.length === 1 ? gw : (gw * i) / (history.length - 1));
    const y = padT + gh - gh * Math.min((p.t || 0) / scaleMax, 1);
    return { x, y, s: p.s, t: p.t, cp: Boolean(p.isCompaction) };
  });

  const pathD = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const areaD = `${pathD} L${coords[coords.length - 1].x.toFixed(1)},${(padT + gh).toFixed(1)} L${coords[0].x.toFixed(1)},${(padT + gh).toFixed(1)} Z`;

  const thY = padT + gh - gh * Math.min(compactionThreshold / scaleMax, 1);
  const cpSvg = coords
    .filter((c) => c.cp)
    .map(
      (c) =>
        `<line x1="${c.x.toFixed(1)}" y1="${padT}" x2="${c.x.toFixed(1)}" y2="${padT + gh}" stroke="var(--fg-warn)" stroke-width="1.5" stroke-dasharray="4,3" />` +
        `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${compact ? 3.5 : 4}" fill="var(--fg-warn)" />`
    )
    .join("");

  const xTicks = [0, Math.floor(coords.length / 2), coords.length - 1]
    .filter((idx, i, arr) => arr.indexOf(idx) === i && coords[idx])
    .map((idx) => {
      const c = coords[idx];
      const anchor = idx === 0 ? "start" : idx === coords.length - 1 ? "end" : "middle";
      return `<text x="${c.x.toFixed(1)}" y="${h - 4}" text-anchor="${anchor}" fill="var(--fg-3)" font-size="${axisFont}" font-family="var(--font-mono)">шаг ${c.s}</text>`;
    })
    .join("");

  const last = coords[coords.length - 1];

  return `
    <div class="chart-box">
      <svg class="chart-svg" viewBox="0 0 ${w} ${h}">
        ${gridSvg}
        <line x1="${padL}" y1="${thY.toFixed(1)}" x2="${w - padR}" y2="${thY.toFixed(1)}" stroke="var(--fg-warn)" stroke-width="1.2" stroke-dasharray="5,4" />
        <text x="${w - padR}" y="${Math.max(padT + 10, thY - 4).toFixed(1)}" text-anchor="end" fill="var(--fg-warn)" font-size="${axisFont}" font-weight="600">Порог ~${esc(fmtTokens(compactionThreshold))}</text>
        <path d="${areaD}" fill="var(--fg-ok)" fill-opacity="0.14" />
        <path d="${pathD}" fill="none" stroke="var(--fg-ok)" stroke-width="${compact ? 2 : 2.2}" stroke-linejoin="round" />
        ${cpSvg}
        <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="${compact ? 3.5 : 4}" fill="var(--fg-info)" />
        ${xTicks}
      </svg>
      <div class="chart-legend">
        <span>${compact ? "Контекст по шагам" : "Зелёная линия: занятый контекст на шаге"}</span>
        <span>${compact ? "Пунктир: порог / CHECKPOINT" : "Жёлтый пунктир: порог и события CHECKPOINT"}</span>
      </div>
    </div>
  `;
}

// ---------- Shared Progress Bar ----------

function renderProgressBar(contextTokens, contextLimit, compactionThreshold, severity, sizeClass = "") {
  const fillPct = contextLimit > 0 ? Math.min(100, (contextTokens / contextLimit) * 100) : 0;
  const threshPct = contextLimit > 0 ? Math.min(99, Math.max(2, (compactionThreshold / contextLimit) * 100)) : 45;
  const remaining = Math.max(0, compactionThreshold - contextTokens);
  const tip = `Занято ${fmtTokens(contextTokens)} из ${fmtTokens(contextLimit)} · порог ~${fmtTokens(compactionThreshold)}${
    remaining > 0 ? ` (запас ~${fmtTokens(remaining)})` : " (порог достигнут)"
  }`;
  return `
    <div class="bar-wrap ${sizeClass}" title="${esc(tip)}">
      <div class="bar-fill ${esc(severity)}" style="width:${fillPct.toFixed(2)}%"></div>
      <div class="bar-threshold" style="left:${threshPct.toFixed(2)}%"></div>
    </div>
  `;
}

// ---------- SIMPLE MODE VIEWS ----------

function renderSimpleChartSection(node, isGlobalRight = false) {
  if (!node) return "";
  const isOpen = state.simpleChartOpen;
  const detail = state.detailById.get(node.id) || null;
  const history =
    detail?.history ||
    (node.sparkline || []).map((p) => ({ s: p.s, t: p.t, isCompaction: Boolean(p.cp) }));
  const cls = isGlobalRight ? "" : "aux-only-active";
  const loadingHint = state.loadingDetailId === node.id ? " · загрузка…" : "";

  return `
    <button class="simple-chart-toggle ${isOpen ? "open" : ""} ${cls}" data-action="toggle-simple-chart" aria-expanded="${isOpen}">
      <span class="simple-chart-toggle-left">
        ${isOpen ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT}
        <span>Динамика контекста по шагам${loadingHint}</span>
      </span>
      <span class="mono" style="font-size:11px;color:var(--fg-3)">${isOpen ? "Скрыть" : `${node.plannerSteps} шагов`}</span>
    </button>
    ${
      isOpen
        ? `<div class="simple-chart-panel ${cls}">${renderDetailedChartSvg(history, node.contextLimit, node.compactionThreshold, { compact: !isGlobalRight })}</div>`
        : ""
    }
  `;
}

function renderSimpleActiveCard(node, isGlobalRight = false) {
  if (!node) {
    return `<div class="simple-card ${isGlobalRight ? "" : "aux-only-active"}"><div class="empty-note">Нет чатов в локальных логах</div></div>`;
  }
  const compBadge =
    node.compactionCount > 0
      ? `<span class="pill warn" title="Последнее сжатие: ${esc(fmtTime(node.lastCompactionAt))}">Сжатий: ${node.compactionCount}×</span>`
      : "";
  const children = node.children || [];
  const freeWindow = Math.max(0, node.contextLimit - node.contextTokens);
  const freeWindowPct = node.contextLimit > 0 ? Math.max(0, 100 - node.percentOfLimit).toFixed(1) : "100";
  const untilCompaction = Math.max(0, node.compactionThreshold - node.contextTokens);
  const isRenaming = state.renamingId === node.id;
  const projTag = node.projectLabel ? `<span class="proj-tag">${esc(node.projectLabel)}</span>` : "";

  return `
    <section class="simple-card ${isGlobalRight ? "" : "aux-only-active"}">
      <div class="simple-card-top">
        <div class="simple-title-wrap">
          <span class="dot ${node.runState === "running" ? "running" : "idle-soft"}" title="${node.runState}"></span>
          <div style="min-width:0;flex:1">
            ${
              isRenaming
                ? `
              <div class="rename-row">
                <input id="rename-input" class="rename-input" type="text" value="${esc(state.renameDraft)}" placeholder="Название чата (пусто = авто)…" />
                <button class="btn sm primary" data-action="save-rename" data-id="${esc(node.id)}">OK</button>
                <button class="btn sm" data-action="cancel-rename">×</button>
              </div>
            `
                : `<div class="simple-title" title="${esc(node.title)}">${esc(node.title)}</div>`
            }
            <div class="simple-sub">
              ${projTag}
              <span>${esc(node.modelShort)}</span>
              <span>·</span>
              <span>${node.userTurns} ходов</span>
              <span>·</span>
              <span>${esc(fmtAgo(node.updatedAt))}</span>
            </div>
          </div>
        </div>
        <div style="display:flex;gap:2px;flex-shrink:0">
          <button class="icon-btn" data-action="start-rename" data-id="${esc(node.id)}" title="Переименовать чат в мониторе">${ICON_EDIT}</button>
          <button class="icon-btn" data-action="copy-uri" data-id="${esc(node.id)}" title="Копировать ссылку conversation://${esc(node.id)}">${ICON_COPY}</button>
        </div>
      </div>

      <div class="simple-limits">
        <div class="simple-ctx-line">
          <div>
            <span class="simple-ctx-num mono sev-${esc(node.severity)}">${esc(fmtTokens(node.contextTokens))}</span>
            <span class="ctx-sub mono"> / ${esc(fmtTokens(node.contextLimit))} (${node.percentOfLimit}%)</span>
          </div>
          <span class="mono" style="font-size:11.5px;color:var(--fg-2)" title="Оставшийся лимит контекстного окна модели">
            Свободно <strong style="color:var(--fg-1)">${esc(fmtTokens(freeWindow))}</strong> (${freeWindowPct}%)
          </span>
        </div>

        ${renderProgressBar(node.contextTokens, node.contextLimit, node.compactionThreshold, node.severity, isGlobalRight ? "large" : "")}

        <div class="limit-line">
          <span class="mono">
            ${
              untilCompaction > 0
                ? `До сжатия <strong>~${esc(fmtTokens(untilCompaction))}</strong> <span style="color:var(--fg-3)">(порог ${esc(fmtTokens(node.compactionThreshold))})</span>`
                : `<strong style="color:var(--fg-warn)">Выше порога сжатия (${esc(fmtTokens(node.compactionThreshold))})</strong>`
            }
          </span>
          <span class="simple-ctx-meta">
            <span class="mono">Кэш ${node.cacheHitRatio}%</span>
            ${compBadge}
          </span>
        </div>
      </div>

      ${
        isGlobalRight
          ? `
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:2px">
          <button class="link-btn" data-action="set-mode" data-mode="detailed">График и детали в Подробном режиме →</button>
        </div>
        ${
          children.length > 0
            ? `
          <div style="margin-top:6px;padding-top:10px;border-top:1px solid var(--bd-2);display:flex;flex-direction:column;gap:5px">
            <div class="simple-section-label">Подчаты (${children.length})</div>
            ${children
              .map(
                (ch) => `
              <div class="simple-row" data-action="select-node" data-id="${esc(ch.id)}">
                <span class="dot ${ch.runState === "running" ? "running" : "idle-soft"}"></span>
                <span class="simple-row-title" title="${esc(ch.title)}">${esc(ch.title)}</span>
                <span class="simple-row-ctx mono sev-${esc(ch.severity)}">${esc(fmtTokens(ch.contextTokens))} · ${ch.percentOfLimit}%</span>
              </div>
            `
              )
              .join("")}
          </div>
        `
            : ""
        }
      `
          : ""
      }
    </section>
  `;
}

function renderSimpleTreeNode(node, isChild = false) {
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  const isExpanded = state.expandedIds.has(node.id);
  const isSelected = state.selectedId === node.id;
  // Hide redundant project pill when already grouped by project
  const projTag =
    !isChild && state.groupBy !== "project" && node.projectLabel
      ? `<span class="proj-tag">${esc(node.projectLabel)}</span>`
      : "";

  const subCount =
    hasChildren && !isExpanded
      ? `<span class="simple-sub-count">+${node.descendantCount}</span>`
      : "";

  const childrenHtml =
    hasChildren && isExpanded
      ? `<div class="simple-children">${node.children.map((ch) => renderSimpleTreeNode(ch, true)).join("")}</div>`
      : "";

  return `
    <div class="simple-branch">
      <div class="simple-row ${isChild ? "is-child" : ""} ${isSelected ? "selected" : ""}" data-action="select-node" data-id="${esc(node.id)}" title="${esc(node.projectLabel ? `[${node.projectLabel}] ` : "")}${esc(node.title)} · ${esc(node.modelName)}">
        ${
          hasChildren
            ? `<button class="toggle-btn" data-action="toggle-branch" data-id="${esc(node.id)}" title="${isExpanded ? "Свернуть" : "Раскрыть"}">${isExpanded ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT}</button>`
            : `<span class="toggle-spacer"></span>`
        }
        <span class="dot ${node.runState === "running" ? "running" : "idle-soft"}"></span>
        ${projTag}
        <span class="simple-row-title">${esc(node.title)}</span>
        ${subCount}
        <span class="simple-row-ctx mono sev-${esc(node.severity)}">${esc(fmtTokens(node.contextTokens))} · ${node.percentOfLimit}%</span>
      </div>
      ${childrenHtml}
    </div>
  `;
}

// ---------- DETAILED MODE VIEWS ----------

function renderDetailedActiveCard(node, settings) {
  if (!node) {
    return `<div class="card aux-only-active"><div class="empty-note">Нет локальных чатов в ~/.gemini/antigravity/brain/</div></div>`;
  }
  const isPinned = settings?.pinnedConversationId === node.id;
  const canMsg = Boolean(state.capabilities?.message);
  const canApiCreate = Boolean(state.snapshot?.canCreateViaApi);
  const remaining = Math.max(0, node.compactionThreshold - node.contextTokens);
  const threshHint =
    node.contextTokens >= node.compactionThreshold
      ? `Выше порога сжатия (${fmtTokens(node.compactionThreshold)})`
      : `Порог ~${fmtTokens(node.compactionThreshold)} · запас ${fmtTokens(remaining)}`;

  return `
    <section class="card aux-only-active">
      <div class="active-header">
        <div style="display:flex;align-items:center;gap:6px;min-width:0">
          <span class="pill ${node.runState === "running" ? "ok" : ""}">
            <span class="dot ${node.runState === "running" ? "running" : ""}"></span>
            ${node.runState === "running" ? "RUNNING" : "IDLE"}
          </span>
          <span style="font-size:11px;color:var(--fg-3)">${isPinned ? "Закреплённый чат" : "Выбранный чат"}</span>
        </div>
        <button class="btn sm ${isPinned ? "active" : ""}" data-action="toggle-pin" data-id="${esc(node.id)}" title="Закрепить этот чат по умолчанию между перезапусками">
          ${isPinned ? "Открепить" : "Закрепить"}
        </button>
      </div>

      <div class="active-title" title="${esc(node.title)}">${esc(node.title)}</div>

      <div class="active-subtitle">
        <span>${esc(node.modelName)}</span>
        <span>·</span>
        <span>окно ${esc(fmtTokens(node.contextLimit))}</span>
        <span>·</span>
        <span>${node.userTurns} ходов</span>
      </div>

      <div class="ctx-row">
        <div>
          <span class="ctx-main mono sev-${esc(node.severity)}">${esc(fmtTokens(node.contextTokens))}</span>
          <span class="ctx-sub mono"> / ${esc(fmtTokens(node.contextLimit))} · ${node.percentOfLimit}%</span>
        </div>
        <span class="ctx-thresh-label">${esc(threshHint)}</span>
      </div>

      ${renderProgressBar(node.contextTokens, node.contextLimit, node.compactionThreshold, node.severity)}

      <div class="metrics-grid">
        <div class="metric-box">
          <div class="metric-label">Кэш (hit rate)</div>
          <div class="metric-value mono" style="color:var(--fg-info)">${node.cacheHitRatio}%</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">Сжатия</div>
          <div class="metric-value mono" style="color:${node.compactionCount > 0 ? "var(--fg-warn)" : "var(--fg-2)"}">
            ${node.compactionCount > 0 ? `${node.compactionCount}× (${fmtTime(node.lastCompactionAt)})` : "0"}
          </div>
        </div>
        <div class="metric-box">
          <div class="metric-label">За сессию</div>
          <div class="metric-value mono">${esc(fmtTokens(node.sessionTotalTokens))}</div>
        </div>
      </div>

      <div class="action-row">
        ${
          canMsg || canApiCreate
            ? `<button class="btn primary" data-action="toggle-new-chat">+ Новый чат в проекте</button>`
            : ""
        }
        ${
          canMsg
            ? `<button class="btn" data-action="remind-compact" title="Отправить напоминание о сжатии контекста в текущий чат">Напомнить о /compact</button>`
            : ""
        }
        <button class="btn" data-action="copy-compact" title="Скопировать команду /compact в буфер обмена">Копировать /compact</button>
      </div>
    </section>
  `;
}

function renderDetailedTreeNode(node, isChild = false) {
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  const isExpanded = state.expandedIds.has(node.id);
  const isSelected = state.selectedId === node.id;
  const showInline = state.accordionOpenId === node.id;
  const isPinned = state.snapshot?.settings?.pinnedConversationId === node.id;

  const compBadge =
    node.compactionCount > 0
      ? `<span class="pill warn" title="Сработало автосжатие: ${node.compactionCount}× (последнее ${esc(fmtTime(node.lastCompactionAt))})">${node.compactionCount}×</span>`
      : "";
  const subBadge =
    node.descendantCount > 0
      ? ` · ${node.descendantCount} подч.`
      : node.subagentType
      ? ` · ${node.subagentType}`
      : "";

  const inlineDetailHtml = showInline
    ? `
      <div class="inline-detail" data-stop-select="1">
        <div class="detail-breakdown mono">
          <span>in ${esc(fmtTokens(node.inputTokens))}</span>
          <span>cache ${esc(fmtTokens(node.cacheReadTokens))} (${node.cacheHitRatio}%)</span>
          <span>out ${esc(fmtTokens(node.outputTokens))}</span>
          <span>ходов: ${node.userTurns}</span>
        </div>
        ${renderSparklineSvg(node.sparkline, node.contextLimit, node.compactionThreshold)}
        <div class="detail-actions">
          <button class="btn sm primary" data-action="copy-uri" data-id="${esc(node.id)}">Копировать conversation://${esc(node.id.slice(0, 8))}…</button>
          <button class="btn sm" data-action="copy-id" data-id="${esc(node.id)}">ID</button>
          <button class="btn sm ${isPinned ? "active" : ""}" data-action="toggle-pin" data-id="${esc(node.id)}">${isPinned ? "Открепить" : "Закрепить"}</button>
        </div>
      </div>
    `
    : "";

  const childrenHtml =
    hasChildren && isExpanded
      ? `<div class="tree-children">${node.children.map((ch) => renderDetailedTreeNode(ch, true)).join("")}</div>`
      : "";

  return `
    <div class="tree-branch">
      <div class="tree-item ${isChild ? "is-child" : ""} ${isSelected ? "selected" : ""}" data-action="select-node" data-id="${esc(node.id)}">
        <div class="tree-row-top">
          ${
            hasChildren
              ? `<button class="toggle-btn" data-action="toggle-branch" data-id="${esc(node.id)}" title="${isExpanded ? "Свернуть ветку" : "Раскрыть ветку"}">${isExpanded ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT}</button>`
              : `<span class="toggle-spacer"></span>`
          }
          <span class="dot ${node.runState === "running" ? "running" : ""}" title="${node.runState}"></span>
          <span class="tree-title" title="${esc(node.title)}">${esc(node.title)}</span>
          <span class="tree-ctx mono sev-${esc(node.severity)}">${esc(fmtTokens(node.contextTokens))} · ${node.percentOfLimit}%</span>
        </div>
        <div class="tree-row-bottom">
          <div class="tree-bar-slot">
            ${renderProgressBar(node.contextTokens, node.contextLimit, node.compactionThreshold, node.severity, "thin")}
          </div>
          <span class="tree-meta">${esc(node.modelShort)} · ${esc(fmtAgo(node.updatedAt))}${esc(subBadge)}</span>
          ${compBadge}
        </div>
        ${inlineDetailHtml}
      </div>
      ${childrenHtml}
    </div>
  `;
}

function renderDetailedInspector(node) {
  if (!node) {
    return `<div class="inspector-card"><div class="empty-note">Выберите чат в дереве слева для детального просмотра</div></div>`;
  }

  const snap = state.snapshot;
  const detail = state.detailById.get(node.id) || null;
  const history =
    detail?.history ||
    (node.sparkline || []).map((p) => ({ s: p.s, t: p.t, isCompaction: Boolean(p.cp) }));
  const compactions = detail?.compactions || [];
  const children = node.children || [];
  const remaining = Math.max(0, node.compactionThreshold - node.contextTokens);
  const canMsg = Boolean(state.capabilities?.message);
  const canApiCreate = Boolean(snap?.canCreateViaApi);

  return `
    <div class="inspector-card">
      <div class="active-header" style="flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="pill ${node.runState === "running" ? "ok" : ""}">
            <span class="dot ${node.runState === "running" ? "running" : ""}"></span>
            ${node.runState === "running" ? "RUNNING" : "IDLE"}
          </span>
          <span class="mono" style="font-size:11.5px;color:var(--fg-3)">${esc(node.id)}</span>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${
            canMsg || canApiCreate
              ? `<button class="btn sm primary" data-action="toggle-new-chat">+ Новый чат</button>`
              : ""
          }
          <button class="btn sm" data-action="copy-compact">Копировать /compact</button>
          <button class="btn sm primary" data-action="copy-uri" data-id="${esc(node.id)}">Копировать conversation://…</button>
        </div>
      </div>

      <div>
        <div style="font-size:18px;font-weight:700;line-height:1.25;word-break:break-word">${esc(node.title)}</div>
        <div class="active-subtitle" style="margin-top:4px">
          <span>${esc(node.modelName)}</span>
          <span>·</span>
          <span>Окно ${esc(fmtExact(node.contextLimit))} tok</span>
          <span>·</span>
          <span>${node.userTurns} ходов · ${node.plannerSteps} ответов модели</span>
          ${!canMsg ? `<span>·</span><span style="color:var(--fg-3)">В global отправка сообщений в чат недоступна</span>` : ""}
        </div>
      </div>

      <div>
        <div class="ctx-row" style="margin-bottom:6px">
          <div>
            <span class="mono sev-${esc(node.severity)}" style="font-size:22px;font-weight:750">${esc(fmtExact(node.contextTokens))}</span>
            <span class="ctx-sub mono"> / ${esc(fmtExact(node.contextLimit))} tok (${node.percentOfLimit}%)</span>
          </div>
          <span class="ctx-thresh-label">
            Порог сжатия: ~${esc(fmtTokens(node.compactionThreshold))} · ${
              remaining > 0 ? `запас ~${esc(fmtTokens(remaining))}` : "порог достигнут"
            }
          </span>
        </div>
        ${renderProgressBar(node.contextTokens, node.contextLimit, node.compactionThreshold, node.severity, "large")}
      </div>

      <div class="inspector-kpis">
        <div class="metric-box">
          <div class="metric-label">Последний шаг (разбивка)</div>
          <div class="metric-value mono">in ${esc(fmtTokens(node.inputTokens))} · out ${esc(fmtTokens(node.outputTokens))}</div>
          <div class="inspector-sub mono">cache_read: ${esc(fmtTokens(node.cacheReadTokens))}</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">Попадание в кэш</div>
          <div class="metric-value mono" style="color:var(--fg-info)">${node.cacheHitRatio}%</div>
          <div class="inspector-sub">доля кэшированного входа</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">Автокомпакции</div>
          <div class="metric-value mono" style="color:${node.compactionCount > 0 ? "var(--fg-warn)" : "var(--fg-2)"}">${node.compactionCount}</div>
          <div class="inspector-sub">${node.lastCompactionAt ? `последняя: ${fmtTime(node.lastCompactionAt)}` : "не срабатывали"}</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">Всего за сессию</div>
          <div class="metric-value mono">${esc(fmtTokens(node.sessionTotalTokens))}</div>
          <div class="inspector-sub">${children.length} прямых подчатов</div>
        </div>
      </div>

      <div>
        <div style="font-size:13px;font-weight:650;margin-bottom:6px">
          Динамика контекста по шагам ${state.loadingDetailId === node.id ? "(загрузка…)" : ""}
        </div>
        ${renderDetailedChartSvg(history, node.contextLimit, node.compactionThreshold)}
      </div>

      <div class="inspector-bottom-grid">
        <div class="sub-panel">
          <div class="sub-panel-title">Дочерние подчаты (${children.length})</div>
          ${
            children.length === 0
              ? `<div class="empty-note" style="padding:10px 4px">У этого чата нет привязанных подчатов</div>`
              : children
                  .map(
                    (ch) => `
                  <div class="sub-row" data-action="select-node" data-id="${esc(ch.id)}">
                    <div style="display:flex;align-items:center;gap:6px">
                      <span class="dot ${ch.runState === "running" ? "running" : ""}"></span>
                      <span style="font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(ch.title)}</span>
                    </div>
                    <div class="mono" style="font-size:11px;color:var(--fg-2)">
                      ${esc(fmtTokens(ch.contextTokens))} (${ch.percentOfLimit}%) · ${esc(ch.modelShort)} · ${esc(fmtAgo(ch.updatedAt))}
                    </div>
                  </div>
                `
                  )
                  .join("")
          }
        </div>

        <div class="sub-panel">
          <div class="sub-panel-title">События сжатия / CHECKPOINT (${compactions.length || node.compactionCount})</div>
          ${
            compactions.length === 0
              ? `<div class="empty-note" style="padding:10px 4px">${
                  node.compactionCount > 0 ? "Загрузка истории компакций…" : "Сжатий контекста в этом чате ещё не было"
                }</div>`
              : compactions
                  .map(
                    (cp, idx) => `
                  <div class="checkpoint-row">
                    <div style="font-weight:650;color:var(--fg-warn)">
                      ${cp.kind === "checkpoint" ? "CHECKPOINT" : "Сброс контекста"} #${idx + 1} · шаг ${cp.stepIndex} · ${esc(fmtTime(cp.at))}
                    </div>
                    <div class="mono">
                      ${esc(fmtTokens(cp.beforeTokens))} → ${cp.afterTokens ? esc(fmtTokens(cp.afterTokens)) : "сжато"}
                      ${
                        cp.beforeTokens && cp.afterTokens && cp.beforeTokens > cp.afterTokens
                          ? ` (освобождено ~${esc(fmtTokens(cp.beforeTokens - cp.afterTokens))})`
                          : ""
                      }
                    </div>
                  </div>
                `
                  )
                  .join("")
          }
        </div>
      </div>
    </div>
  `;
}

function renderSettingsDrawer(settings) {
  if (!state.settingsOpen || !settings || state.viewMode !== "detailed") return "";
  return `
    <div class="settings-drawer">
      <div class="setting-field">
        <label for="set-interval">Интервал автообновления</label>
        <select id="set-interval" data-setting="refreshIntervalSec">
          ${[3, 5, 10, 15, 30]
            .map((sec) => `<option value="${sec}" ${settings.refreshIntervalSec === sec ? "selected" : ""}>Каждые ${sec} сек</option>`)
            .join("")}
        </select>
      </div>

      <div class="setting-field">
        <label for="set-th-mode">Порог автосжатия</label>
        <select id="set-th-mode" data-setting="thresholdMode">
          <option value="adaptive" ${settings.thresholdMode === "adaptive" ? "selected" : ""}>Адаптивный (450K / 135K)</option>
          <option value="custom_k" ${settings.thresholdMode === "custom_k" ? "selected" : ""}>Фиксированный (в K токенов)</option>
          <option value="percent" ${settings.thresholdMode === "percent" ? "selected" : ""}>Процент от окна модели</option>
        </select>
      </div>

      ${
        settings.thresholdMode === "custom_k"
          ? `
        <div class="setting-field">
          <label for="set-th-k">Порог, тыс. токенов (K)</label>
          <input id="set-th-k" type="number" min="20" max="1000" step="5" value="${settings.customThresholdK}" data-setting="customThresholdK" />
        </div>
      `
          : settings.thresholdMode === "percent"
          ? `
        <div class="setting-field">
          <label for="set-th-pct">Порог, % от окна</label>
          <input id="set-th-pct" type="number" min="5" max="95" step="5" value="${settings.customThresholdPercent}" data-setting="customThresholdPercent" />
        </div>
      `
          : ""
      }

      <div class="setting-field">
        <label for="set-age">Скрывать старые чаты</label>
        <select id="set-age" data-setting="maxAgeDays">
          <option value="0" ${settings.maxAgeDays === 0 ? "selected" : ""}>Показывать все</option>
          <option value="1" ${settings.maxAgeDays === 1 ? "selected" : ""}>За последние 24 часа</option>
          <option value="7" ${settings.maxAgeDays === 7 ? "selected" : ""}>За 7 дней</option>
          <option value="30" ${settings.maxAgeDays === 30 ? "selected" : ""}>За 30 дней</option>
        </select>
      </div>

      <label class="setting-check">
        <input type="checkbox" ${settings.showArchived ? "checked" : ""} data-setting="showArchived" />
        Показывать архивные
      </label>
    </div>
  `;
}

function renderNewChatBar() {
  if (!state.newChatOpen || state.viewMode !== "detailed") return "";
  const viaMsg = Boolean(state.capabilities?.message);
  return `
    <div class="new-chat-bar">
      <div style="font-size:11.5px;color:var(--fg-2)">
        ${
          viaMsg
            ? "Создаст новый фоновый чат в этом проекте через sendMessage (target: new):"
            : "Создаст новый чат через ConversationService:"
        }
      </div>
      <div class="new-chat-row">
        <input id="new-chat-input" type="text" placeholder="Стартовый запрос для нового чата…" value="${esc(state.newChatPrompt)}" />
        <button class="btn primary" data-action="submit-new-chat">Создать</button>
        <button class="btn" data-action="toggle-new-chat">Отмена</button>
      </div>
    </div>
  `;
}

// ---------- Main Render ----------

function render() {
  const root = document.getElementById("root");
  if (!root) return;

  const isSimple = state.viewMode !== "detailed";
  root.className = `app-shell ${isSimple ? "mode-simple" : "mode-detailed"}`;

  if (!state.snapshot) {
    root.innerHTML = `
      <div class="loading-screen">
        ${state.lastError ? `<div style="color:var(--fg-danger)">${esc(state.lastError)}</div>` : `<div class="spinner"></div><div>Загрузка данных контекста…</div>`}
        ${state.lastError ? `<button class="btn primary" data-action="refresh">Повторить</button>` : ""}
      </div>
    `;
    return;
  }

  const snap = state.snapshot;
  const settings = snap.settings || {};
  const currentNode = getCurrentNode();
  const roots = getFilteredRoots();
  const modeClass = snap.mode === "full_api" ? "info" : "ok";
  const modeTitle = snap.modeReason
    ? `Режим ${snap.modeLabel}: ${snap.modeReason}`
    : `Режим ${snap.modeLabel}: данные из ConversationService + локальных транскриптов`;

  const modeSwitchHtml = `
    <div class="seg-switch" role="tablist" aria-label="Режим отображения">
      <button class="seg-btn ${isSimple ? "active" : ""}" data-action="set-mode" data-mode="simple" role="tab" aria-selected="${isSimple}">Простой</button>
      <button class="seg-btn ${!isSimple ? "active" : ""}" data-action="set-mode" data-mode="detailed" role="tab" aria-selected="${!isSimple}">Подробный</button>
    </div>
  `;

  if (isSimple) {
    const isSearching = state.search.trim().length > 0;

    root.innerHTML = `
      <header class="topbar">
        <div class="topbar-left">
          ${ICON_TREE}
          ${modeSwitchHtml}
        </div>
        <div class="topbar-actions">
          <button class="icon-btn ${state.inFlightSnapshot ? "spinning" : ""}" data-action="refresh" ${state.inFlightSnapshot ? "disabled" : ""} title="Обновить (авто каждые ${settings.refreshIntervalSec || 5}с)">${ICON_REFRESH}</button>
        </div>
      </header>

      <main class="workspace">
        <div class="left-pane">
          ${renderSimpleActiveCard(currentNode, false)}
          ${renderSimpleChartSection(currentNode, false)}

          <div class="simple-section-head">
            ${renderGroupSwitcher()}
            <button class="icon-btn ${state.simpleSearchOpen || isSearching ? "active" : ""}" data-action="toggle-simple-search" title="Поиск по чатам">${ICON_SEARCH}</button>
          </div>

          ${
            state.simpleSearchOpen || isSearching
              ? `<input id="search-input" class="search-input" type="search" placeholder="Найти чат или проект…" value="${esc(state.search)}" />`
              : ""
          }

          <div class="simple-tree-list">
            ${renderGroupedList(roots, renderSimpleTreeNode)}
          </div>
        </div>

        <section class="right-pane">
          ${renderSimpleActiveCard(currentNode, true)}
          ${renderSimpleChartSection(currentNode, true)}
        </section>
      </main>
    `;
  } else {
    root.innerHTML = `
      <header class="topbar">
        <div class="topbar-left">
          ${ICON_TREE}
          ${modeSwitchHtml}
          <span class="pill ${modeClass}" title="${esc(modeTitle)}">${esc(snap.modeLabel)}</span>
          <span class="topbar-stats">
            ${snap.stats.totalConversations} чатов · ${snap.stats.running} активн. · ${snap.stats.subchats} подчатов · ${snap.stats.compactions} сжатий
          </span>
        </div>
        <div class="topbar-actions">
          <button class="btn sm ${settings.autoRefresh ? "active" : ""}" data-action="toggle-auto" title="Автообновление только при видимой вкладке">
            ${settings.autoRefresh ? `● Авто ${settings.refreshIntervalSec}с` : "○ Авто выкл"}
          </button>
          <button class="btn sm" data-action="refresh" ${state.inFlightSnapshot ? "disabled" : ""}>Обновить</button>
          <button class="btn sm ${state.settingsOpen ? "active" : ""}" data-action="toggle-settings">Пороги</button>
        </div>
      </header>

      ${renderSettingsDrawer(settings)}
      ${renderNewChatBar()}

      <main class="workspace">
        <div class="left-pane">
          ${renderDetailedActiveCard(currentNode, settings)}

          <div class="tree-controls">
            <input id="search-input" class="search-input" type="search" placeholder="Поиск по чатам, проектам, моделям, ID…" value="${esc(state.search)}" />
            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap">
              <div class="filter-chips">
                <button class="chip ${state.chipFilter === "all" ? "active" : ""}" data-chip="all">Все (${snap.stats.visibleRoots})</button>
                <button class="chip ${state.chipFilter === "branches" ? "active" : ""}" data-chip="branches">С подчатами (${snap.stats.subchats})</button>
                <button class="chip ${state.chipFilter === "warn" ? "active" : ""}" data-chip="warn">Высокий (${snap.stats.warnings})</button>
              </div>
              ${renderGroupSwitcher()}
            </div>
          </div>

          <div class="tree-list">
            ${renderGroupedList(roots, renderDetailedTreeNode)}
          </div>
        </div>

        <section class="right-pane">
          ${renderDetailedInspector(currentNode)}
        </section>
      </main>
    `;
  }

  // Preserve search focus if user was typing
  if (document.activeElement?.id !== "search-input" && state._refocusSearch) {
    const inp = document.getElementById("search-input");
    if (inp) {
      inp.focus();
      const pos = typeof state._searchCursor === "number" ? state._searchCursor : inp.value.length;
      inp.setSelectionRange(pos, pos);
    }
    state._refocusSearch = false;
  }
}

// ---------- Data Fetching & Actions ----------

function expandAncestorsOf(tree, id) {
  const chain = findPathToNode(tree, id);
  if (!chain) return;
  for (let i = 0; i < chain.length - 1; i++) {
    state.expandedIds.add(chain[i]);
  }
  const node = findNodeInTree(tree, id);
  if (node?.children?.length > 0) {
    state.expandedIds.add(node.id);
  }
}

function applySnapshot(snapshot, { fromToolResult = false } = {}) {
  if (!snapshot || typeof snapshot !== "object") return;
  const firstLoad = !state.snapshot;
  state.snapshot = snapshot;
  state.lastError = null;

  if (snapshot.settings?.viewMode === "simple" || snapshot.settings?.viewMode === "detailed") {
    state.viewMode = snapshot.settings.viewMode;
  }
  if (["project", "context", "date"].includes(snapshot.settings?.groupBy)) {
    state.groupBy = snapshot.settings.groupBy;
  }
  if (firstLoad && Array.isArray(snapshot.settings?.collapsedGroups)) {
    state.collapsedGroups = new Set(snapshot.settings.collapsedGroups);
  }

  // Determine preferred conversation on initial load or explicit tool call from an agent
  const detectedFromServer = snapshot.detectedConversationId || snapshot.initialSelectedId || null;
  const detectedFromHost = detectHostConversationId(snapshot.tree);
  const explicitTarget = detectedFromServer || detectedFromHost;

  if (firstLoad || (fromToolResult && explicitTarget)) {
    const initSel = explicitTarget || snapshot.active?.id || snapshot.tree?.[0]?.id || null;
    state.selectedId = initSel;
    if (explicitTarget) {
      state.userSelected = true;
    }
    if (initSel) {
      expandAncestorsOf(snapshot.tree, initSel);
      if (state.viewMode === "detailed") {
        loadConversationDetail(initSel);
      }
    }
  } else if (!state.userSelected) {
    const nextAuto = explicitTarget || snapshot.active?.id || snapshot.tree?.[0]?.id || null;
    if (nextAuto) state.selectedId = nextAuto;
  } else if (state.selectedId && !findNodeInTree(snapshot.tree, state.selectedId)) {
    state.selectedId = snapshot.active?.id || snapshot.tree?.[0]?.id || null;
    state.userSelected = false;
  }

  restartPolling();
  render();
}

async function fetchSnapshot() {
  if (!state.connected || state.inFlightSnapshot) return;
  if (!state.capabilities?.serverTools) return;
  state.inFlightSnapshot = true;
  render();
  try {
    const res = await app.callServerTool({
      name: "get_monitor_snapshot",
      arguments: {},
    });
    if (res?.structuredContent) {
      applySnapshot(res.structuredContent);
      if (state.selectedId && ((state.viewMode === "detailed" && window.innerWidth >= 820) || (state.viewMode === "simple" && state.simpleChartOpen))) {
        loadConversationDetail(state.selectedId, true);
      }
    }
  } catch (err) {
    state.lastError = err?.message || "Ошибка обновления";
  } finally {
    state.inFlightSnapshot = false;
    render();
  }
}

async function loadConversationDetail(cid, silent = false) {
  if (!cid || !state.connected || !state.capabilities?.serverTools) return;
  if (state.loadingDetailId === cid) return;
  state.loadingDetailId = cid;
  if (!silent) render();
  try {
    const res = await app.callServerTool({
      name: "get_conversation_detail",
      arguments: { conversationId: cid },
    });
    if (res?.structuredContent?.found) {
      state.detailById.set(cid, res.structuredContent);
    }
  } catch {
    // keep existing sparkline fallback
  } finally {
    if (state.loadingDetailId === cid) state.loadingDetailId = null;
    render();
  }
}

async function saveRename(cid, title) {
  if (!cid || !state.connected || !state.capabilities?.serverTools) return;
  try {
    const res = await app.callServerTool({
      name: "rename_conversation",
      arguments: { conversationId: cid, title: title || "" },
    });
    state.renamingId = null;
    state.renameDraft = "";
    if (res?.structuredContent?.snapshot) {
      applySnapshot(res.structuredContent.snapshot);
      showToast(title.trim() ? "Название сохранено" : "Сброшено к автоназванию");
    } else {
      render();
    }
  } catch {
    showToast("Не удалось сохранить название");
  }
}

async function persistSettings(patch, { silent = false } = {}) {
  if (!state.connected || !state.capabilities?.serverTools) return;
  try {
    const res = await app.callServerTool({
      name: "update_monitor_settings",
      arguments: patch,
    });
    if (res?.structuredContent?.snapshot) {
      applySnapshot(res.structuredContent.snapshot);
      if (!silent) showToast("Настройки сохранены");
    }
  } catch {
    if (!silent) showToast("Не удалось сохранить настройки");
  }
}

async function createNewProjectChat(promptText) {
  const text = (promptText || "").trim();
  if (!text) {
    showToast("Введите текст запроса для нового чата");
    return;
  }

  if (state.capabilities?.message) {
    try {
      const result = await app.sendMessage({
        role: "user",
        content: [{ type: "text", text }],
        _meta: {
          "com.google.antigravity/message": {
            target: "new",
          },
        },
      });
      const newCid = result?._meta?.["com.google.antigravity/message"]?.conversationId;
      state.newChatOpen = false;
      state.newChatPrompt = "";
      render();
      showToast(newCid ? `Создан чат ${newCid.slice(0, 8)}…` : "Новый чат создан в проекте");
      setTimeout(() => fetchSnapshot(), 1500);
      return;
    } catch (err) {
      showToast(`Ошибка создания чата: ${err?.message || "отклонено"}`);
      return;
    }
  }

  if (state.snapshot?.canCreateViaApi && state.capabilities?.serverTools) {
    try {
      const res = await app.callServerTool({
        name: "create_project_chat",
        arguments: {
          prompt: text,
          projectId: state.snapshot.currentProjectId || undefined,
        },
      });
      if (res?.structuredContent?.ok) {
        state.newChatOpen = false;
        state.newChatPrompt = "";
        render();
        showToast("Новый чат создан через API");
        setTimeout(() => fetchSnapshot(), 1200);
      } else {
        showToast(res?.structuredContent?.error || "API недоступен");
      }
    } catch {
      showToast("Не удалось создать чат");
    }
  }
}

async function sendCompactReminder() {
  if (!state.capabilities?.message) {
    await copyText("/compact", "Команда /compact скопирована");
    return;
  }
  const active = getCurrentNode();
  const ctxInfo = active
    ? ` (${fmtTokens(active.contextTokens)} / ${fmtTokens(active.contextLimit)}, ${active.percentOfLimit}%)`
    : "";
  try {
    await app.sendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: `Контекст приближается к порогу${ctxInfo}. Подведи краткий итог текущего состояния и ключевых файлов, чтобы можно было безопасно выполнить /compact.`,
        },
      ],
    });
    showToast("Запрос сводки перед /compact отправлен");
  } catch {
    await copyText("/compact", "Отправка недоступна — скопировал /compact");
  }
}

function restartPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  const settings = state.snapshot?.settings;
  if (!settings?.autoRefresh) return;
  const ms = Math.max(3000, (settings.refreshIntervalSec || 5) * 1000);
  state.pollTimer = setInterval(() => {
    if (document.visibilityState === "visible" && !state.inFlightSnapshot) {
      fetchSnapshot();
    }
  }, ms);
}

// ---------- DOM Event Delegation ----------

document.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-chip]");
  if (chip) {
    state.chipFilter = chip.dataset.chip;
    render();
    return;
  }

  const actionEl = e.target.closest("[data-action]");
  if (!actionEl) return;

  const action = actionEl.dataset.action;
  const id = actionEl.dataset.id;

  if (action === "set-mode") {
    const mode = actionEl.dataset.mode === "detailed" ? "detailed" : "simple";
    if (state.viewMode !== mode) {
      state.viewMode = mode;
      if (mode === "detailed" && state.selectedId) {
        loadConversationDetail(state.selectedId);
      }
      render();
      persistSettings({ viewMode: mode }, { silent: true });
    }
    return;
  }

  if (action === "set-group") {
    const g = actionEl.dataset.group;
    if (["project", "context", "date"].includes(g) && state.groupBy !== g) {
      state.groupBy = g;
      render();
      persistSettings({ groupBy: g }, { silent: true });
    }
    return;
  }

  if (action === "toggle-group") {
    const key = actionEl.dataset.groupKey;
    if (key) {
      if (state.collapsedGroups.has(key)) state.collapsedGroups.delete(key);
      else state.collapsedGroups.add(key);
      render();
      persistSettings({ collapsedGroups: Array.from(state.collapsedGroups) }, { silent: true });
    }
    return;
  }

  if (action === "toggle-simple-chart") {
    state.simpleChartOpen = !state.simpleChartOpen;
    const cur = getCurrentNode();
    if (state.simpleChartOpen && cur?.id) {
      loadConversationDetail(cur.id);
    }
    render();
    return;
  }

  if (action === "toggle-simple-search") {
    state.simpleSearchOpen = !state.simpleSearchOpen;
    if (!state.simpleSearchOpen) state.search = "";
    render();
    if (state.simpleSearchOpen) {
      setTimeout(() => document.getElementById("search-input")?.focus(), 0);
    }
    return;
  }

  if (action === "show-more-simple") {
    state.simpleLimit += 30;
    render();
    return;
  }

  if (action === "toggle-branch") {
    e.stopPropagation();
    if (state.expandedIds.has(id)) state.expandedIds.delete(id);
    else state.expandedIds.add(id);
    render();
    return;
  }

  if (action === "select-node") {
    if (e.target.closest("[data-stop-select]")) return;
    state.selectedId = id;
    state.userSelected = true;

    if (state.viewMode === "detailed") {
      if (window.innerWidth < 820) {
        state.accordionOpenId = state.accordionOpenId === id ? null : id;
      } else {
        loadConversationDetail(id);
      }
    } else if (state.simpleChartOpen) {
      loadConversationDetail(id);
    }
    render();
    return;
  }

  if (action === "refresh") {
    fetchSnapshot();
    return;
  }

  if (action === "toggle-auto") {
    const cur = Boolean(state.snapshot?.settings?.autoRefresh);
    persistSettings({ autoRefresh: !cur });
    return;
  }

  if (action === "toggle-settings") {
    state.settingsOpen = !state.settingsOpen;
    render();
    return;
  }

  if (action === "toggle-new-chat") {
    state.newChatOpen = !state.newChatOpen;
    render();
    if (state.newChatOpen) {
      setTimeout(() => document.getElementById("new-chat-input")?.focus(), 0);
    }
    return;
  }

  if (action === "submit-new-chat") {
    const inp = document.getElementById("new-chat-input");
    createNewProjectChat(inp ? inp.value : state.newChatPrompt);
    return;
  }

  if (action === "remind-compact") {
    sendCompactReminder();
    return;
  }

  if (action === "copy-compact") {
    copyText("/compact", "Скопировано: /compact");
    return;
  }

  if (action === "copy-uri" && id) {
    e.stopPropagation();
    copyText(`conversation://${id}`, `Скопировано: conversation://${id.slice(0, 8)}…`);
    return;
  }

  if (action === "copy-id" && id) {
    e.stopPropagation();
    copyText(id, `Скопирован ID: ${id.slice(0, 8)}…`);
    return;
  }

  if (action === "start-rename" && id) {
    e.stopPropagation();
    const node = findNodeInTree(state.snapshot?.tree, id);
    state.renamingId = id;
    state.renameDraft = node?.title || "";
    render();
    setTimeout(() => {
      const inp = document.getElementById("rename-input");
      if (inp) {
        inp.focus();
        inp.select();
      }
    }, 0);
    return;
  }

  if (action === "save-rename" && id) {
    e.stopPropagation();
    const inp = document.getElementById("rename-input");
    saveRename(id, inp ? inp.value : state.renameDraft);
    return;
  }

  if (action === "cancel-rename") {
    e.stopPropagation();
    state.renamingId = null;
    state.renameDraft = "";
    render();
    return;
  }

  if (action === "toggle-pin" && id) {
    e.stopPropagation();
    const curPinned = state.snapshot?.settings?.pinnedConversationId;
    persistSettings({ pinnedConversationId: curPinned === id ? null : id });
    return;
  }
});

document.addEventListener("input", (e) => {
  if (e.target?.id === "search-input") {
    state.search = e.target.value;
    state._searchCursor = e.target.selectionStart;
    state._refocusSearch = true;
    render();
  } else if (e.target?.id === "new-chat-input") {
    state.newChatPrompt = e.target.value;
  } else if (e.target?.id === "rename-input") {
    state.renameDraft = e.target.value;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.target?.id === "new-chat-input" && e.key === "Enter") {
    e.preventDefault();
    createNewProjectChat(e.target.value);
  } else if (e.target?.id === "rename-input") {
    if (e.key === "Enter") {
      e.preventDefault();
      saveRename(state.renamingId, e.target.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      state.renamingId = null;
      state.renameDraft = "";
      render();
    }
  }
});

document.addEventListener("change", (e) => {
  const key = e.target?.dataset?.setting;
  if (!key) return;
  if (e.target.type === "checkbox") {
    persistSettings({ [key]: Boolean(e.target.checked) });
  } else if (e.target.type === "number" || key === "refreshIntervalSec" || key === "maxAgeDays") {
    const val = Number(e.target.value);
    if (Number.isFinite(val)) persistSettings({ [key]: val });
  } else {
    persistSettings({ [key]: e.target.value });
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.snapshot?.settings?.autoRefresh) {
    fetchSnapshot();
  }
});

// ---------- MCP App Lifecycle (handlers registered BEFORE connect!) ----------

function applyContext(ctx) {
  if (!ctx) return;
  state.hostContext = ctx;
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.dataset.theme = ctx.theme;
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (state.snapshot && !state.userSelected) {
    const detected = detectHostConversationId(state.snapshot.tree);
    if (detected) {
      state.selectedId = detected;
      state.userSelected = true;
      expandAncestorsOf(state.snapshot.tree, detected);
      render();
    }
  }
}

app.ontoolinput = ({ arguments: args }) => {
  if (args?.search && typeof args.search === "string") {
    state.search = args.search;
  }
  if (args?.selectedId && typeof args.selectedId === "string") {
    state.selectedId = args.selectedId;
    state.userSelected = true;
  }
};

app.ontoolresult = (result) => {
  if (result?.structuredContent) {
    applySnapshot(result.structuredContent, { fromToolResult: true });
  }
};

app.ontoolcancelled = () => {
  state.inFlightSnapshot = false;
  render();
};

app.onhostcontextchanged = (ctx) => {
  applyContext(ctx);
};

async function boot() {
  try {
    await app.connect();
    state.connected = true;
    state.capabilities = app.getHostCapabilities() || {};
    applyContext(app.getHostContext());

    setTimeout(() => {
      if (!state.snapshot && state.capabilities?.serverTools) {
        fetchSnapshot();
      }
    }, 350);
  } catch (err) {
    state.lastError = `Ошибка инициализации MCP App: ${err?.message || err}`;
    render();
  }
}

boot();
