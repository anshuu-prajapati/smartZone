#pragma once
// SmartZone hardware configuration for ONE room.
//
// The zone and circuit order here MUST match the same room in
// backend/rooms.json. The backend rejects reports whose zone or circuit
// counts do not match.

#include <IRremoteESP8266.h>

// ---- Room -------------------------------------------------------------------
#define ROOM_ID "room101"

// ---- Zones: one HLK-LD2410C OUT pin per zone --------------------------------
// GPIO 34/35 are input-only and have no internal pull-down: fit a 100 kOhm
// resistor from each sensor OUT pin to GND so an unplugged sensor reads "empty".
static const uint8_t NUM_ZONES = 4;
static const uint8_t SENSOR_PINS[NUM_ZONES] = {34, 35, 32, 33};  // A, B, C, D

// ---- Circuits ---------------------------------------------------------------
// A circuit is one thing the controller switches: a relay channel (lights or
// fans) or the split AC (sent over IR). zoneMask lists the zones it serves; a
// shared circuit stays on until ALL of its zones are empty.
enum CircuitKind : uint8_t { KIND_RELAY = 0, KIND_IR_AC = 1 };

struct CircuitHw {
  CircuitKind kind;
  int8_t pin;         // relay input pin; -1 for IR circuits
  uint16_t zoneMask;  // bit z = serves zone z
  uint32_t minOffMs;  // compressor protection; 0 for lights and fans
};

#define ZONE(n) ((uint16_t)(1u << (n)))

static const uint32_t AC_MIN_OFF_MS = 3UL * 60UL * 1000UL;  // 3 minutes

// GPIO 14 is avoided because it outputs a PWM signal during boot, which can
// click a relay.
static const CircuitHw CIRCUITS[] = {
    {KIND_RELAY, 25, ZONE(0) | ZONE(1), 0},                      // 1 Lights, front row (A+B)
    {KIND_RELAY, 26, ZONE(2) | ZONE(3), 0},                      // 2 Lights, back row  (C+D)
    {KIND_RELAY, 27, ZONE(0) | ZONE(2), 0},                      // 3 Fans, left side   (A+C)
    {KIND_RELAY, 13, ZONE(1) | ZONE(3), 0},                      // 4 Fans, right side  (B+D)
    {KIND_IR_AC, -1, ZONE(0) | ZONE(1) | ZONE(2) | ZONE(3), AC_MIN_OFF_MS},  // 5 Split AC
};
static const uint8_t NUM_CIRCUITS = sizeof(CIRCUITS) / sizeof(CIRCUITS[0]);

// Most opto-isolated relay modules switch ON when the input is pulled LOW.
// Set to false when driving plain LEDs for bench tests.
static const bool RELAY_ACTIVE_LOW = true;

// ---- AC over IR ---------------------------------------------------------------
// Capture your remote with IRrecvDumpV2 (IRremoteESP8266 examples) and put the
// detected protocol here, e.g. decode_type_t::DAIKIN, decode_type_t::LG,
// decode_type_t::VOLTAS, decode_type_t::MIDEA, decode_type_t::COOLIX.
// The firmware sends the AC's full state (power, mode, setpoint, fan) each time,
// not a power-toggle code, so a missed command cannot leave it inverted.
static const uint8_t IR_LED_PIN = 4;
static const decode_type_t AC_PROTOCOL = decode_type_t::COOLIX;
static const int16_t AC_MODEL = -1;  // -1 = library default model
static const float AC_SETPOINT_C = 24.0f;

// ---- Timing -------------------------------------------------------------------
static const uint32_t DEFAULT_OFF_DELAY_S = 180;  // overridden by the dashboard
static const uint32_t MIN_OFF_DELAY_S = 30;
static const uint32_t MAX_OFF_DELAY_S = 1800;
static const uint32_t LOOP_INTERVAL_MS = 100;
static const uint32_t SNAPSHOT_INTERVAL_MS = 30000;  // full state even if nothing changed
static const uint32_t RETRY_INTERVAL_MS = 5000;      // after a failed report
static const uint32_t MIN_REPORT_SPACING_MS = 500;   // coalesce bursts of changes
static const uint32_t HTTP_TIMEOUT_MS = 3000;
