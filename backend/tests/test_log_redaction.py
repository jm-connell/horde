"""Signed-link tokens never reach the access log."""

import logging

from app.services.log_redaction import install_log_redaction, redact_query_secrets


def test_redacts_the_media_token_only():
    assert (
        redact_query_secrets("/api/videos/3/stream?rendition=compat&mt=123.4.abcd&x=1")
        == "/api/videos/3/stream?rendition=compat&mt=[redacted]&x=1"
    )
    assert redact_query_secrets("/api/videos/3/stream?mt=abc") == (
        "/api/videos/3/stream?mt=[redacted]"
    )
    assert redact_query_secrets("/api/videos?smt=keep") == "/api/videos?smt=keep"


def test_the_uvicorn_access_log_is_filtered(caplog):
    install_log_redaction()
    install_log_redaction()  # idempotent
    logger = logging.getLogger("uvicorn.access")
    assert (
        len([f for f in logger.filters if type(f).__name__ == "RedactQuerySecrets"])
        == 1
    )
    with caplog.at_level(logging.INFO, logger="uvicorn.access"):
        logger.info(
            '%s - "%s %s HTTP/%s" %d',
            "127.0.0.1:1",
            "GET",
            "/api/videos/3/stream?mt=1.2.deadbeef",
            "1.1",
            206,
        )
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "deadbeef" not in text and "mt=[redacted]" in text
