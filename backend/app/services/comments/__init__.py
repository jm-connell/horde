"""Saved YouTube comments of library videos (``video_comments``).

* ``fetch``: one yt-dlp call for a video's top comments (and replies to the
  highest-ranked threads), never the media.
* ``store``: replace a video's saved comments, record the outcome, read them back.
* ``worker``: the background fetcher: new downloads first, then the rest of the
  library, one video at a time behind interactive and download work.
* ``live``: a deeper fetch when someone asks for more than was saved (not stored).
* ``search``: keyword matches over saved comments for library search.
"""
