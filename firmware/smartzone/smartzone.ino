// SmartZone firmware: per-zone occupancy control for one room (ESP32).
//
// Design:
//  * loop() (core 1) reads the mmWave sensors every 100 ms, runs the zone logic
//    and drives relays / the AC. It never touches the network, so switching
//    keeps working when Wi-Fi or the backend is down.
//  * reportTask (core 0) sends the room state to the backend over HTTP: right
//    after any change, and as a full snapshot every 30 s. A lost report is
//    corrected by the next snapshot.
//  * The backend's reply carries the current settings (off-delay and per-circuit
//    overrides). They are applied by loop() and saved to flash, so they survive
//    a reboot even if the backend is unreachable at boot.
//
// Libraries (Arduino Library Manager):
//  * ESP32 board package by Espressif (3.x)
//  * ArduinoJson by Benoit Blanchon (7.x)
//  * IRremoteESP8266 by David Conran et al. (2.8.x)

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <IRremoteESP8266.h>
#include <IRac.h>

#include "secrets.h"
#include "config.h"
#include "zone_logic.h"

// ---- Control state (loop task only) -------------------------------------------
static sz::Controller controller;
static sz::CircuitDef circuitDefs[NUM_CIRCUITS];
static Preferences prefs;
static IRac irac(IR_LED_PIN);
static stdAc::state_t acLastSent;
static uint32_t appliedConfigVersion = 0;

// ---- State shared between loop() and reportTask, guarded by stateLock --------
struct Snapshot {
  uint16_t present;
  uint16_t active;
  uint16_t circuits;
  uint32_t configVersion;
};

struct PendingConfig {
  bool valid;
  uint32_t version;
  uint32_t offDelayS;
  sz::Mode modes[NUM_CIRCUITS];
};

static SemaphoreHandle_t stateLock = nullptr;
static Snapshot sharedSnapshot = {};
static PendingConfig pendingConfig = {};
static TaskHandle_t reportTaskHandle = nullptr;

// ---- Helpers ------------------------------------------------------------------
static const char* modeName(sz::Mode m) {
  switch (m) {
    case sz::Mode::ForceOn:
      return "on";
    case sz::Mode::ForceOff:
      return "off";
    default:
      return "auto";
  }
}

static sz::Mode parseMode(const char* s) {
  if (s != nullptr && strcmp(s, "on") == 0) return sz::Mode::ForceOn;
  if (s != nullptr && strcmp(s, "off") == 0) return sz::Mode::ForceOff;
  return sz::Mode::Auto;
}

static uint32_t clampDelay(uint32_t s) {
  if (s < MIN_OFF_DELAY_S) return MIN_OFF_DELAY_S;
  if (s > MAX_OFF_DELAY_S) return MAX_OFF_DELAY_S;
  return s;
}

static void driveRelay(int8_t pin, bool on) {
  // on XOR active-low: active-low modules need LOW to switch on.
  digitalWrite(pin, (on != RELAY_ACTIVE_LOW) ? HIGH : LOW);
}

static void sendAc(bool on) {
  stdAc::state_t st;
  IRac::initState(&st);
  st.protocol = AC_PROTOCOL;
  st.model = AC_MODEL;
  st.power = on;
  st.mode = stdAc::opmode_t::kCool;
  st.celsius = true;
  st.degrees = AC_SETPOINT_C;
  st.fanspeed = stdAc::fanspeed_t::kAuto;
  const bool ok = irac.sendAc(st, &acLastSent);
  acLastSent = st;
  Serial.printf("[ac] IR %s %s\n", on ? "ON" : "OFF", ok ? "sent" : "FAILED (check AC_PROTOCOL)");
}

static void applyOutputs(uint16_t changedMask) {
  for (uint8_t c = 0; c < NUM_CIRCUITS; c++) {
    if (!(changedMask & (1u << c))) continue;
    const bool on = controller.circuitOn(c);
    if (CIRCUITS[c].kind == KIND_RELAY) {
      driveRelay(CIRCUITS[c].pin, on);
    } else {
      sendAc(on);
    }
    Serial.printf("[ctl] circuit %u -> %s\n", c + 1, on ? "ON" : "OFF");
  }
}

static uint16_t readSensors() {
  uint16_t mask = 0;
  for (uint8_t z = 0; z < NUM_ZONES; z++) {
    if (digitalRead(SENSOR_PINS[z]) == HIGH) mask |= (uint16_t)(1u << z);
  }
  return mask;
}

// ---- Persistent settings ------------------------------------------------------
static void loadSettings() {
  prefs.begin("smartzone", false);
  const uint32_t delayS = clampDelay(prefs.getUInt("offDelayS", DEFAULT_OFF_DELAY_S));
  appliedConfigVersion = prefs.getUInt("cfgVer", 0);
  controller.setOffDelayMs(delayS * 1000UL);

  uint8_t stored[NUM_CIRCUITS];
  if (prefs.getBytesLength("modes") == NUM_CIRCUITS) {
    prefs.getBytes("modes", stored, NUM_CIRCUITS);
    for (uint8_t c = 0; c < NUM_CIRCUITS; c++) {
      controller.setMode(c, stored[c] <= 2 ? (sz::Mode)stored[c] : sz::Mode::Auto);
    }
  }
  Serial.printf("[cfg] off-delay %lus, config v%lu\n", (unsigned long)delayS,
                (unsigned long)appliedConfigVersion);
}

static void saveSettings() {
  uint8_t modes[NUM_CIRCUITS];
  for (uint8_t c = 0; c < NUM_CIRCUITS; c++) modes[c] = (uint8_t)controller.mode(c);
  prefs.putUInt("offDelayS", controller.offDelayMs() / 1000UL);
  prefs.putUInt("cfgVer", appliedConfigVersion);
  prefs.putBytes("modes", modes, NUM_CIRCUITS);
}

// Applies settings received by the report task. Returns true if anything changed.
static bool applyPendingConfig() {
  PendingConfig pc;
  xSemaphoreTake(stateLock, portMAX_DELAY);
  pc = pendingConfig;
  pendingConfig.valid = false;
  xSemaphoreGive(stateLock);

  if (!pc.valid || pc.version == appliedConfigVersion) return false;

  controller.setOffDelayMs(clampDelay(pc.offDelayS) * 1000UL);
  for (uint8_t c = 0; c < NUM_CIRCUITS; c++) controller.setMode(c, pc.modes[c]);
  appliedConfigVersion = pc.version;
  saveSettings();
  Serial.printf("[cfg] applied v%lu: off-delay %lus\n", (unsigned long)pc.version,
                (unsigned long)(controller.offDelayMs() / 1000UL));
  return true;
}

static void publishSnapshot() {
  xSemaphoreTake(stateLock, portMAX_DELAY);
  sharedSnapshot.present = controller.presentMask();
  sharedSnapshot.active = controller.activeMask();
  sharedSnapshot.circuits = controller.circuitMask();
  sharedSnapshot.configVersion = appliedConfigVersion;
  xSemaphoreGive(stateLock);
}

// ---- Reporting (core 0) -------------------------------------------------------
static void addBits(JsonArray arr, uint16_t mask, uint8_t count) {
  for (uint8_t i = 0; i < count; i++) arr.add(((mask >> i) & 1u) != 0);
}

static bool postReport(const char* reason, uint32_t seq) {
  Snapshot s;
  xSemaphoreTake(stateLock, portMAX_DELAY);
  s = sharedSnapshot;
  xSemaphoreGive(stateLock);

  JsonDocument doc;
  doc["room"] = ROOM_ID;
  doc["seq"] = seq;
  doc["uptime_ms"] = millis();
  doc["reason"] = reason;
  doc["config_version"] = s.configVersion;
  addBits(doc["present"].to<JsonArray>(), s.present, NUM_ZONES);
  addBits(doc["active"].to<JsonArray>(), s.active, NUM_ZONES);
  addBits(doc["circuits"].to<JsonArray>(), s.circuits, NUM_CIRCUITS);
  String body;
  serializeJson(doc, body);

  HTTPClient http;
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(String(SERVER_URL) + "/api/device/report")) return false;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_KEY);
  const int code = http.POST(body);
  if (code != 200) {
    Serial.printf("[report] failed: HTTP %d\n", code);
    http.end();
    return false;
  }
  const String resp = http.getString();
  http.end();

  JsonDocument cfg;
  if (deserializeJson(cfg, resp)) return true;  // report stored; ignore a bad reply
  JsonArray modes = cfg["modes"];
  if (modes.size() != NUM_CIRCUITS) return true;

  PendingConfig pc = {};
  pc.valid = true;
  pc.version = cfg["version"].as<uint32_t>();
  pc.offDelayS = cfg["off_delay_s"] | DEFAULT_OFF_DELAY_S;
  for (uint8_t c = 0; c < NUM_CIRCUITS; c++) pc.modes[c] = parseMode(modes[c] | "auto");

  xSemaphoreTake(stateLock, portMAX_DELAY);
  pendingConfig = pc;
  xSemaphoreGive(stateLock);
  return true;
}

static void reportTask(void*) {
  uint32_t seq = 0;
  bool bootSent = false;
  const char* reason = "boot";
  for (;;) {
    bool ok = false;
    if (WiFi.status() == WL_CONNECTED) {
      ok = postReport(bootSent ? reason : "boot", seq++);
      if (ok) bootSent = true;
    }
    // Wake early when loop() signals a change; otherwise send a snapshot.
    const uint32_t notified =
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(ok ? SNAPSHOT_INTERVAL_MS : RETRY_INTERVAL_MS));
    reason = notified ? "change" : "snapshot";
    if (notified) vTaskDelay(pdMS_TO_TICKS(MIN_REPORT_SPACING_MS));
  }
}

// ---- Arduino entry points -----------------------------------------------------
void setup() {
  Serial.begin(115200);
  Serial.printf("\nSmartZone %s: %u zones, %u circuits\n", ROOM_ID, NUM_ZONES, NUM_CIRCUITS);

  for (uint8_t c = 0; c < NUM_CIRCUITS; c++) {
    if (CIRCUITS[c].kind == KIND_RELAY) {
      pinMode(CIRCUITS[c].pin, OUTPUT);
      driveRelay(CIRCUITS[c].pin, false);
    }
    circuitDefs[c].zoneMask = CIRCUITS[c].zoneMask;
    circuitDefs[c].minOffMs = CIRCUITS[c].minOffMs;
  }
  for (uint8_t z = 0; z < NUM_ZONES; z++) pinMode(SENSOR_PINS[z], INPUT);

  IRac::initState(&acLastSent);
  acLastSent.protocol = AC_PROTOCOL;
  acLastSent.power = false;

  stateLock = xSemaphoreCreateMutex();
  controller.begin(circuitDefs, NUM_CIRCUITS, NUM_ZONES, DEFAULT_OFF_DELAY_S * 1000UL);
  loadSettings();
  publishSnapshot();

  // Non-blocking: the radio connects (and reconnects) in the background.
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  xTaskCreatePinnedToCore(reportTask, "report", 8192, nullptr, 1, &reportTaskHandle, 0);
}

void loop() {
  static uint32_t lastTick = 0;
  const uint32_t now = millis();
  if ((uint32_t)(now - lastTick) < LOOP_INTERVAL_MS) {
    delay(5);
    return;
  }
  lastTick = now;

  const bool configChanged = applyPendingConfig();
  const uint16_t prevPresent = controller.presentMask();
  const uint16_t prevActive = controller.activeMask();

  const uint16_t changed = controller.update(readSensors(), now);
  applyOutputs(changed);
  publishSnapshot();

  const bool stateChanged = changed != 0 || configChanged ||
                            controller.presentMask() != prevPresent ||
                            controller.activeMask() != prevActive;
  if (stateChanged && reportTaskHandle != nullptr) xTaskNotifyGive(reportTaskHandle);
}
