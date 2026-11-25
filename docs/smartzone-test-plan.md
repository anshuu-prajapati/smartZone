# SmartZone test plan

## 1. Automated tests

| Suite | Command (from repo root) | What it covers |
|---|---|---|
| Firmware logic | `g++ -std=c++17 -Wall -Wextra -I firmware/smartzone firmware/test/test_zone_logic.cpp -o zone_test && ./zone_test` | Off-delay, shared circuits, no flicker when people alternate zones, overrides, AC lockout, `millis()` wrap, boot state |
| Backend | `cd backend && pytest` | Device auth, report validation, settings round-trip and acknowledgement, admin key, energy baseline, gaps, hourly series, `rooms.json` validation |
| Audit tool | `pytest tools/audit` | Shared-circuit rule, off-delay, interval capping, money estimate, bad input |

## 2. Sensor zone test (one LD2410C + ESP32, about ₹1,000 of parts)

Goal: prove that each sensor sees its own zone and not the neighbouring one, including
people sitting still.

1. Mark the zones on the floor with tape. Mount the sensor where it will be used.
2. Upload a two-line sketch that prints `digitalRead(34)` every 500 ms, or use the
   SmartZone serial log.
3. Run the checks below and record the results in the table in section 5.

| # | Action | Pass if |
|---|---|---|
| S1 | Sit still in the sensor's zone for 5 minutes (reading, typing) | Stays "present" the whole time |
| S2 | Sit still in the next zone for 5 minutes | Reads "clear" the whole time |
| S3 | Walk around in the next zone | Reads "clear" (moving people are detected farther away; tune the moving gates) |
| S4 | Walk slowly along the zone boundary | Changes state at the line, not 1–2 m into the next zone |
| S5 | Empty room, ceiling fan on high, 10 minutes | Reads "clear" |
| S6 | Empty room, person moving behind a thin partition | Note the result (mmWave passes through thin materials) |

If S2, S3 or S5 fail, reduce the maximum distance gate or the sensitivity in HLKRadarTool
and repeat.

## 3. Bench tests (ESP32, LEDs or relays, no mains)

Set the off-delay to 30 s from the dashboard to make the tests quicker.

| # | Test | Pass if |
|---|---|---|
| B1 | Power on with the room empty | All outputs off; dashboard shows a `boot` report |
| B2 | Sit in zone A | Front lights, left fans and AC turn on; others stay off |
| B3 | Move from A to B | Front lights never flicker (shared A+B); left fans off after the delay; right fans on |
| B4 | Leave the room | Everything off after the off-delay |
| B5 | Return within 3 minutes of the AC switching off | Lights and fans on at once; AC waits for its 3-minute lockout |
| B6 | Turn off Wi-Fi / stop the backend, then repeat B2–B4 | Switching is unchanged; dashboard shows offline |
| B7 | Restore Wi-Fi | Device reports within 5–30 s; energy chart shows the outage as lower coverage, not as usage |
| B8 | Dashboard: set the front lights to Off while zone A is occupied | Lights off at the next report (≤ 30 s, usually at once); "applied on device" appears |
| B9 | Reboot the ESP32 while the backend is down | Comes back with the last off-delay and overrides from flash |
| B10 | Change the off-delay in the dashboard | Device applies it; serial log prints `[cfg] applied` |
| B11 | Unplug one sensor | That zone reads empty (pull-down working), not random |

## 4. Real appliance tests (enclosed test box, checked by a qualified person)

| # | Test | Pass if |
|---|---|---|
| A1 | Table lamp on relay 1, sit in zone A for 10 minutes | Stays on, no chatter |
| A2 | Table fan on relay 3, leave the room | Off after the delay; relay switches cleanly |
| A3 | Split AC via IR | Turns on with a beep when occupied, off after the delay, and respects the 3-minute lockout |
| A4 | ESP32 resets when relays click? | Must not happen. If it does, the power supply is too weak or ground is shared badly |

## 5. Results log

| Date | Test # | Result | Notes / tuning changes |
|---|---|---|---|
| | | | |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Sensor always reads present | Range or sensitivity too high; fan or curtain in view |
| ESP32 resets when relays click | Weak supply; use the 5 V 2 A adapter with JD-VCC isolation |
| Never connects to Wi-Fi | ESP32 supports 2.4 GHz only |
| Backend logs 401 | `DEVICE_KEY` in `secrets.h` does not match `SMARTZONE_DEVICE_KEY` |
| Backend logs 422 | Zone or circuit count in `config.h` does not match `rooms.json` |
| ESP32 cannot reach backend | Laptop firewall blocks port 8000; ESP32 and laptop on different networks; started without `--host 0.0.0.0` |
| AC does not respond | Wrong `AC_PROTOCOL`; IR LED not aimed at the receiver; LED wired backwards |
