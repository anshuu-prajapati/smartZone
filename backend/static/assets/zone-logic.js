"use strict";
// JavaScript port of firmware/smartzone/zone_logic.h. Same rules, same order of
// evaluation, so the browser prototype behaves exactly like the ESP32:
//  * a zone is active while present, and for offDelayMs after the last reading;
//  * a circuit in Auto is ON while any zone it serves is active;
//  * overrides ("on" / "off") win over Auto;
//  * circuits with minOffMs (AC) stay off at least that long after switching off.
(function (global) {
  class ZoneController {
    constructor(circuits, numZones, offDelayMs) {
      this.defs = circuits.map((c) => ({ zones: c.zones.slice(), minOffMs: c.minOffMs || 0 }));
      this.numZones = numZones;
      this.offDelayMs = offDelayMs;
      this.seen = new Array(numZones).fill(false);
      this.lastSeen = new Array(numZones).fill(0);
      this.present = new Array(numZones).fill(false);
      this.active = new Array(numZones).fill(false);
      this.on = new Array(circuits.length).fill(false);
      this.lockedOut = new Array(circuits.length).fill(false);
      this.offSince = new Array(circuits.length).fill(0);
      this.modes = new Array(circuits.length).fill("auto");
      this.first = true;
    }

    setMode(c, mode) { this.modes[c] = mode; }

    // present: array of booleans; returns array of changed circuit indexes.
    update(present, nowMs) {
      for (let z = 0; z < this.numZones; z++) {
        this.present[z] = !!present[z];
        if (present[z]) {
          this.seen[z] = true;
          this.lastSeen[z] = nowMs;
        } else if (this.seen[z] && nowMs - this.lastSeen[z] >= this.offDelayMs) {
          this.seen[z] = false;
        }
        this.active[z] = this.seen[z];
      }
      const changed = [];
      this.defs.forEach((d, c) => {
        if (this.lockedOut[c] && nowMs - this.offSince[c] >= d.minOffMs) this.lockedOut[c] = false;
        let want;
        if (this.modes[c] === "on") want = true;
        else if (this.modes[c] === "off") want = false;
        else want = d.zones.some((z) => this.active[z]);
        if (want && !this.on[c] && this.lockedOut[c]) want = false;
        if (want !== this.on[c] || this.first) {
          if (this.on[c] && !want) {
            this.offSince[c] = nowMs;
            this.lockedOut[c] = d.minOffMs > 0;
          }
          this.on[c] = want;
          changed.push(c);
        }
      });
      this.first = false;
      return changed;
    }

    // Seconds left on a zone's off-delay, or null if not counting down.
    holdLeftS(z, nowMs) {
      if (this.present[z] || !this.active[z]) return null;
      return Math.max(0, (this.offDelayMs - (nowMs - this.lastSeen[z])) / 1000);
    }

    lockLeftS(c, nowMs) {
      if (!this.lockedOut[c]) return null;
      return Math.max(0, (this.defs[c].minOffMs - (nowMs - this.offSince[c])) / 1000);
    }
  }

  global.SZ = global.SZ || {};
  global.SZ.ZoneController = ZoneController;
})(window);
