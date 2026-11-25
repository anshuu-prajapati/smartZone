from __future__ import annotations

from conftest import report

ALL_ON = (True,) * 5


def test_device_report_requires_key(client):
    r = report(client, key="wrong")
    assert r.status_code == 401


def test_device_report_returns_default_config(client):
    r = report(client, reason="boot")
    assert r.status_code == 200
    assert r.json() == {"off_delay_s": 180, "modes": ["auto"] * 5, "version": 1}


def test_unknown_room_rejected(client):
    assert report(client, room="nope").status_code == 404


def test_wrong_zone_or_circuit_count_rejected(client):
    assert report(client, present=(True, False)).status_code == 422
    assert report(client, circuits=(True,)).status_code == 422


def test_status_shows_latest_report_and_online(client, clock):
    status = client.get("/api/rooms/room101/status").json()
    assert status["online"] is False
    assert status["last_report"] is None

    report(client, present=(True, False, False, False), circuits=(True, False, True, False, True))
    status = client.get("/api/rooms/room101/status").json()
    assert status["online"] is True
    assert status["last_report"]["present"] == [True, False, False, False]
    assert status["last_report"]["circuits"] == [True, False, True, False, True]

    clock.advance(600)
    assert client.get("/api/rooms/room101/status").json()["online"] is False


def test_override_reaches_device_and_is_acknowledged(client):
    report(client)
    r = client.put("/api/rooms/room101/circuits/4/mode", json={"mode": "off"})
    assert r.status_code == 200
    new_version = r.json()["version"]
    assert new_version == 2

    status = client.get("/api/rooms/room101/status").json()
    assert status["config_applied"] is False

    # The device receives the new settings in its next report reply...
    cfg = report(client).json()
    assert cfg["modes"] == ["auto", "auto", "auto", "auto", "off"]
    assert cfg["version"] == new_version
    # ...and acknowledges them in the report after that.
    report(client, config_version=new_version)
    assert client.get("/api/rooms/room101/status").json()["config_applied"] is True


def test_off_delay_validation(client):
    assert client.put("/api/rooms/room101/config", json={"off_delay_s": 10}).status_code == 422
    assert client.put("/api/rooms/room101/config", json={"off_delay_s": 5000}).status_code == 422
    r = client.put("/api/rooms/room101/config", json={"off_delay_s": 300})
    assert r.status_code == 200
    assert r.json()["off_delay_s"] == 300


def test_bad_mode_and_circuit_index(client):
    assert client.put("/api/rooms/room101/circuits/0/mode", json={"mode": "maybe"}).status_code == 422
    assert client.put("/api/rooms/room101/circuits/9/mode", json={"mode": "on"}).status_code == 404


def test_admin_key_enforced_when_configured(make_client):
    client = make_client(admin_key="secret")
    assert client.put("/api/rooms/room101/config", json={"off_delay_s": 60}).status_code == 401
    r = client.put(
        "/api/rooms/room101/config", json={"off_delay_s": 60}, headers={"X-Admin-Key": "secret"}
    )
    assert r.status_code == 200
    assert client.get("/api/health").json()["admin_key_required"] is True


def test_energy_endpoint(client, clock):
    # 1 hour: zone A occupied, only front lights + left fans + AC on.
    on = (True, False, True, False, True)
    for _ in range(120):
        report(client, present=(True, False, False, False), circuits=on)
        clock.advance(30)
    data = client.get("/api/rooms/room101/energy?hours=24").json()
    # used: 160 + 150 + 1500*0.65 = 1285 W for 1 h
    assert data["used_kwh"] == 1.285
    # baseline: everything (160+160+150+150+975 = 1595 W) for 1 h
    assert data["baseline_kwh"] == 1.595
    assert data["saved_kwh"] == 0.31
    assert data["saved_pct"] == 19.4
    assert len(data["series"]) == 24


def test_events_endpoint(client):
    for i in range(3):
        report(client, seq=i)
    events = client.get("/api/rooms/room101/events?limit=2").json()
    assert [e["seq"] for e in events] == [2, 1]


def test_dashboard_served(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "SmartZone" in r.text
