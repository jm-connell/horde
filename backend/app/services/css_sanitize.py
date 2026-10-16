"""Strip network-fetching constructs from user-authored CSS.

Custom CSS is applied to every page of the app. CSS can load remote resources
(``@import``, ``url()``, ``image-set()``), which lets a stylesheet send data to
another host (attribute-selector exfiltration) or pull in someone else's rules.

Policy, applied when settings are saved:

* ``@import`` rules are removed.
* ``url()`` and the image functions that take URLs keep only ``data:`` URLs and
  same-origin relative URLs (for example an uploaded background). Anything with a
  scheme, a ``//host`` prefix or a backslash trick is replaced by ``none``.

The scanner decodes CSS escapes before it compares names and values, so
``\\75rl(...)`` and ``@\\69mport`` do not slip through. Comments, strings and
everything else are copied through untouched, so a user's stylesheet round-trips.

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

_HEX = "0123456789abcdefABCDEF"
_WHITESPACE = " \t\n\r\f"
_SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.\-]*:")


def _is_ident_char(ch: str) -> bool:
    return ch.isalnum() and ch.isascii() or ch in "-_" or ord(ch) > 0x7F


def _ident_end(css: str, start: int) -> int:
    """Index just past the identifier (with escapes) that begins at ``start``."""
    i = start
    n = len(css)
    while i < n:
        ch = css[i]
        if ch == "\\":
            if i + 1 >= n:
                return i + 1
            i += 1
            if css[i] in _HEX:
                digits = 0
                while i < n and css[i] in _HEX and digits < 6:
                    i += 1
                    digits += 1
                if i < n and css[i] in _WHITESPACE:
                    i += 1
            else:
                i += 1
        elif _is_ident_char(ch):
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


def _string_end(css: str, start: int) -> int:
    """Index just past the quoted string that opens at ``start``."""
    quote = css[start]
    i = start + 1
    n = len(css)
    while i < n:
        ch = css[i]
        if ch == "\\":
            i += 2
            continue
        if ch == quote:
            return i + 1
        if ch == "\n":
            return i  # unterminated string ends at the newline
        i += 1
    return n


def _comment_end(css: str, start: int) -> int:
    end = css.find("*/", start + 2)
    return len(css) if end < 0 else end + 2


def _parens_end(css: str, open_idx: int) -> int:
    """Index just past the ``)`` matching the ``(`` at ``open_idx``."""
    depth = 0
    i = open_idx
    n = len(css)
    while i < n:
        ch = css[i]
        if ch == "\\":
            i += 2
            continue
        if ch in "\"'":
            i = _string_end(css, i)
            continue
        if ch == "/" and css.startswith("/*", i):
            i = _comment_end(css, i)
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return n


def _statement_end(css: str, start: int) -> int:
    """End of an at-rule that has no block: just past ``;``, or before ``{``/``}``."""
    i = start
    n = len(css)
    while i < n:
        ch = css[i]
        if ch == "\\":
            i += 2
            continue
        if ch in "\"'":
            i = _string_end(css, i)
            continue
        if ch == "/" and css.startswith("/*", i):
            i = _comment_end(css, i)
            continue
        if ch == "(":
            i = _parens_end(css, i)
            continue
        if ch == ";":
            return i + 1
        if ch in "{}":
            return i
        i += 1
    return n


def url_allowed(value: str) -> bool:
    """True for ``data:`` URLs and same-origin relative URLs."""
    v = "".join(c for c in unescape(value) if c >= " " and c != "\x7f").strip().lower()
    v = v.replace("\\", "/")
    if not v or v.startswith("data:"):
        return True
    return not (v.startswith("//") or _SCHEME_RE.match(v))


def _string_values(text: str) -> list[str]:
    """Contents of every quoted string in ``text`` (outside comments)."""
    values: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "/" and text.startswith("/*", i):
            i = _comment_end(text, i)
        elif ch in "\"'":
            end = _string_end(text, i)
            values.append(text[i + 1 : end - 1 if end > i + 1 else end])
            i = end
        elif ch == "\\":
            i += 2
        else:
            i += 1
    return values


def _call_is_safe(name: str, inner: str) -> bool:
    if name == "url":
        value = inner.strip()
        if value[:1] in ("'", '"'):
            end = _string_end(value, 0)
            value = value[1 : end - 1 if end > 1 else end]
        return url_allowed(value)
    # image-set(), src(), cross-fade(): every string and nested url() must be safe.
    if not all(url_allowed(v) for v in _string_values(inner)):
        return False
    return sanitize_custom_css(inner) == inner


def sanitize_custom_css(css: str) -> str:
    """Return ``css`` with ``@import`` and non-local URLs removed."""
    css = css.replace("\0", "")
    out: list[str] = []
    i = 0
    n = len(css)
    while i < n:
        ch = css[i]
        if ch == "/" and css.startswith("/*", i):
            end = _comment_end(css, i)
            out.append(css[i:end])
            i = end
        elif ch in "\"'":
            end = _string_end(css, i)
            out.append(css[i:end])
            i = end
        elif ch == "@":
            end = _ident_end(css, i + 1)
            if unescape(css[i + 1 : end]).lower() == "import":
                i = _statement_end(css, end)
                continue
            out.append(css[i:end])
            i = end
        elif ch == "\\" or _is_ident_char(ch):
            end = _ident_end(css, i)
            name = unescape(css[i:end]).lower()
            if end < n and css[end] == "(" and name in _URL_FUNCTIONS:
                close = _parens_end(css, end)
                closed = close <= n and css[close - 1 : close] == ")"
                inner = css[end + 1 : close - 1 if closed else close]
                out.append(css[i:close] if _call_is_safe(name, inner) else "none")
                i = close
            else:
                out.append(css[i:end])
                i = end
        else:
            out.append(ch)
            i += 1
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
