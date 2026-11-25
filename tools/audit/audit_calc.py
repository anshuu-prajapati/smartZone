"""SmartZone walk-through audit calculator (standard library only).

Turns hand-recorded room observations into:
  * waste share: of all appliance-observations that were ON, how many were
    running over zones where nobody was sitting (shared-circuit rule: a circuit
    counts as wasted only when EVERY zone it serves is empty);
  * estimated wasted energy, using the same watts x duty figures as the backend;
  * estimated achievable saving: wasted runs shortened by SmartZone's off-delay,
    because the controller waits that long before switching off.

Input CSV columns (see audit_template.csv):
  date        YYYY-MM-DD
  time        HH:MM (24 h)
  room        room id from rooms.json
  occupied    zones with at least one person, 1-based, space separated ("1 3"); blank = none
  on          circuits that were ON, 1-based, space separated ("1 2 5"); blank = none

Each observation is assumed to hold until the next observation of the same room
on the same day, capped at --max-interval minutes; the last observation of a day
counts for --last-interval minutes.

Usage:
  python tools/audit/audit_calc.py observations.csv
  python tools/audit/audit_calc.py observations.csv --off-delay 180 --tariff 8 --days-per-month 25 --json
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

DEFAULT_ROOMS = Path(__file__).resolve().parents[2] / "backend" / "rooms.json"


@dataclass
class Circuit:
    name: str
    zones: list[int]
    avg_watts: float


@dataclass
class Room:
    id: str
    zones: list[str]
    circuits: list[Circuit]


@dataclass
class Observation:
    when: datetime
    occupied: set[int]
    on: set[int]
    hours: float = 0.0


@dataclass
class RoomResult:
    room: str
    days: int = 0
    observations: int = 0
    observed_hours: float = 0.0
    on_count: int = 0
    wasted_count: int = 0
    on_wh: float = 0.0
    wasted_wh: float = 0.0
    achievable_wh: float = 0.0
    per_circuit_wasted_wh: dict[str, float] = field(default_factory=dict)

    def summary(self, days_per_month: float, tariff: float) -> dict:
        per_day_kwh = self.achievable_wh / 1000 / self.days if self.days else 0.0
        monthly_kwh = per_day_kwh * days_per_month
        return {
            "room": self.room,
            "days_observed": self.days,
            "observations": self.observations,
            "observed_hours": round(self.observed_hours, 1),
            "waste_share_by_count_pct": _pct(self.wasted_count, self.on_count),
            "waste_share_by_energy_pct": _pct(self.wasted_wh, self.on_wh),
            "energy_on_kwh": round(self.on_wh / 1000, 2),
            "energy_wasted_kwh": round(self.wasted_wh / 1000, 2),
            "energy_achievable_kwh": round(self.achievable_wh / 1000, 2),
            "achievable_kwh_per_day": round(per_day_kwh, 2),
            "achievable_kwh_per_month": round(monthly_kwh, 1),
            "achievable_rupees_per_month": round(monthly_kwh * tariff),
            "wasted_kwh_by_circuit": {k: round(v / 1000, 2) for k, v in self.per_circuit_wasted_wh.items()},
        }


def _pct(part: float, whole: float) -> float | None:
    return None if not whole else round(100.0 * part / whole, 1)


def load_rooms(path: Path) -> dict[str, Room]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    rooms = {}
    for r in data["rooms"]:
        circuits = [
            Circuit(c["name"], list(c["zones"]), float(c["watts"]) * float(c.get("duty", 1.0)))
            for c in r["circuits"]
        ]
        rooms[r["id"]] = Room(r["id"], list(r["zones"]), circuits)
    return rooms


def _indices(text: str, limit: int, what: str, line: int) -> set[int]:
    out = set()
    for tok in (text or "").replace(",", " ").split():
        n = int(tok)
        if not 1 <= n <= limit:
            raise ValueError(f"line {line}: {what} {n} is out of range 1..{limit}")
        out.add(n - 1)
    return out


def read_observations(path: Path, rooms: dict[str, Room]) -> dict[str, list[Observation]]:
    by_room: dict[str, list[Observation]] = defaultdict(list)
    with open(path, newline="", encoding="utf-8-sig") as f:
        for line, row in enumerate(csv.DictReader(f), start=2):
            if not any((v or "").strip() for v in row.values()):
                continue
            room_id = row["room"].strip()
            if room_id not in rooms:
                raise ValueError(f"line {line}: unknown room {room_id!r} (not in rooms.json)")
            room = rooms[room_id]
            when = datetime.strptime(f"{row['date'].strip()} {row['time'].strip()}", "%Y-%m-%d %H:%M")
            by_room[room_id].append(
                Observation(
                    when=when,
                    occupied=_indices(row["occupied"], len(room.zones), "zone", line),
                    on=_indices(row["on"], len(room.circuits), "circuit", line),
                )
            )
    return by_room


def assign_durations(obs: list[Observation], max_interval_min: float, last_interval_min: float) -> None:
    obs.sort(key=lambda o: o.when)
    for i, o in enumerate(obs):
        nxt = obs[i + 1] if i + 1 < len(obs) else None
        if nxt is not None and nxt.when.date() == o.when.date():
            minutes = min((nxt.when - o.when).total_seconds() / 60, max_interval_min)
        else:
            minutes = last_interval_min
        o.hours = minutes / 60


def analyse_room(room: Room, obs: list[Observation], off_delay_s: float) -> RoomResult:
    res = RoomResult(room=room.id, observations=len(obs))
    res.days = len({o.when.date() for o in obs})
    res.observed_hours = sum(o.hours for o in obs)
    res.per_circuit_wasted_wh = {c.name: 0.0 for c in room.circuits}
    off_delay_h = off_delay_s / 3600

    for ci, c in enumerate(room.circuits):
        run_h = 0.0
        run_day = None

        def close_run() -> None:
            nonlocal run_h
            res.achievable_wh += max(0.0, run_h - off_delay_h) * c.avg_watts
            run_h = 0.0

        for o in obs:
            if ci not in o.on:
                close_run()
                continue
            res.on_count += 1
            res.on_wh += c.avg_watts * o.hours
            wasted = not any(z in o.occupied for z in c.zones)
            if not wasted:
                close_run()
                continue
            if run_day is not None and o.when.date() != run_day:
                close_run()
            run_day = o.when.date()
            res.wasted_count += 1
            res.wasted_wh += c.avg_watts * o.hours
            res.per_circuit_wasted_wh[c.name] += c.avg_watts * o.hours
            run_h += o.hours
        close_run()
    return res


def run(
    csv_path: Path,
    rooms_path: Path = DEFAULT_ROOMS,
    off_delay_s: float = 180,
    max_interval_min: float = 60,
    last_interval_min: float = 30,
    tariff: float = 8.0,
    days_per_month: float = 25,
) -> list[dict]:
    rooms = load_rooms(rooms_path)
    by_room = read_observations(csv_path, rooms)
    results = []
    for room_id in sorted(by_room):
        obs = by_room[room_id]
        assign_durations(obs, max_interval_min, last_interval_min)
        results.append(analyse_room(rooms[room_id], obs, off_delay_s).summary(days_per_month, tariff))
    return results


def _print_text(results: list[dict], args: argparse.Namespace) -> None:
    print("SmartZone walk-through audit")
    print(f"  off-delay {args.off_delay:.0f} s, tariff Rs {args.tariff}/kWh, {args.days_per_month} days/month\n")
    for r in results:
        print(f"Room {r['room']}: {r['observations']} observations over {r['days_observed']} day(s), "
              f"{r['observed_hours']} h")
        print(f"  Waste share (appliances on over empty zones): "
              f"{r['waste_share_by_count_pct']}% of observations, {r['waste_share_by_energy_pct']}% of energy")
        print(f"  Energy while on: {r['energy_on_kwh']} kWh; over empty zones: {r['energy_wasted_kwh']} kWh")
        print(f"  Achievable with SmartZone (after off-delay): {r['energy_achievable_kwh']} kWh "
              f"= {r['achievable_kwh_per_day']} kWh/day")
        print(f"  Estimate: {r['achievable_kwh_per_month']} kWh/month, about Rs {r['achievable_rupees_per_month']}/month")
        for name, kwh in r["wasted_kwh_by_circuit"].items():
            print(f"    {name}: {kwh} kWh over empty zones")
        print()
    print("These are estimates from observations and nameplate x duty figures, not metered energy.")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("csv", type=Path, help="observations CSV")
    p.add_argument("--rooms", type=Path, default=DEFAULT_ROOMS, help="rooms.json (default: backend/rooms.json)")
    p.add_argument("--off-delay", type=float, default=180, help="SmartZone off-delay in seconds (default 180)")
    p.add_argument("--max-interval", type=float, default=60, help="cap per observation, minutes (default 60)")
    p.add_argument("--last-interval", type=float, default=30, help="last observation of a day, minutes (default 30)")
    p.add_argument("--tariff", type=float, default=8.0, help="Rs per kWh (default 8)")
    p.add_argument("--days-per-month", type=float, default=25, help="working days per month (default 25)")
    p.add_argument("--json", action="store_true", help="print JSON instead of text")
    args = p.parse_args(argv)

    try:
        results = run(args.csv, args.rooms, args.off_delay, args.max_interval,
                      args.last_interval, args.tariff, args.days_per_month)
    except (ValueError, KeyError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(results, indent=2))
    else:
        _print_text(results, args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
