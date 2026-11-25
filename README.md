# SmartZone: occupancy-based, per-zone appliance control

SmartZone switches lights, fans and air conditioning on only in the parts of a room where
people are sitting, and switches empty zones off after a short delay. A classroom with
15 students in one corner no longer runs every light, fan and AC in the room.

- **Per-zone presence** with 24 GHz mmWave sensors (HLK-LD2410C), which detect people
  sitting still, unlike PIR motion sensors.
- **Shared-circuit aware:** a light row or AC that serves several zones switches off only
  when every zone it serves is empty, so it works with existing room wiring.
- **Runs locally:** all switching logic is on the ESP32. Wi-Fi or server outages do not
  stop it.
- **Safe AC control:** split ACs are controlled with their own IR remote protocol (full
  state, never a power toggle), with a 3-minute compressor lockout. No relay ever cuts an
  AC compressor.
- **Honest savings:** the dashboard compares usage against a room-switch baseline
  (everything on whenever anyone is in the room), not against "everything on all day",
  and leaves out periods with no data instead of guessing.
- **No cameras.**

## Repository layout

```
firmware/smartzone/      ESP32 sketch (Arduino IDE)
  smartzone.ino          sensors, relays, IR, reporting task
  zone_logic.h           pure C++ zone/circuit logic (unit-tested on a PC)
  config.h               pins, zones, circuits, timing for one room
  secrets.h.example      Wi-Fi and server settings template
firmware/test/           PC unit tests for zone_logic.h
backend/                 FastAPI service + SQLite + dashboard
  app/                   API, storage, energy accounting
  static/                dashboard (plain HTML/CSS/JS, works offline)
  rooms.json             zones, circuits, watts per room
  tests/                 pytest suite
tools/audit/             walk-through audit calculator for measuring real waste
docs/                    architecture, hardware, test plan, savings method, submission
```

## Quick start

### 1. Backend and dashboard (any laptop on the same Wi-Fi as the ESP32)

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000
```

Open http://localhost:8000 for the dashboard and http://localhost:8000/docs for the API.

Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `SMARTZONE_DEVICE_KEY` | `change-me` | Shared key the ESP32 sends in `X-Device-Key` |
| `SMARTZONE_ADMIN_KEY` | empty | If set, dashboard changes require `X-Admin-Key` |
| `SMARTZONE_DB` | `backend/smartzone.db` | SQLite file |
| `SMARTZONE_ROOMS` | `backend/rooms.json` | Room definitions |

### 2. Firmware

1. Arduino IDE 2 → Boards Manager → install **esp32 by Espressif** (3.x).
2. Library Manager → install **ArduinoJson** (7.x) and **IRremoteESP8266** (2.8.x).
3. Copy `firmware/smartzone/secrets.h.example` to `secrets.h` and fill in Wi-Fi (2.4 GHz),
   the laptop's IP address and the device key.
4. Check pins, zones and circuits in `config.h`. They must match the room in
   `backend/rooms.json`.
5. Set `AC_PROTOCOL` from your AC remote (see [the hardware guide](docs/smartzone-hardware-and-wiring.md)).
6. Board: *ESP32 Dev Module* → Upload. Open the Serial Monitor at 115200 baud.

Wiring, bill of materials and mains safety: [docs/smartzone-hardware-and-wiring.md](docs/smartzone-hardware-and-wiring.md).

### 3. Tests

```bash
# backend + audit tool
cd backend && pip install -r requirements-dev.txt && pytest
cd .. && pytest tools/audit

# firmware logic (needs g++ or clang++)
g++ -std=c++17 -Wall -Wextra -I firmware/smartzone firmware/test/test_zone_logic.cpp -o zone_test && ./zone_test
```

## API

| Method | Path | Used by | Purpose |
|---|---|---|---|
| POST | `/api/device/report` | ESP32 | State report (on change and every 30 s); reply carries current settings |
| GET | `/api/rooms` | Dashboard | Room, zone and circuit definitions |
| GET | `/api/rooms/{room}/status` | Dashboard | Live zones, circuits, online status, settings |
| PUT | `/api/rooms/{room}/config` | Dashboard | `{"off_delay_s": 30-1800}` |
| PUT | `/api/rooms/{room}/circuits/{i}/mode` | Dashboard | `{"mode": "auto" \| "on" \| "off"}` manual override |
| GET | `/api/rooms/{room}/energy?hours=24` | Dashboard | Used vs. room-switch baseline, coverage, hourly series |
| GET | `/api/rooms/{room}/events?limit=50` | Dashboard | Recent device reports |
| GET | `/api/health` | Anyone | Liveness check |

## Measuring real savings

Before any hardware is installed, run a one-week walk-through audit and calculate the
real waste with `tools/audit/audit_calc.py`. See [docs/smartzone-savings-method.md](docs/smartzone-savings-method.md).

## Safety

Mains wiring must be done or checked by a qualified electrician. Never switch an AC
compressor with a relay: use IR control (as here) or a rated contactor with a minimum
off-time.

## Documentation

- [Architecture](docs/smartzone-architecture.md)
- [Hardware, wiring and safety](docs/smartzone-hardware-and-wiring.md)
- [Test plan](docs/smartzone-test-plan.md)
- [Savings measurement method](docs/smartzone-savings-method.md)
- [Project submission write-up](docs/smartzone-submission.md)

## License

MIT, see [LICENSE](LICENSE).
