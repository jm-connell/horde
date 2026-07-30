"""Catalog video text used for embeddings."""

from __future__ import annotations

import hashlib

from ...models import ChannelCatalogVideo

_MAX_DESC_CHARS = 4000

def catalog_document(video: ChannelCatalogVideo) -> str:
    parts = [f"Title: {video.title or ''}"]
    if video.description:
        parts.append("Description: " + video.description[:_MAX_DESC_CHARS])
    return "\n".join(parts).strip()


def catalog_content_hash(video: ChannelCatalogVideo) -> str:
    text = catalog_document(video)
    return hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()
