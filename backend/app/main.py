"""SmartZone HTTP API and dashboard.

Run from the backend/ folder:
    uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import secrets
from pathlib import Path
from urllib.parse import quote

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import energy
from .db import Database, Report, RoomSettings
from .models import ConfigUpdate, DeviceConfig, DeviceReport, ModeUpdate
from .rooms import RoomDef, load_rooms
from .settings import Settings

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


TECHFEST_BRIEF = "12_Techfest_AWS_Brief.html"
SETUP_LAB = "13_3D_Setup_Lab.html"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    rooms = load_rooms(settings.rooms_file)
    db = Database(settings.db_path)

    app = FastAPI(
        title="SmartZone API",
        version="1.0.0",
        description="Occupancy-based, per-zone control of lights, fans and AC.",
    )
    app.state.settings = settings
    app.state.db = db
    app.state.rooms = rooms

    # ---- helpers -------------------------------------------------------------
    def get_room(room_id: str) -> RoomDef:
        room = rooms.get(room_id)
        if room is None:
            raise HTTPException(status_code=404, detail=f"unknown room {room_id!r}")
        return room

    def room_settings(room: RoomDef) -> RoomSettings:
        return db.get_settings(room.id, len(room.circuits), settings.default_off_delay_s)

    def require_device(x_device_key: str = Header(default="")) -> None:
        if not secrets.compare_digest(x_device_key, settings.device_key):
            raise HTTPException(status_code=401, detail="bad device key")

    def require_admin(x_admin_key: str = Header(default="")) -> None:
        if settings.admin_key and not secrets.compare_digest(x_admin_key, settings.admin_key):
            raise HTTPException(status_code=401, detail="bad admin key")

    def config_out(s: RoomSettings) -> dict:
        return {"off_delay_s": s.off_delay_s, "modes": s.modes, "version": s.version}

    def report_out(r: Report) -> dict:
        return {
            "ts": r.ts,
            "reason": r.reason,
            "seq": r.seq,
            "uptime_ms": r.uptime_ms,
            "config_version": r.config_version,
            "present": r.present,
            "active": r.active,
            "circuits": r.circuits,
        }

    # ---- device --------------------------------------------------------------
    @app.post(
        "/api/device/report",
        response_model=DeviceConfig,
        dependencies=[Depends(require_device)],
        tags=["device"],
    )
    def device_report(body: DeviceReport) -> dict:
        """Called by the ESP32 on every change and every 30 s. Returns the
        room's current settings so the device can apply dashboard changes."""
        room = get_room(body.room)
        nz, nc = len(room.zones), len(room.circuits)
        if len(body.present) != nz or len(body.active) != nz:
            raise HTTPException(422, f"room {room.id} has {nz} zones; check firmware config.h")
        if len(body.circuits) != nc:
            raise HTTPException(422, f"room {room.id} has {nc} circuits; check firmware config.h")
        db.insert_report(
            Report(
                room=room.id,
                ts=settings.clock(),
                seq=body.seq,
                reason=body.reason,
                uptime_ms=body.uptime_ms,
                config_version=body.config_version,
                present=body.present,
                active=body.active,
                circuits=body.circuits,
            )
        )
        return config_out(room_settings(room))

    # ---- dashboard -----------------------------------------------------------
    @app.get("/api/health", tags=["dashboard"])
    def health() -> dict:
        return {"ok": True, "rooms": len(rooms), "admin_key_required": bool(settings.admin_key)}

    @app.get("/api/rooms", tags=["dashboard"])
    def list_rooms() -> list[dict]:
        return [r.model_dump() for r in rooms.values()]

    @app.get("/api/rooms/{room_id}/status", tags=["dashboard"])
    def room_status(room_id: str) -> dict:
        room = get_room(room_id)
        last = db.latest_report(room.id)
        cfg = room_settings(room)
        now = settings.clock()
        age = None if last is None else now - last.ts
        return {
            "room": room.id,
            "online": age is not None and age <= settings.online_window_s,
            "last_report_age_s": None if age is None else round(age, 1),
            "last_report": None if last is None else report_out(last),
            "config": config_out(cfg),
            "config_applied": last is not None and last.config_version == cfg.version,
        }

    @app.put(
        "/api/rooms/{room_id}/config",
        response_model=DeviceConfig,
        dependencies=[Depends(require_admin)],
        tags=["dashboard"],
    )
    def update_config(room_id: str, body: ConfigUpdate) -> dict:
        room = get_room(room_id)
        cfg = room_settings(room)
        cfg.off_delay_s = body.off_delay_s
        return config_out(db.save_settings(cfg))

    @app.put(
        "/api/rooms/{room_id}/circuits/{index}/mode",
        response_model=DeviceConfig,
        dependencies=[Depends(require_admin)],
        tags=["dashboard"],
    )
    def update_mode(room_id: str, index: int, body: ModeUpdate) -> dict:
        room = get_room(room_id)
        if not 0 <= index < len(room.circuits):
            raise HTTPException(404, f"room {room.id} has no circuit {index}")
        cfg = room_settings(room)
        cfg.modes[index] = body.mode
        return config_out(db.save_settings(cfg))

    @app.get("/api/rooms/{room_id}/energy", tags=["dashboard"])
    def room_energy(room_id: str, hours: int = Query(default=24, ge=1, le=168)) -> dict:
        room = get_room(room_id)
        now = settings.clock()
        start = now - hours * 3600
        samples = db.reports_for_window(room.id, start, now)
        totals = energy.integrate(room, samples, start, now, now, settings.max_gap_s)
        return {
            "room": room.id,
            "hours": hours,
            **totals.as_dict(),
            "baseline": "room switch: every circuit on whenever any zone is occupied",
            "series": energy.hourly_series(room, samples, start, now, now, settings.max_gap_s),
        }

    @app.get("/api/rooms/{room_id}/events", tags=["dashboard"])
    def room_events(room_id: str, limit: int = Query(default=50, ge=1, le=500)) -> list[dict]:
        room = get_room(room_id)
        return [report_out(r) for r in db.recent_reports(room.id, limit)]

    @app.get("/api/downloads", tags=["portal"])
    def downloads() -> list[dict]:
        """Submission files served under /downloads/ (one level of sub-folders)."""
        root = settings.submission_dir
        if not root.is_dir():
            return []
        out = []
        for p in sorted(root.iterdir()):
            if p.name.startswith("."):
                continue
            if p.is_dir():
                children = [
                    {"name": c.name, "size": c.stat().st_size, "url": f"/downloads/{quote(p.name)}/{quote(c.name)}"}
                    for c in sorted(p.iterdir())
                    if c.is_file() and not c.name.startswith(".")
                ]
                out.append({"name": p.name, "is_dir": True, "children": children})
            else:
                out.append({"name": p.name, "is_dir": False, "size": p.stat().st_size, "url": f"/downloads/{quote(p.name)}"})
        return out

    @app.get("/techfest", include_in_schema=False)
    @app.get("/techfest/", include_in_schema=False)
    def techfest_brief() -> RedirectResponse:
        """Short link to the Techfest Campus to Cloud (AWS) brief in the submission folder."""
        return RedirectResponse(f"/downloads/{TECHFEST_BRIEF}", status_code=307)

    @app.get("/lab", include_in_schema=False)
    @app.get("/lab/", include_in_schema=False)
    def setup_lab() -> RedirectResponse:
        """Short link to the interactive 3D setup lab in the submission folder."""
        return RedirectResponse(f"/downloads/{SETUP_LAB}", status_code=307)

    if settings.submission_dir.is_dir():
        app.mount("/downloads", StaticFiles(directory=settings.submission_dir), name="downloads")
    if STATIC_DIR.is_dir():
        app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="site")

    return app
