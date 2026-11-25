# SmartZone: power only where people are

*Project submission write-up*

> Fill in every **[bracketed]** item before submitting. They are left blank on purpose:
> they must come from your own audit, quotes or cited sources, not from estimates.

## 1. Problem

In classrooms, libraries, labs and offices, lights, fans and ACs run across the whole room
even when people sit in only one part of it. A 60-seat hall with 15 students, or a library
at 9 a.m., has every row lit and every fan running. Switches control a whole room or a whole
row, and nobody walks across to switch off the empty side.

- **Who pays:** schools, colleges and offices, through their electricity bills, and
  institutions with sustainability targets.
- **Why it matters:** lighting and cooling are the largest electricity loads in these
  buildings, and partly-occupied rooms are the normal case, not an exception.
- **How big:** in our one-week walk-through audit of **[N]** rooms, **[X]%** of appliance
  running time was over empty zones (see the method in
  [smartzone-savings-method.md](smartzone-savings-method.md)). **[Add one cited external
  source for building energy waste, or leave this line out.]**

## 2. Solution

SmartZone divides a room into zones, for example four quadrants. Each zone has a 24 GHz
mmWave presence sensor. A small ESP32 controller switches on the lights, fans and AC
serving a zone only while someone is in it, and switches them off a few minutes after it
empties.

**Flow:** a person sits down → the zone's mmWave sensor detects them, even sitting still →
the ESP32 marks the zone active → the light row and fans over that zone switch on through
relays, and the AC turns on with an IR command → the zone empties → a 3-minute timer runs,
so nothing flickers → the appliances switch off → the dashboard logs the event and the
energy.

### Key engineering decisions

| Decision | Why |
|---|---|
| mmWave (HLK-LD2410C) instead of PIR | PIR sensors see motion only and switch off on people reading or typing; mmWave detects the small movements of breathing |
| Shared-circuit rule | Existing light rows and ACs usually serve several zones. A circuit switches off only when every zone it serves is empty, so no rewiring is needed to start |
| AC by IR, full state, 3-minute lockout | Cutting compressor power with a relay damages ACs. IR uses the AC's own remote protocol, and sending the full state means a missed command can't invert it |
| Control logic on the device | Switching never depends on Wi-Fi or a server |
| Conservative savings baseline | Savings are reported against ordinary room switches used perfectly, not against everything on all day |

## 3. Architecture

ESP32 + sensors + relays + IR LED in each room → HTTP → FastAPI + SQLite server → web
dashboard with live zones, manual overrides, off-delay setting and energy charts. Details:
[smartzone-architecture.md](smartzone-architecture.md).

## 4. What is built

| Part | Status |
|---|---|
| ESP32 firmware: zone logic, relays, IR AC, non-blocking reporting, settings saved in flash | Written; logic unit-tested on a PC; **[hardware-tested on: date]** |
| Backend API, database, energy accounting | Written; automated test suite passing |
| Dashboard | Written; served by the backend; works without internet |
| Audit calculator | Written and tested |
| Hardware prototype | **[status / photos]** |

## 5. Innovation

1. **Zones within a room.** Most products switch a whole room on or off. SmartZone switches
   parts of a room.
2. **Detects people sitting still,** which PIR-based room sensors miss.
3. **Works with existing wiring** through the shared-circuit rule, and with existing split
   ACs through IR.
4. **Edge-first:** keeps working without internet or a server.
5. **No cameras:** radar presence only, which protects privacy.
6. **Open source** and maintainable by the institution's own staff.

## 6. Existing solutions and how SmartZone differs

| | Enterprise lighting/HVAC platforms (e.g. Siemens Enlighted) | Room PIR sensors | Consumer mmWave (e.g. Aqara FP2) | SmartZone |
|---|---|---|---|---|
| Granularity | Per fixture | Whole room | Zones, but home-oriented | Zones within a room |
| Still-person detection | Varies | Poor | Yes | Yes (mmWave) |
| AC control | Through the building system | Usually none | Through a smart-home hub | Direct IR to any supported split AC |
| Install | Fixture replacement, enterprise contract | Simple | Needs a hub and smart switches | Retrofit onto existing circuits |
| Works offline | Varies | Yes | Hub-dependent | Yes |

**Prior art to address:** Indian patent application 202441092013 describes occupancy-based
control of classroom fans, lights, ACs and water. Read it and state clearly how SmartZone
differs (zones within a room, the shared-circuit rule, still-person radar, IR AC control,
open source). **[Fill in after reading.]**

References to check before citing (from early research; verify each one):
Siemens Enlighted catalogue and press release; 9to5Mac and Home Assistant community posts on
the Aqara FP2; BuildTrack wireless occupancy sensors; TRUEiSENSE; patent 202441092013;
Presense² (James Dyson Award 2025); 75F (Entrepreneur India).

## 7. Impact and cost

**Cost per room:** about **[₹ from current quotes]** for electronics (team estimate:
₹3,000–3,500), plus electrician time for a permanent install.

**Savings:** use the achievable figure from the audit tool:

```
monthly saving (₹) = achievable kWh/month × tariff (₹/kWh)
payback (months)   = cost per room ÷ monthly saving
CO₂ avoided (kg)   = kWh saved × grid emission factor
```

| Item | Value |
|---|---|
| Achievable saving per room | **[Y] kWh/month** (from audit) |
| Tariff | **[₹/kWh from the institution's bill]** |
| Monthly saving | **[₹]** |
| Payback | **[months]** |
| Grid emission factor | **[kg CO₂/kWh, cite the CEA CO₂ baseline database]** |
| CO₂ avoided per room per year | **[kg]** |

**Other benefits:** longer lamp and fan life, and real room-usage data that helps with
timetable and space planning.

## 8. Limitations (stated openly)

- Sensors measure distance, not left/right position, so zone edges depend on mounting
  position and tuning (see the sensor zone test in the test plan).
- Turning one AC off in an open room saves less than its full rating, because the other
  units work harder. Savings figures use measured or duty-adjusted watts.
- IR is one-way: the controller cannot confirm the AC received the command. Sending the
  full state limits the damage from a missed command.
- Savings shown before installation are estimates from an audit and nameplate ratings, not
  metered values.

## 9. Roadmap

1. Pilot in one room for a week with a sub-meter.
2. Per-circuit current sensing to measure real kWh and catch stuck relays.
3. Timetable-aware pre-cooling (turn the AC on 10 minutes before a scheduled class).
4. Campus dashboard across many rooms; PostgreSQL; per-device keys and HTTPS.
5. Evaluate position-tracking radar (HLK-LD2450) to cover several zones with one sensor,
   after confirming it detects seated people reliably.

## 10. What we need

**[Pilot room access, electrician support, hardware budget, mentorship: choose what
applies.]**
