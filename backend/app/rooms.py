"""Room definitions (zones and circuits), loaded from rooms.json.

The same file is used by the energy calculation and by the savings audit tool
(tools/audit/audit_calc.py), so both count energy the same way.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class CircuitDef(BaseModel):
    name: str
    kind: Literal["relay", "ir_ac"]
    zones: list[int] = Field(min_length=1)
    watts: float = Field(gt=0, description="Nameplate power of everything on this circuit")
    duty: float = Field(
        default=1.0,
        gt=0,
        le=1,
        description="Average share of nameplate power actually drawn while on "
        "(AC compressors cycle: ~0.6-0.7; measure if you can).",
    )

    @property
    def avg_watts(self) -> float:
        return self.watts * self.duty


class RoomDef(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,32}$")
    name: str
    zones: list[str] = Field(min_length=1, max_length=16)
    circuits: list[CircuitDef] = Field(min_length=1, max_length=16)

    @model_validator(mode="after")
    def _check_zone_indices(self) -> "RoomDef":
        n = len(self.zones)
        for i, c in enumerate(self.circuits):
            bad = [z for z in c.zones if z < 0 or z >= n]
            if bad:
                raise ValueError(f"circuit {i} ({c.name!r}) refers to unknown zones {bad}")
        return self


class RoomsFile(BaseModel):
    rooms: list[RoomDef] = Field(min_length=1)

    @model_validator(mode="after")
    def _unique_ids(self) -> "RoomsFile":
        ids = [r.id for r in self.rooms]
        if len(ids) != len(set(ids)):
            raise ValueError("room ids must be unique")
        return self


def load_rooms(path: Path) -> dict[str, RoomDef]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    parsed = RoomsFile.model_validate(data)
    return {r.id: r for r in parsed.rooms}
