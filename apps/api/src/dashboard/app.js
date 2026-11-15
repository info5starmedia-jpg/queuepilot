/* QueuePilot dashboard — zero-build, zero-dependency, talks only to the API
   on this origin (loopback). All state comes from the REST API; live updates
   arrive over the SSE stream. */

const $ = (sel) => document.querySelector(sel);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
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

/* ---------------- engine + google chips ---------------- */

async function refreshHealth() {
  try {
    const h = await api("/engine/health");
    const el = $("#engine");
    el.textContent = h.binaryPresent
      ? `engine: ${h.runtime}`
      : `engine binary missing`;
    el.className = "chip " + (h.binaryPresent ? "chip-on" : "chip-off");
  } catch {
    $("#engine").textContent = "engine: ?";
  }
  try {
    const g = await api("/google/auth/status");
    const el = $("#google");
    el.textContent = g.connected ? "google connected" : "google not connected";
    el.className = "chip " + (g.connected ? "chip-on" : "");
  } catch {
    /* chip stays muted */
  }
}

/* ---------------- setup checklist (P5.5 first-run) ---------------- */

async function loadChecklist() {
  const ul = $("#checklist");
  const items = [];
  // 1. engine binary present
  try {
    const h = await api("/engine/health");
    items.push({
      ok: h.binaryPresent,
      label: h.binaryPresent
        ? `engine installed (${h.installs.length} verified install${h.installs.length === 1 ? "" : "s"})`
        : "engine binary missing — run setup.ps1 from the engine package",
      action: h.binaryPresent
        ? null
        : { text: "AV notes", href: "https://github.com/info5starmedia-jpg/queuepilot/blob/main/docs/av-notes.md" },
    });
  } catch {
    items.push({ ok: false, label: "engine health unreachable" });
  }
  // 2. proxies configured
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
  // 3. profiles exist
  try {
    const { profiles } = await api("/profiles");
    items.push({
      ok: profiles.length > 0,
      label: profiles.length
        ? `${profiles.length} profile${profiles.length === 1 ? "" : "s"} ready`
        : "no profiles yet — create one above or import a CSV",
    });
  } catch {
    items.push({ ok: false, label: "profile list unreachable" });
  }
  ul.innerHTML = "";
  for (const it of items) {
    const li = document.createElement("li");
    li.className = it.ok ? "check-ok" : "check-warn";
    li.innerHTML = `<span class="mark">${it.ok ? "✓" : "!"}</span> ${esc(it.label)}${
      it.action ? ` <a href="${esc(it.action.href)}" target="_blank" rel="noreferrer">${esc(it.action.text)}</a>` : ""
    }`;
    ul.appendChild(li);
  }
}

/* ---------------- profiles ---------------- */

/* A2 batch selection — survives card re-renders (SSE run.* events reload
   the grid constantly, so selection lives here, not in the DOM). */
const batchSelection = new Set();

function updateBatchBar() {
  const bar = $("#batch-bar");
  if (!bar) return;
  const n = batchSelection.size;
  bar.hidden = n === 0;
  $("#batch-count").textContent = `${n} selected`;
}

async function startSelected() {
  const ids = [...batchSelection];
  if (ids.length === 0) return;
  const staggerMs = settingsData?.launch?.batchStaggerMs ?? 0;
  const btn = $("#batch-start");
  btn.disabled = true;
  try {
    const r = await api("/profiles/batch-start", {
      method: "POST",
      body: JSON.stringify({ ids, staggerMs }),
    });
    const failed = r.results.filter((x) => x.status === "failed").length;
    pushEvent({
      type: "info",
      detail: `batch-start: ${r.results.length - failed}/${r.results.length} started${failed ? `, ${failed} failed` : ""}`,
      at: new Date().toISOString(),
    });
    for (const x of r.results.filter((x) => x.status === "failed")) {
      pushEvent({ type: "error", detail: `${x.id}: ${x.error?.message ?? "failed"}`, at: new Date().toISOString() });
    }
    batchSelection.clear();
    updateBatchBar();
  } catch (err) {
    pushEvent({ type: "error", detail: err.message, at: new Date().toISOString() });
  } finally {
    btn.disabled = false;
  }
  await loadProfiles();
}

async function loadProfiles() {
  const { profiles } = await api("/profiles");
  const grid = $("#profiles");
  grid.innerHTML = "";
  for (const p of profiles) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = p.id;

    let driftBadge = "";
    let tabsInfo = "";
    if (p.status === "running") {
      try {
        const { drift } = await api(`/profiles/${p.id}/drift`);
        if (drift?.stale)
          driftBadge = `<span class="badge badge-drift" title="${esc(drift.message)}">applies at next start</span>`;
        const { tabs } = await api(`/profiles/${p.id}/tabs`);
        tabsInfo = `${tabs.length} tab${tabs.length === 1 ? "" : "s"}`;
      } catch {
        /* drift/tabs best-effort */
      }
    }

    const favorite = p.extra?.favorite === true;
    const tabColor = typeof p.extra?.tabColor === "string" ? p.extra.tabColor : null;

    card.innerHTML = `
      <div><input type="checkbox" class="batch-check" data-batch="${esc(p.id)}" title="select for batch" ${batchSelection.has(p.id) ? "checked" : ""} /> <span class="name">${tabColor ? `<span class="color-dot" style="background:${esc(tabColor)}"></span>` : ""}${esc(p.name)}</span><span class="badge badge-${esc(p.status)}">${esc(p.status)}</span>${driftBadge}</div>
      <div class="meta">${esc(p.group)}${p.email ? " · " + esc(p.email) : ""}${tabsInfo ? " · " + tabsInfo : ""}</div>
      <div class="actions">
        <button class="secondary" data-act="favorite" title="favorite">${favorite ? "★" : "☆"}</button>
        ${
          p.status === "running"
            ? `<button class="danger" data-act="stop">Stop</button>`
            : `<button data-act="start">Start</button>`
        }
        <button class="secondary" data-act="regen" title="regenerate fingerprint">New fingerprint</button>
      </div>`;
    card
      .querySelectorAll("button")
      .forEach((b) =>
        b.addEventListener("click", () => onProfileAction(p.id, b.dataset.act, p)),
      );
    grid.appendChild(card);
  }
}

async function onProfileAction(id, act, profile) {
  try {
    if (act === "start")
      await api(`/profiles/${id}/start`, { method: "POST", body: "{}" });
    if (act === "stop") await api(`/profiles/${id}/stop`, { method: "POST" });
    if (act === "regen")
      await api(`/profiles/${id}/fingerprint/regenerate`, {
        method: "POST",
        body: "{}",
      });
    if (act === "favorite") {
      const next = profile?.extra?.favorite === true ? false : true;
      await api(`/profiles/${id}/persona`, {
        method: "PATCH",
        body: JSON.stringify({ favorite: next }),
      });
    }
  } catch (err) {
    pushEvent({
      type: "error",
      detail: err.message,
      at: new Date().toISOString(),
    });
  }
  await loadProfiles();
}

$("#create-profile").addEventListener("submit", async (e) => {  e.preventDefault();
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
  } catch (err) {
    pushEvent({
      type: "error",
      detail: err.message,
      at: new Date().toISOString(),
    });
  }
  await loadProfiles();
});

// A2 batch selection: delegated so it survives grid re-renders.
$("#profiles").addEventListener("change", (e) => {
  const cb = e.target.closest?.(".batch-check");
  if (!cb) return;
  if (cb.checked) batchSelection.add(cb.dataset.batch);
  else batchSelection.delete(cb.dataset.batch);
  updateBatchBar();
});

$("#batch-start")?.addEventListener("click", startSelected);

async function tileSelected(preset) {
  const ids = [...batchSelection];
  if (ids.length === 0) return;
  try {
    const r = await api("/profiles/batch-tile", {
      method: "POST",
      body: JSON.stringify({ ids, preset }),
    });
    const failed = r.results.filter((x) => x.status === "failed").length;
    pushEvent({
      type: "info",
      detail: `tile ${preset}: ${r.results.length - failed}/${r.results.length} placed${failed ? `, ${failed} failed` : ""}`,
      at: new Date().toISOString(),
    });
    for (const x of r.results.filter((x) => x.status === "failed")) {
      pushEvent({ type: "error", detail: `${x.id}: ${x.error?.message ?? "failed"}`, at: new Date().toISOString() });
    }
  } catch (err) {
    pushEvent({ type: "error", detail: err.message, at: new Date().toISOString() });
  }
}

$("#tile-cascade")?.addEventListener("click", () => tileSelected("cascade"));
$("#tile-grid")?.addEventListener("click", () => tileSelected("grid"));

$("#batch-clear")?.addEventListener("click", () => {
  batchSelection.clear();
  updateBatchBar();
  loadProfiles();
});

/* ---------------- proxies ---------------- */

async function loadProxies() {
  const { proxies } = await api("/proxies");
  const tbody = $("#proxies tbody");
  tbody.innerHTML = "";
  for (const p of proxies) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(p.name)}</td>
      <td>${esc(p.type)}</td>
      <td class="mono">${esc(p.host)}:${esc(p.port)}</td>
      <td>${esc(p.timezone ?? "")}</td>
      <td><button class="secondary" data-act="test">test</button> <span class="meta"></span></td>`;
    tr.querySelector("button").addEventListener("click", async (ev) => {
      const out = ev.target.parentElement.querySelector(".meta");
      out.textContent = "…";
      try {
        const r = await api(`/proxies/${p.id}/test`, { method: "POST" });
        out.textContent = r.ok ? `ok · ${r.latencyMs}ms` : `fail: ${r.error}`;
      } catch (err) {
        out.textContent = err.message;
      }
    });
    tbody.appendChild(tr);
  }
}

/* ---------------- CSV import ---------------- */

let lastImportCsv = null; // csv text that passed a dry run

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
  const csv = $("#import-csv").value.trim();
  if (!csv) return;
  const data = await api("/profiles/import", {
    method: "POST",
    body: JSON.stringify({
      csv,
      dryRun,
      upsert: $("#import-upsert").checked,
    }),
  });
  renderImportResult(data, !dryRun);
  $("#import-apply").disabled = dryRun ? data.succeeded === 0 : true;
  if (dryRun) lastImportCsv = csv;
  if (!dryRun) await loadProfiles();
}

$("#import-file").addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
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
    pushEvent({ type: "error", detail: err.message, at: new Date().toISOString() });
  }
});

$("#import-apply").addEventListener("click", async () => {
  if ($("#import-csv").value.trim() !== lastImportCsv) {
    $("#import-apply").disabled = true;
    return;
  }
  try {
    await runImport(false);
  } catch (err) {
    pushEvent({ type: "error", detail: err.message, at: new Date().toISOString() });
  }
});

/* ---------------- proxy providers (star = default) ---------------- */

async function loadProxyProviders() {
  let data;
  try {
    data = await api("/proxy-providers");
  } catch {
    return; // providers surface optional
  }
  let section = $("#proxy-providers");
  if (!section) {
    // Build the section lazily after the Proxies table.
    const proxiesSection = $("#proxies")?.closest("section");
    if (!proxiesSection) return;
    section = document.createElement("section");
    section.innerHTML = `
      <div class="section-head"><h2>Proxy providers</h2>
        <span class="hint">★ = default provider</span></div>
      <table id="proxy-providers">
        <thead><tr><th></th><th>name</th><th>type</th><th>distribution</th><th>proxies</th><th></th></tr></thead>
        <tbody></tbody>
      </table>`;
    proxiesSection.after(section);
  }
  const tbody = section.querySelector("tbody");
  tbody.innerHTML = "";
  for (const p of data.providers ?? []) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><button class="secondary" data-star title="star as default">${p.starred ? "★" : "☆"}</button></td>
      <td>${esc(p.name)}</td>
      <td>${esc(p.type)}</td>
      <td>${esc(p.distribution)}</td>
      <td class="meta" data-count>…</td>
      <td><button class="secondary" data-act="refresh">refresh</button> <span class="meta" data-msg></span></td>`;
    tr.querySelector("[data-star]").addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      try {
        await api(`/proxy-providers/${p.id}/star`, {
          method: "POST",
          body: JSON.stringify({ starred: !p.starred }),
        });
        await loadProxyProviders();
      } catch (err) {
        pushEvent({ type: "error", detail: err.message, at: new Date().toISOString() });
        ev.target.disabled = false;
      }
    });
    tr.querySelector("[data-act='refresh']").addEventListener("click", async (ev) => {
      const msg = tr.querySelector("[data-msg]");
      msg.textContent = "…";
      try {
        await api(`/proxy-providers/${p.id}/refresh`, { method: "POST" });
        msg.textContent = "ok";
        await loadProxies();
        await loadProxyProviders();
      } catch (err) {
        msg.textContent = err.message;
      }
    });
    tbody.appendChild(tr);
  }
}

/* ---------------- tabs (Tab Thinger + mass select) ---------------- */

let lastTabs = []; // last query result, for the selection model

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

async function runTabsQuery() {
  const profileId = $("#tabs-profile").value;
  const tbody = $("#tabs-table tbody");
  if (!profileId) {
    tbody.innerHTML = "";
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
  for (const t of data.tabs) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" data-tab="${esc(t.id)}" ${t.status === "closed" ? "disabled" : ""} /></td>
      <td class="mono">${esc(t.url ?? "—")}</td>
      <td><span class="badge badge-${esc(t.status)}">${esc(t.status)}</span></td>
      <td class="mono">${esc(t.partitionId.slice(0, 8))}</td>
      <td>${t.status === "open" ? `<button class="secondary" data-close="${esc(t.id)}">close</button>` : ""}</td>`;
    tr.querySelector("[data-close]")?.addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      await api(`/profiles/${profileId}/tabs/${t.id}/close`, { method: "POST" });
      await runTabsQuery();
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
    pushEvent({
      type: "info",
      detail: `bulk-close: ${r.results.length - failed}/${r.results.length} closed`,
      at: new Date().toISOString(),
    });
  } catch (err) {
    pushEvent({ type: "error", detail: err.message, at: new Date().toISOString() });
  }
  $("#tabs-select-all").checked = false;
  await runTabsQuery();
  await loadProfiles();
});

$("#tabs-open").addEventListener("click", async () => {
  const profileId = $("#tabs-profile").value;
  const urls = $("#tabs-open-urls")
    .value.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!profileId || urls.length === 0) return;
  try {
    const r = await api(`/profiles/${profileId}/tabs/bulk-open`, {
      method: "POST",
      body: JSON.stringify({ urls }),
    });
    const failed = r.results.filter((x) => x.tab === null).length;
    pushEvent({
      type: "info",
      detail: `bulk-open: ${r.results.length - failed}/${r.results.length} opened`,
      at: new Date().toISOString(),
    });
    $("#tabs-open-urls").value = "";
  } catch (err) {
    pushEvent({ type: "error", detail: err.message, at: new Date().toISOString() });
  }
  await runTabsQuery();
  await loadProfiles();
});

$("#tabs-profile").addEventListener("change", runTabsQuery);

/* ---------------- settings (console Settings section) ---------------- */

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
  ],
  team: [
    { key: "serverUrl", label: "Team server URL", type: "text", placeholder: "https://… (empty = off)" },
    { key: "token", label: "Team server token", type: "text", placeholder: "bearer token (empty = off)" },
    { key: "syncGroups", label: "Sync groups (comma-separated)", type: "text", placeholder: "e.g. ads, shop" },
  ],
  integrations: [
    { key: "googleAccount", label: "Google account", type: "text", placeholder: "display name (empty = none)" },
    { key: "providersNote", label: "Providers note", type: "textarea", placeholder: "where credentials live — never store secrets here" },
  ],
  automation: [
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
  if (f.key === "syncGroups" || f.key === "enabledPlugins" || f.key === "enabledJyl")
    return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (f.key === "serverUrl" || f.key === "token" || f.key === "googleAccount")
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
  renderSettings();
}

function renderSettingsNav() {
  const nav = $("#settings-nav");
  nav.innerHTML = "";
  for (const s of SETTINGS_SECTIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s;
    b.className = s === settingsSection ? "" : "secondary";
    b.addEventListener("click", () => {
      settingsSection = s;
      renderSettings();
    });
    nav.appendChild(b);
  }
}

function renderSettings() {
  if (!settingsData) return;
  renderSettingsNav();
  const form = $("#settings-form");
  const doc = settingsData[settingsSection];
  const values = settingsToForm(settingsSection, doc);
  form.innerHTML = "";
  for (const f of SETTINGS_FIELDS[settingsSection]) {
    const label = document.createElement("label");
    label.className = "settings-field";
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
    $("#settings-status").textContent = `${settingsSection}.${key} saved`;
  } catch (err) {
    $("#settings-status").textContent = `save failed: ${err.message}`;
    renderSettings(); // revert to last known-good values
  }
}

$("#settings-form").addEventListener("change", (e) => {
  const key = e.target.id?.replace(`set-${settingsSection}-`, "");
  const field = SETTINGS_FIELDS[settingsSection].find((f) => f.key === key);
  if (field) persistSetting(key, field);
});

/* ---------------- live events (SSE) ---------------- */

function pushEvent(e) {
  const li = document.createElement("li");
  li.className = e.type.replace(".", "-");
  const time = (e.at ?? new Date().toISOString()).slice(11, 19);
  li.innerHTML = `<span class="type">${esc(e.type)}</span> ${esc(e.detail ?? "")} <span>${esc(time)}</span>`;
  const list = $("#events");
  list.prepend(li);
  while (list.children.length > 50) list.lastChild.remove();
}

function connectEvents() {
  const es = new EventSource("/events");
  es.onopen = () => {
    const el = $("#sse");
    el.textContent = "live";
    el.className = "chip chip-on";
  };
  es.onerror = () => {
    const el = $("#sse");
    el.textContent = "offline";
    el.className = "chip chip-off";
  };
  es.onmessage = (msg) => {
    try {
      const e = JSON.parse(msg.data);
      if (e.detail === "connected") return;
      pushEvent(e);
      // Run/tab transitions change the grids; reload lazily.
      if (e.type.startsWith("run.") || e.type.startsWith("tab.")) {
        loadProfiles();
        refreshTabsProfiles();
        if ($("#tabs-profile").value) runTabsQuery();
      }
    } catch {
      /* malformed event — ignore */
    }
  };
}

/* ---------------- boot ---------------- */

refreshHealth();
loadChecklist();
loadProfiles();
loadProxies();
loadProxyProviders();
refreshTabsProfiles();
loadSettings();
connectEvents();
setInterval(refreshHealth, 30_000);
