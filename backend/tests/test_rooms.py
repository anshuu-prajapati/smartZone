from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from app.rooms import load_rooms


def write(tmp_path, data):
    p = tmp_path / "rooms.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    return p


def room(**kw):
    base = {
        "id": "r1",
        "name": "R1",
        "zones": ["A", "B"],
        "circuits": [{"name": "L", "kind": "relay", "zones": [0, 1], "watts": 100}],
    }
    base.update(kw)
    return base


def test_shipped_rooms_file_is_valid():
    from conftest import ROOMS_FILE

    rooms = load_rooms(ROOMS_FILE)
    assert "room101" in rooms
    assert len(rooms["room101"].circuits) == 5


def test_circuit_zone_out_of_range(tmp_path):
    bad = room(circuits=[{"name": "L", "kind": "relay", "zones": [2], "watts": 100}])
    with pytest.raises(ValidationError):
        load_rooms(write(tmp_path, {"rooms": [bad]}))


def test_duplicate_room_ids(tmp_path):
    with pytest.raises(ValidationError):
        load_rooms(write(tmp_path, {"rooms": [room(), room()]}))


def test_duty_must_be_fraction(tmp_path):
    bad = room(circuits=[{"name": "AC", "kind": "ir_ac", "zones": [0], "watts": 1500, "duty": 65}])
    with pytest.raises(ValidationError):
        load_rooms(write(tmp_path, {"rooms": [bad]}))
