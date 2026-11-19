"""Recommended: recommendations that reach past the library and the catalogs.

* ``history``: what a user streamed without downloading (``user_stream_state``),
  and one watch history across library and streams (``watches``).
* ``feedback``: "not interested", "don't recommend this channel", dismissed
  channel suggestions, and how often a recommendation was shown unwatched.
* ``interests``: the user's interests as groups of watches, and the searches
  built from them.
* ``gather``: the worker that asks YouTube for candidates (searches and up next
  lists, ``ytdlp_extract``), with its budget and back-off.
* ``runtime``: the ``DiscoveryRuntime`` held on the ``AppContext``.
* ``candidates``: every video Recommended may show, with its vector.
* ``relevance``: how well a candidate fits the user's taste, and which
  channels they know; ``household``: what the other people here add.
* ``scoring``: what each kind of pick is scored on (one recipe per kind) and
  the thresholds between kinds; ``mix``: the buckets mixed into one feed.
* ``feed``: sorts candidates into buckets, ranks and caches the feed;
  ``picks``: what a feed is made of; ``suggest``: channels to follow.
* ``tuning``, ``algorithms``, ``topics``: a user's own settings for all of it.

Design and tuning: ``docs/adr/0019-recommended-plus.md`` and
``docs/adr/0024-tunable-recommended-plus.md``.
"""
