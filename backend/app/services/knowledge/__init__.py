"""Ask: channels' captions as a searchable knowledge base.

``channels`` adds, lists and removes Ask channels; ``listing`` reads a channel's
uploads from YouTube; ``captions`` fetches one video's captions; ``chunking`` turns
them into timed passages; ``worker`` runs listing and fetching in the background;
``search`` is the keyword search over the passages. Design:
``docs/design/channel-knowledge.md``.
"""
