"""Energy accounting.

Used energy: each circuit's average power (watts x duty) while it was ON.

Baseline ("room switch") energy: what the same room would use with ordinary
room switches, assuming people switch EVERYTHING on while anyone is in the
room and switch it off as soon as the room is empty. That is generous to the
baseline (real rooms are often left on after everyone leaves), so the savings
reported here are a conservative lower bound of what zoning saves over
room-level switching. Nothing is compared against "everything on 24 hours".

Gaps: the device reports at least every 30 s. If two consecutive reports are
more than max_gap_s apart, that interval is counted as "no data" in BOTH used
and baseline, and shows up as reduced coverage instead of guessed energy.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Sequence

from .rooms import RoomDef


class Sample(Protocol):
    ts: float
    active: list[bool]
    circuits: list[bool]


@dataclass
class EnergyTotals:
    used_wh: float = 0.0
    baseline_wh: float = 0.0
    covered_s: float = 0.0
    window_s: float = 0.0

    @property
    def saved_wh(self) -> float:
        return self.baseline_wh - self.used_wh

    @property
    def saved_pct(self) -> float | None:
        if self.baseline_wh <= 0:
            return None
        return 100.0 * self.saved_wh / self.baseline_wh

    @property
    def coverage_pct(self) -> float:
        if self.window_s <= 0:
            return 0.0
        return 100.0 * self.covered_s / self.window_s

    def as_dict(self) -> dict:
        pct = self.saved_pct
        return {
            "used_kwh": round(self.used_wh / 1000, 3),
            "baseline_kwh": round(self.baseline_wh / 1000, 3),
            "saved_kwh": round(self.saved_wh / 1000, 3),
            "saved_pct": None if pct is None else round(pct, 1),
            "coverage_pct": round(self.coverage_pct, 1),
        }


def _power(room: RoomDef, s: Sample) -> tuple[float, float]:
    used = sum(c.avg_watts for c, on in zip(room.circuits, s.circuits) if on)
    baseline = sum(c.avg_watts for c in room.circuits) if any(s.active) else 0.0
    return used, baseline


def integrate(
    room: RoomDef,
    samples: Sequence[Sample],
    start: float,
    end: float,
    now: float,
    max_gap_s: float,
) -> EnergyTotals:
    """Integrates energy over [start, end]. `samples` must be sorted by time.
    The state reported in sample i holds until sample i+1 (or `now` for the
    last sample)."""
    totals = EnergyTotals(window_s=max(0.0, end - start))
    for i, s in enumerate(samples):
        nxt = samples[i + 1].ts if i + 1 < len(samples) else now
        if nxt - s.ts > max_gap_s:
            continue  # device silent too long: unknown, not guessed
        seg_start = max(s.ts, start)
        seg_end = min(nxt, end)
        if seg_end <= seg_start:
            continue
        hours = (seg_end - seg_start) / 3600.0
        used_w, baseline_w = _power(room, s)
        totals.used_wh += used_w * hours
        totals.baseline_wh += baseline_w * hours
        totals.covered_s += seg_end - seg_start
    return totals


def hourly_series(
    room: RoomDef,
    samples: Sequence[Sample],
    start: float,
    end: float,
    now: float,
    max_gap_s: float,
    bucket_s: float = 3600.0,
) -> list[dict]:
    out = []
    t = start
    while t < end:
        b_end = min(t + bucket_s, end)
        tot = integrate(room, samples, t, b_end, now, max_gap_s)
        out.append(
            {
                "start": t,
                "used_kwh": round(tot.used_wh / 1000, 4),
                "baseline_kwh": round(tot.baseline_wh / 1000, 4),
                "coverage_pct": round(tot.coverage_pct, 1),
            }
        )
        t = b_end
    return out
