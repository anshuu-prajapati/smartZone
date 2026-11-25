"use strict";
// SmartZone live dashboard. Talks to the API on the same origin.
(function () {
  const { el, renderBoard, renderCircuits } = window.SZ;
  const $ = (id) => document.getElementById(id);
  const STATUS_MS = 3000;
  const ENERGY_MS = 30000;
  const EVENTS_MS = 10000;

  const state = { rooms: [], room: null, hours: 24, adminRequired: false };

  function recall(store, key) { try { return window[store].getItem(key); } catch (_) { return null; } }
  function remember(store, key, value) { try { window[store].setItem(key, value); } catch (_) { /* unavailable */ } }

  async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    const key = $("admin-key").value.trim();
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

  const room = () => state.rooms.find((r) => r.id === state.room);
  const zoneLabel = (r, z) => r.zones[z].split(" ")[0];
  const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const fmtKwh = (v) => (v == null ? "–" : `${v.toFixed(2)} kWh`);
  function fmtAge(s) {
    if (s < 60) return `${Math.round(s)} s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return `${Math.round(s / 3600)} h ago`;
  }

  function message(text, isError) {
    const m = $("settings-msg");
    m.textContent = text;
    m.style.color = isError ? "var(--danger)" : "";
  }

  // ---- rendering ----------------------------------------------------------------
  function renderStatus(s) {
    const r = room();
    if (!r) return;
    const rep = s.last_report;
    const pill = $("online-pill");
    if (s.online) { pill.className = "pill pill-on"; pill.textContent = "online"; }
    else if (rep) { pill.className = "pill pill-bad"; pill.textContent = "offline"; }
    else { pill.className = "pill pill-off"; pill.textContent = "waiting for hardware"; }

    $("last-seen").textContent = rep
      ? `Last report ${fmtAge(s.last_report_age_s)} (${fmtTime(rep.ts)}, ${rep.reason})`
      : "No reports from this room's controller yet.";
    $("waiting").hidden = !!rep;

    const empty = { present: r.zones.map(() => false), active: r.zones.map(() => false), circuits: r.circuits.map(() => false) };
    const view = rep ? { present: rep.present, active: rep.active, circuits: rep.circuits } : empty;
    renderBoard($("board"), r, view);

    const circuits = $("circuits");
    const focusedKey = document.activeElement && circuits.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    renderCircuits(circuits, r, view, { modes: s.config.modes, onMode: setMode });
    circuits.querySelectorAll("button").forEach((b, i) => { b.dataset.key = `m${i}`; });
    if (focusedKey) { const b = circuits.querySelector(`[data-key="${focusedKey}"]`); if (b) b.focus({ preventScroll: true }); }

    $("meta-delay").textContent = `${s.config.off_delay_s} s`;
    $("meta-zones").textContent = rep ? `${rep.present.filter(Boolean).length} / ${r.zones.length}` : "–";
    $("meta-circuits").textContent = rep ? `${rep.circuits.filter(Boolean).length} / ${r.circuits.length}` : "–";
    $("meta-config").textContent = `v${s.config.version}`;
    $("config-state").textContent = !rep ? "" : s.config_applied
      ? `settings v${s.config.version} applied on device`
      : `settings v${s.config.version} waiting for device`;

    const input = $("off-delay");
    if (document.activeElement !== input) input.value = s.config.off_delay_s;
  }

  function renderChart(series) {
    const W = 720, H = 220, L = 44, R = 8, T = 10, B = 24;
    const NS = "http://www.w3.org/2000/svg";
    const max = Math.max(0.05, ...series.map((b) => Math.max(b.baseline_kwh, b.used_kwh)));
    const nice = niceMax(max);
    const n = Math.max(series.length, 1);
    const bw = (W - L - R) / n;
    const y = (v) => T + (H - T - B) * (1 - v / nice);
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
    for (let i = 0; i <= 4; i++) {
      const v = (nice * i) / 4;
      add("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), style: "stroke: var(--line)", "stroke-width": 1 });
      add("text", { x: L - 6, y: y(v) + 3, "text-anchor": "end" }, v.toFixed(v < 1 ? 2 : 1));
    }
    const every = Math.ceil(n / 8);
    series.forEach((b, i) => {
      const x = L + i * bw;
      const w = Math.max(1.5, bw * 0.78);
      const tip = `${new Date(b.start * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}: used ${b.used_kwh.toFixed(3)} kWh, baseline ${b.baseline_kwh.toFixed(3)} kWh, coverage ${b.coverage_pct}%`;
      const base = add("rect", { x, y: y(b.baseline_kwh), width: w, height: Math.max(0, H - B - y(b.baseline_kwh)), rx: 2, style: "fill: var(--off-soft); stroke: var(--line)" });
      const used = add("rect", { x: x + w * 0.22, y: y(b.used_kwh), width: w * 0.56, height: Math.max(0, H - B - y(b.used_kwh)), rx: 2, style: "fill: var(--accent)" });
      for (const r of [base, used]) { const t = document.createElementNS(NS, "title"); t.textContent = tip; r.append(t); }
      if (i % every === 0) {
        const d = new Date(b.start * 1000);
        const label = n > 48 ? d.toLocaleDateString([], { weekday: "short" }) : d.toLocaleTimeString([], { hour: "2-digit" });
        add("text", { x: x + w / 2, y: H - 6, "text-anchor": "middle" }, label);
      }
    });
    $("chart").replaceChildren(svg);
  }

  function niceMax(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  function renderEnergy(e) {
    $("e-used").textContent = fmtKwh(e.used_kwh);
    $("e-base").textContent = fmtKwh(e.baseline_kwh);
    $("e-saved").textContent = e.saved_pct == null ? "–" : fmtKwh(e.saved_kwh);
    $("e-saved-pct").textContent = e.saved_pct == null ? "No occupied time yet" : `${e.saved_pct}% of baseline`;
    $("e-cov").textContent = `${e.coverage_pct}%`;
    renderChart(e.series);
  }

  function renderEvents(events) {
    const r = room();
    const names = (bits, fn) => bits.map((v, i) => (v ? fn(i) : null)).filter(Boolean).join(", ") || "none";
    const body = $("events");
    if (!events.length) {
      body.replaceChildren(el("tr", {}, [el("td", { colspan: "4", class: "muted", text: "No reports yet." })]));
      return;
    }
    body.replaceChildren(...events.map((ev) => el("tr", {}, [
      el("td", { text: fmtTime(ev.ts) }),
      el("td", { text: ev.reason }),
      el("td", { text: names(ev.present, (z) => zoneLabel(r, z)) }),
      el("td", { text: names(ev.circuits, (c) => r.circuits[c].name) }),
    ])));
  }

  // ---- actions ------------------------------------------------------------------
  function writeError(err) {
    if (err.status === 401) {
      $("admin-field").hidden = false;
      $("admin-key").focus();
      message("Enter the admin key to change settings.", true);
    } else {
      message(`Could not save: ${err.message}`, true);
    }
  }

  async function setMode(i, mode) {
    try {
      await api(`/api/rooms/${state.room}/circuits/${i}/mode`, { method: "PUT", body: JSON.stringify({ mode }) });
      remember("sessionStorage", "smartzone.admin", $("admin-key").value.trim());
      message(`${room().circuits[i].name} set to ${mode}. The controller applies it on its next report.`);
      refreshStatus();
    } catch (err) { writeError(err); }
  }

  async function saveDelay(ev) {
    ev.preventDefault();
    const value = Number($("off-delay").value);
    try {
      await api(`/api/rooms/${state.room}/config`, { method: "PUT", body: JSON.stringify({ off_delay_s: value }) });
      remember("sessionStorage", "smartzone.admin", $("admin-key").value.trim());
      message(`Off-delay set to ${value} s.`);
      $("off-delay").blur();
      refreshStatus();
    } catch (err) { writeError(err); }
  }

  // ---- polling ------------------------------------------------------------------
  async function refreshStatus() {
    if (!state.room) return;
    try { renderStatus(await api(`/api/rooms/${state.room}/status`)); }
    catch (_) { const p = $("online-pill"); p.className = "pill pill-bad"; p.textContent = "server unreachable"; }
  }
  async function refreshEnergy() {
    if (!state.room) return;
    try { renderEnergy(await api(`/api/rooms/${state.room}/energy?hours=${state.hours}`)); } catch (_) { /* keep last */ }
  }
  async function refreshEvents() {
    if (!state.room) return;
    try { renderEvents(await api(`/api/rooms/${state.room}/events?limit=15`)); } catch (_) { /* keep last */ }
  }
  const refreshAll = () => { refreshStatus(); refreshEnergy(); refreshEvents(); };

  async function init() {
    const health = await api("/api/health");
    state.adminRequired = health.admin_key_required;
    $("admin-field").hidden = !state.adminRequired;
    $("admin-key").value = recall("sessionStorage", "smartzone.admin") || "";

    state.rooms = await api("/api/rooms");
    const select = $("room-select");
    select.replaceChildren(...state.rooms.map((r) => el("option", { value: r.id, text: r.name })));
    const saved = recall("localStorage", "smartzone.room");
    state.room = state.rooms.some((r) => r.id === saved) ? saved : state.rooms[0] && state.rooms[0].id;
    select.value = state.room;
    select.addEventListener("change", () => {
      state.room = select.value;
      remember("localStorage", "smartzone.room", state.room);
      refreshAll();
    });

    document.querySelectorAll("#window [data-hours]").forEach((b) => b.addEventListener("click", () => {
      state.hours = Number(b.dataset.hours);
      document.querySelectorAll("#window [data-hours]").forEach((x) => x.classList.toggle("active", x === b));
      refreshEnergy();
    }));
    $("delay-form").addEventListener("submit", saveDelay);

    refreshAll();
    setInterval(refreshStatus, STATUS_MS);
    setInterval(refreshEnergy, ENERGY_MS);
    setInterval(refreshEvents, EVENTS_MS);
  }

  init().catch((err) => {
    const p = $("online-pill");
    p.className = "pill pill-bad";
    p.textContent = `failed to load: ${err.message}`;
  });
})();
