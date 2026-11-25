"""SQLite storage for device reports and per-room settings.

A new connection is opened per operation, so the database is safe to use from
FastAPI's worker threads without sharing a connection.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    ts REAL NOT NULL,
    seq INTEGER NOT NULL,
    reason TEXT NOT NULL,
    uptime_ms INTEGER NOT NULL,
    config_version INTEGER NOT NULL,
    present TEXT NOT NULL,
    active TEXT NOT NULL,
    circuits TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_room_ts ON reports(room, ts);

CREATE TABLE IF NOT EXISTS room_settings (
    room TEXT PRIMARY KEY,
    off_delay_s INTEGER NOT NULL,
    modes TEXT NOT NULL,
    version INTEGER NOT NULL
);
"""


@dataclass
class Report:
    room: str
    ts: float
    seq: int
    reason: str
    uptime_ms: int
    config_version: int
    present: list[bool]
    active: list[bool]
    circuits: list[bool]


@dataclass
class RoomSettings:
    room: str
    off_delay_s: int
    modes: list[str]
    version: int


def _bits(values: list[bool]) -> str:
    return json.dumps([1 if v else 0 for v in values])


def _unbits(text: str) -> list[bool]:
    return [bool(v) for v in json.loads(text)]


def _row_to_report(row: sqlite3.Row) -> Report:
    return Report(
        room=row["room"],
        ts=row["ts"],
        seq=row["seq"],
        reason=row["reason"],
        uptime_ms=row["uptime_ms"],
        config_version=row["config_version"],
        present=_unbits(row["present"]),
        active=_unbits(row["active"]),
        circuits=_unbits(row["circuits"]),
    )


class Database:
    def __init__(self, path: Path | str):
        self.path = str(path)
        with self.connect() as conn:
            conn.executescript(SCHEMA)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    # ---- reports ---------------------------------------------------------------
    def insert_report(self, r: Report) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO reports (room, ts, seq, reason, uptime_ms, config_version,"
                " present, active, circuits) VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    r.room,
                    r.ts,
                    r.seq,
                    r.reason,
                    r.uptime_ms,
                    r.config_version,
                    _bits(r.present),
                    _bits(r.active),
                    _bits(r.circuits),
                ),
            )

    def latest_report(self, room: str) -> Report | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM reports WHERE room=? ORDER BY ts DESC, id DESC LIMIT 1", (room,)
            ).fetchone()
        return _row_to_report(row) if row else None

    def reports_for_window(self, room: str, start: float, end: float) -> list[Report]:
        """Reports inside [start, end], plus the last one before start (the state
        at the start of the window) and the first one after end (where the last
        in-window state stops)."""
        with self.connect() as conn:
            before = conn.execute(
                "SELECT * FROM reports WHERE room=? AND ts<? ORDER BY ts DESC, id DESC LIMIT 1",
                (room, start),
            ).fetchall()
            inside = conn.execute(
                "SELECT * FROM reports WHERE room=? AND ts>=? AND ts<=? ORDER BY ts, id",
                (room, start, end),
            ).fetchall()
            after = conn.execute(
                "SELECT * FROM reports WHERE room=? AND ts>? ORDER BY ts, id LIMIT 1",
                (room, end),
            ).fetchall()
        return [_row_to_report(r) for r in [*before, *inside, *after]]

    def recent_reports(self, room: str, limit: int) -> list[Report]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM reports WHERE room=? ORDER BY ts DESC, id DESC LIMIT ?",
                (room, limit),
            ).fetchall()
        return [_row_to_report(r) for r in rows]

    # ---- settings --------------------------------------------------------------
    def get_settings(self, room: str, num_circuits: int, default_off_delay_s: int) -> RoomSettings:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM room_settings WHERE room=?", (room,)).fetchone()
            if row is None:
                modes = ["auto"] * num_circuits
                conn.execute(
                    "INSERT INTO room_settings (room, off_delay_s, modes, version) VALUES (?,?,?,1)",
                    (room, default_off_delay_s, json.dumps(modes)),
                )
                return RoomSettings(room, default_off_delay_s, modes, 1)
        modes = json.loads(row["modes"])
        # rooms.json may have gained or lost circuits since the settings were saved
        if len(modes) != num_circuits:
            modes = (modes + ["auto"] * num_circuits)[:num_circuits]
        return RoomSettings(room, row["off_delay_s"], modes, row["version"])

    def save_settings(self, s: RoomSettings) -> RoomSettings:
        """Stores new settings and bumps the version so the device picks them up."""
        with self.connect() as conn:
            conn.execute(
                "UPDATE room_settings SET off_delay_s=?, modes=?, version=version+1 WHERE room=?",
                (s.off_delay_s, json.dumps(s.modes), s.room),
            )
            row = conn.execute(
                "SELECT version FROM room_settings WHERE room=?", (s.room,)
            ).fetchone()
        return RoomSettings(s.room, s.off_delay_s, list(s.modes), row["version"])
