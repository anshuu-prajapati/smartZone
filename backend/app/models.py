"""Request and response bodies for the HTTP API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Mode = Literal["auto", "on", "off"]

MIN_OFF_DELAY_S = 30
MAX_OFF_DELAY_S = 1800


class DeviceReport(BaseModel):
    room: str
    seq: int = Field(ge=0)
    uptime_ms: int = Field(ge=0)
    reason: Literal["boot", "change", "snapshot"]
    config_version: int = Field(default=0, ge=0)
    present: list[bool]
    active: list[bool]
    circuits: list[bool]


class DeviceConfig(BaseModel):
    off_delay_s: int
    modes: list[Mode]
    version: int


class ConfigUpdate(BaseModel):
    off_delay_s: int = Field(ge=MIN_OFF_DELAY_S, le=MAX_OFF_DELAY_S)


class ModeUpdate(BaseModel):
    mode: Mode
