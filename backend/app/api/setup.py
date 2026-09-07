from pydantic import BaseModel

from fastapi import APIRouter

from ..services import factory_reset

router = APIRouter(prefix="/api/setup", tags=["setup"])


class ResetRequest(BaseModel):
    erase_media: bool = False


class ResetResponse(BaseModel):
    setup_completed: bool = False
    erased_media: bool
    library_video_count: int = 0


@router.post("/reset", response_model=ResetResponse)
def reset_app(payload: ResetRequest) -> ResetResponse:
    result = factory_reset.reset_app(erase_media=payload.erase_media)
    return ResetResponse(**result)
