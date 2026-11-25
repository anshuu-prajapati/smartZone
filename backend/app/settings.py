"""Runtime settings, read from environment variables."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

BACKEND_DIR = Path(__file__).resolve().parent.parent

# The firmware sends a full snapshot every 30 s. If no report arrives for
# longer than this, the time in between is treated as "no data" rather than
# assuming the last known state continued.
DEFAULT_MAX_GAP_S = 105.0


@dataclass
class Settings:
    db_path: Path = BACKEND_DIR / "smartzone.db"
    rooms_file: Path = BACKEND_DIR / "rooms.json"
    submission_dir: Path = BACKEND_DIR.parent / "submission"
    device_key: str = "change-me"
    # Empty = dashboard write endpoints are open (fine on a closed demo LAN).
    admin_key: str = ""
    default_off_delay_s: int = 180
    max_gap_s: float = DEFAULT_MAX_GAP_S
    online_window_s: float = 75.0
    clock: Callable[[], float] = field(default=time.time)

    @classmethod
    def from_env(cls) -> "Settings":
        env = os.environ
        return cls(
            db_path=Path(env.get("SMARTZONE_DB", BACKEND_DIR / "smartzone.db")),
            rooms_file=Path(env.get("SMARTZONE_ROOMS", BACKEND_DIR / "rooms.json")),
            device_key=env.get("SMARTZONE_DEVICE_KEY", "change-me"),
            admin_key=env.get("SMARTZONE_ADMIN_KEY", ""),
            default_off_delay_s=int(env.get("SMARTZONE_DEFAULT_OFF_DELAY_S", "180")),
            max_gap_s=float(env.get("SMARTZONE_MAX_GAP_S", DEFAULT_MAX_GAP_S)),
        )
