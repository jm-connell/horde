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


def test_notification_secrets_are_redacted_too():
    assert (
        redact_query_secrets(
            "POST https://discord.com/api/webhooks/123456/abcDEF-ghi_JKL?wait=true"
        )
        == "POST https://discord.com/api/webhooks/123456/[redacted]?wait=true"
    )
    assert (
        redact_query_secrets("headers={'Authorization': 'Bearer tk_secret.1'}")
        == "headers={'Authorization': 'Bearer [redacted]'}"
    )


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


def test_httpx_logs_its_url_object_not_a_string(caplog):
    """httpx's own request log passes ``request.url`` (an ``httpx.URL``) as an argument."""
    import httpx

    install_log_redaction()
    logger = logging.getLogger("httpx")
    with caplog.at_level(logging.INFO, logger="httpx"):
        logger.info(
            'HTTP Request: %s %s "%s %d %s"',
            "POST",
            httpx.URL("https://discord.com/api/webhooks/123456/abcDEF-ghi_JKL"),
            "HTTP/1.1",
            204,
            "No Content",
        )
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "abcDEF" not in text
    assert "https://discord.com/api/webhooks/123456/[redacted]" in text
    assert '"HTTP/1.1 204 No Content"' in text  # the other arguments are untouched
