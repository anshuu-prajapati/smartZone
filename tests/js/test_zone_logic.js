// Runs the same scenarios as firmware/test/test_zone_logic.cpp against the
// browser port (backend/static/assets/zone-logic.js), so the prototype on the
// portal is proven to behave like the firmware.
//   node tests/js/test_zone_logic.js
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");

global.window = global;
require(path.join(__dirname, "../../backend/static/assets/zone-logic.js"));
const { ZoneController } = global.SZ;

const DEFS = [
  { zones: [0, 1], minOffMs: 0 },        // 0 lights front
  { zones: [2, 3], minOffMs: 0 },        // 1 lights back
  { zones: [0, 2], minOffMs: 0 },        // 2 fans left
  { zones: [1, 3], minOffMs: 0 },        // 3 fans right
  { zones: [0, 1, 2, 3], minOffMs: 10000 }, // 4 AC
];
const make = (delay) => new ZoneController(DEFS, 4, delay);
const P = (...zones) => [0, 1, 2, 3].map((z) => zones.includes(z));

const tests = {
  "first update puts every output into a known state"() {
    const c = make(10000);
    assert.deepEqual(c.update(P(), 0), [0, 1, 2, 3, 4]);
    assert.deepEqual(c.update(P(), 100), []);
  },
  "zone stays on for the off-delay after the person leaves"() {
    const c = make(10000);
    c.update(P(0), 0);
    c.update(P(), 9999);
    assert.equal(c.on[0], true);
    assert.ok(c.update(P(), 10000).includes(0));
    assert.equal(c.on[0], false);
  },
  "a person in zone C turns on only circuits serving C"() {
    const c = make(10000);
    c.update(P(2), 0);
    assert.deepEqual(c.on, [false, true, true, false, true]);
  },
  "shared circuit waits for every zone it serves"() {
    const c = make(10000);
    c.update(P(0, 1), 0);
    c.update(P(1), 1000);
    c.update(P(1), 21000);           // B last seen at t=21000
    assert.equal(c.on[0], true);
    c.update(P(), 21100);
    c.update(P(), 30999);
    assert.equal(c.on[0], true);
    c.update(P(), 31000);
    assert.equal(c.on[0], false);
  },
  "people alternating between two zones never flicker a shared circuit"() {
    const c = make(10000);
    c.update(P(0), 0);
    let toggles = 0;
    for (let t = 100; t <= 120000; t += 100) {
      if (c.update(Math.floor(t / 5000) % 2 === 0 ? P(0) : P(1), t).includes(0)) toggles++;
    }
    assert.equal(toggles, 0);
  },
  "overrides win over auto"() {
    const c = make(10000);
    c.update(P(0), 0);
    c.setMode(0, "off");
    c.update(P(0), 100);
    assert.equal(c.on[0], false);
    c.setMode(0, "auto");
    c.update(P(0), 200);
    assert.equal(c.on[0], true);
    c.setMode(1, "on");
    c.update(P(), 300);
    assert.equal(c.on[1], true);
  },
  "AC respects its minimum off time, even against an override"() {
    const c = make(1000);
    c.update(P(0), 0);
    c.update(P(), 1000);
    assert.equal(c.on[4], false);
    assert.equal(c.lockedOut[4], true);
    c.update(P(0), 2000);
    assert.equal(c.on[4], false);
    assert.equal(c.on[0], true);
    c.setMode(4, "on");
    c.update(P(0), 5000);
    assert.equal(c.on[4], false);
    c.setMode(4, "auto");
    c.update(P(0), 10999);
    assert.equal(c.on[4], false);
    c.update(P(0), 11000);
    assert.equal(c.on[4], true);
  },
  "zero off-delay switches off on the next empty reading"() {
    const c = make(0);
    c.update(P(3), 0);
    assert.equal(c.on[3], true);
    c.update(P(), 100);
    assert.equal(c.on[3], false);
  },
  "countdown helpers report remaining time"() {
    const c = make(10000);
    c.update(P(0), 0);
    c.update(P(), 4000);
    assert.equal(c.holdLeftS(0, 4000), 6);
    assert.equal(c.holdLeftS(1, 4000), null);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
if (failed) { console.log(`\n${failed} test(s) failed`); process.exit(1); }
console.log("\nall zone logic (JS port) tests passed");
