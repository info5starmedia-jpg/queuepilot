/* QueuePilot dashboard — zero-build, zero-dependency, talks only to the API
   on this origin (loopback). All state comes from the REST API; live updates
   arrive over the SSE stream.

   Ops-console layout: sidebar views (Profiles/Proxies/Tabs/Cookies/
   Warmups/Providers/Events/Settings), top action bar, single scrolling
   table. */

const $ = (sel) => document.querySelector(sel);

async function api(path, opts = {}) {
  /* JSON content-type only when there IS a body: Fastify answers a body-less
     request that claims application/json with a 500, which broke every
     body-less DELETE/POST in the console (delete, stop, proxy test, …). */
  const res = await fetch(path, {
    ...opts,
    headers: opts.body === undefined ? opts.headers : { "content-type": "application/json", ...opts.headers },
  });
  if (res.status === 204) return null;
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }
  return body;
}

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

function toast(detail, type = "info") {
  pushEvent({ type, detail, at: new Date().toISOString() });
}

/* ============================ view switching ============================ */

const VIEWS = ["profiles", "proxies", "tabs", "tabview", "deck", "cookies", "thinger", "autofill", "warmups", "providers", "events", "settings"];
let activeView = "profiles";

function setView(name) {
  if (!VIEWS.includes(name)) return;
  activeView = name;
  for (const v of VIEWS) {
    $(`#view-${v}`).hidden = v !== name;
    document.querySelector(`#nav button[data-view="${v}"]`)?.classList.toggle("active", v === name);
  }
  $("#view-title").textContent = name.charAt(0).toUpperCase() + name.slice(1);
  renderTopbarActions();
  renderStats();
  if (name === "cookies") refreshCookiesProfiles();
  if (name === "tabview") loadTabView();
  if (name === "deck") loadDeck();
  if (name === "thinger") loadThinger();
  if (name === "autofill") loadAutofill();
  if (name === "warmups") { loadWarmups(); loadPersonaCard(); }
}

document.querySelectorAll("#nav button").forEach((b) =>
  b.addEventListener("click", () => setView(b.dataset.view)),
);

window.addEventListener("keydown", (e) => {
  const tag = e.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const k = e.key.toLowerCase();
  const map = { p: "profiles", x: "proxies", t: "tabs", n: "tabview", d: "deck", c: "cookies", k: "thinger", a: "autofill", w: "warmups", v: "providers", e: "events", g: "settings" };
  if (map[k]) setView(map[k]);
  if (k === "/" && activeView === "profiles") {
    e.preventDefault();
    $("#profile-search")?.focus();
  }
});

/* per-view topbar actions */
function renderTopbarActions() {
  const bar = $("#topbar-actions");
  bar.innerHTML = "";
  if (activeView === "profiles") {
    bar.innerHTML = `
      <button id="tb-new" class="primary">+ New Profile</button>
      <button id="tb-import">Import</button>
      <button id="tb-export" title="download the visible profiles as CSV">Export</button>
      <span class="sep"></span>
      <button id="tb-start" title="start selected profiles">▶ Start</button>
      <button id="tb-stop" class="danger" title="stop selected profiles">■ Stop</button>
      <button id="tb-delete" class="danger" title="delete selected profiles">Delete</button>`;
    $("#tb-new").addEventListener("click", () => { $("#create-modal").hidden = false; $("#new-name").focus(); });
    $("#tb-import").addEventListener("click", () => { $("#import-modal").hidden = false; });
    $("#tb-export").addEventListener("click", exportVisibleCsv);
    $("#tb-start").addEventListener("click", startSelected);
    $("#tb-stop").addEventListener("click", stopSelected);
    $("#tb-delete").addEventListener("click", deleteSelected);
  }
  /* Every other view (Warmups included) keeps its controls in its own
     toolbar — the topbar stays empty there. */
}

/* ======================= engine + google + sse status =================== */

async function refreshHealth() {
  try {
    const h = await api("/engine/health");
    $("#engine").textContent = h.binaryPresent ? `engine: ${h.runtime}` : "engine binary missing";
    $("#engine-dot").className = "dot " + (h.binaryPresent ? "dot-on" : "dot-warn");
  } catch {
    $("#engine").textContent = "engine: ?";
    $("#engine-dot").className = "dot dot-off";
  }
  try {
    const g = await api("/google/auth/status");
    $("#google").textContent = g.connected ? "google connected" : "google not connected";
    $("#google-dot").className = "dot " + (g.connected ? "dot-on" : "dot-off");
  } catch {
    /* chip stays muted */
  }
}

/* ========================= setup checklist (P5.5) ======================= */

let checklistDismissed = false;

async function loadChecklist() {
  const items = [];
  try {
    const h = await api("/engine/health");
    items.push({
      ok: h.binaryPresent,
      label: h.binaryPresent
        ? `engine installed (${h.installs.length} verified install${h.installs.length === 1 ? "" : "s"})`
        : "engine binary missing — run setup.ps1 from the engine package",
    });
  } catch {
    items.push({ ok: false, label: "engine health unreachable" });
  }
  try {
    const { proxies } = await api("/proxies");
    items.push({
      ok: proxies.length > 0,
      label: proxies.length
        ? `${proxies.length} prox${proxies.length === 1 ? "y" : "ies"} configured`
        : "no proxies yet — profiles will use your real IP",
    });
  } catch {
    items.push({ ok: false, label: "proxy list unreachable" });
  }
  try {
    const { profiles } = await api("/profiles");
    items.push({
      ok: profiles.length > 0,
      label: profiles.length
        ? `${profiles.length} profile${profiles.length === 1 ? "" : "s"} ready`
        : "no profiles yet — create one or import a CSV",
    });
  } catch {
    items.push({ ok: false, label: "profile list unreachable" });
  }
  const allOk = items.every((i) => i.ok);
  const banner = $("#checklist-banner");
  if (allOk || checklistDismissed) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  $("#checklist").innerHTML = items
    .map((it) => `<li class="${it.ok ? "ok" : "warn"}"><span class="mark">${it.ok ? "✓" : "!"}</span>${esc(it.label)}</li>`)
    .join("");
}

$("#checklist-close").addEventListener("click", () => {
  checklistDismissed = true;
  $("#checklist-banner").hidden = true;
});

/* ============================= profiles ================================ */

/* Batch selection survives re-renders (SSE run.* events reload the table
   constantly, so selection lives here, not in the DOM). */
const batchSelection = new Set();

function updateBatchBar() {
  const n = batchSelection.size;
  $("#batch-bar").hidden = n === 0;
  $("#batch-count").textContent = `${n} selected`;
  updateSelectAll();
}

/* Header checkbox: checked = every profile in the current view (all pages,
   current group + search) is selected; dash = some are. */
function updateSelectAll() {
  const box = $("#profiles-select-all");
  if (!box) return;
  const ids = visibleProfiles().map((p) => p.id);
  const picked = ids.filter((id) => batchSelection.has(id)).length;
  box.checked = ids.length > 0 && picked === ids.length;
  box.indeterminate = picked > 0 && picked < ids.length;
}

$("#profiles-select-all").addEventListener("change", (e) => {
  const ids = visibleProfiles().map((p) => p.id);
  for (const id of ids) {
    if (e.target.checked) batchSelection.add(id);
    else batchSelection.delete(id);
  }
  updateBatchBar();
  renderProfileTable();
});

/* "+ New group": groups are a property of profiles, so a new group needs
   its first members — the selection, or a newly created profile. */
async function newGroupFromSelection() {
  const ids = [...batchSelection];
  if (ids.length === 0) {
    toast("Tick the profiles for the new group (or the select-all box), then click + New group again — or create a profile and type a new group name.");
    return;
  }
  const name = window.prompt(`New group name for ${ids.length} selected profile${ids.length === 1 ? "" : "s"}:`, "");
  if (!name || name.trim() === "") return;
  try {
    const r = await api("/profiles/batch-move", { method: "POST", body: JSON.stringify({ ids, group: name.trim() }) });
    toast(`created group "${name.trim()}" with ${r.moved} profile${r.moved === 1 ? "" : "s"}`);
    activeGroup = name.trim();
    batchSelection.clear();
    updateBatchBar();
    await loadProfiles();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function startSelected() {
  const ids = [...batchSelection];
  if (ids.length === 0) return;
  const staggerMs = settingsData?.launch?.batchStaggerMs ?? 0;
  try {
    const r = await api("/profiles/batch-start", {
      method: "POST",
      body: JSON.stringify({ ids, staggerMs }),
    });
    const failed = r.results.filter((x) => x.status === "failed").length;
    toast(`batch-start: ${r.results.length - failed}/${r.results.length} started${failed ? `, ${failed} failed` : ""}`);
    for (const x of r.results.filter((x) => x.status === "failed")) {
      toast(`${x.id}: ${x.error?.message ?? "failed"}`, "error");
    }
    batchSelection.clear();
    updateBatchBar();
  } catch (err) {
    toast(err.message, "error");
  }
  await loadProfiles();
}

async function stopSelected() {
  const ids = [...batchSelection];
  if (ids.length === 0) return;
  try {
    const r = await api("/profiles/batch-stop", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    const failed = r.results.filter((x) => x.status === "failed").length;
    toast(`batch-stop: ${r.results.length - failed}/${r.results.length} stopped${failed ? `, ${failed} failed` : ""}`);
    for (const x of r.results.filter((x) => x.status === "failed")) {
      toast(`${x.id}: ${x.error?.message ?? "failed"}`, "error");
    }
  } catch (err) {
    toast(err.message, "error");
  }
  await loadProfiles();
}

async function deleteSelected() {
  const ids = [...batchSelection];
  if (ids.length === 0) return;
  if (!window.confirm(`Delete ${ids.length} profile${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
  let okCount = 0;
  for (const id of ids) {
    try {
      await api(`/profiles/${id}`, { method: "DELETE" });
      okCount++;
    } catch (err) {
      toast(`${id}: ${err.message}`, "error");
    }
  }
  toast(`deleted ${okCount}/${ids.length} profiles`);
  batchSelection.clear();
  updateBatchBar();
  await loadProfiles();
}

async function tileSelected(preset) {
  const ids = [...batchSelection];
  if (ids.length === 0) return;
  try {
    const r = await api("/profiles/batch-tile", {
      method: "POST",
      body: JSON.stringify({ ids, preset }),
    });
    const failed = r.results.filter((x) => x.status === "failed").length;
    toast(`tile ${preset}: ${r.results.length - failed}/${r.results.length} placed${failed ? `, ${failed} failed` : ""}`);
    for (const x of r.results.filter((x) => x.status === "failed")) {
      toast(`${x.id}: ${x.error?.message ?? "failed"}`, "error");
    }
  } catch (err) {
    toast(err.message, "error");
  }
}

/* Group filter chips — "All" plus one chip per group (GoLogin pattern).
   All profiles are fetched once and filtered client-side. */
let allProfiles = [];
let activeGroup = "all";
let profileQuery = "";
let proxyById = new Map();
/* pagination */
let page = 1;
let pageSize = Number(localStorage.getItem("qp.pageSize")) || 20;

function renderProfileTabs(groups) {
  const total = groups.reduce((n, g) => n + g.total, 0);
  const running = groups.reduce((n, g) => n + g.running, 0);
  const tabs = [
    { key: "all", label: "All", total, running },
    ...groups.map((g) => ({ key: g.group, label: g.group, total: g.total, running: g.running })),
  ];
  const bar = $("#profile-tabs");
  bar.innerHTML = "";
  for (const t of tabs) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip-tab" + (t.key === activeGroup ? " active" : "");
    b.innerHTML = `${esc(t.label)}<span class="count">${t.total}${t.running ? ` · <span class="run">${t.running}▶</span>` : ""}</span>`;
    b.addEventListener("click", () => {
      activeGroup = t.key;
      page = 1;
      renderProfileTabs(groups);
      renderProfileTable();
    });
    if (t.key !== "all") {
      const edit = document.createElement("span");
      edit.className = "rename";
      edit.title = "rename group";
      edit.textContent = "✎";
      edit.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const to = window.prompt(`Rename group "${t.label}" to:`, t.label);
        if (!to || to.trim() === "" || to.trim() === t.label) return;
        try {
          await api("/profile-groups/rename", {
            method: "POST",
            body: JSON.stringify({ from: t.label, to: to.trim() }),
          });
          if (activeGroup === t.label) activeGroup = to.trim();
          await loadProfiles();
        } catch (err) {
          toast(err.message, "error");
        }
      });
      b.appendChild(edit);
    }
    bar.appendChild(b);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.id = "new-group-chip";
  add.className = "chip-tab";
  add.title = "create a group from the selected profiles";
  add.textContent = "+ New group";
  add.addEventListener("click", newGroupFromSelection);
  bar.appendChild(add);
  $("#group-names").innerHTML = groups.map((g) => `<option value="${esc(g.group)}"></option>`).join("");
  const moveSel = $("#batch-move-group");
  moveSel.innerHTML =
    groups.map((g) => `<option value="${esc(g.group)}">${esc(g.group)}</option>`).join("") +
    `<option value="__new__">+ new group…</option>`;
}

function visibleProfiles() {
  let list = activeGroup === "all"
    ? allProfiles
    : allProfiles.filter((p) => p.group === activeGroup);
  if (profileQuery) {
    const q = profileQuery;
    list = list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.email ?? "").toLowerCase().includes(q) ||
        (p.group ?? "").toLowerCase().includes(q),
    );
  }
  return list;
}

function renderStats() {
  const stats = $("#view-stats");
  if (activeView !== "profiles") {
    stats.innerHTML = "";
    return;
  }
  const buckets = { running: 0, idle: 0, stopped: 0, error: 0 };
  for (const p of allProfiles) {
    const s = String(p.status ?? "idle").toLowerCase();
    if (s in buckets) buckets[s]++;
    else buckets.idle++;
  }
  stats.innerHTML = `
    <span>PROFILES <b>${allProfiles.length}</b></span>
    <span class="st-running">RUNNING <b>${buckets.running}</b></span>
    <span class="st-idle">IDLE <b>${buckets.idle}</b></span>
    <span>STOPPED <b>${buckets.stopped}</b></span>
    <span class="st-error">ERROR <b>${buckets.error}</b></span>`;
}

async function loadProfiles() {
  const [{ profiles }, groupData] = await Promise.all([
    api("/profiles"),
    api("/profile-groups").catch(() => ({ groups: [] })),
  ]);
  allProfiles = profiles;
  renderProfileTabs(groupData.groups ?? []);
  renderProfileTable();
  renderStats();
  loadChecklist();
}

async function renderProfileTable() {
  const tbody = $("#profiles-table tbody");
  tbody.innerHTML = "";
  const list = visibleProfiles();
  $("#profiles-empty").hidden = list.length !== 0;

  const pageCount = Math.max(1, Math.ceil(list.length / pageSize));
  if (page > pageCount) page = pageCount;
  const start = (page - 1) * pageSize;
  const rows = list.slice(start, start + pageSize);

  /* ONE batch request for every running profile's drift + tab count —
     per-row polling buckled past a few dozen running profiles (audit B4). */
  const stateById = new Map();
  const runningIds = rows.filter((p) => p.status === "running").map((p) => p.id);
  if (runningIds.length > 0) {
    try {
      const { states } = await api("/profiles/batch-state", {
        method: "POST",
        body: JSON.stringify({ ids: runningIds }),
      });
      for (const s of states) stateById.set(s.id, s);
    } catch {
      /* batch state is best-effort — badges just stay hidden */
    }
  }

  rows.forEach((p, i) => {
    const tr = document.createElement("tr");
    tr.dataset.id = p.id;
    if (batchSelection.has(p.id)) tr.classList.add("selected");

    const state = stateById.get(p.id);
    const driftBadge = state?.drift?.stale
      ? `<span class="tag tag-drift" title="${esc(state.drift.message)}">applies at next start</span>`
      : "";
    /* Adopted after an API restart: the proxy relay died with the old API. */
    const relayBadge =
      state?.relay === "lost-held"
        ? `<span class="tag tag-drift" title="The proxy relay died with the previous API process. Every page in this browser fails (nothing leaks). Stop and restart the profile to browse again.">proxy lost — restart</span>`
        : state?.relay === "lost-unguarded"
          ? `<span class="tag" style="color:var(--red);border-color:var(--red)" title="The proxy relay port is owned by another process: this browser's traffic may NOT go through its proxy. Stop this profile now.">proxy port taken — stop now</span>`
          : "";
    const favorite = p.extra?.favorite === true;
    const tabColor = typeof p.extra?.tabColor === "string" ? p.extra.tabColor : null;
    const proxy = p.proxyId ? proxyById.get(p.proxyId) : null;
    const proxyText = proxy ? `${proxy.host}:${proxy.port}` : "—";
    const status = String(p.status ?? "idle").toLowerCase();
    const running = status === "running";
    const tabCount = state ? state.tabCount : null;

    tr.innerHTML = `
      <td><input type="checkbox" class="batch-check" data-batch="${esc(p.id)}" title="select" ${batchSelection.has(p.id) ? "checked" : ""} /></td>
      <td class="mono" style="color:var(--faint)">${String(start + i + 1).padStart(4, "0")}</td>
      <td><span class="pname">${tabColor ? `<span class="color-dot" style="background:${esc(tabColor)}"></span>` : ""}<span class="fav ${favorite ? "" : "off"}" data-act="favorite" title="favorite">${favorite ? "★" : "☆"}</span><span data-act="edit" title="open profile editor" style="cursor:pointer">${esc(p.name)}</span></span> ${driftBadge}${relayBadge}</td>
      <td><span class="status status-${esc(status)}"><span class="dot ${running ? "dot-on" : status === "error" ? "dot-warn" : "dot-off"}"></span>${esc(status.toUpperCase())}</span></td>
      <td class="mono">${esc(proxyText)}</td>
      <td><span class="tag">${esc(p.group ?? "default")}</span></td>
      <td class="mono" style="color:var(--faint)">${tabCount ?? "—"}</td>
      <td><span class="row-actions">
        <button class="act-${running ? "stop" : "start"}" data-act="${running ? "stop" : "start"}" title="${running ? "stop" : "start"}">${running ? "■" : "▶"}</button>
        <button class="act-edit" data-act="edit" title="edit profile">✎</button>
        <button class="act-clone" data-act="clone" title="duplicate with a fresh fingerprint">⎘</button>
        <button data-act="regen" title="regenerate fingerprint">↻</button>
        <button class="act-delete" data-act="delete" title="delete profile">🗑</button>
      </span></td>`;
    tr.querySelectorAll("[data-act]").forEach((b) =>
      b.addEventListener("click", () => onProfileAction(p.id, b.dataset.act, p)),
    );
    tbody.appendChild(tr);
  });

  renderPagination(list.length, pageCount);
  updateSelectAll();
}

function renderPagination(total, pageCount) {
  const el = $("#pagination");
  if (total === 0) {
    el.innerHTML = "";
    return;
  }
  const pages = [];
  const push = (n) => pages[pages.length - 1] !== n && pages.push(n);
  push(1);
  for (let n = page - 1; n <= page + 1; n++) if (n > 1 && n < pageCount) push(n);
  push(pageCount);
  let pagesHtml = `<button data-page="prev" ${page === 1 ? "disabled" : ""}>‹</button>`;
  let last = 0;
  for (const n of pages) {
    if (n - last > 1) pagesHtml += `<button disabled>…</button>`;
    pagesHtml += `<button data-page="${n}" class="${n === page ? "cur" : ""}">${n}</button>`;
    last = n;
  }
  pagesHtml += `<button data-page="next" ${page === pageCount ? "disabled" : ""}>›</button>`;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  el.innerHTML = `
    <div class="pages">${pagesHtml}</div>
    <label style="margin-left:14px">SHOW <select id="page-size">
      ${[20, 50, 100].map((n) => `<option value="${n}" ${n === pageSize ? "selected" : ""}>${n}</option>`).join("")}
    </select></label>
    <span class="range">${from}–${to} of ${total}</span>`;
  el.querySelectorAll("[data-page]").forEach((b) =>
    b.addEventListener("click", () => {
      const v = b.dataset.page;
      if (v === "prev") page = Math.max(1, page - 1);
      else if (v === "next") page = Math.min(pageCount, page + 1);
      else page = Number(v);
      renderProfileTable();
    }),
  );
  $("#page-size").addEventListener("change", (e) => {
    pageSize = Number(e.target.value);
    localStorage.setItem("qp.pageSize", String(pageSize));
    page = 1;
    renderProfileTable();
  });
}

async function onProfileAction(id, act, profile) {
  try {
    if (act === "edit") {
      await openProfilePanel(id);
      return;
    }
    if (act === "start")
      await api(`/profiles/${id}/start`, { method: "POST", body: "{}" });
    if (act === "stop") await api(`/profiles/${id}/stop`, { method: "POST" });
    if (act === "regen")
      await api(`/profiles/${id}/fingerprint/regenerate`, { method: "POST", body: "{}" });
    if (act === "clone") {
      const name = window.prompt("Name for the copy (blank = auto):", `${profile?.name ?? ""} copy`);
      const payload = name && name.trim() !== "" ? { name: name.trim() } : {};
      await api(`/profiles/${id}/clone`, { method: "POST", body: JSON.stringify(payload) });
    }
    if (act === "favorite") {
      const next = profile?.extra?.favorite === true ? false : true;
      await api(`/profiles/${id}/persona`, {
        method: "PATCH",
        body: JSON.stringify({ favorite: next }),
      });
    }
    if (act === "delete") {
      if (!window.confirm(`Delete profile "${profile?.name ?? id}"? This cannot be undone.`)) return;
      await api(`/profiles/${id}`, { method: "DELETE" });
      batchSelection.delete(id);
      updateBatchBar();
    }
  } catch (err) {
    toast(err.message, "error");
  }
  await loadProfiles();
}

/* selection: delegated on the table so it survives re-renders */
$("#profiles-table").addEventListener("change", (e) => {
  const cb = e.target.closest?.(".batch-check");
  if (!cb) return;
  if (cb.checked) batchSelection.add(cb.dataset.batch);
  else batchSelection.delete(cb.dataset.batch);
  updateBatchBar();
  const tr = cb.closest("tr");
  if (tr) tr.classList.toggle("selected", cb.checked);
});

$("#profile-search").addEventListener("input", (e) => {
  profileQuery = e.target.value.trim().toLowerCase();
  page = 1;
  renderProfileTable();
});

$("#batch-start").addEventListener("click", startSelected);
$("#batch-stop").addEventListener("click", stopSelected);
$("#batch-delete").addEventListener("click", deleteSelected);
$("#tile-cascade").addEventListener("click", () => tileSelected("cascade"));
$("#tile-grid").addEventListener("click", () => tileSelected("grid"));
$("#batch-clear").addEventListener("click", () => {
  batchSelection.clear();
  updateBatchBar();
  renderProfileTable();
});
$("#batch-move").addEventListener("click", async () => {
  const ids = [...batchSelection];
  if (ids.length === 0) return;
  let group = $("#batch-move-group").value;
  if (group === "__new__") {
    const name = window.prompt("New group name:", "");
    if (!name || name.trim() === "") return;
    group = name.trim();
  }
  try {
    const r = await api("/profiles/batch-move", {
      method: "POST",
      body: JSON.stringify({ ids, group }),
    });
    toast(`moved ${r.moved} profile${r.moved === 1 ? "" : "s"} to "${group}"`);
    batchSelection.clear();
    updateBatchBar();
    await loadProfiles();
  } catch (err) {
    toast(err.message, "error");
  }
});

/* client-side CSV export of the visible profiles */
function exportVisibleCsv() {
  const list = visibleProfiles();
  if (list.length === 0) return;
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    ["name", "group", "email", "status", "tags", "notes"].join(","),
    ...list.map((p) =>
      [cell(p.name), cell(p.group), cell(p.email), cell(p.status), cell((p.tags ?? []).join(";")), cell(p.notes)]
        .join(","),
    ),
  ];
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `queuepilot-profiles-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`exported ${list.length} profiles to CSV`);
}

/* ========================= profile editor panel ========================= */

let panelProfileId = null;
let panelExtra = {};
let panelTabColor = null;

async function openProfilePanel(id) {
  try {
    const [p, proxyData] = await Promise.all([
      api(`/profiles/${id}`),
      api("/proxies").catch(() => ({ proxies: [] })),
    ]);
    panelProfileId = p.id;
    panelExtra = p.extra ?? {};
    panelTabColor = typeof panelExtra.tabColor === "string" ? panelExtra.tabColor : null;

    $("#panel-title").textContent = p.name;
    $("#pf-name").value = p.name;
    $("#pf-group").value = p.group ?? "";
    $("#pf-email").value = p.email ?? "";
    $("#pf-tags").value = (p.tags ?? []).join(", ");
    $("#pf-notes").value = p.notes ?? "";

    const proxies = proxyData.proxies ?? [];
    const sel = $("#pf-proxy");
    sel.innerHTML =
      `<option value="">(none)</option>` +
      proxies
        .map(
          (x) =>
            `<option value="${esc(x.id)}">${esc(x.name)} (${esc(x.host)}:${esc(x.port)})</option>`,
        )
        .join("");
    sel.value = p.proxyId ?? "";

    $("#pf-phone").value = panelExtra.phone ?? "";
    $("#pf-dob").value = panelExtra.dob ?? "";
    $("#pf-address1").value = panelExtra.address?.line1 ?? "";
    $("#pf-sms").value = (panelExtra.smsNumbers ?? [])
      .map((n) => (typeof n === "object" && n !== null ? (n.number ?? "") : String(n)))
      .filter(Boolean)
      .join("\n");
    $("#pf-starturls").value = (panelExtra.startUrls ?? []).join("\n");
    $("#pf-favorite").checked = panelExtra.favorite === true;
    $("#pf-tabcolor").value = /^#[0-9a-fA-F]{6}$/.test(panelTabColor ?? "")
      ? panelTabColor
      : "#4a9eff";
    $("#panel-status").textContent = "";
    $("#profile-panel").hidden = false;
  } catch (err) {
    toast(err.message, "error");
  }
}

function closeProfilePanel() {
  panelProfileId = null;
  panelExtra = {};
  panelTabColor = null;
  $("#profile-panel").hidden = true;
}

$("#panel-close").addEventListener("click", closeProfilePanel);

$("#pf-clearcolor").addEventListener("click", () => {
  panelTabColor = null;
  $("#panel-status").textContent = "tab color cleared — save to apply";
});

$("#panel-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!panelProfileId) return;
  const id = panelProfileId;
  const tags = $("#pf-tags")
    .value.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 24);
  const email = $("#pf-email").value.trim();
  const sms = $("#pf-sms").value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 50);
  const startUrls = $("#pf-starturls").value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 25);
  const phone = $("#pf-phone").value.trim();
  const dob = $("#pf-dob").value.trim();
  const address1 = $("#pf-address1").value.trim();
  const colorInput = $("#pf-tabcolor").value;
  const tabColor = panelTabColor === null ? null : /^#[0-9a-fA-F]{6}$/.test(colorInput) ? colorInput : null;

  try {
    await api(`/profiles/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: $("#pf-name").value.trim(),
        group: $("#pf-group").value.trim() || "default",
        email: email === "" ? null : email,
        notes: $("#pf-notes").value,
        tags,
        proxyId: $("#pf-proxy").value || null,
      }),
    });
    await api(`/profiles/${id}/persona`, {
      method: "PATCH",
      body: JSON.stringify({
        favorite: $("#pf-favorite").checked,
        smsNumbers: sms,
        startUrls,
        phone: phone === "" ? null : phone,
        dob: dob === "" ? null : dob,
        tabColor,
        address: { ...(panelExtra.address ?? {}), line1: address1 === "" ? null : address1 },
      }),
    });
    $("#panel-status").textContent = "saved";
    toast(`profile "${$("#pf-name").value.trim()}" saved`);
  } catch (err) {
    $("#panel-status").textContent = err.message;
    toast(err.message, "error");
  }
  await loadProfiles();
});

$("#pf-delete").addEventListener("click", async () => {
  if (!panelProfileId) return;
  const id = panelProfileId;
  const name = $("#pf-name").value.trim();
  if (!window.confirm(`Delete profile "${name}"? This cannot be undone.`)) return;
  try {
    await api(`/profiles/${id}`, { method: "DELETE" });
    batchSelection.delete(id);
    updateBatchBar();
    closeProfilePanel();
    toast(`profile "${name}" deleted`);
  } catch (err) {
    toast(err.message, "error");
  }
  await loadProfiles();
});

/* ========================= create profile modal ========================= */

$("#create-profile").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#new-name").value.trim();
  const group = $("#new-group").value.trim();
  if (!name) return;
  try {
    await api("/profiles", {
      method: "POST",
      body: JSON.stringify(group ? { name, group } : { name }),
    });
    $("#new-name").value = "";
    $("#new-group").value = "";
    $("#create-modal").hidden = true;
  } catch (err) {
    toast(err.message, "error");
  }
  await loadProfiles();
});

$("#create-close").addEventListener("click", () => { $("#create-modal").hidden = true; });
$("#create-modal").addEventListener("click", (e) => { if (e.target.id === "create-modal") $("#create-modal").hidden = true; });

/* ============================= proxies ================================ */

async function loadProxies() {
  const { proxies } = await api("/proxies");
  proxyById = new Map(proxies.map((p) => [p.id, p]));
  for (const id of [...proxySelection]) if (!proxyById.has(id)) proxySelection.delete(id);
  const tbody = $("#proxies tbody");
  tbody.innerHTML = "";
  $("#proxies-empty").hidden = proxies.length !== 0;
  for (const p of proxies) {
    const tr = document.createElement("tr");
    if (proxySelection.has(p.id)) tr.classList.add("selected");
    tr.innerHTML = `
      <td><input type="checkbox" data-proxy="${esc(p.id)}" ${proxySelection.has(p.id) ? "checked" : ""} /></td>
      <td style="font-weight:600">${esc(p.name)}</td>
      <td><span class="tag">${esc(p.type)}</span></td>
      <td class="mono">${esc(p.host)}:${esc(p.port)}${p.username ? ` <span style="color:var(--faint)">· ${esc(p.username)}</span>` : ""}</td>
      <td class="mono">${esc(p.timezone ?? "—")}</td>
      <td><button class="ghost" data-act="test">test</button> <span class="mono" style="color:var(--faint)" data-out></span></td>
      <td><span class="row-actions"><button class="act-delete" data-act="delete" title="delete proxy">🗑</button></span></td>`;
    tr.querySelector("[data-proxy]").addEventListener("change", (ev) => {
      if (ev.target.checked) proxySelection.add(p.id);
      else proxySelection.delete(p.id);
      tr.classList.toggle("selected", ev.target.checked);
      updateProxySelection();
    });
    tr.querySelector("[data-act='test']").addEventListener("click", () => testProxyRow(p, tr));
    tr.querySelector("[data-act='delete']").addEventListener("click", async () => {
      if (!window.confirm(`Delete proxy "${p.name}"?`)) return;
      try {
        await api(`/proxies/${p.id}`, { method: "DELETE" });
        proxySelection.delete(p.id);
        toast(`proxy "${p.name}" deleted`);
      } catch (err) {
        toast(err.message, "error");
      }
      await loadProxies();
    });
    tbody.appendChild(tr);
  }
  updateProxySelection();
}

/* Proxies view: selection, bulk test/delete, add drawer */
const proxySelection = new Set();

function updateProxySelection() {
  const n = proxySelection.size;
  $("#proxies-selected").textContent = n ? `${n} selected` : "";
  $("#proxies-delete-selected").disabled = n === 0;
  $("#proxies-test-selected").disabled = n === 0;
  const all = [...proxyById.keys()];
  const box = $("#proxies-select-all");
  box.checked = all.length > 0 && all.every((id) => proxySelection.has(id));
  box.indeterminate = n > 0 && !box.checked;
}

async function testProxyRow(p, tr) {
  const out = tr.querySelector("[data-out]");
  out.textContent = "…";
  out.style.color = "var(--faint)";
  try {
    const r = await api(`/proxies/${p.id}/test`, { method: "POST" });
    const geo = r.geo ? ` · ${[r.geo.city, r.geo.region, r.geo.country].filter(Boolean).join(", ")}` : "";
    out.textContent = r.ok ? `ok · ${r.latencyMs}ms${r.exitIp ? ` · ${r.exitIp}` : ""}${geo}` : `fail: ${r.error}`;
    out.style.color = r.ok ? "var(--green)" : "var(--red)";
  } catch (err) {
    out.textContent = err.message;
    out.style.color = "var(--red)";
  }
}

$("#proxies-select-all").addEventListener("change", (e) => {
  for (const id of proxyById.keys()) {
    if (e.target.checked) proxySelection.add(id);
    else proxySelection.delete(id);
  }
  loadProxies();
});

$("#proxies-test-selected").addEventListener("click", async () => {
  for (const tr of document.querySelectorAll("#proxies tbody tr")) {
    const id = tr.querySelector("[data-proxy]")?.dataset.proxy;
    if (id && proxySelection.has(id)) await testProxyRow(proxyById.get(id), tr);
  }
});

$("#proxies-delete-selected").addEventListener("click", async () => {
  const ids = [...proxySelection];
  if (ids.length === 0) return;
  if (!window.confirm(`Delete ${ids.length} prox${ids.length === 1 ? "y" : "ies"}?`)) return;
  const failed = [];
  for (const id of ids) {
    try {
      await api(`/proxies/${id}`, { method: "DELETE" });
      proxySelection.delete(id);
    } catch (err) {
      failed.push(`${proxyById.get(id)?.name ?? id}: ${err.message}`);
    }
  }
  toast(failed.length ? `${ids.length - failed.length} deleted; ${failed.length} kept — ${failed.join("; ")}` : `${ids.length} deleted`, failed.length ? "error" : "info");
  await loadProxies();
});

/* One pasted line -> proxy input. Accepts host:port, host:port:user:pass and
   name:host:port:user:pass, with an optional scheme:// prefix. The password
   is everything after the user (it may itself contain ':'). */
function parseProxyLine(raw, defaultType) {
  let line = raw.trim();
  if (!line) return null;
  let type = defaultType;
  const scheme = /^(https?|socks5h?):\/\//i.exec(line);
  if (scheme) {
    type = scheme[1].toLowerCase().replace("socks5h", "socks5");
    line = line.slice(scheme[0].length);
  }
  const parts = line.split(":");
  let name = null;
  if (parts.length >= 3 && !/^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2])) name = parts.shift();
  const [host, port, username, ...rest] = parts;
  if (!host || !/^\d+$/.test(port ?? "")) throw new Error("expected host:port[:user:pass]");
  return {
    name: name || `${host}:${port}`,
    type,
    host,
    port: Number(port),
    username: username || null,
    password: rest.length ? rest.join(":") : null,
  };
}

$("#proxy-add-open").addEventListener("click", () => {
  $("#proxy-add-result").innerHTML = "";
  $("#proxy-add-status").textContent = "";
  $("#proxy-add-modal").hidden = false;
  $("#proxy-add-lines").focus();
});
$("#proxy-add-close").addEventListener("click", () => { $("#proxy-add-modal").hidden = true; });
$("#proxy-add-modal").addEventListener("click", (e) => { if (e.target.id === "proxy-add-modal") $("#proxy-add-modal").hidden = true; });

$("#proxy-add-go").addEventListener("click", async () => {
  const lines = $("#proxy-add-lines").value.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return;
  const type = $("#proxy-add-type").value;
  const btn = $("#proxy-add-go");
  btn.disabled = true;
  const rows = [];
  let added = 0;
  for (const [i, raw] of lines.entries()) {
    let input = null;
    try {
      input = parseProxyLine(raw, type);
      await api("/proxies", { method: "POST", body: JSON.stringify(input) });
      added++;
      rows.push(`<tr><td>line ${i + 1}</td><td>${esc(input.name)} added</td></tr>`);
    } catch (err) {
      /* never echo the line back: it may carry a password */
      rows.push(`<tr class="import-err"><td>line ${i + 1}</td><td>${esc(input?.name ?? "")} ${esc(err.message)}</td></tr>`);
    }
  }
  btn.disabled = false;
  $("#proxy-add-status").textContent = `${added}/${lines.length} added`;
  $("#proxy-add-result").innerHTML = `<table class="import-table"><tbody>${rows.join("")}</tbody></table>`;
  if (added === lines.length) $("#proxy-add-lines").value = "";
  toast(`${added} prox${added === 1 ? "y" : "ies"} added`);
  await loadProxies();
});

/* ========================= CSV / xlsx import ============================ */

let pendingXlsx = null;
let lastImportCsv = null;
let lastImportXlsx = null;

function renderImportResult(data, applied) {
  const box = $("#import-result");
  const rows = (data.results ?? [])
    .map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.action)}</td></tr>`)
    .join("");
  const errs = (data.errors ?? [])
    .map(
      (e) =>
        `<tr class="import-err"><td>${esc(e.name)}</td><td>row ${esc(e.row)}: ${esc(e.message)}</td></tr>`,
    )
    .join("");
  box.innerHTML = `
    <p class="hint">${applied ? "Imported" : "Dry run"}: ${data.succeeded}/${data.total} ok${data.errors?.length ? `, ${data.errors.length} error${data.errors.length === 1 ? "" : "s"}` : ""}</p>
    <table class="import-table"><tbody>${rows}${errs}</tbody></table>`;
}

async function runImport(dryRun) {
  let data;
  if (pendingXlsx) {
    data = await api("/profiles/import-xlsx", {
      method: "POST",
      body: JSON.stringify({ xlsx: pendingXlsx, dryRun, upsert: $("#import-upsert").checked }),
    });
  } else {
    const csv = $("#import-csv").value.trim();
    if (!csv) return;
    data = await api("/profiles/import", {
      method: "POST",
      body: JSON.stringify({ csv, dryRun, upsert: $("#import-upsert").checked }),
    });
  }
  renderImportResult(data, !dryRun);
  $("#import-apply").disabled = dryRun ? data.succeeded === 0 : true;
  if (dryRun) {
    lastImportCsv = $("#import-csv").value.trim();
    lastImportXlsx = pendingXlsx;
  }
  if (!dryRun) {
    $("#import-modal").hidden = true;
    await loadProfiles();
  }
}

$("#import-file").addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  if (/\.xlsx$/i.test(f.name)) {
    const reader = new FileReader();
    reader.onload = () => {
      pendingXlsx = String(reader.result ?? "").split(",")[1] ?? null;
      $("#import-csv").value = "";
      $("#import-apply").disabled = true;
      $("#import-result").innerHTML = `<p class="hint">${esc(f.name)} loaded — preview, then apply</p>`;
    };
    reader.readAsDataURL(f);
    return;
  }
  pendingXlsx = null;
  const reader = new FileReader();
  reader.onload = () => {
    $("#import-csv").value = String(reader.result ?? "");
    $("#import-apply").disabled = true;
  };
  reader.readAsText(f);
});

$("#import-csv").addEventListener("input", () => {
  $("#import-apply").disabled = true;
});

$("#import-preview").addEventListener("click", async () => {
  try {
    await runImport(true);
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#import-apply").addEventListener("click", async () => {
  /* The import source must be byte-identical to what passed the dry run. */
  if ($("#import-csv").value.trim() !== lastImportCsv || pendingXlsx !== lastImportXlsx) {
    $("#import-apply").disabled = true;
    return;
  }
  try {
    await runImport(false);
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#import-close").addEventListener("click", () => { $("#import-modal").hidden = true; });
$("#import-modal").addEventListener("click", (e) => { if (e.target.id === "import-modal") $("#import-modal").hidden = true; });

/* ========================= proxy providers ============================== */

async function loadProxyProviders() {
  let data;
  try {
    data = await api("/proxy-providers");
  } catch {
    return; /* providers surface optional */
  }
  const tbody = $("#proxy-providers tbody");
  tbody.innerHTML = "";
  const providers = data.providers ?? [];
  $("#providers-empty").hidden = providers.length !== 0;
  for (const p of providers) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><button class="ghost" data-star title="star as default">${p.starred ? "★" : "☆"}</button></td>
      <td style="font-weight:600">${esc(p.name)}</td>
      <td><span class="tag">${esc(p.type)}</span></td>
      <td class="mono">${esc(p.distribution)}</td>
      <td><button class="ghost" data-act="refresh">refresh</button> <span class="mono" style="color:var(--faint)" data-msg></span></td>`;
    tr.querySelector("[data-star]").addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      try {
        await api(`/proxy-providers/${p.id}/star`, {
          method: "POST",
          body: JSON.stringify({ starred: !p.starred }),
        });
        await loadProxyProviders();
      } catch (err) {
        toast(err.message, "error");
        ev.target.disabled = false;
      }
    });
    tr.querySelector("[data-act='refresh']").addEventListener("click", async () => {
      const msg = tr.querySelector("[data-msg]");
      msg.textContent = "…";
      try {
        await api(`/proxy-providers/${p.id}/refresh`, { method: "POST" });
        msg.textContent = "ok";
        msg.style.color = "var(--green)";
        await loadProxies();
      } catch (err) {
        msg.textContent = err.message;
        msg.style.color = "var(--red)";
      }
    });
    tbody.appendChild(tr);
  }
}

/* ============================ tabs (Tab Thinger) ======================== */

let lastTabs = [];

async function refreshTabsProfiles() {
  const sel = $("#tabs-profile");
  const current = sel.value;
  const { profiles } = await api("/profiles");
  const running = profiles.filter((p) => p.status === "running");
  sel.innerHTML =
    `<option value="">(${running.length} running — pick one)</option>` +
    running.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  if (running.some((p) => p.id === current)) sel.value = current;
}

function selectedTabIds() {
  return [...document.querySelectorAll("#tabs-table tbody input[data-tab]:checked")].map(
    (c) => c.dataset.tab,
  );
}

/* tab-ops depth: per-tab reload / duplicate / screenshot / close */
const AUTO_RELOAD_CHOICES = [[0, "off"], [15, "15 s"], [30, "30 s"], [60, "1 min"], [300, "5 min"], [900, "15 min"]];

async function onTabAction(profileId, tab, act, btn) {
  btn.disabled = true;
  try {
    if (act === "reload") {
      await api(`/profiles/${profileId}/tabs/${tab.id}/reload`, { method: "POST" });
      toast(`reloaded ${tab.url ?? tab.id}`);
    } else if (act === "duplicate") {
      await api(`/profiles/${profileId}/tabs/${tab.id}/duplicate`, { method: "POST" });
    } else if (act === "close") {
      await api(`/profiles/${profileId}/tabs/${tab.id}/close`, { method: "POST" });
    } else if (act === "screenshot") {
      /* fetch, not a plain <img src>: the bearer-token hook applies to images too */
      const res = await fetch(`/profiles/${profileId}/tabs/${tab.id}/screenshot`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      const img = $("#tab-shot-img");
      if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
      img.src = URL.createObjectURL(await res.blob());
      $("#tab-shot-url").textContent = tab.url ?? tab.id;
      $("#tab-shot-modal").hidden = false;
    }
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
  if (act === "duplicate" || act === "close") await runTabsQuery();
}

$("#tab-shot-close").addEventListener("click", () => { $("#tab-shot-modal").hidden = true; });
$("#tab-shot-modal").addEventListener("click", (e) => { if (e.target.id === "tab-shot-modal") $("#tab-shot-modal").hidden = true; });

async function runTabsQuery() {
  const profileId = $("#tabs-profile").value;
  const tbody = $("#tabs-table tbody");
  if (!profileId) {
    tbody.innerHTML = "";
    $("#tabs-empty").hidden = false;
    $("#tabs-summary").textContent = "start a profile to see its tabs";
    lastTabs = [];
    return;
  }
  let data;
  try {
    data = await api(`/profiles/${profileId}/tabs/query`, {
      method: "POST",
      body: JSON.stringify({ q: $("#tabs-query").value, sort: $("#tabs-sort").value || undefined }),
    });
  } catch (err) {
    tbody.innerHTML = "";
    $("#tabs-summary").textContent = err.message;
    lastTabs = [];
    return;
  }
  lastTabs = data.tabs;
  tbody.innerHTML = "";
  $("#tabs-empty").hidden = data.tabs.length !== 0;
  for (const t of data.tabs) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" data-tab="${esc(t.id)}" ${t.status === "closed" ? "disabled" : ""} /></td>
      <td class="mono" style="max-width:420px;overflow:hidden;text-overflow:ellipsis">${esc(t.url ?? "—")}</td>
      <td><span class="status status-${esc(t.status)}"><span class="dot ${t.status === "open" ? "dot-on" : "dot-off"}"></span>${esc(t.status.toUpperCase())}</span></td>
      <td class="mono" style="color:var(--faint)">${esc(t.partitionId.slice(0, 8))}</td>
      <td>${t.status === "open" ? `<select data-autoreload title="reload this tab on an interval while it stays open">${AUTO_RELOAD_CHOICES.map(([sec, label]) => `<option value="${sec}" ${Number(t.autoReloadSec ?? 0) === sec ? "selected" : ""}>${label}</option>`).join("")}</select>` : ""}</td>
      <td>${t.status === "open" ? `<span class="row-actions">
        <button data-tact="reload" title="reload tab">↻</button>
        <button class="act-clone" data-tact="duplicate" title="duplicate into the same session partition">⎘</button>
        <button class="act-edit" data-tact="screenshot" title="screenshot">📷</button>
        <button class="act-delete" data-tact="close" title="close tab">✕</button>
      </span>` : ""}</td>`;
    tr.querySelectorAll("[data-tact]").forEach((b) =>
      b.addEventListener("click", () => onTabAction(profileId, t, b.dataset.tact, b)),
    );
    tr.querySelector("[data-autoreload]")?.addEventListener("change", async (ev) => {
      const intervalSec = Number(ev.target.value);
      try {
        await api(`/profiles/${profileId}/tabs/${t.id}/auto-reload`, { method: "POST", body: JSON.stringify({ intervalSec }) });
        toast(intervalSec ? `auto-reload every ${intervalSec}s: ${t.url ?? t.id}` : `auto-reload off: ${t.url ?? t.id}`);
      } catch (err) {
        toast(err.message, "error");
        await runTabsQuery();
      }
    });
    tbody.appendChild(tr);
  }
  const open = data.tabs.filter((t) => t.status === "open").length;
  $("#tabs-summary").textContent = `${data.tabs.length} tabs (${open} open)`;
}

$("#tabs-run").addEventListener("click", runTabsQuery);
$("#tabs-query").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runTabsQuery();
});
$("#tabs-select-all").addEventListener("change", (e) => {
  document
    .querySelectorAll("#tabs-table tbody input[data-tab]:not(:disabled)")
    .forEach((c) => (c.checked = e.target.checked));
});
$("#tabs-close").addEventListener("click", async () => {
  const profileId = $("#tabs-profile").value;
  const tabIds = selectedTabIds();
  if (!profileId || tabIds.length === 0) return;
  try {
    const r = await api(`/profiles/${profileId}/tabs/bulk-close`, {
      method: "POST",
      body: JSON.stringify({ tabIds }),
    });
    const failed = r.results.filter((x) => !x.closed).length;
    toast(`bulk-close: ${r.results.length - failed}/${r.results.length} closed`);
  } catch (err) {
    toast(err.message, "error");
  }
  $("#tabs-select-all").checked = false;
  await runTabsQuery();
  await loadProfiles();
});
$("#tabs-open").addEventListener("click", async () => {
  const profileId = $("#tabs-profile").value;
  const urls = $("#tabs-open-urls").value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!profileId || urls.length === 0) return;
  try {
    const r = await api(`/profiles/${profileId}/tabs/bulk-open`, {
      method: "POST",
      body: JSON.stringify({ urls }),
    });
    const failed = r.results.filter((x) => x.tab === null).length;
    toast(`bulk-open: ${r.results.length - failed}/${r.results.length} opened`);
    $("#tabs-open-urls").value = "";
  } catch (err) {
    toast(err.message, "error");
  }
  await runTabsQuery();
  await loadProfiles();
});
$("#tabs-profile").addEventListener("change", runTabsQuery);

/* ============================== cookies ================================ */

async function refreshCookiesProfiles() {
  const sel = $("#cookies-profile");
  const current = sel.value;
  const { profiles } = await api("/profiles");
  const running = profiles.filter((p) => p.status === "running");
  sel.innerHTML =
    `<option value="">(${running.length} running — pick one)</option>` +
    running.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  if (running.some((p) => p.id === current)) sel.value = current;
}

function cookieStatus(msg, isErr = false) {
  const el = $("#cookies-status");
  el.textContent = msg;
  el.style.color = isErr ? "var(--red)" : "var(--faint)";
}

async function loadCookieJar() {
  const profileId = $("#cookies-profile").value;
  const tbody = $("#cookies-table tbody");
  if (!profileId) {
    tbody.innerHTML = "";
    $("#cookies-empty").hidden = false;
    cookieStatus("start a profile, pick it above, then Load jar");
    return;
  }
  cookieStatus("loading…");
  try {
    const data = await api(`/profiles/${profileId}/cookies`);
    tbody.innerHTML = "";
    $("#cookies-empty").hidden = (data.cookies ?? []).length !== 0;
    for (const c of data.cookies ?? []) {
      const tr = document.createElement("tr");
      const expires = c.expires && c.expires > 0
        ? new Date(c.expires * 1000).toISOString().slice(0, 10)
        : "session";
      tr.innerHTML = `
        <td style="font-weight:600">${esc(c.name)}</td>
        <td class="mono">${esc(c.domain)}</td>
        <td class="mono">${esc(c.path)}</td>
        <td class="mono" style="color:var(--faint)">${esc(expires)}</td>
        <td class="mono">${c.secure ? "✓" : ""}</td>
        <td class="mono">${c.httpOnly ? "✓" : ""}</td>
        <td class="mono" style="color:var(--faint)">${esc(c.value)}</td>`;
      tbody.appendChild(tr);
    }
    cookieStatus(`${data.total} cookies${data.revealed ? " (raw values)" : " (values redacted)"}`);
  } catch (err) {
    tbody.innerHTML = "";
    $("#cookies-empty").hidden = false;
    cookieStatus(err.message, true);
  }
}

$("#cookies-refresh").addEventListener("click", loadCookieJar);
$("#cookies-profile").addEventListener("change", loadCookieJar);

$("#cookies-file").addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    $("#cookies-status").dataset.pendingImport = String(reader.result ?? "");
    cookieStatus(`${f.name} loaded — click Import into jar`);
  };
  reader.readAsText(f);
});

$("#cookies-import").addEventListener("click", async () => {
  const profileId = $("#cookies-profile").value;
  if (!profileId) return;
  const content = $("#cookies-status").dataset.pendingImport ?? "";
  if (!content.trim()) {
    cookieStatus("pick a cookies.txt / .json file first", true);
    return;
  }
  try {
    const r = await api(`/profiles/${profileId}/cookies/import`, {
      method: "POST",
      body: JSON.stringify({ format: $("#cookies-import-format").value, content }),
    });
    toast(`cookie import: ${r.set}/${r.total} loaded`);
    $("#cookies-status").dataset.pendingImport = "";
    $("#cookies-file").value = "";
    await loadCookieJar();
  } catch (err) {
    cookieStatus(err.message, true);
  }
});

$("#cookies-export").addEventListener("click", async () => {
  const profileId = $("#cookies-profile").value;
  if (!profileId) return;
  const format = $("#cookies-export-format").value;
  try {
    const res = await fetch(`/profiles/${profileId}/cookies/export?format=${format}`);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cookies-${profileId.slice(0, 8)}.${format === "json" ? "json" : "txt"}`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("cookie jar exported");
  } catch (err) {
    cookieStatus(err.message, true);
  }
});

$("#cookies-clear").addEventListener("click", async () => {
  const profileId = $("#cookies-profile").value;
  if (!profileId) return;
  const domain = $("#cookies-clear-filter").value.trim();
  if (!domain) {
    cookieStatus("type a domain filter first — refusing to wipe the whole jar blindly", true);
    return;
  }
  if (!window.confirm(`Clear all cookies matching "${domain}"?`)) return;
  try {
    const r = await api(`/profiles/${profileId}/cookies/clear`, {
      method: "POST",
      body: JSON.stringify({ domain }),
    });
    toast(`cleared ${r.matched} cookies matching ${domain}`);
    await loadCookieJar();
  } catch (err) {
    cookieStatus(err.message, true);
  }
});

/* ============================== settings ================================ */

/* Field descriptors per section — mirror packages/contracts/src/settings.ts.
   The API validates everything it receives; these drive the form only. */
const SETTINGS_FIELDS = {
  general: [
    { key: "theme", label: "Theme", type: "select", options: [["jancy", "Jancy (dark, classic)"], ["light", "Light (planned)"]] },
    { key: "density", label: "Table density", type: "select", options: [["comfortable", "Comfortable"], ["pro", "Pro (dense)"]] },
    { key: "language", label: "Language", type: "select", options: [["en", "English"], ["es", "Español"]] },
    { key: "startOnBoot", label: "Start QueuePilot with Windows", type: "checkbox" },
  ],
  engine: [
    { key: "channel", label: "Engine update channel", type: "select", options: [["stable", "Stable"], ["beta", "Beta"]] },
    { key: "downloadConsent", label: "Allow engine binary downloads", type: "checkbox" },
  ],
  launch: [
    { key: "batchStaggerMs", label: "Batch start delay (ms)", type: "number", min: 0, max: 60000 },
    { key: "maxConcurrent", label: "Max concurrent profiles (0 = built-in cap)", type: "number", min: 0, max: 500 },
    { key: "openStartPages", label: "Open start pages at launch", type: "checkbox" },
    { key: "deckEnabled", label: "Profile Deck: put each launched profile in one window with a tab per profile (Windows)", type: "checkbox" },
  ],
  team: [
    { key: "serverUrl", label: "Team server URL", type: "text", placeholder: "https://… (empty = off)" },
    { key: "token", label: "Team server token", type: "text", placeholder: "bearer token (empty = off)" },
    { key: "syncPassphrase", label: "Sync passphrase (enables background pull sync)", type: "text", placeholder: "empty = manual push/pull only" },
    { key: "syncGroups", label: "Sync groups (comma-separated)", type: "text", placeholder: "e.g. ads, shop" },
  ],
  integrations: [
    { key: "googleAccount", label: "Google account", type: "text", placeholder: "display name (empty = none)" },
    { key: "providersNote", label: "Providers note", type: "textarea", placeholder: "where credentials live — never store secrets here" },
  ],
  sites: [
    { key: "extractorsEnabled", label: "Read queue position / cart timer / event info from open tabs", type: "checkbox" },
    { key: "extractorIntervalSec", label: "Read every (seconds)", type: "number", min: 2, max: 60 },
    { key: "queuePositionCsv", label: "Log every new queue position to a CSV per event", type: "checkbox" },
    { key: "tmDismissOverlay", label: "Ticketmaster: dismiss the overlay (clicks)", type: "checkbox" },
    { key: "tmAutoNoInsurance", label: "Ticketmaster: choose no insurance (clicks)", type: "checkbox" },
    { key: "tmAutoTerms", label: "Ticketmaster: accept terms (clicks)", type: "checkbox" },
    { key: "discordEnabled", label: "Send Discord notifications (set the webhook under Integrations)", type: "checkbox" },
    { key: "discordEvents", label: "Discord events (comma-separated)", type: "text", placeholder: "queue.passed, cart.timer, code.failed, run.crashed" },
    { key: "discordPositionEveryMin", label: "Post queue position every N minutes (0 = never)", type: "number", min: 0, max: 1440 },
    { key: "discordCookieExport", label: "Allow sending a profile's cookies + exit IP to Discord (needs SPECTRA_API_TOKEN)", type: "checkbox" },
  ],
  ui: [
    { key: "tabLabelFormat", label: "Tab label format (JS body over ctx, e.g. return ctx.email + \" #\" + ctx.tab.data.queuePosition)", type: "textarea", placeholder: "empty = email · #position" },
    { key: "tabSort", label: "Tab View sort (JS body over a, b returning a number)", type: "textarea", placeholder: "empty = priority, then name" },
  ],
  automation: [
    { key: "scriptingEndpoints", label: "Enable scripting endpoints (JYL run, plugins/parsers/resolvers, aliases) — runs code, keep off unless needed", type: "checkbox" },
    { key: "enabledPlugins", label: "Enabled plugins (comma-separated)", type: "text", placeholder: "plugin file names" },
    { key: "enabledJyl", label: "Enabled JYL commands (comma-separated)", type: "text", placeholder: "command names" },
  ],
};
const SETTINGS_SECTIONS = Object.keys(SETTINGS_FIELDS);
let settingsData = null;
let settingsSection = "general";

function settingsToForm(section, doc) {
  const out = {};
  for (const f of SETTINGS_FIELDS[section]) {
    if (f.type === "checkbox") out[f.key] = doc[f.key] === true;
    else if (Array.isArray(doc[f.key])) out[f.key] = doc[f.key].join(", ");
    else out[f.key] = doc[f.key] ?? "";
  }
  return out;
}

function settingsFromField(f, raw) {
  if (f.type === "checkbox") return raw;
  if (f.type === "number") return Number(raw);
  if (f.key === "syncGroups" || f.key === "enabledPlugins" || f.key === "enabledJyl" || f.key === "discordEvents")
    return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (["serverUrl", "token", "googleAccount", "syncPassphrase", "tabLabelFormat", "tabSort"].includes(f.key))
    return String(raw).trim() === "" ? null : String(raw).trim();
  return raw;
}

async function loadSettings() {
  try {
    settingsData = await api("/settings/sections");
  } catch (err) {
    $("#settings-status").textContent = `settings unavailable: ${err.message}`;
    return;
  }
  applyDensity();
  renderSettings();
}

function applyDensity() {
  const d = settingsData?.general?.density ?? "comfortable";
  document.body.dataset.density = d;
}

function renderSettingsNav() {
  const nav = $("#settings-nav");
  nav.innerHTML = "";
  for (const s of SETTINGS_SECTIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s;
    b.className = s === settingsSection ? "active" : "";
    b.addEventListener("click", () => {
      settingsSection = s;
      renderSettings();
    });
    nav.appendChild(b);
  }
}

/* Integrations gets a read-only reference card for the email resolvers —
   there is no writable IMAP settings endpoint; IMAP/Gmail are resolvers in
   the scripting layer. This card documents the URL shapes. */
function renderIntegrationsInfo() {
  const box = $("#integrations-info");
  if (settingsSection !== "integrations") {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `
    <div class="info-card" id="email-accounts-card">
      <h4>Email accounts (Gmail / IMAP)</h4>
      <p>Used to read one-time codes from mail. For Gmail, turn on 2-Step Verification and create an <b>app password</b> (Google Account → Security → App passwords). The app password is stored encrypted on this machine and never shown again.</p>
      <table class="import-table" id="email-accounts-table"><tbody></tbody></table>
      <p id="email-accounts-empty" class="hint" hidden>No email accounts yet.</p>
      <form id="email-account-form" autocomplete="off" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;align-items:end;margin-top:10px">
        <label>Email <input id="email-account-email" type="email" required maxlength="254" placeholder="you@gmail.com" /></label>
        <label>App password <input id="email-account-password" type="password" required maxlength="200" autocomplete="new-password" placeholder="16-letter app password" /></label>
        <label>Server <input id="email-account-host" required maxlength="253" value="imap.gmail.com" /></label>
        <label>Port <input id="email-account-port" type="number" required min="1" max="65535" value="993" /></label>
        <button type="submit" class="primary" id="email-account-add">+ Add</button>
      </form>
      <p class="hint" id="email-account-status"></p>
      <p>In a profile CSV <code>Site:Ticketmaster</code> column: <code>emailcode=imap:you@gmail.com:ticketmaster</code> returns the code (the parser picks the right email). Raw body for scripts: <code>imap:you@gmail.com</code>.</p>
    </div>
    <div class="info-card" id="team-redeem-card">
      <h4>Redeem an invite</h4>
      <p>Paste the server address and the one-time invite (<code>qpi_…</code>) the owner sent. The licence key is stored in Settings → Team and never shown.</p>
      <p id="licence-state" class="hint">checking…</p>
      <form id="redeem-form" autocomplete="off" style="display:grid;grid-template-columns:minmax(220px,2fr) minmax(220px,2fr) minmax(120px,1fr) auto;gap:8px;align-items:end;margin-top:6px">
        <label>Server <input id="redeem-server" maxlength="300" placeholder="https://…" /></label>
        <label>Invite <input id="redeem-invite" type="password" maxlength="100" autocomplete="off" placeholder="qpi_…" /></label>
        <label>Your name <input id="redeem-name" maxlength="80" placeholder="optional" /></label>
        <button type="submit" class="primary">Redeem</button>
      </form>
      <p class="hint" id="redeem-status"></p>
    </div>
    <div class="info-card" id="discord-card">
      <h4>Discord notifications</h4>
      <p>Paste a Discord <b>webhook URL</b> (channel settings → Integrations → Webhooks). It is stored encrypted on this machine and only a masked form is ever shown. Choose what to send under Settings → sites.</p>
      <p id="discord-state" class="hint">checking…</p>
      <form id="discord-form" autocomplete="off" style="display:grid;grid-template-columns:minmax(260px,3fr) auto auto auto;gap:8px;align-items:end;margin-top:6px">
        <label>Webhook URL <input id="discord-url" type="password" maxlength="400" autocomplete="new-password" placeholder="https://discord.com/api/webhooks/…" /></label>
        <button type="submit" class="primary">Save</button>
        <button type="button" class="ghost" id="discord-test">Send test</button>
        <button type="button" class="danger" id="discord-remove">Remove</button>
      </form>
      <p class="hint" id="discord-status"></p>
    </div>
    <div class="info-card" id="aycd-card">
      <h4>AYCD Inbox</h4>
      <p>Reads 2FA codes through AYCD Inbox. Paste the <b>Inbox API key</b> (Inbox → Settings → Tasks (API)). It is stored encrypted on this machine and never shown again. <b>The Inbox app must be open</b> while codes are fetched.</p>
      <p id="aycd-state" class="hint">checking…</p>
      <form id="aycd-form" autocomplete="off" style="display:grid;grid-template-columns:minmax(220px,2fr) auto auto auto;gap:8px;align-items:end;margin-top:6px">
        <label>Inbox API key <input id="aycd-key" type="password" maxlength="500" autocomplete="new-password" placeholder="paste key" /></label>
        <button type="submit" class="primary">Save key</button>
        <button type="button" class="ghost" id="aycd-test">Test</button>
        <button type="button" class="danger" id="aycd-remove">Remove</button>
      </form>
      <p class="hint" id="aycd-status"></p>
      <p>In a profile CSV <code>Site:Ticketmaster</code> column: <code>emailcode=aycd:@aycd</code>. Catch-all/forwarding accounts: <code>aycd:@aycd:ticketmaster:&lt;templateId&gt;</code>. Or use AYCD's <b>IMAP Server</b> (Inbox → Mail → IMAP Server): <code>emailcode=imap:127.0.0.1:&lt;port&gt;:&lt;account email&gt;:&lt;password&gt;:ticketmaster</code>.</p>
    </div>`;
  $("#email-account-form").addEventListener("submit", addEmailAccount);
  loadEmailAccounts();
  wireAycdCard();
  wireDiscordCard();
  wireRedeemCard();
}

function wireDiscordCard() {
  const state = $("#discord-state");
  const status = $("#discord-status");
  const say = (msg, color) => {
    status.textContent = msg;
    status.style.color = color;
  };
  const refresh = async () => {
    try {
      const s = await api("/integrations/discord");
      state.textContent = s.configured ? `Webhook stored: ${s.webhook}` : "No webhook stored yet.";
      state.style.color = s.configured ? "var(--green)" : "var(--faint)";
    } catch (err) {
      state.textContent = err.message;
      state.style.color = "var(--red)";
    }
  };
  $("#discord-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("#discord-url");
    const webhookUrl = input.value.trim();
    input.value = "";
    if (!webhookUrl) return say("paste the webhook URL first", "var(--red)");
    try {
      await api("/integrations/discord", { method: "PUT", body: JSON.stringify({ webhookUrl }) });
      say("webhook saved — click Send test", "var(--faint)");
    } catch (err) {
      say(err.message, "var(--red)");
    }
    refresh();
  });
  $("#discord-test").addEventListener("click", async (ev) => {
    ev.target.disabled = true;
    say("sending…", "var(--faint)");
    try {
      await api("/integrations/discord/test", { method: "POST" });
      say("test message sent", "var(--green)");
    } catch (err) {
      say(err.message, "var(--red)");
    }
    ev.target.disabled = false;
  });
  $("#discord-remove").addEventListener("click", async () => {
    if (!window.confirm("Remove the stored Discord webhook?")) return;
    try {
      await api("/integrations/discord", { method: "DELETE" });
      say("webhook removed", "var(--faint)");
    } catch (err) {
      say(err.message, "var(--red)");
    }
    refresh();
  });
  refresh();
}

function wireRedeemCard() {
  const status = $("#redeem-status");
  const say = (msg, color) => {
    status.textContent = msg;
    status.style.color = color;
  };
  const refresh = async () => {
    const el = $("#licence-state");
    try {
      const r = await api("/team/licence");
      if (!r.configured) el.textContent = "Not connected to a team server.";
      else if (r.error) el.textContent = `Connected, but: ${r.error.message}`;
      else el.textContent = `Licence: ${r.licence.account?.name ?? "?"}${r.licence.daysLeft != null ? ` · ${r.licence.daysLeft} days left` : ""}`;
    } catch (err) {
      el.textContent = err.message;
    }
  };
  const server = $("#redeem-server");
  api("/settings/sections/team").then((t) => { if (t.serverUrl) server.value = t.serverUrl; }).catch(() => {});
  $("#redeem-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const invite = $("#redeem-invite").value.trim();
    $("#redeem-invite").value = "";
    if (!server.value.trim() || !invite) return say("enter the server and the invite", "var(--red)");
    try {
      await api("/team/redeem", { method: "POST", body: JSON.stringify({ serverUrl: server.value.trim(), invite, name: $("#redeem-name").value.trim() || undefined }) });
      say("invite redeemed — you are connected", "var(--green)");
    } catch (err) {
      say(err.message, "var(--red)");
    }
    refresh();
  });
  refresh();
}

function wireAycdCard() {
  const state = $("#aycd-state");
  const status = $("#aycd-status");
  const say = (msg, color) => {
    status.textContent = msg;
    status.style.color = color;
  };
  const refresh = async () => {
    try {
      const s = await api("/integrations/aycd");
      state.textContent = s.configured ? "Key stored." : "No key stored yet.";
      state.style.color = s.configured ? "var(--green)" : "var(--faint)";
    } catch (err) {
      state.textContent = err.message;
      state.style.color = "var(--red)";
    }
  };
  $("#aycd-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("#aycd-key");
    const apiKey = input.value.trim();
    input.value = "";
    if (!apiKey) return say("paste the Inbox API key first", "var(--red)");
    try {
      await api("/integrations/aycd", { method: "PUT", body: JSON.stringify({ apiKey }) });
      say("key saved — click Test (with the Inbox app open)", "var(--faint)");
    } catch (err) {
      say(err.message, "var(--red)");
    }
    refresh();
  });
  $("#aycd-test").addEventListener("click", async (ev) => {
    ev.target.disabled = true;
    say("contacting AYCD…", "var(--faint)");
    try {
      const r = await api("/integrations/aycd/verify", { method: "POST" });
      r.ok ? say("ok — key accepted, Inbox reachable", "var(--green)") : say(r.error, "var(--red)");
    } catch (err) {
      say(err.message, "var(--red)");
    }
    ev.target.disabled = false;
  });
  $("#aycd-remove").addEventListener("click", async () => {
    if (!window.confirm("Remove the stored AYCD Inbox key?")) return;
    try {
      await api("/integrations/aycd", { method: "DELETE" });
      say("key removed", "var(--faint)");
    } catch (err) {
      say(err.message, "var(--red)");
    }
    refresh();
  });
  refresh();
}

async function loadEmailAccounts() {
  const tbody = $("#email-accounts-table tbody");
  if (!tbody) return;
  let accounts = [];
  try {
    ({ accounts } = await api("/email-accounts"));
  } catch (err) {
    $("#email-account-status").textContent = err.message;
    return;
  }
  tbody.innerHTML = "";
  $("#email-accounts-empty").hidden = accounts.length !== 0;
  for (const a of accounts) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="font-weight:600">${esc(a.email)}</td>
      <td class="mono">${esc(a.host)}:${esc(a.port)}${a.tls ? "" : " (no TLS)"}</td>
      <td>${a.hasPassword ? "app password stored" : `<span style="color:var(--red)">no password</span>`}</td>
      <td><button type="button" class="ghost" data-act="test">Test</button> <span class="mono" data-out></span></td>
      <td><button type="button" class="danger" data-act="remove">Remove</button></td>`;
    tr.querySelector('[data-act="test"]').addEventListener("click", async (ev) => {
      const out = tr.querySelector("[data-out]");
      ev.target.disabled = true;
      out.textContent = "logging in…";
      out.style.color = "var(--faint)";
      try {
        const r = await api(`/email-accounts/${a.id}/test`, { method: "POST" });
        out.textContent = r.ok ? "ok — logged in" : r.error;
        out.style.color = r.ok ? "var(--green)" : "var(--red)";
      } catch (err) {
        out.textContent = err.message;
        out.style.color = "var(--red)";
      }
      ev.target.disabled = false;
    });
    tr.querySelector('[data-act="remove"]').addEventListener("click", async () => {
      if (!window.confirm(`Remove ${a.email}? Its stored app password is deleted too.`)) return;
      try {
        await api(`/email-accounts/${a.id}`, { method: "DELETE" });
        toast(`email account ${a.email} removed`);
      } catch (err) {
        toast(err.message, "error");
      }
      loadEmailAccounts();
    });
    tbody.appendChild(tr);
  }
}

async function addEmailAccount(e) {
  e.preventDefault();
  const status = $("#email-account-status");
  const body = {
    email: $("#email-account-email").value.trim(),
    appPassword: $("#email-account-password").value,
    host: $("#email-account-host").value.trim(),
    port: Number($("#email-account-port").value),
  };
  try {
    await api("/email-accounts", { method: "POST", body: JSON.stringify(body) });
    status.textContent = `${body.email} added — click Test to check the login`;
    status.style.color = "var(--faint)";
    $("#email-account-email").value = "";
    $("#email-account-password").value = "";
  } catch (err) {
    status.textContent = err.message;
    status.style.color = "var(--red)";
  }
  $("#email-account-password").value = "";
  loadEmailAccounts();
}

function renderSettings() {
  if (!settingsData) return;
  renderSettingsNav();
  renderIntegrationsInfo();
  const form = $("#settings-form");
  const doc = settingsData[settingsSection];
  const values = settingsToForm(settingsSection, doc);
  form.innerHTML = "";
  for (const f of SETTINGS_FIELDS[settingsSection]) {
    const label = document.createElement("label");
    label.className = "settings-field" + (f.type === "checkbox" ? " check" : "");
    const id = `set-${settingsSection}-${f.key}`;
    let control;
    if (f.type === "select") {
      control = `<select id="${id}">${f.options.map(([v, t]) => `<option value="${esc(v)}" ${values[f.key] === v ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
    } else if (f.type === "checkbox") {
      control = `<input type="checkbox" id="${id}" ${values[f.key] ? "checked" : ""} />`;
    } else if (f.type === "textarea") {
      control = `<textarea id="${id}" rows="3" placeholder="${esc(f.placeholder ?? "")}">${esc(values[f.key])}</textarea>`;
    } else {
      control = `<input type="${f.type}" id="${id}" value="${esc(values[f.key])}" ${f.min !== undefined ? `min="${f.min}"` : ""} ${f.max !== undefined ? `max="${f.max}"` : ""} placeholder="${esc(f.placeholder ?? "")}" />`;
    }
    label.innerHTML = `${control}<span>${esc(f.label)}</span>`;
    form.appendChild(label);
  }
  $("#settings-status").textContent = "";
}

async function persistSetting(key, field) {
  const el = $(`#set-${settingsSection}-${key}`);
  const raw = field.type === "checkbox" ? el.checked : el.value;
  const value = settingsFromField(field, raw);
  try {
    const updated = await api(`/settings/sections/${settingsSection}`, {
      method: "PATCH",
      body: JSON.stringify({ [key]: value }),
    });
    settingsData[settingsSection] = updated;
    if (key === "density") applyDensity();
    $("#settings-status").textContent = `${settingsSection}.${key} saved`;
  } catch (err) {
    $("#settings-status").textContent = `save failed: ${err.message}`;
    renderSettings(); /* revert to last known-good values */
  }
}

$("#settings-form").addEventListener("change", (e) => {
  const key = e.target.id?.replace(`set-${settingsSection}-`, "");
  const field = SETTINGS_FIELDS[settingsSection].find((f) => f.key === key);
  if (field) persistSetting(key, field);
});

/* ============================== warmups ================================ */

/* Record and Run both hold their HTTP request open for the whole window
   (the recording duration / the recipe's total dwell), so each has an
   explicit in-progress state: the button is disabled and a ticking status
   line shows the elapsed time until the request returns. */

let warmupRecipes = [];
let warmupRunRecipe = null; /* recipe shown in the run modal */
let warmupRunning = false; /* a run request is in flight */

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function warmupStatus(msg, isErr = false) {
  const el = $("#warmups-status");
  el.textContent = msg;
  el.style.color = isErr ? "var(--red)" : "var(--faint)";
}

async function refreshWarmupProfiles() {
  const sel = $("#warmup-record-profile");
  const current = sel.value;
  const { profiles } = await api("/profiles");
  const running = profiles.filter((p) => p.status === "running");
  sel.innerHTML =
    `<option value="">(${running.length} running — pick one)</option>` +
    running.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  if (running.some((p) => p.id === current)) sel.value = current;
}

async function loadWarmups() {
  refreshWarmupProfiles().catch(() => {});
  const tbody = $("#warmups-table tbody");
  try {
    const { recipes } = await api("/warmups");
    warmupRecipes = recipes ?? [];
  } catch (err) {
    warmupRecipes = [];
    warmupStatus(err.message, true);
  }
  tbody.innerHTML = "";
  $("#warmups-empty").hidden = warmupRecipes.length !== 0;
  for (const r of warmupRecipes) {
    const steps = r.steps ?? [];
    const total = steps.reduce((sum, s) => sum + (Number(s.dwellMs) || 0), 0);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="font-weight:600" title="${esc(steps.map((s) => s.url).join("\n"))}">${esc(r.name)}</td>
      <td class="mono">${steps.length}</td>
      <td class="mono">${esc(fmtDuration(total))}</td>
      <td class="mono" style="color:var(--faint)">${esc(String(r.createdAt ?? "").slice(0, 16).replace("T", " "))}</td>
      <td><span class="row-actions">
        <button class="act-start" data-act="run" title="run this recipe on a profile">▶</button>
        <button class="act-delete" data-act="delete" title="delete recipe">🗑</button>
      </span></td>`;
    tr.querySelector('[data-act="run"]').addEventListener("click", () => openWarmupRun(r));
    tr.querySelector('[data-act="delete"]').addEventListener("click", () => deleteWarmup(r));
    tbody.appendChild(tr);
  }
}

async function deleteWarmup(recipe) {
  if (!window.confirm(`Delete warmup recipe "${recipe.name}"? This cannot be undone.`)) return;
  try {
    await api(`/warmups/${recipe.id}`, { method: "DELETE" });
    toast(`warmup "${recipe.name}" deleted`);
  } catch (err) {
    toast(err.message, "error");
  }
  await loadWarmups();
}

async function recordWarmup() {
  const profileId = $("#warmup-record-profile").value;
  const name = $("#warmup-record-name").value.trim();
  const seconds = Number($("#warmup-record-seconds").value);
  if (!profileId) return warmupStatus("pick a running profile to record", true);
  if (!name) return warmupStatus("give the recipe a name", true);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) {
    return warmupStatus("duration must be a whole number of seconds, 1–600", true);
  }
  const btn = $("#warmup-record");
  const started = Date.now();
  const tick = () => {
    const left = Math.max(0, seconds - Math.floor((Date.now() - started) / 1000));
    btn.textContent = `● Recording… ${left}s`;
    warmupStatus(`recording "${name}" — open tabs in the profile now (${left}s left)`);
  };
  btn.disabled = true;
  tick();
  const timer = setInterval(tick, 1000);
  try {
    const recipe = await api(`/profiles/${profileId}/warmup/record`, {
      method: "POST",
      body: JSON.stringify({ name, durationMs: seconds * 1000 }),
    });
    $("#warmup-record-name").value = "";
    warmupStatus(`recorded "${recipe.name}" — ${recipe.steps.length} step${recipe.steps.length === 1 ? "" : "s"}`);
    toast(`warmup "${recipe.name}" recorded (${recipe.steps.length} steps)`);
  } catch (err) {
    warmupStatus(err.message, true);
    toast(err.message, "error");
  } finally {
    clearInterval(timer);
    btn.disabled = false;
    btn.textContent = "● Record";
  }
  await loadWarmups();
}

async function openWarmupRun(recipe) {
  warmupRunRecipe = recipe;
  const steps = recipe.steps ?? [];
  const total = steps.reduce((sum, s) => sum + (Number(s.dwellMs) || 0), 0);
  $("#warmup-run-recipe").textContent =
    `"${recipe.name}" — ${steps.length} step${steps.length === 1 ? "" : "s"}, about ${fmtDuration(total)} (dwell varies ±20% per step)`;
  $("#warmup-run-result").innerHTML = "";
  $("#warmup-run-status").textContent = "";
  $("#warmup-run-stop").checked = false;
  $("#warmup-run-go").disabled = warmupRunning;
  const sel = $("#warmup-run-profile");
  sel.innerHTML = `<option value="">(loading profiles…)</option>`;
  $("#warmup-run-modal").hidden = false;
  try {
    const { profiles } = await api("/profiles");
    sel.innerHTML =
      `<option value="">(pick a profile)</option>` +
      profiles
        .map((p) => `<option value="${esc(p.id)}">${esc(p.name)} — ${esc(String(p.status ?? "idle"))}</option>`)
        .join("");
  } catch (err) {
    sel.innerHTML = `<option value="">(could not load profiles)</option>`;
    $("#warmup-run-status").textContent = err.message;
  }
}

function closeWarmupRun() {
  $("#warmup-run-modal").hidden = true;
}

function renderWarmupRunResult(data) {
  const results = data.results ?? [];
  const ok = results.filter((r) => r.ok).length;
  const rows = results
    .map((r) =>
      r.ok
        ? `<tr><td>✓</td><td class="mono">${esc(r.url)}</td><td class="mono">${esc(fmtDuration(r.dwellMs))}</td></tr>`
        : `<tr class="import-err"><td>✗</td><td class="mono">${esc(r.url)}</td><td>${esc(r.error ?? "failed")}</td></tr>`,
    )
    .join("");
  $("#warmup-run-result").innerHTML = `
    <p class="hint">${ok}/${results.length} steps ok — ${data.startedByRun ? "profile was started by this run" : "profile was already running"}</p>
    <table class="import-table"><tbody>${rows}</tbody></table>`;
}

async function runWarmup() {
  const recipe = warmupRunRecipe;
  const profileId = $("#warmup-run-profile").value;
  const status = $("#warmup-run-status");
  if (!recipe || warmupRunning) return;
  if (!profileId) {
    status.textContent = "pick a profile";
    return;
  }
  const stopAfter = $("#warmup-run-stop").checked;
  const btn = $("#warmup-run-go");
  const started = Date.now();
  const tick = () => {
    status.textContent = `running… ${fmtDuration(Date.now() - started)} elapsed — this stays open until the recipe finishes`;
  };
  warmupRunning = true;
  btn.disabled = true;
  btn.textContent = "Running…";
  $("#warmup-run-result").innerHTML = "";
  tick();
  const timer = setInterval(tick, 1000);
  try {
    const data = await api(`/warmups/${recipe.id}/run`, {
      method: "POST",
      body: JSON.stringify({ profileId, stopAfter }),
    });
    const results = data.results ?? [];
    const ok = results.filter((r) => r.ok).length;
    toast(`warmup "${recipe.name}" finished: ${ok}/${results.length} steps ok`, ok === results.length ? "info" : "error");
    /* the modal may have been closed or re-opened on another recipe meanwhile */
    if (warmupRunRecipe === recipe) {
      status.textContent = `finished in ${fmtDuration(Date.now() - started)}`;
      renderWarmupRunResult(data);
    }
  } catch (err) {
    toast(err.message, "error");
    if (warmupRunRecipe === recipe) status.textContent = err.message;
  } finally {
    clearInterval(timer);
    warmupRunning = false;
    btn.disabled = false;
    btn.textContent = "Run";
  }
  await loadProfiles();
  if (activeView === "warmups") refreshWarmupProfiles().catch(() => {});
}

/* ---------------------------- persona warmup ---------------------------- */

let personaSites = null; /* { sites, added, excluded } for the picked persona */
let personaPoll = null;

function personaStatus(msg, isErr = false) {
  const el = $("#persona-status");
  el.textContent = msg;
  el.style.color = isErr ? "var(--red)" : "var(--faint)";
}

async function loadPersonaCard() {
  try {
    const [{ profiles }, { personas }] = await Promise.all([api("/profiles"), api("/warmups/personas")]);
    const pSel = $("#persona-profile");
    const cur = pSel.value;
    pSel.innerHTML =
      `<option value="">(pick a profile)</option>` +
      profiles.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.status === "running" ? " · running" : ""}</option>`).join("");
    if (profiles.some((p) => p.id === cur)) pSel.value = cur;
    const kSel = $("#persona-pick");
    const curK = kSel.value;
    kSel.innerHTML = personas.map((p) => `<option value="${esc(p.id)}" title="${esc(p.description ?? "")}">${esc(p.name)} (${p.sites} sites)</option>`).join("");
    if (personas.some((p) => p.id === curK)) kSel.value = curK;
    await loadPersonaSites();
    if (pSel.value) await showPersonaStatus(pSel.value);
  } catch (err) {
    personaStatus(err.message, true);
  }
}

async function loadPersonaSites() {
  const id = $("#persona-pick").value;
  if (!id) return;
  personaSites = await api(`/warmups/personas/${encodeURIComponent(id)}/sites`);
  renderPersonaSites();
}

function renderPersonaSites() {
  const tbody = $("#persona-sites-table tbody");
  tbody.innerHTML = "";
  const row = (s, removable) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" ${s.excluded ? "" : "checked"} /></td>
      <td class="mono">${esc(s.url)}</td>
      <td>${esc(s.category)}</td>
      <td style="color:var(--faint)">${esc(removable ? "added" : s.pool)}</td>
      <td>${removable ? '<button class="act-delete" title="remove this site">🗑</button>' : ""}</td>`;
    tr.querySelector("input").addEventListener("change", (e) => {
      const set = new Set(personaSites.excluded);
      if (e.target.checked) set.delete(s.host); else set.add(s.host);
      personaSites.excluded = [...set];
      s.excluded = !e.target.checked;
    });
    if (removable) {
      tr.querySelector("button").addEventListener("click", () => {
        personaSites.added = personaSites.added.filter((a) => a.url !== s.url);
        renderPersonaSites();
      });
    }
    tbody.appendChild(tr);
  };
  const host = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
  for (const s of personaSites.sites) row(s, false);
  for (const a of personaSites.added) {
    const h = host(a.url);
    row({ url: a.url, host: h, category: a.category ?? "general", pool: "added", excluded: personaSites.excluded.includes(h) }, true);
  }
}

async function savePersonaSites() {
  const id = $("#persona-pick").value;
  if (!id || !personaSites) return;
  try {
    await api(`/warmups/personas/${encodeURIComponent(id)}/sites`, {
      method: "PUT",
      body: JSON.stringify({ excluded: personaSites.excluded, added: personaSites.added }),
    });
    toast("persona sites saved");
    personaStatus("sites saved");
    await loadPersonaCard();
  } catch (err) {
    personaStatus(err.message, true);
  }
}

function describePersonaRun(s) {
  if (!s) return "";
  const base = `${s.persona}: ${s.sessionsDone}/${s.sessionsPlanned} sessions, ${s.visits} site visits`;
  if (s.state === "running") return `running — ${base}`;
  if (s.state === "stopped") return `stopped — ${base}`;
  if (s.state === "done") return `done — ${base} (finished ${String(s.finishedAt ?? "").slice(11, 19)})`;
  return `failed — ${s.error ?? "unknown error"}`;
}

async function showPersonaStatus(profileId) {
  clearTimeout(personaPoll);
  const { status } = await api(`/profiles/${profileId}/warmup/persona`);
  personaStatus(describePersonaRun(status), status?.state === "failed");
  $("#persona-start").disabled = status?.state === "running";
  $("#persona-stop").hidden = status?.state !== "running";
  if (status?.state === "running" && activeView === "warmups") {
    personaPoll = setTimeout(() => showPersonaStatus(profileId).catch(() => {}), 3000);
  }
}

$("#persona-start").addEventListener("click", async () => {
  const profileId = $("#persona-profile").value;
  if (!profileId) return personaStatus("pick a profile to warm up", true);
  const sessions = Number($("#persona-sessions").value);
  if (!Number.isInteger(sessions) || sessions < 1 || sessions > 10) return personaStatus("sessions must be 1–10", true);
  try {
    await api(`/profiles/${profileId}/warmup/persona`, {
      method: "POST",
      body: JSON.stringify({ persona: $("#persona-pick").value, sessions, keepRunning: $("#persona-keep").checked }),
    });
    toast("persona warmup started");
    await showPersonaStatus(profileId);
  } catch (err) {
    personaStatus(err.message, true);
  }
});
$("#persona-stop").addEventListener("click", async () => {
  const profileId = $("#persona-profile").value;
  if (!profileId) return;
  try {
    await api(`/profiles/${profileId}/warmup/persona/stop`, { method: "POST", body: "{}" });
    toast("stopping the warmup…");
    await showPersonaStatus(profileId);
  } catch (err) {
    personaStatus(err.message, true);
  }
});
$("#persona-profile").addEventListener("change", (e) => {
  if (e.target.value) showPersonaStatus(e.target.value).catch((err) => personaStatus(err.message, true));
  else personaStatus("");
});
$("#persona-pick").addEventListener("change", () => loadPersonaSites().catch((err) => personaStatus(err.message, true)));
$("#persona-add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = $("#persona-add-url").value.trim();
  let u;
  try { u = new URL(url); } catch { return personaStatus("enter a full address, e.g. https://www.example.com", true); }
  if (!/^https?:$/.test(u.protocol)) return personaStatus("only http(s) sites", true);
  if (!personaSites) return;
  if (personaSites.added.some((a) => a.url === u.origin)) return personaStatus("already added", true);
  personaSites.added.push({ url: u.origin, category: $("#persona-add-cat").value });
  $("#persona-add-url").value = "";
  personaStatus("added — press Save sites to keep it");
  renderPersonaSites();
});
$("#persona-sites-save").addEventListener("click", savePersonaSites);

$("#warmup-record").addEventListener("click", recordWarmup);
$("#warmups-refresh").addEventListener("click", loadWarmups);
$("#warmup-run-go").addEventListener("click", runWarmup);
$("#warmup-run-close").addEventListener("click", closeWarmupRun);
$("#warmup-run-modal").addEventListener("click", (e) => { if (e.target.id === "warmup-run-modal") closeWarmupRun(); });

/* ============================ live events (SSE) ========================= */

function pushEvent(e) {
  const li = document.createElement("li");
  li.className = "event-" + String(e.type ?? "").replace(".", "-").replace(/^run$/, "run");
  const time = (e.at ?? new Date().toISOString()).slice(11, 19);
  li.innerHTML = `<span class="type">${esc(e.type)}</span> ${esc(e.detail ?? "")} <span class="time">${esc(time)}</span>`;
  const list = $("#events");
  list.prepend(li);
  while (list.children.length > 50) list.lastChild.remove();
}

function connectEvents() {
  const es = new EventSource("/events");
  es.onopen = () => {
    $("#sse").textContent = "live";
    $("#sse-dot").className = "dot dot-on";
  };
  es.onerror = () => {
    $("#sse").textContent = "offline";
    $("#sse-dot").className = "dot dot-off";
  };
  es.onmessage = (msg) => {
    try {
      const e = JSON.parse(msg.data);
      if (e.detail === "connected") return;
      pushEvent(e);
      /* run/tab transitions change the grids; reload lazily */
      if (e.type.startsWith("run.") || e.type.startsWith("tab.")) {
        loadProfiles();
        refreshTabsProfiles();
        if (activeView === "cookies") refreshCookiesProfiles();
        if (activeView === "warmups") refreshWarmupProfiles().catch(() => {});
        if ($("#tabs-profile").value) runTabsQuery();
      }
    } catch {
      /* malformed event — ignore */
    }
  };
}

/* ================================ boot ================================= */

setView("profiles"); /* renders nav state, topbar actions, and stats */
refreshHealth();
loadProfiles();
loadProxies();
loadProxyProviders();
refreshTabsProfiles();
loadSettings();
connectEvents();
setInterval(refreshHealth, 30_000);

/* ============================ Tab View (J3a/J3b) ============================ */

let tabViewTimer = null;
async function loadTabView() {
  clearTimeout(tabViewTimer);
  if (activeView !== "tabview") return;
  try {
    const data = await api(`/tab-view${$("#tabview-all").checked ? "?all=1" : ""}`);
    const q = $("#tabview-filter").value.trim().toLowerCase();
    let rows = (data.rows ?? data.tabs ?? data).filter((r) =>
      !q || `${r.profileName} ${r.email ?? ""} ${r.state?.notes ?? ""}`.toLowerCase().includes(q),
    );
    rows = applyUiExpressions(rows);
    const tbody = $("#tabview-table tbody");
    tbody.innerHTML = rows
      .map((r) => {
        const d = r.state?.data ?? {};
        const colour = r.state?.colour ? ` style="border-left:4px solid ${esc(r.state.colour)}"` : "";
        return `<tr${colour}>
          <td><input type="checkbox" data-profile="${esc(r.profileId)}" /></td>
          <td>${esc(r.uiLabel ?? r.label)}${r.state?.subtitle ? `<div class="mono" style="color:var(--muted)">${esc(r.state.subtitle)}</div>` : ""}</td>
          <td>${esc(d.stage ?? "—")}</td><td>${esc(d.queuePosition ?? "—")}</td><td>${esc(d.cartTimer ?? "—")}</td>
          <td>${esc(r.state?.priority ?? "—")}</td><td>${esc(r.state?.notes ?? "")}</td>
          <td>${(r.state?.passcodes ?? []).filter((p) => !p.used).length}/${(r.state?.passcodes ?? []).length}</td>
          <td><span class="row-actions">
            <button data-tv="passcode" data-id="${esc(r.profileId)}" title="take the next unused passcode">🔑</button>
            <button data-tv="priority" data-id="${esc(r.profileId)}" title="set priority">▲</button>
            <button data-tv="notes" data-id="${esc(r.profileId)}" title="edit note">✎</button>
            <button data-tv="colour" data-id="${esc(r.profileId)}" title="set row colour">🎨</button>
          </span></td></tr>`;
      })
      .join("");
    $("#tabview-empty").hidden = rows.length !== 0;
  } catch (err) {
    toast(err.message, "error");
  }
  tabViewTimer = setTimeout(loadTabView, 5000);
}
const tabViewSelected = () => [...document.querySelectorAll("#tabview-table tbody input[data-profile]:checked")].map((i) => i.dataset.profile);
$("#tabview-select").addEventListener("change", (e) => document.querySelectorAll("#tabview-table tbody input[data-profile]").forEach((i) => (i.checked = e.target.checked)));
$("#tabview-filter").addEventListener("input", loadTabView);
$("#tabview-all").addEventListener("change", loadTabView);
$("#tabview-clear").addEventListener("click", async () => {
  for (const id of tabViewSelected()) await api(`/profiles/${id}/tab-state/clear-codes`, { method: "POST", body: "{}" }).catch((e) => toast(e.message, "error"));
  loadTabView();
});
$("#tabview-lognote").addEventListener("click", async () => {
  const note = $("#tabview-note").value.trim();
  if (!note) return toast("type a note first", "error");
  for (const id of tabViewSelected()) await api(`/profiles/${id}/log-note`, { method: "POST", body: JSON.stringify({ note }) }).catch((e) => toast(e.message, "error"));
  toast("note logged", "info");
});
$("#tabview-export").addEventListener("click", async () => {
  const ids = tabViewSelected();
  if (!ids.length) return toast("select tabs first", "error");
  const res = await fetch("/tabs/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profileIds: ids }) });
  const url = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement("a"), { href: url, download: "open-tabs.csv" }).click();
  URL.revokeObjectURL(url);
});

/* ============== J7: format string, custom sort, command palette, key binds ============== */

let uiSettings = { tabLabelFormat: null, tabSort: null, keybinds: {} };
let uiWarned = false;
async function loadUiSettings() {
  try { uiSettings = await api("/settings/sections/ui"); } catch { /* defaults */ }
}
loadUiSettings();

/* The operator's own JS, run here in the console page against a frozen copy of the tab (never in the API). */
function tabCtx(r) {
  const s = r.state ?? {};
  return Object.freeze({
    profileName: r.profileName, email: r.email, label: r.label,
    tab: Object.freeze({ data: Object.freeze({ ...(s.data ?? {}) }), notes: s.notes ?? "", priority: s.priority, priorityGroup: s.priorityGroup, colour: s.colour, passcodes: Object.freeze((s.passcodes ?? []).map((p) => ({ ...p }))) }),
    emailCode: s.codes?.emailCode ?? null, smsCode: s.codes?.smsCode ?? null, otherCode: s.codes?.otherCode ?? null,
  });
}
function applyUiExpressions(rows) {
  const warn = (what, e) => { if (!uiWarned) { uiWarned = true; toast(`${what} failed: ${e.message}`, "error"); } };
  let out = rows.map((r) => ({ ...r }));
  if (uiSettings.tabLabelFormat) {
    try {
      const f = new Function("ctx", uiSettings.tabLabelFormat);
      for (const r of out) { try { r.uiLabel = String(f(tabCtx(r))); } catch (e) { warn("tab label format", e); } }
    } catch (e) { warn("tab label format", e); }
  }
  if (uiSettings.tabSort) {
    try {
      const f = new Function("a", "b", uiSettings.tabSort);
      out = out.sort((x, y) => Number(f(tabCtx(x), tabCtx(y))) || 0);
    } catch (e) { warn("tab sort", e); }
  }
  return out;
}

const currentSelection = () => (activeView === "tabview" ? tabViewSelected() : [...batchSelection]);
let commandCatalogue = null;

async function runCommand(cmd) {
  const ids = currentSelection();
  if (!ids.length) return toast("select profiles first", "error");
  const args = {};
  for (const a of cmd.args) {
    const v = window.prompt(`${cmd.title}: ${a.name}${a.optional ? " (optional)" : ""}`, "");
    if (v === null) return;
    if (v !== "") args[a.name] = a.type === "number" ? Number(v) : v;
  }
  try {
    const { results } = await api("/commands/run", { method: "POST", body: JSON.stringify({ command: cmd.id, profileIds: ids, args }) });
    const bad = results.filter((r) => !r.ok);
    toast(`${cmd.title}: ${results.length - bad.length} ok${bad.length ? `, ${bad.length} failed (${bad[0].error})` : ""}`, bad.length ? "error" : "info");
  } catch (e) { toast(e.message, "error"); }
}

async function openPalette() {
  if (document.getElementById("palette")) return;
  commandCatalogue ??= (await api("/commands")).commands;
  const box = document.createElement("div");
  box.id = "palette";
  box.style.cssText = "position:fixed;inset:0;background:#0009;display:flex;justify-content:center;align-items:flex-start;padding-top:12vh;z-index:50";
  box.innerHTML = `<div style="background:var(--panel);border:1px solid var(--panel-3);border-radius:8px;width:min(560px,92vw);padding:10px">
    <input id="palette-q" placeholder="command…  (Enter runs on the selection · Shift+Enter binds a key)" style="width:100%" autocomplete="off" />
    <div id="palette-list" style="margin-top:8px;max-height:50vh;overflow:auto"></div></div>`;
  document.body.appendChild(box);
  const q = $("#palette-q"), list = $("#palette-list");
  let shown = [], idx = 0;
  const draw = () => {
    const t = q.value.toLowerCase();
    shown = commandCatalogue.filter((c) => !t || `${c.id} ${c.title}`.toLowerCase().includes(t));
    idx = Math.min(idx, Math.max(0, shown.length - 1));
    list.innerHTML = shown.map((c, i) => `<div data-i="${i}" style="padding:6px 8px;border-radius:4px;cursor:pointer;${i === idx ? "background:var(--panel-3)" : ""}">${esc(c.title)} <span class="mono" style="color:var(--muted)">${esc(c.id)}${uiSettings.keybinds[c.id] ? ` · ${esc(uiSettings.keybinds[c.id])}` : ""}</span></div>`).join("");
  };
  const close = () => box.remove();
  box.addEventListener("click", (e) => { if (e.target === box) close(); const d = e.target.closest("[data-i]"); if (d) { close(); runCommand(shown[Number(d.dataset.i)]); } });
  q.addEventListener("input", () => { idx = 0; draw(); });
  q.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") return close();
    if (e.key === "ArrowDown") { idx = Math.min(idx + 1, shown.length - 1); e.preventDefault(); draw(); }
    if (e.key === "ArrowUp") { idx = Math.max(idx - 1, 0); e.preventDefault(); draw(); }
    if (e.key === "Enter" && shown[idx]) {
      const c = shown[idx];
      if (e.shiftKey) {
        const combo = window.prompt(`Key combo for "${c.title}" (e.g. ctrl+shift+c; empty clears)`, uiSettings.keybinds[c.id] ?? "");
        if (combo === null) return;
        const keybinds = { ...uiSettings.keybinds };
        if (combo.trim()) keybinds[c.id] = combo.trim().toLowerCase(); else delete keybinds[c.id];
        try { uiSettings = await api("/settings/sections/ui", { method: "PATCH", body: JSON.stringify({ keybinds }) }); draw(); } catch (err) { toast(err.message, "error"); }
      } else { close(); runCommand(c); }
    }
  });
  draw();
  q.focus();
}

const comboOf = (e) => [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "meta", e.key === " " ? "space" : e.key.toLowerCase()].filter(Boolean).join("+");
window.addEventListener("keydown", async (e) => {
  const combo = comboOf(e);
  if (combo === "ctrl+shift+space") { e.preventDefault(); return openPalette(); }
  if (!combo.includes("+") || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target?.tagName)) return;
  const id = Object.keys(uiSettings.keybinds).find((k) => uiSettings.keybinds[k] === combo);
  if (!id) return;
  e.preventDefault();
  commandCatalogue ??= (await api("/commands")).commands;
  const cmd = commandCatalogue.find((c) => c.id === id);
  if (cmd) runCommand(cmd);
});

/* ================= running-profile picker (shared) ===================== */
async function fillProfileSelect(sel, { runningOnly = true } = {}) {
  const current = sel.value;
  const { profiles } = await api("/profiles");
  const list = runningOnly ? profiles.filter((p) => p.status === "running") : profiles;
  sel.innerHTML =
    `<option value="">(${list.length} ${runningOnly ? "running" : "profile" + (list.length === 1 ? "" : "s")} — pick one)</option>` +
    list.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${runningOnly ? "" : ` · ${esc(String(p.status ?? "idle"))}`}</option>`).join("");
  if (list.some((p) => p.id === current)) sel.value = current;
  return list;
}
const runningIds = async () => (await api("/profiles")).profiles.filter((p) => p.status === "running").map((p) => p.id);

/* ============================ Deck (ADR-0008) =========================== */
async function loadDeck() {
  const el = $("#deck-state");
  let data;
  try {
    data = await api("/deck");
  } catch (err) {
    el.textContent = err.message;
    el.style.color = "var(--red)";
    return;
  }
  el.style.color = "var(--faint)";
  el.textContent = !data.supported
    ? "The Profile Deck is Windows-only for now — not available on this machine."
    : data.open
      ? `Deck open · ${data.tabs.length} tab${data.tabs.length === 1 ? "" : "s"}`
      : "Deck closed.";
  $("#deck-open").disabled = !data.supported;
  $("#deck-group").disabled = !data.supported;
  $("#deck-close").disabled = !data.supported || !data.open;
  const nameOf = new Map(allProfiles.map((p) => [p.id, p.name]));
  const tbody = $("#deck-table tbody");
  tbody.innerHTML = "";
  $("#deck-empty").hidden = data.tabs.length !== 0;
  for (const t of data.tabs) {
    const tr = document.createElement("tr");
    const adopted = t.adopted === true ? "in deck" : t.adopted === false ? "separate" : "pending";
    tr.innerHTML = `
      <td>${esc(nameOf.get(t.profileId) ?? t.label ?? t.profileId.slice(0, 8))}</td>
      <td><span class="tag">${esc(adopted)}</span></td>
      <td><button class="ghost" data-select>Show</button></td>`;
    tr.querySelector("[data-select]").addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      try { await api(`/deck/profiles/${t.profileId}/select`, { method: "POST", body: "{}" }); }
      catch (err) { toast(err.message, "error"); }
      ev.target.disabled = false;
    });
    tbody.appendChild(tr);
  }
}
$("#deck-refresh").addEventListener("click", loadDeck);
$("#deck-open").addEventListener("click", async () => {
  try { await api("/deck/open", { method: "POST", body: "{}" }); toast("deck opened"); } catch (err) { toast(err.message, "error"); }
  loadDeck();
});
$("#deck-close").addEventListener("click", async () => {
  if (!window.confirm("Close the Profile Deck? Each profile window goes back to a normal window.")) return;
  try { await api("/deck", { method: "DELETE" }); toast("deck closed"); } catch (err) { toast(err.message, "error"); }
  loadDeck();
});
$("#deck-group").addEventListener("click", async () => {
  try { await api("/deck/group-taskbar", { method: "POST", body: "{}" }); toast("taskbar grouped"); } catch (err) { toast(err.message, "error"); }
});

/* ============================ Cookie Thinger (J5) ======================= */
function thingerSay(sel, msg, isErr) { const el = $(sel); el.textContent = msg; el.style.color = isErr ? "var(--red)" : "var(--faint)"; }
function thingerResult(data) {
  const el = $("#thinger-result");
  if (Array.isArray(data?.results)) {
    const ok = data.results.filter((r) => r.ok).length;
    el.textContent = `${ok}/${data.results.length} profile${data.results.length === 1 ? "" : "s"} ran`;
  } else if (data) {
    el.textContent = `group ${data.group}: ${data.deleted ?? 0} deleted, ${data.copied ?? 0} copied, ${data.pasted ?? 0} pasted${(data.errors ?? []).length ? ` · ${data.errors.length} error(s)` : ""}`;
  }
}
async function loadThinger() {
  const gsel = $("#thinger-group");
  if (!gsel.options.length) gsel.innerHTML = Array.from({ length: 10 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("");
  fillProfileSelect($("#thinger-profile")).catch(() => {});
  try {
    const s = await api("/cookie-thinger");
    const groups = Object.entries(s.groups ?? {}).map(([g, n]) => `#${g}:${n}`).join(" ") || "none";
    const errs = (s.errors ?? []).length;
    thingerSay("#thinger-state", `${s.exists ? "file saved" : "no file yet"} · groups ${groups}${errs ? ` · ${errs} error${errs === 1 ? "" : "s"}` : ""}`, errs > 0);
  } catch (err) { thingerSay("#thinger-state", err.message, true); }
}
$("#thinger-refresh").addEventListener("click", loadThinger);
$("#thinger-save").addEventListener("click", async () => {
  const text = $("#thinger-text").value;
  if (!text.trim()) return thingerSay("#thinger-save-status", "paste the file first", true);
  try {
    const s = await api("/cookie-thinger", { method: "PUT", body: JSON.stringify({ text }) });
    const groups = Object.entries(s.groups ?? {}).map(([g, n]) => `#${g}:${n}`).join(" ") || "none";
    thingerSay("#thinger-save-status", `saved · groups ${groups}`, false);
    $("#thinger-text").value = "";
    loadThinger();
  } catch (err) { thingerSay("#thinger-save-status", err.message, true); }
});
$("#thinger-run").addEventListener("click", async () => {
  const id = $("#thinger-profile").value;
  const group = Number($("#thinger-group").value);
  if (!id) return toast("pick a running profile", "error");
  try { thingerResult(await api(`/profiles/${id}/cookie-thinger/run`, { method: "POST", body: JSON.stringify({ group }) })); }
  catch (err) { toast(err.message, "error"); }
});
$("#thinger-run-all").addEventListener("click", async () => {
  const group = Number($("#thinger-group").value);
  const ids = await runningIds();
  if (!ids.length) return toast("no running profiles", "error");
  try { thingerResult(await api("/cookie-thinger/run", { method: "POST", body: JSON.stringify({ group, profileIds: ids }) })); }
  catch (err) { toast(err.message, "error"); }
});
$("#thinger-csv-file").addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => { $("#thinger-csv").value = String(reader.result ?? ""); };
  reader.readAsText(f);
});
$("#thinger-csv-load").addEventListener("click", async () => {
  const csv = $("#thinger-csv").value.trim();
  if (!csv) return thingerSay("#thinger-csv-status", "paste or choose a CSV first", true);
  try {
    const r = await api("/cookie-thinger/load-csv", { method: "POST", body: JSON.stringify({ csv }) });
    const set = (r.results ?? []).reduce((n, x) => n + (x.set ?? 0), 0);
    thingerSay("#thinger-csv-status", `loaded ${set} cookie${set === 1 ? "" : "s"} into ${(r.results ?? []).length} profile(s)${r.unmatched?.length ? ` · ${r.unmatched.length} unmatched` : ""}`, false);
    $("#thinger-csv").value = ""; $("#thinger-csv-file").value = "";
  } catch (err) { thingerSay("#thinger-csv-status", err.message, true); }
});

/* ============================ Autofill Map (J4) ========================= */
function autofillSay(sel, msg, isErr) { const el = $(sel); el.textContent = msg; el.style.color = isErr ? "var(--red)" : "var(--faint)"; }
function autofillOptions() {
  const opts = {};
  const card = $("#autofill-card").value.trim();
  const mode = $("#autofill-mode").value;
  if (card) opts.card = card;
  if (mode) opts.defaultMode = mode;
  return opts;
}
function autofillResult(data) {
  const el = $("#autofill-result");
  if (Array.isArray(data?.results)) {
    const ok = data.results.filter((r) => r.ok).length;
    el.textContent = `${ok}/${data.results.length} profile${data.results.length === 1 ? "" : "s"} filled`;
  } else if (data) {
    const filled = (data.filled ?? []).length, missing = (data.missing ?? []).length, errs = (data.errors ?? []).length;
    el.textContent = `filled ${filled} field${filled === 1 ? "" : "s"}${missing ? `, ${missing} missing` : ""}${data.clicked ? `, ${data.clicked} clicked` : ""}${errs ? ` · ${errs} error(s)` : ""}`;
  }
}
async function loadAutofill() {
  fillProfileSelect($("#autofill-profile")).catch(() => {});
  try {
    const s = await api("/autofill/map");
    const errs = (s.errors ?? []).length;
    autofillSay("#autofill-state", `${s.exists ? "map saved" : "no map yet"} · ${s.blocks} site block${s.blocks === 1 ? "" : "s"}${errs ? ` · ${errs} error${errs === 1 ? "" : "s"}` : ""}`, errs > 0);
  } catch (err) { autofillSay("#autofill-state", err.message, true); }
}
$("#autofill-refresh").addEventListener("click", loadAutofill);
$("#autofill-save").addEventListener("click", async () => {
  const text = $("#autofill-text").value;
  if (!text.trim()) return autofillSay("#autofill-save-status", "paste the map first", true);
  try {
    const s = await api("/autofill/map", { method: "PUT", body: JSON.stringify({ text }) });
    autofillSay("#autofill-save-status", `saved · ${s.blocks} block${s.blocks === 1 ? "" : "s"}`, false);
    $("#autofill-text").value = "";
    loadAutofill();
  } catch (err) { autofillSay("#autofill-save-status", err.message, true); }
});
$("#autofill-fill").addEventListener("click", async () => {
  const id = $("#autofill-profile").value;
  if (!id) return toast("pick a running profile", "error");
  try { autofillResult(await api(`/profiles/${id}/autofill/map`, { method: "POST", body: JSON.stringify(autofillOptions()) })); }
  catch (err) { toast(err.message, "error"); }
});
$("#autofill-broadcast").addEventListener("click", async () => {
  const ids = await runningIds();
  if (!ids.length) return toast("no running profiles", "error");
  try { autofillResult(await api("/autofill/map/broadcast", { method: "POST", body: JSON.stringify({ profileIds: ids, ...autofillOptions() }) })); }
  catch (err) { toast(err.message, "error"); }
});

/* ============== Tab View per-row actions (J3b) ============== */
$("#tabview-table tbody").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-tv]");
  if (!btn) return;
  const id = btn.dataset.id;
  try {
    if (btn.dataset.tv === "passcode") {
      const r = await api(`/profiles/${id}/tab-state/passcode`, { method: "POST", body: "{}" });
      if (r.passcode) window.prompt("Next passcode (copy it):", r.passcode);
      else toast("no unused passcodes for this tab", "error");
      return;
    }
    if (btn.dataset.tv === "priority") {
      const v = window.prompt("Priority (higher sorts first; blank clears):", "");
      if (v === null) return;
      const priority = v.trim() === "" ? null : Number(v);
      if (priority !== null && !Number.isInteger(priority)) return toast("priority must be a whole number", "error");
      await api(`/profiles/${id}/tab-state`, { method: "PATCH", body: JSON.stringify({ priority }) });
    } else if (btn.dataset.tv === "notes") {
      const v = window.prompt("Note for this tab:", "");
      if (v === null) return;
      await api(`/profiles/${id}/tab-state`, { method: "PATCH", body: JSON.stringify({ notes: v }) });
    } else if (btn.dataset.tv === "colour") {
      const v = window.prompt("Row colour as #rrggbb (blank clears):", "#3366ff");
      if (v === null) return;
      const colour = v.trim() === "" ? null : v.trim();
      if (colour !== null && !/^#[0-9a-fA-F]{6}$/.test(colour)) return toast("colour must be like #3366ff", "error");
      await api(`/profiles/${id}/tab-state`, { method: "PATCH", body: JSON.stringify({ colour }) });
    }
    loadTabView();
  } catch (err) { toast(err.message, "error"); }
});
