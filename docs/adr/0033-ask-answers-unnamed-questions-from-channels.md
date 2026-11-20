# 0033. Ask sends a question that names no channel to the channels that cover it

Status: Accepted (amends [0030](0030-ask-routes-on-its-own.md))

## Context

[0030](0030-ask-routes-on-its-own.md) routes by words alone: a question reaches a channel when it names one, when the chat is about one, or from that channel's page. Anything else goes to Horde. With several indexed channels on different subjects, that sent ordinary questions to the one place that cannot answer them: "How much protein should I eat to build muscle?" from the home page reached Horde, which could only say "name Jeff Nippard and ask again", and "What's the latest news about Anthropic?" was refused although two indexed channels had covered it that week.

Similarity between the question and each channel's passages separates these well, but its scale depends on the embedding model (the same threshold does not hold for OpenAI's and a local model's vectors), and a geography question still lands close to a channel's travel video.

## Decision

- A question that names no channel, asked away from any channel's page and not about Horde or the user's own things, is matched to channels (`knowledge/channel_guess.py`).
- Embeddings shortlist the three closest channels (only their order is used, not a threshold). The chat model, with thinking off and at temperature 0, is shown their names, the titles of their videos that matched and their newest titles, and names the one or two whose videos would very likely answer it, or none. When unsure it names none.
- No match, a small model, no chat model or any failure: Horde answers, as before, and is told that no channel covers the question.
- The answer is labelled with its channels and **Ask Horde instead** sits under it, as for any channel answer.

## Consequences

- Questions on a channel's subject are answered from it without naming it; general knowledge, chit-chat and arithmetic still reach Horde.
- Such a question costs one more small model call (about $0.0001) and about a second before the answer starts. Questions recognised as Horde's by their words skip it.
- The decision rests on the model: a borderline question ("how do I train my dog?" with a podcast that once interviewed a dog trainer) may go either way.
