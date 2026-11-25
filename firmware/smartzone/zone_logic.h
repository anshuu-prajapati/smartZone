#pragma once
// SmartZone occupancy logic.
//
// Pure C++ with no Arduino dependencies, so the same code runs on the ESP32
// and in the PC unit test (firmware/test/test_zone_logic.cpp).
//
// Rules:
//  * A zone is "active" while its sensor reports presence, and for offDelayMs
//    after the last presence reading (prevents flicker when someone sits still
//    at the edge of the sensor's range or steps out briefly).
//  * A circuit (relay or AC) can serve several zones. In Auto mode it is ON
//    while ANY zone it serves is active, so a shared circuit switches off only
//    when every zone it serves is empty.
//  * Overrides (ForceOn / ForceOff) from the dashboard win over Auto.
//  * Circuits with minOffMs > 0 (AC compressors) stay off for at least
//    minOffMs after being switched off, even if a zone becomes active again
//    or an override asks for ON.
//  * All time arithmetic uses unsigned differences, so millis() wrap-around
//    (every ~49.7 days) is handled.

#include <stdint.h>

namespace sz {

constexpr uint8_t kMaxZones = 16;
constexpr uint8_t kMaxCircuits = 16;

enum class Mode : uint8_t { Auto = 0, ForceOn = 1, ForceOff = 2 };

struct CircuitDef {
  uint16_t zoneMask;  // bit z set => this circuit serves zone z
  uint32_t minOffMs;  // minimum off time before switching back on; 0 = none
};

class Controller {
 public:
  void begin(const CircuitDef* defs, uint8_t numCircuits, uint8_t numZones,
             uint32_t offDelayMs) {
    defs_ = defs;
    numCircuits_ = numCircuits > kMaxCircuits ? kMaxCircuits : numCircuits;
    numZones_ = numZones > kMaxZones ? kMaxZones : numZones;
    offDelayMs_ = offDelayMs;
    present_ = 0;
    active_ = 0;
    first_ = true;
    for (uint8_t z = 0; z < kMaxZones; z++) {
      seen_[z] = false;
      lastSeen_[z] = 0;
    }
    for (uint8_t c = 0; c < kMaxCircuits; c++) {
      on_[c] = false;
      lockedOut_[c] = false;
      offSince_[c] = 0;
      mode_[c] = Mode::Auto;
    }
  }

  void setOffDelayMs(uint32_t ms) { offDelayMs_ = ms; }
  uint32_t offDelayMs() const { return offDelayMs_; }

  void setMode(uint8_t c, Mode m) {
    if (c < numCircuits_) mode_[c] = m;
  }
  Mode mode(uint8_t c) const { return c < numCircuits_ ? mode_[c] : Mode::Auto; }

  // Feed the raw sensor readings (bit z = sensor z reports a person).
  // Returns a bitmask of circuits whose ON/OFF state changed; the caller
  // drives the hardware for those circuits. The first call after begin()
  // reports every circuit as changed so the hardware is put into a known
  // state.
  uint16_t update(uint16_t presentMask, uint32_t nowMs) {
    present_ = presentMask;
    active_ = 0;
    for (uint8_t z = 0; z < numZones_; z++) {
      const uint16_t bit = (uint16_t)(1u << z);
      if (presentMask & bit) {
        seen_[z] = true;
        lastSeen_[z] = nowMs;
      } else if (seen_[z] && (uint32_t)(nowMs - lastSeen_[z]) >= offDelayMs_) {
        seen_[z] = false;
      }
      if (seen_[z]) active_ |= bit;
    }

    uint16_t changed = 0;
    for (uint8_t c = 0; c < numCircuits_; c++) {
      if (lockedOut_[c] && (uint32_t)(nowMs - offSince_[c]) >= defs_[c].minOffMs) {
        lockedOut_[c] = false;
      }

      bool want;
      switch (mode_[c]) {
        case Mode::ForceOn:
          want = true;
          break;
        case Mode::ForceOff:
          want = false;
          break;
        default:
          want = (active_ & defs_[c].zoneMask) != 0;
          break;
      }
      if (want && !on_[c] && lockedOut_[c]) want = false;

      if (want != on_[c] || first_) {
        if (on_[c] && !want) {
          offSince_[c] = nowMs;
          lockedOut_[c] = defs_[c].minOffMs > 0;
        }
        on_[c] = want;
        changed |= (uint16_t)(1u << c);
      }
    }
    first_ = false;
    return changed;
  }

  bool circuitOn(uint8_t c) const { return c < numCircuits_ && on_[c]; }
  bool lockedOut(uint8_t c) const { return c < numCircuits_ && lockedOut_[c]; }

  uint16_t circuitMask() const {
    uint16_t m = 0;
    for (uint8_t c = 0; c < numCircuits_; c++)
      if (on_[c]) m |= (uint16_t)(1u << c);
    return m;
  }
  uint16_t presentMask() const { return present_; }
  uint16_t activeMask() const { return active_; }
  uint8_t numZones() const { return numZones_; }
  uint8_t numCircuits() const { return numCircuits_; }

 private:
  const CircuitDef* defs_ = nullptr;
  uint8_t numCircuits_ = 0;
  uint8_t numZones_ = 0;
  uint32_t offDelayMs_ = 0;
  uint16_t present_ = 0;
  uint16_t active_ = 0;
  bool first_ = true;

  bool seen_[kMaxZones] = {};
  uint32_t lastSeen_[kMaxZones] = {};

  bool on_[kMaxCircuits] = {};
  bool lockedOut_[kMaxCircuits] = {};
  uint32_t offSince_[kMaxCircuits] = {};
  Mode mode_[kMaxCircuits] = {};
};

}  // namespace sz
