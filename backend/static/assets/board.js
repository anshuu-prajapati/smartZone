"use strict";
// Draws a room as a floor plan: AC on the front wall, one tile per zone with its
// light strip, desks and fan. Shared by the prototype and the live dashboard.
(function (global) {
  const FAN_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2.2" fill="currentColor"/>' +
    '<path d="M12 9.8c0-4 1.2-6.8 3.4-6.8 2 0 2.6 2.4.6 4.6-1.2 1.3-2.6 2-4 2.2zM14.2 12c4 0 6.8 1.2 6.8 3.4 0 2-2.4 2.6-4.6.6-1.3-1.2-2-2.6-2.2-4zM12 14.2c0 4-1.2 6.8-3.4 6.8-2 0-2.6-2.4-.6-4.6 1.2-1.3 2.6-2 4-2.2zM9.8 12c-4 0-6.8-1.2-6.8-3.4 0-2 2.4-2.6 4.6-.6 1.3 1.2 2 2.6 2.2 4z" fill="currentColor"/></svg>';

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children || []) if (c != null) node.append(c);
    return node;
  }

  function kindOf(circuit) {
    if (circuit.kind === "ir_ac") return "ac";
    if (/fan/i.test(circuit.name)) return "fan";
    return "light";
  }

  function fmtDuration(s) {
    s = Math.ceil(s);
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
  }

  // view = { present[], active[], circuits[], people[]?, holdLeft[]?, locked[]?, lockLeft[]? }
  function renderBoard(container, room, view, opts = {}) {
    const nz = room.zones.length;
    const kinds = room.circuits.map(kindOf);
    const servingOn = (z, kind) =>
      room.circuits.some((c, i) => kinds[i] === kind && c.zones.includes(z) && view.circuits[i]);

    const acUnits = room.circuits
      .map((c, i) => ({ c, i }))
      .filter(({ i }) => kinds[i] === "ac")
      .map(({ c, i }) => {
        const on = !!view.circuits[i];
        const locked = view.locked && view.locked[i];
        let state = on ? "ON" : "OFF";
        if (!on && locked) state = `LOCK ${fmtDuration(view.lockLeft[i])}`;
        return el("div", { class: `ac-unit ${on ? "on" : ""} ${!on && locked ? "locked" : ""}`, title: c.name }, [
          el("span", { class: "vent" }),
          el("span", { text: `AC ${state}` }),
        ]);
      });

    const tiles = room.zones.map((name, z) => {
      const present = !!view.present[z];
      const active = !!view.active[z];
      const hold = !present && active;
      const people = view.people ? view.people[z] : present ? 2 : 0;
      let state;
      if (present) state = el("span", { class: "pill pill-on", text: "Occupied" });
      else if (hold) {
        const left = view.holdLeft && view.holdLeft[z] != null ? ` ${fmtDuration(view.holdLeft[z])}` : "";
        state = el("span", { class: "pill pill-hold", text: `Off-delay${left}` });
      } else state = el("span", { class: "pill pill-off", text: "Empty" });

      const desks = el("div", { class: "zone-desks", "aria-hidden": "true" },
        Array.from({ length: 6 }, (_, k) => el("span", { class: `desk ${k < people ? "taken" : ""}` })));
      const fanOn = servingOn(z, "fan");
      const label = name.split(" ")[0];
      const children = [
        el("span", { class: `zone-light ${servingOn(z, "light") ? "on" : ""}`, "aria-hidden": "true" }),
        el("div", { class: "zone-head" }, [el("span", { class: "zone-name", text: `Zone ${label}` }), state]),
        desks,
        el("div", { class: "zone-foot" }, [
          el("span", { text: name.split(" ").slice(1).join(" ") || "" }),
          el("span", { class: `fan ${fanOn ? "on" : ""}`, title: fanOn ? "Fan on" : "Fan off", html: FAN_SVG }),
        ]),
      ];
      const cls = `zone ${present ? "present" : hold ? "hold" : ""}`;
      if (opts.onZoneClick) {
        return el("button", {
          type: "button", class: cls,
          "aria-pressed": present ? "true" : "false",
          "aria-label": `Zone ${label}: ${present ? "occupied" : hold ? "off-delay running" : "empty"}. Click to ${present ? "empty" : "seat people in"} this zone.`,
          onclick: () => opts.onZoneClick(z),
        }, children);
      }
      return el("div", { class: cls }, children);
    });

    const cols = Math.ceil(Math.sqrt(nz));
    const board = el("div", { class: "board" }, [
      el("div", { class: "board-wall" }, [el("span", { class: "label", text: opts.wallLabel || "Front wall · board" }), el("div", { style: "display:flex;gap:8px" }, acUnits)]),
      el("div", { class: "zones", style: `--cols:${cols}` }, tiles),
    ]);
    container.replaceChildren(board);
  }

  function renderCircuits(container, room, view, opts = {}) {
    const items = room.circuits.map((c, i) => {
      const on = !!view.circuits[i];
      const locked = !on && view.locked && view.locked[i];
      const zoneChips = room.zones.map((zn, z) =>
        c.zones.includes(z) ? el("span", { class: `chip ${view.active && view.active[z] ? "on" : ""}`, text: zn.split(" ")[0] }) : null);
      const meta = [
        el("span", { text: `${c.kind === "ir_ac" ? "AC via IR" : "Relay"} · ${c.watts} W · zones` }),
        ...zoneChips,
      ];
      if (locked) meta.push(el("span", { class: "pill pill-hold", text: `lockout ${fmtDuration(view.lockLeft[i])}` }));
      const children = [
        el("span", { class: `lamp ${on ? "on" : locked ? "locked" : ""}`, title: on ? "On" : "Off" }),
        el("div", {}, [
          el("div", { class: "circuit-name", text: `${c.name}` }),
          el("div", { class: "circuit-meta" }, meta),
        ]),
      ];
      if (opts.modes) {
        const seg = el("div", { class: "seg", role: "group", "aria-label": `Mode for ${c.name}` },
          ["auto", "on", "off"].map((m) =>
            el("button", {
              type: "button", "data-mode": m, class: opts.modes[i] === m ? "active" : "",
              "aria-pressed": opts.modes[i] === m ? "true" : "false",
              text: m === "auto" ? "Auto" : m === "on" ? "On" : "Off",
              onclick: () => opts.onMode && opts.onMode(i, m),
            })));
        children.push(seg);
      } else {
        children.push(el("span", { class: `pill ${on ? "pill-on" : "pill-off"}`, text: on ? "ON" : "OFF" }));
      }
      return el("div", { class: "circuit" }, children);
    });
    container.replaceChildren(...items);
  }

  global.SZ = global.SZ || {};
  Object.assign(global.SZ, { el, renderBoard, renderCircuits, fmtDuration, kindOf });
})(window);
