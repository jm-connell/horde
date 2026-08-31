"""OpenRouter usage writes must not deadlock the embed job Session."""

from sqlmodel import select

from app.models import OpenRouterUsage, VideoEmbedding
from app.services.ai import cost_ledger, embeddings


class _FakeOpenRouter:
    name = "openrouter"

    def embed_many(self, texts, model, **kwargs):
        cost_ledger.record_cost(
            cost=5.28e-06,
            kind="embed",
            model=model,
            video_id=kwargs.get("video_id"),
            prompt_tokens=264,
        )
        return [[0.1, 0.2, 0.3, 0.4] for _ in texts]


def test_embed_video_records_openrouter_usage_without_lock(
    session, add_video, monkeypatch
):
    video = add_video(title="The Big Move Day 3", description="It's coming together")
    monkeypatch.setattr(embeddings, "get_embed_provider", lambda: _FakeOpenRouter())
    monkeypatch.setattr(
        embeddings,
        "resolve_embed_model",
        lambda provider=None: "openai/text-embedding-3-small",
    )

    assert embeddings.embed_video(session, video.id) is True

    stored = session.exec(
        select(VideoEmbedding).where(VideoEmbedding.video_id == video.id)
    ).all()
    assert stored
    usage = session.exec(select(OpenRouterUsage)).all()
    assert len(usage) == 1
    assert usage[0].kind == "embed"
    assert usage[0].video_id == video.id
    assert usage[0].model == "openai/text-embedding-3-small"
