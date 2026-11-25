from __future__ import annotations

import json

import pytest

import audit_calc

ROOMS = {
    "rooms": [
        {
            "id": "r1",
            "name": "R1",
            "zones": ["A", "B"],
            "circuits": [
                {"name": "lights A", "kind": "relay", "zones": [0], "watts": 100},
                {"name": "lights shared", "kind": "relay", "zones": [0, 1], "watts": 200},
                {"name": "ac", "kind": "ir_ac", "zones": [0, 1], "watts": 1000, "duty": 0.5},
            ],
        }
    ]
}


@pytest.fixture
def rooms_file(tmp_path):
    p = tmp_path / "rooms.json"
    p.write_text(json.dumps(ROOMS), encoding="utf-8")
    return p


def write_csv(tmp_path, rows):
    p = tmp_path / "obs.csv"
    p.write_text("date,time,room,occupied,on\n" + "\n".join(rows) + "\n", encoding="utf-8")
    return p


def test_shared_circuit_rule(tmp_path, rooms_file):
    # Only zone B occupied; lights A (serves A only) is wasted, shared lights are not.
    csv = write_csv(tmp_path, ["2026-12-01,09:00,r1,2,1 2", "2026-12-01,10:00,r1,2,1 2"])
    [r] = audit_calc.run(csv, rooms_file, off_delay_s=0, last_interval_min=60)
    assert r["waste_share_by_count_pct"] == 50.0
    assert r["energy_wasted_kwh"] == 0.2  # 100 W x 2 h
    assert r["wasted_kwh_by_circuit"]["lights shared"] == 0.0


def test_off_delay_reduces_achievable(tmp_path, rooms_file):
    # Empty room, AC on for 1 h (two 30-minute observations).
    csv = write_csv(tmp_path, ["2026-12-01,09:00,r1,,3", "2026-12-01,09:30,r1,,3"])
    [r] = audit_calc.run(csv, rooms_file, off_delay_s=600, last_interval_min=30)
    assert r["energy_wasted_kwh"] == 0.5  # 500 W avg x 1 h
    # 10-minute delay: 50 of 60 minutes are savable
    assert r["energy_achievable_kwh"] == pytest.approx(0.42, abs=0.01)


def test_intervals_capped_and_split_by_day(tmp_path, rooms_file):
    csv = write_csv(tmp_path, [
        "2026-12-01,08:00,r1,,1",
        "2026-12-01,12:00,r1,,1",   # 4 h later -> capped to 60 min
        "2026-12-02,08:00,r1,,1",   # next day: previous obs gets last-interval
    ])
    [r] = audit_calc.run(csv, rooms_file, off_delay_s=0, max_interval_min=60, last_interval_min=30)
    assert r["days_observed"] == 2
    assert r["observed_hours"] == 2.0  # 1 h + 0.5 h + 0.5 h


def test_money_estimate(tmp_path, rooms_file):
    csv = write_csv(tmp_path, ["2026-12-01,09:00,r1,,3"])
    [r] = audit_calc.run(csv, rooms_file, off_delay_s=0, last_interval_min=60, tariff=8, days_per_month=25)
    assert r["achievable_kwh_per_day"] == 0.5
    assert r["achievable_kwh_per_month"] == 12.5
    assert r["achievable_rupees_per_month"] == 100


def test_bad_rows_are_reported(tmp_path, rooms_file):
    with pytest.raises(ValueError, match="out of range"):
        audit_calc.run(write_csv(tmp_path, ["2026-12-01,09:00,r1,3,"]), rooms_file)
    with pytest.raises(ValueError, match="unknown room"):
        audit_calc.run(write_csv(tmp_path, ["2026-12-01,09:00,zz,,"]), rooms_file)


def test_cli_runs(tmp_path, rooms_file, capsys):
    csv = write_csv(tmp_path, ["2026-12-01,09:00,r1,1,1 2 3"])
    assert audit_calc.main([str(csv), "--rooms", str(rooms_file)]) == 0
    assert "Room r1" in capsys.readouterr().out
