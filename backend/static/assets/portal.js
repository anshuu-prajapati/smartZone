"use strict";
(function () {
  const { el, renderBoard, renderCircuits, fmtDuration } = window.SZ;
  const $ = (id) => document.getElementById(id);

  // Same definition as backend/rooms.json, used if the API is unreachable.
  const FALLBACK_ROOM = {
    id: "room101",
    name: "Room 101 (prototype)",
    zones: ["A front-left", "B front-right", "C back-left", "D back-right"],
    circuits: [
      { name: "Lights, front row", kind: "relay", zones: [0, 1], watts: 160, duty: 1 },
      { name: "Lights, back row", kind: "relay", zones: [2, 3], watts: 160, duty: 1 },
      { name: "Fans, left side", kind: "relay", zones: [0, 2], watts: 150, duty: 1 },
      { name: "Fans, right side", kind: "relay", zones: [1, 3], watts: 150, duty: 1 },
      { name: "Split AC", kind: "ir_ac", zones: [0, 1, 2, 3], watts: 1500, duty: 0.65 },
    ],
  };
  const AC_MIN_OFF_MS = 3 * 60 * 1000;
  const START_MS = 9 * 3600 * 1000;
  const TICK_MS = 200;

  // Keeps keyboard focus on the same control when a panel is re-rendered.
  function withFocus(container, render) {
    const active = document.activeElement;
    const key = active && container.contains(active) ? active.dataset.key : null;
    render();
    if (key) {
      const again = container.querySelector(`[data-key="${key}"]`);
      if (again) again.focus({ preventScroll: true });
    }
  }

  function tagKeys(container, prefix) {
    container.querySelectorAll("button").forEach((b, i) => {
      b.dataset.key = `${prefix}-${b.dataset.mode || ""}-${i}`;
    });
  }

  // ---- Prototype simulation ---------------------------------------------------
  const sim = {
    room: FALLBACK_ROOM,
    ctl: null,
    people: [],
    now: START_MS,
    speed: 10,
    usedWh: 0,
    baseWh: 0,
    delayS: 180,
    log: [],
  };

  function avgWatts(c) { return c.watts * (c.duty == null ? 1 : c.duty); }

  function simTime(ms) {
    const s = Math.floor(ms / 1000) % 86400;
    const p = (n) => String(n).padStart(2, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  }

  function addLog(text) {
    sim.log.unshift({ t: simTime(sim.now), text });
    sim.log = sim.log.slice(0, 40);
    $("sim-log").replaceChildren(...sim.log.map((e) => el("div", {}, [el("b", { text: e.t }), ` ${e.text}`])));
  }

  function resetSim() {
    const room = sim.room;
    sim.ctl = new window.SZ.ZoneController(
      room.circuits.map((c) => ({ zones: c.zones, minOffMs: c.kind === "ir_ac" ? AC_MIN_OFF_MS : 0 })),
      room.zones.length,
      sim.delayS * 1000,
    );
    sim.people = new Array(room.zones.length).fill(0);
    sim.now = START_MS;
    sim.usedWh = 0;
    sim.baseWh = 0;
    sim.log = [];
    sim.ctl.update(sim.people.map((n) => n > 0), sim.now);
    addLog("Simulation started. Room empty, everything off.");
    renderSim();
  }

  function zoneLabel(z) { return sim.room.zones[z].split(" ")[0]; }

  function setPeople(next, label) {
    next.forEach((n, z) => {
      if ((n > 0) !== (sim.people[z] > 0)) addLog(n > 0 ? `Zone ${zoneLabel(z)}: ${n} ${n === 1 ? "person" : "people"} sat down` : `Zone ${zoneLabel(z)}: everyone left`);
    });
    sim.people = next;
    if (label) addLog(`Scenario: ${label}`);
    step(0);
  }

  function step(dt) {
    const room = sim.room;
    const ctl = sim.ctl;
    if (dt > 0) {
      // Energy for the interval uses the state before this update.
      const used = room.circuits.reduce((s, c, i) => s + (ctl.on[i] ? avgWatts(c) : 0), 0);
      const base = ctl.active.some(Boolean) ? room.circuits.reduce((s, c) => s + avgWatts(c), 0) : 0;
      sim.usedWh += (used * dt) / 3.6e6;
      sim.baseWh += (base * dt) / 3.6e6;
      sim.now += dt;
    }
    const changed = ctl.update(sim.people.map((n) => n > 0), sim.now);
    changed.forEach((c) => addLog(`${room.circuits[c].name} → ${ctl.on[c] ? "ON" : "OFF"}`));
    renderSim();
  }

  function simView() {
    const ctl = sim.ctl;
    const n = sim.room.circuits.length;
    return {
      present: ctl.present.slice(),
      active: ctl.active.slice(),
      circuits: ctl.on.slice(),
      people: sim.people.slice(),
      holdLeft: sim.room.zones.map((_, z) => ctl.holdLeftS(z, sim.now)),
      locked: ctl.lockedOut.slice(),
      lockLeft: Array.from({ length: n }, (_, c) => ctl.lockLeftS(c, sim.now)),
    };
  }

  function renderSim() {
    const view = simView();
    const room = sim.room;
    const board = $("sim-board");
    withFocus(board, () => {
      renderBoard(board, room, view, {
        onZoneClick: (z) => {
          const next = sim.people.slice();
          next[z] = next[z] > 0 ? 0 : 2;
          setPeople(next);
        },
      });
      tagKeys(board, "zone");
    });
    const circuits = $("sim-circuits");
    withFocus(circuits, () => {
      renderCircuits(circuits, room, view, {
        modes: sim.ctl.modes,
        onMode: (i, m) => {
          sim.ctl.setMode(i, m);
          addLog(`${room.circuits[i].name}: mode set to ${m}`);
          step(0);
        },
      });
      tagKeys(circuits, "mode");
    });

    $("sim-clock").textContent = simTime(sim.now);
    const usedW = room.circuits.reduce((s, c, i) => s + (sim.ctl.on[i] ? avgWatts(c) : 0), 0);
    const baseW = sim.ctl.active.some(Boolean) ? room.circuits.reduce((s, c) => s + avgWatts(c), 0) : 0;
    $("sim-used").textContent = `${(sim.usedWh / 1000).toFixed(3)} kWh`;
    $("sim-base").textContent = `${(sim.baseWh / 1000).toFixed(3)} kWh`;
    $("sim-used-w").textContent = `${Math.round(usedW)} W now`;
    $("sim-base-w").textContent = `${Math.round(baseW)} W now`;
    const saved = sim.baseWh - sim.usedWh;
    $("sim-saved").textContent = sim.baseWh > 0.0005
      ? `${(saved / 1000).toFixed(3)} kWh · ${((100 * saved) / sim.baseWh).toFixed(1)}%`
      : "–";
  }

  const SCENARIOS = {
    front: { label: "small class at the front", people: [3, 2, 0, 0] },
    scattered: { label: "library, scattered readers", people: [1, 0, 0, 1] },
    full: { label: "full room", people: [5, 5, 5, 5] },
    leave: { label: "everyone leaves", people: [0, 0, 0, 0] },
  };

  function initSim() {
    resetSim();
    document.querySelectorAll("[data-scenario]").forEach((b) =>
      b.addEventListener("click", () => {
        const s = SCENARIOS[b.dataset.scenario];
        setPeople(s.people.slice(0, sim.room.zones.length), s.label);
      }));
    document.querySelectorAll("#speed [data-speed]").forEach((b) =>
      b.addEventListener("click", () => {
        sim.speed = Number(b.dataset.speed);
        document.querySelectorAll("#speed [data-speed]").forEach((x) => x.classList.toggle("active", x === b));
      }));
    const delay = $("sim-delay");
    const showDelay = () => { $("sim-delay-out").textContent = fmtDuration(Number(delay.value)); };
    delay.addEventListener("input", () => {
      sim.delayS = Number(delay.value);
      sim.ctl.offDelayMs = sim.delayS * 1000;
      showDelay();
    });
    delay.addEventListener("change", () => addLog(`Off-delay set to ${fmtDuration(sim.delayS)}`));
    showDelay();
    $("sim-reset").addEventListener("click", resetSim);
    setInterval(() => { if (!document.hidden) step(TICK_MS * sim.speed); }, TICK_MS);
  }

  // ---- Live status --------------------------------------------------------------
  async function initLive() {
    const pill = $("live-pill");
    const text = $("live-text");
    try {
      const res = await fetch("/api/rooms/room101/status");
      if (!res.ok) throw new Error(String(res.status));
      const s = await res.json();
      if (s.online) {
        const occupied = s.last_report.present.filter(Boolean).length;
        const on = s.last_report.circuits.filter(Boolean).length;
        pill.className = "pill pill-on";
        pill.textContent = "device online";
        text.textContent = `Room 101 is reporting: ${occupied} zone${occupied === 1 ? "" : "s"} occupied, ${on} circuit${on === 1 ? "" : "s"} on.`;
      } else if (s.last_report) {
        pill.className = "pill pill-hold";
        pill.textContent = "device offline";
        text.textContent = `Last report from Room 101: ${new Date(s.last_report.ts * 1000).toLocaleString()}.`;
      } else {
        pill.className = "pill pill-off";
        pill.textContent = "waiting for hardware";
        text.textContent = "The server is live. The dashboard fills in as soon as the room's ESP32 starts reporting.";
      }
    } catch (_) {
      pill.className = "pill pill-bad";
      pill.textContent = "unreachable";
    }
  }

  // ---- Downloads ------------------------------------------------------------------
  const DELIVERABLES = [
    { name: "01_Project_Proposal.pdf", title: "Project proposal", desc: "Problem, solution, use cases, architecture, impact and roadmap." },
    { name: "02_Presentation.pptx", title: "Presentation", desc: "Slide deck with speaker notes." },
    { name: "03_Demo_Video.mp4", title: "Demo video", desc: "Walkthrough of the prototype and live dashboard." },
    { name: "04_Architecture.png", title: "Architecture diagram", desc: "Edge, server, web and the CI/CD pipeline." },
    { name: "05_GitHub_Link.txt", title: "GitHub link", desc: "Source code repository." },
    { name: "06_Live_Demo_Link.txt", title: "Live demo links", desc: "Portal, dashboard and prototype URLs." },
    { name: "07_Team_Details.pdf", title: "Team details", desc: "Team and contact information." },
    { name: "08_Project_Screenshots", title: "Project screenshots", desc: "Portal, prototype and dashboard.", dir: true },
    { name: "09_Pitch_Script.pdf", title: "Pitch script", desc: "Timed script for the spoken pitch." },
    { name: "10_Tools_and_Components", title: "Tools and components", desc: "Hardware and software images with credits.", dir: true, anchor: "#build-kit" },
  ];

  function fmtSize(bytes) {
    if (bytes == null) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  async function initDownloads() {
    let files = [];
    try {
      const res = await fetch("/api/downloads");
      if (res.ok) files = await res.json();
    } catch (_) { /* render placeholders */ }
    const byName = Object.fromEntries(files.map((f) => [f.name, f]));

    const cards = DELIVERABLES.map((d) => {
      const f = byName[d.name];
      const ext = d.dir ? "dir" : d.name.split(".").pop();
      const label = d.dir ? "IMG" : ext.toUpperCase();
      let meta = "Coming soon";
      let href = null;
      if (f && d.dir) {
        meta = `${(f.children || []).filter((c) => /\.(png|jpe?g)$/i.test(c.name)).length} images`;
        href = d.anchor || "#media-row";
      } else if (f) {
        meta = `${label} · ${fmtSize(f.size)}`;
        href = f.url;
      }
      const inner = [
        el("span", { class: `dl-icon ${ext}`, text: label }),
        el("div", {}, [
          el("div", { class: "dl-title", text: d.title }),
          el("div", { class: "dl-desc", text: d.desc }),
          el("div", { class: "dl-meta", text: `${d.name}${d.dir ? "/" : ""} · ${meta}` }),
        ]),
      ];
      if (!href) return el("div", { class: "card dl missing" }, inner);
      const attrs = { class: "card dl", href };
      if (!d.dir) {
        if (["pdf", "png", "txt", "mp4"].includes(ext)) attrs.target = "_blank";
        else attrs.download = d.name;
        attrs.rel = "noopener";
      }
      return el("a", attrs, inner);
    });
    $("downloads-list").replaceChildren(...cards);

    const video = byName["03_Demo_Video.mp4"];
    const shots = (byName["08_Project_Screenshots"] || {}).children || [];
    if (video || shots.length) {
      $("media-row").hidden = false;
      if (video) $("demo-video").src = video.url;
      else $("demo-video").replaceWith(el("img", { src: (byName["04_Architecture.png"] || {}).url || "", alt: "SmartZone architecture" }));
      $("shots").replaceChildren(...shots.slice(0, 4).map((s) =>
        el("a", { href: s.url, target: "_blank", rel: "noopener" }, [el("img", { src: s.url, alt: s.name.replace(/[_-]/g, " ").replace(/\.\w+$/, ""), loading: "lazy" })])));
    }
  }

  // ---- Build kit --------------------------------------------------------------------
  const KIT_DIR = "/downloads/10_Tools_and_Components/";
  const KIT_NAMES = {
    hw_01: "ESP32 controller",
    hw_02: "ESP32 DevKit pinout",
    hw_03: "Relay module",
    hw_04: "Infrared LED",
    hw_05: "IR receiver (TSOP)",
    hw_06: "2N2222 transistor",
    hw_07: "Breadboard",
    hw_08: "Jumper wires",
    sw_01: "Arduino IDE 2",
    sw_02: "Python",
    sw_03: "FastAPI",
    sw_04: "Caddy",
    sw_05: "GitHub",
    sw_06: "GitHub Actions",
  };

  function kitCard(item) {
    const key = item.file.slice(0, 5);
    const credit = el("div", { class: "kit-credit" }, [
      "Image: ",
      el("a", { href: item.source, target: "_blank", rel: "noopener", text: item.author }),
      " · ",
      item.license_url
        ? el("a", { href: item.license_url, target: "_blank", rel: "noopener", text: item.license })
        : item.license,
    ]);
    return el("article", { class: "card kit-card" }, [
      el("div", { class: "kit-media" }, [
        el("img", { src: KIT_DIR + encodeURIComponent(item.file), alt: KIT_NAMES[key] || item.caption, loading: "lazy" }),
      ]),
      el("div", { class: "kit-body" }, [
        el("div", { class: "kit-name", text: KIT_NAMES[key] || item.file }),
        el("div", { class: "kit-role", text: item.caption }),
        credit,
      ]),
    ]);
  }

  function pendingCard(name, role) {
    return el("article", { class: "card kit-card" }, [
      el("div", { class: "kit-media pending", text: "Team photo coming with the hardware build" }),
      el("div", { class: "kit-body" }, [el("div", { class: "kit-name", text: name }), el("div", { class: "kit-role", text: role })]),
    ]);
  }

  async function initKit() {
    let items = [];
    try {
      const res = await fetch(KIT_DIR + "credits.json");
      if (res.ok) items = await res.json();
    } catch (_) { /* section stays with pending cards only */ }
    const hw = items.filter((i) => i.file.startsWith("hw_")).map(kitCard);
    hw.splice(Math.min(2, hw.length), 0, pendingCard(
      "HLK-LD2410C mmWave sensor",
      "24 GHz presence radar, one per zone. Detects people sitting still, which PIR sensors miss."));
    $("kit-hw").replaceChildren(...hw);
    $("kit-sw").replaceChildren(...items.filter((i) => i.file.startsWith("sw_")).map(kitCard));
  }

  async function init() {
    try {
      const res = await fetch("/api/rooms");
      if (res.ok) {
        const rooms = await res.json();
        sim.room = rooms.find((r) => r.id === "room101") || rooms[0] || FALLBACK_ROOM;
      }
    } catch (_) { /* keep fallback */ }
    initSim();
    initLive();
    initDownloads();
    initKit();
  }

  init();
})();
