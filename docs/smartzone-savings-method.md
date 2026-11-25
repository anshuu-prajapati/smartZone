# How SmartZone measures savings

Two measurements, used for different purposes:

1. **Before installation:** a walk-through audit shows how much energy real rooms waste
   over empty zones today. It costs nothing and gives the figure for the pitch.
2. **After installation:** the dashboard measures what SmartZone used compared with a
   room-switch baseline.

Neither one compares against "everything on 24 hours a day". That comparison makes any
system look like it saves 80–90% and does not survive questioning.

## 1. Walk-through audit (no hardware)

### Procedure

1. Pick 2–3 typical rooms (a classroom, a library section, a lab) and sketch each one's
   zones and switch circuits. Enter them in `backend/rooms.json` (zones, which zones each
   circuit serves, nameplate watts).
2. For one week, visit each room about 10 times a day, at varied times during working
   hours. At each visit, note:
   - which zones have at least one person;
   - which circuits (light rows, fan groups, ACs) are on.
3. Walk past as part of a normal route rather than standing in the door with a clipboard.
   If people notice they are being watched, they switch things off and the audit
   understates the waste.
4. Fill in `tools/audit/audit_template.csv` with one row per visit:

   ```
   date,time,room,occupied,on
   2026-12-01,09:10,room101,1 2,1 2 3 4 5
   2026-12-01,10:05,room101,,1 3 5
   ```

   Zones and circuits are numbered from 1, in the same order as `rooms.json`. A blank cell
   means none.

5. Run:

   ```bash
   python tools/audit/audit_calc.py my_audit.csv --off-delay 180 --tariff 8 --days-per-month 25
   ```

### What the tool reports

- **Waste share:** of the appliance-observations that were ON, the share running over zones
  where nobody sat. It applies the shared-circuit rule: a light row over zones A and B counts
  as wasted only if both A and B were empty, because SmartZone could not switch it off
  otherwise.
- **Wasted energy:** time-weighted, using `watts × duty`. Each visit is assumed to hold until
  the next visit that day, capped at 60 minutes.
- **Achievable saving:** wasted runs shortened by the off-delay, because SmartZone waits that
  long before switching off. This is the number to use as "what SmartZone would save".
- kWh per day and month, and rupees per month at your tariff.

### Watts and duty

- Use nameplate watts from the fittings: tube lights, LED panels, fan labels, AC rating.
- **AC compressors cycle**, so the average draw is below nameplate. The default
  `duty: 0.65` is an estimate. Replace it with one clamp-meter reading or a sub-meter
  reading over an hour.
- Fans on low speed draw less than nameplate. Lower their duty if they usually run slow.

### How to present it

> "In a one-week audit of N rooms, X% of appliance running time was over empty zones. With
> a 3-minute off-delay, SmartZone could have avoided about Y kWh per room per month (about
> ₹Z), estimated from nameplate ratings."

Call it a measured waste share and an estimated energy figure. If you borrow a clamp meter
or can read the room's kWh meter for a week before and after, add that measured number
alongside.

## 2. Live measurement (with SmartZone installed)

The dashboard's **Energy** panel shows:

| Figure | Meaning |
|---|---|
| Used | Σ (`watts × duty`) of circuits that were ON, over time |
| Room-switch baseline | The same room with ordinary switches: every circuit on whenever any zone is occupied, off the moment the room is empty |
| Saved | Baseline − used (can be negative if overrides keep things on in an empty room) |
| Data coverage | Share of the window with reports from the device; gaps are excluded, not guessed |

The baseline assumes people switch everything off as soon as the room empties. Real rooms
are often left on, so the saving shown is a **lower bound**. The audit captures the extra
waste from rooms left on.

For the strongest evidence, put a plug-in energy meter on one test load (a lamp or fan) and
compare one day with SmartZone against one day of normal use over the same hours.
