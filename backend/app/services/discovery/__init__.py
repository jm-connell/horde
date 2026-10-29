"""Recommended+: recommendations that reach past the library and the catalogs.

* ``history``: what a user streamed without downloading (``user_stream_state``),
  and one watch history across library and streams (``watches``).
* ``feedback``: "not interested", "don't recommend this channel", dismissed
  channel suggestions, and how often a recommendation was shown unwatched.
* ``interests``: the user's interests as groups of watches, and the searches
  built from them.
* ``gather``: the worker that asks YouTube for candidates (searches and up next
  lists, ``ytdlp_extract``), with its budget and back-off.
* ``runtime``: the ``DiscoveryRuntime`` held on the ``AppContext``.
* ``candidates``: every video Recommended+ may show, with its vector.
* ``feed``: the ranked and mixed Recommended+ feed; ``suggest``: channels to follow.

Design and tuning: ``docs/adr/0019-recommended-plus.md``.
"""
