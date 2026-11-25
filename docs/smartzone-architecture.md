# SmartZone architecture

## Overview

```
 ROOM (edge)                                   SERVER (laptop / campus PC)          BROWSER
┌───────────────────────────────────────┐     ┌─────────────────────────────┐     ┌──────────────┐
│ LD2410C ×4 ──► ESP32                  │     │ FastAPI                     │     │ Dashboard    │
│ (one per zone)  │                     │HTTP │  /api/device/report  ◄──────┼─────│ live zones   │
│                 ├─► relays: lights,   │────►│  settings in reply ─────────┼──┐  │ overrides    │
│                 │   fans (4 channels) │◄────│                             │  │  │ off-delay    │
│                 └─► IR LED: split AC  │     │ SQLite: reports, settings   │  │  │ energy chart │
│ zone logic runs here; works offline   │     │ energy accounting           │◄─┴──│              │
└───────────────────────────────────────┘     └─────────────────────────────┘     └──────────────┘
```

## Edge: ESP32 firmware

Two FreeRTOS tasks, so the network can never delay switching:

| Task | Core | Job |
|---|---|---|
| `loop()` | 1 | Every 100 ms: read sensors → zone logic → drive relays / send IR. Applies new settings and stores them in flash. Never touches the network. |
| `reportTask` | 0 | Posts the room state to the backend immediately after a change and as a full snapshot every 30 s; retries every 5 s after a failure. HTTP connect/read timeouts are 3 s. |

They share a small snapshot struct and a pending-config struct guarded by a FreeRTOS mutex.
Wi-Fi connects and reconnects in the background (`WiFi.setAutoReconnect`), and `setup()`
never waits for it.

### Zone logic (`zone_logic.h`)

- **Zone active** = sensor reports presence now, or did so within the off-delay (default
  180 s, adjustable 30–1800 s from the dashboard).
- **Circuit** = one switched load: a relay channel or the AC. Each circuit lists the zones
  it serves. In Auto mode it is ON while any of its zones is active, so a shared light row
  switches off only when every zone under it is empty.
- **Overrides** per circuit: Auto / On / Off, set from the dashboard and saved on the
  device.
- **AC lockout:** after the AC is switched off it cannot be switched on again for
  3 minutes, even by an override, which protects the compressor.
- On boot, every output is driven to the computed state once, so the hardware is in a known
  state.
- All timing uses unsigned `millis()` differences, so the 49-day counter wrap-around is safe.

The header has no Arduino dependencies. `firmware/test/test_zone_logic.cpp` tests it on a PC.

### AC over IR

`IRremoteESP8266`'s `IRac` class sends the AC's complete state (power, cool mode, 24 °C,
auto fan) in the remote's own protocol. Because the whole state is sent, a missed command
cannot leave the AC in the opposite state, which can happen with a single power-toggle code.

## Device ↔ server protocol

`POST /api/device/report` with header `X-Device-Key`:

```json
{
  "room": "room101",
  "seq": 42,
  "uptime_ms": 360000,
  "reason": "change",
  "config_version": 3,
  "present":  [true, false, false, false],
  "active":   [true, true, false, false],
  "circuits": [true, false, true, true, true]
}
```

- `present` = raw sensor reading; `active` = after the off-delay; `circuits` = outputs.
- `reason` is `boot`, `change` or `snapshot`.
- Reply: `{"off_delay_s": 180, "modes": ["auto", ...], "version": 4}`. The device applies
  the settings when `version` differs from the one it holds and reports the version back
  in `config_version`, so the dashboard can show "applied on device".

Settings changed while the device is offline are delivered on its next successful report.
Settings already on the device persist through reboots, so it works even if the server is
down at boot.

## Server: FastAPI + SQLite

| Module | Responsibility |
|---|---|
| `app/rooms.py` | Loads and validates `rooms.json` (zones, circuits, watts, duty factor) |
| `app/db.py` | `reports` and `room_settings` tables; one connection per operation (thread-safe) |
| `app/energy.py` | Used vs. baseline energy, coverage, hourly series |
| `app/main.py` | HTTP API and static dashboard |

### Energy accounting

- **Used:** for each interval between reports, the sum of `watts × duty` for circuits that
  were ON.
- **Baseline (room switch):** if any zone in the room was active, all circuits in the room
  count as ON; otherwise none do. This assumes people switch everything off the moment the
  room empties, which real rooms rarely do, so the savings shown are a conservative lower
  bound.
- **Gaps:** if two reports are more than 105 s apart (more than three missed 30 s
  snapshots), that interval counts in neither figure. It appears as lower data coverage.
- `duty` captures that AC compressors cycle (≈0.6–0.7 of nameplate). Replace it with a
  measured value when you have one.

## Dashboard

Plain HTML/CSS/JS in `backend/static/`, served by the same FastAPI process. It loads
nothing from the internet, so it works on an isolated hotspot. It polls status every 3 s,
the event log every 10 s and energy every 30 s.

## Security model (prototype)

- Device writes require a shared `X-Device-Key`.
- Dashboard writes require `X-Admin-Key` if `SMARTZONE_ADMIN_KEY` is set. Leave it empty
  only on a closed demo network.
- Plain HTTP on the LAN. For a campus deployment, put the server behind HTTPS and give each
  device its own key.

## Scaling to a campus

Add rooms to `rooms.json` (one ESP32 per room, each with its own `ROOM_ID`). The server is
stateless apart from SQLite. Switch to PostgreSQL once there are many rooms or several
servers.
