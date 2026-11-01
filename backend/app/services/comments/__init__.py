"""Saved YouTube comments of library videos (``video_comments``).

* ``fetch``: one yt-dlp call for a video's top comments (and replies to the
  highest-ranked threads), never the media.
* ``store``: replace a video's saved comments, record the outcome, read them back.
* ``worker``: the background fetcher: new downloads first, then the rest of the
  library, one video at a time behind interactive and download work.
* ``live``: a deeper fetch when someone asks for more than was saved (not stored).
* ``search``: keyword matches over saved comments for library search.

``comments_enabled`` (Settings → Library → Comments) turns all of it off: no
fetching, no comments on the watch page, in search or in the video chat. Saved
comments stay in the database, so turning it back on brings them back.
"""

from __future__ import annotations

SETTING = "comments_enabled"


def enabled() -> bool:
    from .. import app_settings

    return bool(app_settings.load().get(SETTING, True))
