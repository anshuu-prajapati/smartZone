// PC unit tests for firmware/smartzone/zone_logic.h.
//
// Build and run from the repo root:
//   g++ -std=c++17 -Wall -Wextra -I firmware/smartzone firmware/test/test_zone_logic.cpp -o zone_test
//   ./zone_test

#include <cstdio>
#include <cstdlib>

#include "zone_logic.h"

static int failures = 0;

#define CHECK(cond)                                                    \
  do {                                                                 \
    if (!(cond)) {                                                     \
      std::printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);   \
      failures++;                                                      \
    }                                                                  \
  } while (0)

static const uint16_t Z0 = 1u << 0, Z1 = 1u << 1, Z2 = 1u << 2, Z3 = 1u << 3;

// Same layout as firmware/smartzone/config.h, with a 10 s AC lockout for speed.
static const sz::CircuitDef kDefs[] = {
    {Z0 | Z1, 0},            // 0 lights front
    {Z2 | Z3, 0},            // 1 lights back
    {Z0 | Z2, 0},            // 2 fans left
    {Z1 | Z3, 0},            // 3 fans right
    {Z0 | Z1 | Z2 | Z3, 10000},  // 4 AC
};
static const uint8_t kCircuits = 5;

static sz::Controller make(uint32_t offDelayMs) {
  sz::Controller c;
  c.begin(kDefs, kCircuits, 4, offDelayMs);
  return c;
}

static void test_first_update_reports_all_circuits() {
  std::puts("first update puts every output into a known state");
  auto c = make(10000);
  CHECK(c.update(0, 0) == 0x1F);
  CHECK(c.circuitMask() == 0);
  CHECK(c.update(0, 100) == 0);
}

static void test_off_delay() {
  std::puts("zone stays on for the off-delay after the person leaves");
  auto c = make(10000);
  c.update(Z0, 0);
  CHECK(c.circuitOn(0));
  c.update(0, 5000);
  CHECK(c.circuitOn(0));
  c.update(0, 9999);
  CHECK(c.circuitOn(0));
  const uint16_t changed = c.update(0, 10000);
  CHECK(!c.circuitOn(0));
  CHECK(changed & (1u << 0));
}

static void test_only_serving_circuits_turn_on() {
  std::puts("a person in zone C turns on only circuits serving C");
  auto c = make(10000);
  c.update(Z2, 0);
  CHECK(!c.circuitOn(0));  // lights front
  CHECK(c.circuitOn(1));   // lights back
  CHECK(c.circuitOn(2));   // fans left
  CHECK(!c.circuitOn(3));  // fans right
  CHECK(c.circuitOn(4));   // AC
}

static void test_shared_circuit_waits_for_all_zones() {
  std::puts("shared circuit stays on until every zone it serves is empty");
  auto c = make(10000);
  c.update(Z0 | Z1, 0);
  c.update(Z1, 1000);       // A leaves
  c.update(Z1, 20000);      // A long empty, B still present
  CHECK(c.circuitOn(0));
  c.update(0, 21000);       // B leaves
  c.update(0, 30999);
  CHECK(c.circuitOn(0));
  c.update(0, 31000);
  CHECK(!c.circuitOn(0));
}

static void test_alternating_occupancy_never_flickers() {
  std::puts("people alternating between two zones of a shared circuit: no flicker");
  auto c = make(10000);
  c.update(Z0, 0);
  int toggles = 0;
  for (uint32_t t = 100; t <= 120000; t += 100) {
    const uint16_t present = ((t / 5000) % 2 == 0) ? Z0 : Z1;
    if (c.update(present, t) & (1u << 0)) toggles++;
  }
  CHECK(toggles == 0);
  CHECK(c.circuitOn(0));
}

static void test_overrides() {
  std::puts("dashboard overrides win over auto");
  auto c = make(10000);
  c.update(Z0, 0);
  c.setMode(0, sz::Mode::ForceOff);
  c.update(Z0, 100);
  CHECK(!c.circuitOn(0));
  c.setMode(0, sz::Mode::Auto);
  c.update(Z0, 200);
  CHECK(c.circuitOn(0));
  c.setMode(1, sz::Mode::ForceOn);
  c.update(0, 300);
  CHECK(c.circuitOn(1));
}

static void test_ac_min_off_time() {
  std::puts("AC respects its minimum off time");
  auto c = make(1000);
  c.update(Z0, 0);
  CHECK(c.circuitOn(4));
  c.update(0, 1000);  // off-delay elapsed -> AC off at t=1000
  CHECK(!c.circuitOn(4));
  CHECK(c.lockedOut(4));
  c.update(Z0, 2000);  // person returns, still locked out
  CHECK(!c.circuitOn(4));
  CHECK(c.circuitOn(0));  // lights are not locked
  c.setMode(4, sz::Mode::ForceOn);
  c.update(Z0, 5000);  // override cannot bypass compressor protection
  CHECK(!c.circuitOn(4));
  c.setMode(4, sz::Mode::Auto);
  c.update(Z0, 10999);
  CHECK(!c.circuitOn(4));
  c.update(Z0, 11000);
  CHECK(c.circuitOn(4));
}

static void test_millis_wraparound() {
  std::puts("millis() wrap-around does not break the off-delay");
  auto c = make(10000);
  const uint32_t start = 0xFFFFFFFFu - 3000u;
  c.update(Z0, start);
  c.update(0, start + 5000u);  // wrapped
  CHECK(c.circuitOn(0));
  c.update(0, start + 10000u);
  CHECK(!c.circuitOn(0));
}

static void test_zero_delay() {
  std::puts("zero off-delay switches off on the next empty reading");
  auto c = make(0);
  c.update(Z3, 0);
  CHECK(c.circuitOn(3));
  c.update(0, 100);
  CHECK(!c.circuitOn(3));
}

int main() {
  test_first_update_reports_all_circuits();
  test_off_delay();
  test_only_serving_circuits_turn_on();
  test_shared_circuit_waits_for_all_zones();
  test_alternating_occupancy_never_flickers();
  test_overrides();
  test_ac_min_off_time();
  test_millis_wraparound();
  test_zero_delay();
  if (failures) {
    std::printf("\n%d check(s) failed\n", failures);
    return EXIT_FAILURE;
  }
  std::puts("\nall zone logic tests passed");
  return EXIT_SUCCESS;
}
