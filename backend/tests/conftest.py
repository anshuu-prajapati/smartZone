from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings

ROOMS_FILE = Path(__file__).resolve().parent.parent / "rooms.json"
DEVICE_KEY = "test-device-key"


class FakeClock:
    def __init__(self, t: float = 1_800_000_000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def make_client(tmp_path, clock):
    def _make(**overrides) -> TestClient:
        settings = Settings(
            db_path=tmp_path / "test.db",
            rooms_file=ROOMS_FILE,
            device_key=DEVICE_KEY,
            clock=clock,
            **overrides,
        )
        return TestClient(create_app(settings))

    return _make


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()


def report(
    client: TestClient,
    present=(False,) * 4,
    active=None,
    circuits=(False,) * 5,
    reason="snapshot",
    seq=0,
    config_version=0,
    room="room101",
    key=DEVICE_KEY,
):
    body = {
        "room": room,
        "seq": seq,
        "uptime_ms": 1000,
        "reason": reason,
        "config_version": config_version,
        "present": list(present),
        "active": list(active if active is not None else present),
        "circuits": list(circuits),
    }
    return client.post("/api/device/report", json=body, headers={"X-Device-Key": key})
