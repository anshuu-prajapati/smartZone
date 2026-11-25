"use strict";

// SmartZone dashboard. Talks to the backend on the same origin.

const STATUS_MS = 3000;
const ENERGY_MS = 30000;
const EVENTS_MS = 10000;

const state = {
  rooms: [],
  room: null,
  hours: 24,
  adminRequired: false,
  lastStatus: null,
};

const $ = (id) => document.getElementById(id);

function store(key, value) {
  try { localStorage.setItem(key, value); } catch (_) { /* storage unavailable */ }
}
function recall(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const key = $("admin-key").value;
  if (key) headers["X-Admin-Key"] = key;
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) { /* not JSON */ }
    const err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function currentRoom() {
  return state.rooms.find((r) => r.id === state.room);
}

function zoneLabel(room, z) {
  return room.zones[z].split(" ")[0];
}

function fmtKwh(v) {
  return v == null ? "–" : `${v.toFixed(2)} kWh`;
}

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function showMessage(text, isError = false) {
  const msg = $("settings-msg");
  msg.textContent = text;
  msg.style.color = isError ? "var(--danger)" : "";
}

// ---- rendering --------------------------------------------------------------
function renderZones(room, report) {
  const map = $("zone-map");
  const cols = Math.ceil(Math.sqrt(room.zones.length));
  map.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  map.replaceChildren(
    ...room.zones.map((name, z) => {
      const present = report ? report.present[z] : false;
      const active = report ? report.active[z] : false;
      const cls = present ? "present" : active ? "hold" : "";
      const label = !report ? "No data" : present ? "Occupied" : active ? "Off-delay running" : "Empty";
      return el("div", { class: `zone ${cls}` }, [
        el("span", { class: "zone-name", text: name }),
        el("span", { class: "zone-state", text: label }),
      ]);
    })
  );
}

function renderCircuits(room, report, config) {
  const box = $("circuits");
  box.replaceChildren(
    ...room.circuits.map((c, i) => {
      const on = report ? report.circuits[i] : false;
      const zones = c.zones.map((z) => zoneLabel(room, z)).join("+");
      const kind = c.kind === "ir_ac" ? "AC (IR)" : "Relay";
      const mode = config.modes[i];
      const seg = el("div", { class: "seg", role: "group", "aria-label": `Mode for ${c.name}` },
        ["auto", "on", "off"].map((m) => {
          const b = el("button", { type: "button", text: m === "auto" ? "Auto" : m === "on" ? "On" : "Off" });
          if (m === mode) b.classList.add("active");
          b.addEventListener("click", () => setMode(i, m));
          return b;
        })
      );
      return el("div", { class: "circuit" }, [
        el("span", { class: `lamp ${on ? "on" : ""}`, title: on ? "On" : "Off" }),
        el("div", {}, [
          el("div", { class: "circuit-name", text: `${c.name} — ${on ? "ON" : "OFF"}` }),
          el("div", { class: "circuit-meta", text: `${kind} · zones ${zones} · ${c.watts} W` }),
        ]),
        seg,
      ]);
    })
  );
}

function renderStatus(status) {
  const room = currentRoom();
  if (!room) return;
  state.lastStatus = status;
  const report = status.last_report;

  const badge = $("online-badge");
  if (status.online) {
    badge.className = "badge badge-ok";
    badge.textContent = `online · ${Math.round(status.last_report_age_s)} s ago`;
  } else if (report) {
    badge.className = "badge badge-bad";
    badge.textContent = `offline · last seen ${fmtTime(report.ts)}`;
  } else {
    badge.className = "badge badge-muted";
    badge.textContent = "no device yet";
  }

  renderZones(room, report);
  renderCircuits(room, report, status.config);

  $("config-state").textContent = status.config_applied
    ? `settings v${status.config.version} applied on device`
    : `settings v${status.config.version} waiting for device`;

  const input = $("off-delay");
  if (document.activeElement !== input) input.value = status.config.off_delay_s;
}

function renderChart(series) {
  const box = $("chart");
  const W = 600, H = 180, padL = 34, padB = 18, padT = 6;
  const max = Math.max(0.01, ...series.map((b) => Math.max(b.baseline_kwh, b.used_kwh)));
  const n = series.length || 1;
  const bw = (W - padL) / n;
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");

  const add = (tag, attrs, text) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    svg.append(node);
    return node;
  };

  add("text", { x: 0, y: padT + 8 }, `${max.toFixed(2)}`);
  add("text", { x: 0, y: H - padB }, "0 kWh");
  series.forEach((b, i) => {
    const x = padL + i * bw;
    const w = Math.max(1, bw * 0.8);
    const base = add("rect", { x, y: y(b.baseline_kwh), width: w, height: H - padB - y(b.baseline_kwh), style: "fill: var(--bar-base)" });
    const used = add("rect", { x: x + w * 0.2, y: y(b.used_kwh), width: w * 0.6, height: H - padB - y(b.used_kwh), style: "fill: var(--bar-used)" });
    const tip = `${new Date(b.start * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}: used ${b.used_kwh.toFixed(3)} kWh, baseline ${b.baseline_kwh.toFixed(3)} kWh`;
    for (const r of [base, used]) {
      const t = document.createElementNS(NS, "title");
      t.textContent = tip;
      r.append(t);
    }
    const labelEvery = Math.ceil(n / 8);
    if (i % labelEvery === 0) {
      add("text", { x, y: H - 4 }, new Date(b.start * 1000).toLocaleTimeString([], { hour: "2-digit" }));
    }
  });
  box.replaceChildren(svg);
}

function renderEnergy(e) {
  $("e-used").textContent = fmtKwh(e.used_kwh);
  $("e-base").textContent = fmtKwh(e.baseline_kwh);
  $("e-saved").textContent = e.saved_pct == null ? "–" : `${e.saved_kwh.toFixed(2)} kWh (${e.saved_pct}%)`;
  $("e-cov").textContent = `${e.coverage_pct}%`;
  renderChart(e.series);
}

function renderEvents(events) {
  const room = currentRoom();
  const names = (bits, labelFn) => bits.map((v, i) => (v ? labelFn(i) : null)).filter(Boolean).join(", ") || "none";
  $("events").replaceChildren(
    ...events.map((ev) =>
      el("tr", {}, [
        el("td", { text: fmtTime(ev.ts) }),
        el("td", { text: ev.reason }),
        el("td", { text: names(ev.present, (z) => zoneLabel(room, z)) }),
        el("td", { text: names(ev.circuits, (c) => String(c + 1)) }),
      ])
    )
  );
}

// ---- actions ------------------------------------------------------------------
async function setMode(index, mode) {
  try {
    await api(`/api/rooms/${state.room}/circuits/${index}/mode`, {
      method: "PUT",
      body: JSON.stringify({ mode }),
    });
    showMessage(`Circuit ${index + 1} set to ${mode}. The device applies it on its next report.`);
    refreshStatus();
  } catch (err) {
    handleWriteError(err);
  }
}

async function saveDelay(event) {
  event.preventDefault();
  const value = Number($("off-delay").value);
  try {
    await api(`/api/rooms/${state.room}/config`, {
      method: "PUT",
      body: JSON.stringify({ off_delay_s: value }),
    });
    showMessage(`Off-delay set to ${value} s.`);
    $("off-delay").blur();
    refreshStatus();
  } catch (err) {
    handleWriteError(err);
  }
}

function handleWriteError(err) {
  if (err.status === 401) {
    $("admin-row").hidden = false;
    showMessage("Enter the admin key to change settings.", true);
  } else {
    showMessage(`Could not save: ${err.message}`, true);
  }
}

// ---- polling ------------------------------------------------------------------
async function refreshStatus() {
  if (!state.room) return;
  try {
    renderStatus(await api(`/api/rooms/${state.room}/status`));
  } catch (err) {
    const badge = $("online-badge");
    badge.className = "badge badge-bad";
    badge.textContent = "backend unreachable";
  }
}

async function refreshEnergy() {
  if (!state.room) return;
  try {
    renderEnergy(await api(`/api/rooms/${state.room}/energy?hours=${state.hours}`));
  } catch (_) { /* keep last values */ }
}

async function refreshEvents() {
  if (!state.room) return;
  try {
    renderEvents(await api(`/api/rooms/${state.room}/events?limit=20`));
  } catch (_) { /* keep last values */ }
}

function refreshAll() {
  refreshStatus();
  refreshEnergy();
  refreshEvents();
}

async function init() {
  const health = await api("/api/health");
  state.adminRequired = health.admin_key_required;
  $("admin-row").hidden = !state.adminRequired;

  state.rooms = await api("/api/rooms");
  const select = $("room-select");
  select.replaceChildren(...state.rooms.map((r) => el("option", { value: r.id, text: r.name })));
  const saved = recall("smartzone.room");
  state.room = state.rooms.some((r) => r.id === saved) ? saved : state.rooms[0]?.id;
  select.value = state.room;
  select.addEventListener("change", () => {
    state.room = select.value;
    store("smartzone.room", state.room);
    refreshAll();
  });

  document.querySelectorAll(".seg [data-hours]").forEach((b) =>
    b.addEventListener("click", () => {
      state.hours = Number(b.dataset.hours);
      document.querySelectorAll(".seg [data-hours]").forEach((x) => x.classList.toggle("active", x === b));
      refreshEnergy();
    })
  );
  $("delay-form").addEventListener("submit", saveDelay);

  refreshAll();
  setInterval(refreshStatus, STATUS_MS);
  setInterval(refreshEnergy, ENERGY_MS);
  setInterval(refreshEvents, EVENTS_MS);
}

init().catch((err) => {
  $("online-badge").className = "badge badge-bad";
  $("online-badge").textContent = `failed to load: ${err.message}`;
});
