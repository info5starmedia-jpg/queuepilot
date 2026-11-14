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

/* ---------------- profiles ---------------- */

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

    card.innerHTML = `
      <div><span class="name">${esc(p.name)}</span><span class="badge badge-${esc(p.status)}">${esc(p.status)}</span>${driftBadge}</div>
      <div class="meta">${esc(p.group)}${p.email ? " · " + esc(p.email) : ""}${tabsInfo ? " · " + tabsInfo : ""}</div>
      <div class="actions">
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
        b.addEventListener("click", () => onProfileAction(p.id, b.dataset.act)),
      );
    grid.appendChild(card);
  }
}

async function onProfileAction(id, act) {
  try {
    if (act === "start")
      await api(`/profiles/${id}/start`, { method: "POST", body: "{}" });
    if (act === "stop") await api(`/profiles/${id}/stop`, { method: "POST" });
    if (act === "regen")
      await api(`/profiles/${id}/fingerprint/regenerate`, {
        method: "POST",
        body: "{}",
      });
  } catch (err) {
    pushEvent({
      type: "error",
      detail: err.message,
      at: new Date().toISOString(),
    });
  }
  await loadProfiles();
}

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
  } catch (err) {
    pushEvent({
      type: "error",
      detail: err.message,
      at: new Date().toISOString(),
    });
  }
  await loadProfiles();
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
      if (e.type.startsWith("run.") || e.type.startsWith("tab."))
        loadProfiles();
    } catch {
      /* malformed event — ignore */
    }
  };
}

/* ---------------- boot ---------------- */

refreshHealth();
loadProfiles();
loadProxies();
connectEvents();
setInterval(refreshHealth, 30_000);
