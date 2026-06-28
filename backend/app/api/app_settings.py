from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..services import app_settings

router = APIRouter(prefix="/api/settings", tags=["settings"])


class AppSettingsRead(BaseModel):
    progress_expiry_days: int


class AppSettingsUpdate(BaseModel):
    progress_expiry_days: Optional[int] = Field(default=None, ge=1, le=365)


@router.get("", response_model=AppSettingsRead)
def get_settings():
    data = app_settings.load()
    return AppSettingsRead(progress_expiry_days=data["progress_expiry_days"])


@router.patch("", response_model=AppSettingsRead)
def update_settings(payload: AppSettingsUpdate):
    updates: dict = {}
    if payload.progress_expiry_days is not None:
        updates["progress_expiry_days"] = payload.progress_expiry_days
    data = app_settings.save(updates) if updates else app_settings.load()
    return AppSettingsRead(progress_expiry_days=data["progress_expiry_days"])
