from __future__ import annotations

from dataclasses import dataclass

import pytest

from app.energy import hourly_series, integrate
from app.rooms import CircuitDef, RoomDef

ROOM = RoomDef(
    id="r",
    name="test",
    zones=["A", "B"],
    circuits=[
        CircuitDef(name="lights A", kind="relay", zones=[0], watts=100),
        CircuitDef(name="lights B", kind="relay", zones=[1], watts=100),
        CircuitDef(name="ac", kind="ir_ac", zones=[0, 1], watts=1000, duty=0.5),
    ],
)
GAP = 105.0


@dataclass
class S:
    ts: float
    active: list[bool]
    circuits: list[bool]


def snapshots(t0, t1, active, circuits, every=30):
    return [S(t, list(active), list(circuits)) for t in range(t0, t1, every)]


def test_one_zone_occupied_saves_the_other_zone():
    samples = snapshots(0, 3600, [True, False], [True, False, True])
    tot = integrate(ROOM, samples, 0, 3600, now=3600, max_gap_s=GAP)
    assert tot.used_wh == pytest.approx(600)  # 100 + 1000*0.5
    assert tot.baseline_wh == pytest.approx(700)  # 100 + 100 + 500
    assert tot.saved_pct == pytest.approx(100 / 7)
    assert tot.coverage_pct == pytest.approx(100)


def test_empty_room_costs_nothing_in_either():
    samples = snapshots(0, 3600, [False, False], [False, False, False])
    tot = integrate(ROOM, samples, 0, 3600, now=3600, max_gap_s=GAP)
    assert tot.used_wh == 0
    assert tot.baseline_wh == 0
    assert tot.saved_pct is None


def test_override_on_in_empty_room_counts_as_negative_savings():
    samples = snapshots(0, 3600, [False, False], [True, False, False])
    tot = integrate(ROOM, samples, 0, 3600, now=3600, max_gap_s=GAP)
    assert tot.used_wh == pytest.approx(100)
    assert tot.saved_wh == pytest.approx(-100)


def test_gap_is_excluded_not_guessed():
    on = [True, True, True]
    samples = snapshots(0, 1800, [True, True], on) + snapshots(3600, 7200, [True, True], on)
    tot = integrate(ROOM, samples, 0, 7200, now=7200, max_gap_s=GAP)
    # The 1770 -> 3600 interval (device offline) is not counted at all.
    assert tot.covered_s == pytest.approx(1800 + 3600 - 30)
    assert tot.used_wh == pytest.approx(tot.baseline_wh)


def test_state_before_window_carries_in():
    samples = [S(0, [True, False], [True, False, False]), S(60, [False, False], [False, False, False])]
    tot = integrate(ROOM, samples, 30, 60, now=60, max_gap_s=GAP)
    assert tot.used_wh == pytest.approx(100 * 30 / 3600)
    assert tot.covered_s == pytest.approx(30)


def test_last_sample_runs_until_now_only_if_recent():
    samples = [S(0, [True, False], [True, False, False])]
    assert integrate(ROOM, samples, 0, 60, now=60, max_gap_s=GAP).covered_s == pytest.approx(60)
    assert integrate(ROOM, samples, 0, 600, now=600, max_gap_s=GAP).covered_s == 0


def test_hourly_series_sums_to_total():
    samples = snapshots(0, 3 * 3600, [True, False], [True, False, True])
    total = integrate(ROOM, samples, 0, 3 * 3600, now=3 * 3600, max_gap_s=GAP)
    series = hourly_series(ROOM, samples, 0, 3 * 3600, now=3 * 3600, max_gap_s=GAP)
    assert len(series) == 3
    assert sum(b["used_kwh"] for b in series) == pytest.approx(total.used_wh / 1000, abs=1e-3)
