"""Strip network-fetching constructs from user-authored CSS.

Custom CSS is applied to every page of the app. CSS can load remote resources
(``@import``, ``url()``, ``image-set()``), which lets a stylesheet send data to
another host (attribute-selector exfiltration) or pull in someone else's rules.

Policy, applied when settings are saved:

* ``@import`` rules are removed.
* ``url()`` and the image functions that take URLs keep only ``data:`` URLs and
  same-origin relative URLs (for example an uploaded background). Anything with a
  scheme, a ``//host`` prefix or a backslash trick is replaced by ``none``, and so
  is a malformed (bad) url token.
* An image function whose arguments use a substitution function (``var()``,
  ``env()``, ``attr()``, ``if()``, a custom ``--function()``) is replaced by
  ``none`` too, because the URL it would load is not visible in the text.

The scanner splits the text into tokens the way a browser does (CSS Syntax
Level 3, including the special url token, bad url tokens, hash tokens and the
newline preprocessing), so a quote, a ``/*`` or an escape cannot make it skip
text that the browser reads as a ``url()``. It decodes escapes before it compares
names and values, so ``\\75rl(...)`` and ``@\\69mport`` do not slip through.
Comments, strings and everything else are copied through untouched, so a user's
stylesheet round-trips.

``frontend/src/customCss.ts`` implements the same algorithm for the live preview;
both are exercised by the same test vectors.
"""

from __future__ import annotations

import re
from typing import Any

#: Functions whose arguments are URLs the browser would fetch.
_URL_FUNCTIONS = frozenset(
    {
        "url",
        "src",
        "image",
        "image-set",
        "-webkit-image-set",
        "cross-fade",
        "-webkit-cross-fade",
    }
)

#: Functions whose value is only known once the browser substitutes it.
_SUBSTITUTION_FUNCTIONS = frozenset({"var", "env", "attr", "if", "inherit"})

_HEX = "0123456789abcdefABCDEF"
#: Whitespace after preprocessing (CR, CR LF and FF have become LF).
_WHITESPACE = " \t\n"
_SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.\-]*:")
_CLOSER = {"(": ")", "[": "]", "{": "}"}
#: Replacement for a forbidden URL when the text after it would extend ``none``.
_NONE_THEN_COMMENT = "none/**/"


def _is_ident_char(ch: str) -> bool:
    return ch.isalnum() and ch.isascii() or ch in "-_" or ord(ch) > 0x7F


def _is_non_printable(ch: str) -> bool:
    code = ord(ch)
    return code <= 0x08 or code == 0x0B or 0x0E <= code <= 0x1F or code == 0x7F


def _preprocess(css: str) -> str:
    """CSS Syntax 3 input preprocessing: CR LF, CR and FF are newlines.

    NUL is dropped rather than turned into U+FFFD, which only makes the
    sanitizer see more as one identifier than a browser would.
    """
    return (
        css.replace("\0", "")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\f", "\n")
    )


def _is_valid_escape(css: str, i: int) -> bool:
    """True when ``css[i]`` is a backslash that starts an escape."""
    return css[i : i + 1] == "\\" and css[i + 1 : i + 2] != "\n"


def _escape_end(css: str, i: int) -> int:
    """Index just past the escape whose backslash is at ``i``."""
    i += 1
    n = len(css)
    if i >= n:
        return n
    if css[i] not in _HEX:
        return i + 1
    j = i
    while j < n and css[j] in _HEX and j - i < 6:
        j += 1
    if j < n and css[j] in _WHITESPACE:
        j += 1
    return j


def _ident_end(css: str, start: int) -> int:
    """Index just past the identifier (with escapes) that begins at ``start``."""
    i = start
    n = len(css)
    while i < n:
        if css[i] == "\\":
            if not _is_valid_escape(css, i):
                break
            i = _escape_end(css, i)
        elif _is_ident_char(css[i]):
            i += 1
        else:
            break
    return i


def unescape(text: str) -> str:
    """Decode CSS escapes (``\\75`` and ``\\u``)."""
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch != "\\":
            out.append(ch)
            i += 1
            continue
        i += 1
        if i >= n:
            break
        if text[i] in _HEX:
            j = i
            while j < n and text[j] in _HEX and j - i < 6:
                j += 1
            code = int(text[i:j], 16)
            out.append(chr(code) if 0 < code <= 0x10FFFF else "�")
            i = j
            if i < n and text[i] in _WHITESPACE:
                i += 1
        elif text[i] == "\n":
            i += 1  # escaped newline inside a string: line continuation
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


def _string_token(css: str, start: int) -> tuple[int, str]:
    """End of the string that opens at ``start``, and its raw contents."""
    quote = css[start]
    i = start + 1
    n = len(css)
    while i < n:
        ch = css[i]
        if ch == "\\":
            i += 2  # an escaped newline continues the string
            continue
        if ch == quote:
            return i + 1, css[start + 1 : i]
        if ch == "\n":
            return i, css[start + 1 : i]  # bad string: ends before the newline
        i += 1
    return n, css[start + 1 :]


def _comment_end(css: str, start: int) -> int:
    end = css.find("*/", start + 2)
    return len(css) if end < 0 else end + 2


def _bad_url_end(css: str, i: int) -> int:
    """Consume the remnants of a bad url: up to and including the next ``)``."""
    n = len(css)
    while i < n:
        if css[i] == ")":
            return i + 1
        i = _escape_end(css, i) if _is_valid_escape(css, i) else i + 1
    return n


def _url_token(css: str, start: int) -> tuple[str, int, str]:
    """The url (or bad-url) token whose ``url(`` ends at ``start``.

    Follows "consume a url token": quotes, ``(``, whitespace inside the value,
    non-printable characters and a backslash before a newline make it a bad url,
    which runs to the next unescaped ``)``. ``/*`` is ordinary URL text.
    """
    n = len(css)
    i = start
    while i < n and css[i] in _WHITESPACE:
        i += 1
    value_start = i
    while i < n:
        ch = css[i]
        if ch == ")":
            return "url", i + 1, css[value_start:i]
        if ch in _WHITESPACE:
            value_end = i
            while i < n and css[i] in _WHITESPACE:
                i += 1
            if i >= n:
                return "url", n, css[value_start:value_end]
            if css[i] == ")":
                return "url", i + 1, css[value_start:value_end]
            return "bad-url", _bad_url_end(css, i), ""
        if ch in "\"'(" or _is_non_printable(ch):
            return "bad-url", _bad_url_end(css, i), ""
        if ch == "\\":
            if not _is_valid_escape(css, i):
                return "bad-url", _bad_url_end(css, i), ""
            i = _escape_end(css, i)
            continue
        i += 1
    return "url", n, css[value_start:]


def _token(css: str, i: int) -> tuple[str, int, str]:
    """``(kind, end, arg)`` of the token that starts at ``i``.

    ``arg`` is the lowercased, unescaped name of an ident, function, hash or
    at-keyword, the raw contents of a string or url, or the character of a
    delimiter. Digits are read as part of an identifier: a number followed by a
    name is a dimension in CSS, which is never a function either.
    """
    n = len(css)
    ch = css[i]
    if css.startswith("/*", i):
        return "comment", _comment_end(css, i), ""
    if ch in "\"'":
        end, value = _string_token(css, i)
        return "string", end, value
    if ch in _WHITESPACE:
        end = i + 1
        while end < n and css[end] in _WHITESPACE:
            end += 1
        return "whitespace", end, ""
    if ch in "#@":
        end = _ident_end(css, i + 1)
        if end == i + 1:
            return "delim", end, ch
        kind = "hash" if ch == "#" else "at-keyword"
        return kind, end, unescape(css[i + 1 : end]).lower()
    if _is_ident_char(ch) or _is_valid_escape(css, i):
        end = _ident_end(css, i)
        name = unescape(css[i:end]).lower()
        if css[end : end + 1] != "(":
            return "ident", end, name
        if name == "url":
            j = end + 1
            while j < n and css[j] in _WHITESPACE:
                j += 1
            if css[j : j + 1] not in ('"', "'"):
                return _url_token(css, end + 1)
        return "function", end + 1, name
    return "delim", i + 1, ch


def _block_end(css: str, i: int, closer: str) -> int:
    """Index just past the ``closer`` that ends the block whose contents start at ``i``.

    Nested functions and ``(``/``[``/``{`` blocks are skipped as a whole, and a
    closing bracket of another kind is part of the contents, as in a browser.
    """
    stack = [closer]
    n = len(css)
    while i < n:
        kind, end, arg = _token(css, i)
        if kind == "function":
            stack.append(")")
        elif kind == "delim" and arg in _CLOSER:
            stack.append(_CLOSER[arg])
        elif kind == "delim" and arg == stack[-1]:
            stack.pop()
            if not stack:
                return end
        i = end
    return n


def _prelude_end(css: str, i: int) -> int:
    """End of an at-rule prelude: just past ``;``, or before ``{``/``}``."""
    n = len(css)
    while i < n:
        kind, end, arg = _token(css, i)
        if kind == "delim" and arg == ";":
            return end
        if kind == "delim" and arg in ("{", "}"):
            return i
        if kind == "function":
            end = _block_end(css, end, ")")
        elif kind == "delim" and arg in ("(", "["):
            end = _block_end(css, end, _CLOSER[arg])
        i = end
    return n


def url_allowed(value: str) -> bool:
    """True for ``data:`` URLs and same-origin relative URLs."""
    v = "".join(c for c in unescape(value) if c >= " " and c != "\x7f").strip().lower()
    v = v.replace("\\", "/")
    if not v or v.startswith("data:"):
        return True
    return not (v.startswith("//") or _SCHEME_RE.match(v))


def _arguments_safe(css: str, start: int, stop: int) -> bool:
    """Every URL an image function's arguments (``css[start:stop]``) name is allowed."""
    i = start
    while i < stop:
        kind, end, arg = _token(css, i)
        if kind == "bad-url":
            return False
        if kind in ("url", "string") and not url_allowed(arg):
            return False
        if kind == "function" and (
            arg in _SUBSTITUTION_FUNCTIONS or arg.startswith("--")
        ):
            return False
        i = end
    return True


def _ends_cleanly(kind: str, arg: str) -> bool:
    """True when no text that follows a token of this kind can merge into it."""
    return kind in ("", "whitespace", "comment") or (
        kind == "delim" and arg in (";", "{", "}")
    )


def _continues_a_name(css: str, i: int) -> bool:
    """True when ``css[i]`` would extend an identifier written just before it."""
    return i < len(css) and (
        _is_ident_char(css[i]) or _is_valid_escape(css, i) or css[i] == "("
    )


def sanitize_custom_css(css: str) -> str:
    """Return ``css`` with ``@import`` and non-local URLs removed.

    Idempotent by construction: the output is the input's tokens with some of
    them replaced, and no replacement merges with its neighbours. A removed
    ``@import`` leaves an empty comment unless the previous token ends cleanly
    (otherwise ``u@import "x";rl(...)`` would become ``url(...)``). The ``none``
    that replaces a URL is followed by an empty comment when the next character
    would extend it; nothing before a URL can extend into it.
    """
    css = _preprocess(css)
    out: list[str] = []
    prev_kind, prev_arg = "", ""
    i = 0
    n = len(css)
    while i < n:
        kind, end, arg = _token(css, i)
        if kind == "at-keyword" and arg == "import":
            i = _prelude_end(css, end)
            if not _ends_cleanly(prev_kind, prev_arg):
                out.append("/**/")
                prev_kind, prev_arg = "comment", ""
            continue
        if kind in ("url", "bad-url"):
            if kind == "url" and url_allowed(arg):
                out.append(css[i:end])
            else:
                out.append(
                    _NONE_THEN_COMMENT if _continues_a_name(css, end) else "none"
                )
        elif kind == "function" and arg in _URL_FUNCTIONS:
            close = _block_end(css, end, ")")
            if _arguments_safe(css, end, close):
                out.append(css[i:close])
            else:
                out.append(
                    _NONE_THEN_COMMENT if _continues_a_name(css, close) else "none"
                )
            end = close
        else:
            out.append(css[i:end])
        prev_kind, prev_arg = kind, arg
        i = end
    return "".join(out)


#: Keys of the ``ui`` settings blob that hold custom CSS.
CUSTOM_CSS_KEYS = ("customCss", "custom_css")


def sanitize_ui_css(value: Any) -> Any:
    """Sanitize custom CSS wherever it appears in a ``ui`` blob (saved themes too)."""
    if isinstance(value, dict):
        return {
            k: (
                sanitize_custom_css(v)
                if k in CUSTOM_CSS_KEYS and isinstance(v, str)
                else sanitize_ui_css(v)
            )
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [sanitize_ui_css(v) for v in value]
    return value
