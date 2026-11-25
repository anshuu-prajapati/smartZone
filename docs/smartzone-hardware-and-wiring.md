# SmartZone hardware, wiring and safety

## Bill of materials (one room, prototype)

| Part | Qty | Purpose |
|---|---|---|
| ESP32 DevKit V1 (38-pin) | 1 | Controller with Wi-Fi |
| HLK-LD2410C mmWave presence sensor | 4 (2 for a first test) | One per zone |
| 4-channel 5 V relay module, opto-isolated, with JD-VCC jumper | 1 | Lights and fans |
| 940 nm IR LED + 2N2222 transistor + 1 kΩ and 68 Ω resistors | 1 set | Sends AC commands |
| TSOP1838 IR receiver | 1 | Only for capturing the AC remote's protocol |
| 100 kΩ resistors | 4 | Pull-downs on sensor OUT pins |
| 5 V 2 A power adapter | 1 | Sensors and relays (a USB port is too weak for 4 relays) |
| LEDs + 220 Ω resistors | 4 | Stand-in loads for bench testing |
| Breadboard, jumpers, enclosure | — | Prototyping |
| Plug-in energy meter or PZEM-004T | 1 (optional) | Measuring a real load |

The team estimate is about ₹3,000–3,500 per room for electronics. Confirm against current
quotes before putting a number in the pitch. Electrician time for a permanent install is
extra.

## Pin map (matches `firmware/smartzone/config.h`)

| Function | ESP32 pin | Notes |
|---|---|---|
| Zone A sensor OUT | GPIO 34 | Input-only pin; 100 kΩ to GND |
| Zone B sensor OUT | GPIO 35 | Input-only pin; 100 kΩ to GND |
| Zone C sensor OUT | GPIO 32 | 100 kΩ to GND |
| Zone D sensor OUT | GPIO 33 | 100 kΩ to GND |
| Relay IN1 – lights, front row (A+B) | GPIO 25 | |
| Relay IN2 – lights, back row (C+D) | GPIO 26 | |
| Relay IN3 – fans, left (A+C) | GPIO 27 | |
| Relay IN4 – fans, right (B+D) | GPIO 13 | GPIO 14 avoided: it pulses at boot |
| IR LED driver (2N2222 base via 1 kΩ) | GPIO 4 | |
| IR receiver OUT (capture only) | GPIO 15 | Not used by the main sketch |

If your room's circuits are different, change `CIRCUITS[]` in `config.h` **and** the
matching room in `backend/rooms.json`, in the same order.

## Wiring

**LD2410C (×4):** VCC → 5 V, GND → GND, OUT → sensor pin above. OUT is 3.3 V logic, so it
is safe for the ESP32. Add the 100 kΩ resistor from OUT to GND so an unplugged sensor reads
"empty" instead of floating.

**Relay module:** IN1–IN4 → relay pins above. Remove the JD-VCC jumper and power JD-VCC
from the 5 V adapter, and VCC from the ESP32's 3.3 V pin, so the coils are isolated from the
logic. Connect the grounds of the ESP32 and the adapter. Most modules switch ON with a LOW
input (`RELAY_ACTIVE_LOW = true`). If a module does not trigger reliably from 3.3 V, use
a 3.3 V-compatible module.

**IR transmitter:** GPIO 4 → 1 kΩ → 2N2222 base; emitter → GND; collector → IR LED
cathode; IR LED anode → 68 Ω → 5 V. Point the LED at the AC's receiver window, within about
5 m with a clear line of sight.

**Bench test with LEDs:** connect LEDs through 220 Ω resistors in place of the relay
inputs and set `RELAY_ACTIVE_LOW = false`.

## Setting up the AC protocol

1. Wire the TSOP1838: VS → 3.3 V, GND → GND, OUT → GPIO 15.
2. Open *File → Examples → IRremoteESP8266 → IRrecvDumpV2*, set `kRecvPin = 15`, and
   upload.
3. Press the AC remote's power button at the receiver. The Serial Monitor prints a line such
   as `Protocol : DAIKIN` and a decoded description of the state.
4. Put that protocol in `config.h` (`AC_PROTOCOL = decode_type_t::DAIKIN`) and upload
   SmartZone again.
5. Test: occupy a zone. The AC should turn on with a beep. Empty the room and wait for the
   off-delay, then confirm it turns off. If the protocol shows as `UNKNOWN`, `IRac` does
   not support that AC, and the firmware has no raw-code mode. Use a supported AC for the
   demo, or show AC control as roadmap and demonstrate lights and fans only.

## Placing and tuning sensors

- Mount each sensor at 1–1.5 m on a wall, or on the ceiling, pointing into its own zone.
- In the HLKRadarTool phone app (Bluetooth), set the maximum moving and stationary distance
  gates (0.75 m per gate) so the sensor sees only its zone. Moving people are detected
  farther away than still ones, so tune both settings.
- mmWave passes through thin wood, plastic and glass. Do not rely on a partition to block it.
- Ceiling fans and curtains can trigger detection. Lower the sensitivity of the gates where
  they are.

Follow the zone test in [the test plan](smartzone-test-plan.md) before connecting any
appliance.

## Mains safety (read before connecting appliances)

- **Lights and fans:** only the **live** wire goes through the relay's COM/NO contacts.
  Neutral and earth go straight through. Use an enclosed box with cable glands and strain
  relief, and have it checked by someone qualified before switching it on. Do not touch it
  while it is plugged in.
- Check relay ratings: a 10 A relay contact is fine for lights and fans, but fans and LED
  drivers have inrush and inductive loads, so stay well under the rating.
- **ACs:** never switch an AC through a relay or extension board. Use IR (this design). For
  central units, use a contactor rated for the compressor, installed by an electrician, with
  a minimum off-time.
- Permanent installation in a building must be done by a licensed electrician and approved
  by the facility owner.
