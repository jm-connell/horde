from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import require_admin
from ..services import factory_reset

router = APIRouter(prefix="/api/setup", tags=["setup"])

#: Typed confirmations the caller must send. Factory reset is irreversible, so a
#: bare request (or a forged cross-site one) must never trigger it.
CONFIRM_RESET = "RESET"
CONFIRM_ERASE_MEDIA = "ERASE MEDIA"


class ResetRequest(BaseModel):
    erase_media: bool = False
    confirm: str = ""


class ResetResponse(BaseModel):
    setup_completed: bool = False
    erased_media: bool
    library_video_count: int = 0


@router.post(
    "/reset", response_model=ResetResponse, dependencies=[Depends(require_admin)]
)
def reset_app(payload: ResetRequest) -> ResetResponse:
    expected = CONFIRM_ERASE_MEDIA if payload.erase_media else CONFIRM_RESET
    if payload.confirm != expected:
        raise HTTPException(
            status_code=400,
            detail=f'Type "{expected}" to confirm the reset',
        )
    result = factory_reset.reset_app(erase_media=payload.erase_media)
    return ResetResponse(**result)
