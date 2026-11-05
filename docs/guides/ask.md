# Ask

**Ask** is the chat at the bottom of every page (in the installed app on a phone, the **Ask** tab). It answers from one of two places:

- **Horde**: how to use, set up or fix Horde, its settings, and your own downloads, library and playlists. What it can do there is in [AI features](ai-features.md#ask).
- **Channels**: what YouTube channels said in their videos, with a numbered reference to the moment for every point. The rest of this page is about those.

The source shows beside the panel's title: **Ask Automatic**, **Ask Horde** or **Ask \<channel\>** says where the next answer comes from. Press it to pick:

- **Automatic** (the start): Horde, or a channel when the question names it. On a channel's page it reads **\<channel\> or Horde**: questions about its videos go to the channel.
- **Horde**: only Horde, even when a question names a channel.
- A channel: only that channel.

Each answer is labelled with where it came from too.

For channels, Horde fetches the captions of every upload of a channel (not the videos), indexes what was said, and then:

- the **search bar** finds it: a search on the home page adds a **Said in videos** section with every passage that mentions your words, grouped by video, each with a link that opens the video at that moment;
- **Ask** answers questions about it, such as *"What does The Car Care Nut say about the 2004 4Runner?"*, from those passages only, with a numbered reference for every point.

## Turning Ask on for a channel

Open **Settings → Library → Channels Ask can answer from** and press **Add channel**, or open a channel's settings (the gear on its page) and use the **Ask** section. Paste the channel's link or its `@handle` and press **Look up**: Horde shows the channel's name and how many videos it has. If the channel has past live streams you can also index them; it is off by default, because streams are long and often off-topic.

Indexing runs in the background and can take hours: Horde fetches about four videos' captions a minute, waits when YouTube rate-limits it, and always lets your own library's caption fetches go first. The newest uploads are indexed first, so Ask is useful long before it finishes. New uploads are picked up once a day. Videos you have downloaded use their caption file, with no request to YouTube.

That section shows each channel's progress: videos indexed, videos without captions (Ask cannot use those) and videos it could not fetch (members-only, removed). **Pause** stops fetching; **Turn off** deletes everything indexed for the channel.

Only the administrator, and members given **Manage channel indexing** (Account → Users), see that section and add or remove channels. Everyone can search and, with the **Use AI** permission, ask.

## Asking a channel

Dock Ask at the side with the expand button (⤢) in its header to keep it open beside what you are watching or browsing. A question goes to a channel when it **names** it: *"What does Linus Tech Tips say about…"*, *"@TheCarCareNut on…"*, *"does carcarenut recommend…"*. Name two channels to compare them, or ask about *"all my channels"*. A question that names no channel is answered from Horde.

To skip the guessing, pick the channel beside **Ask**. Picking **Horde** keeps every answer on Horde, even when a question names a channel (useful for *"how do I stop indexing The Car Care Nut?"*); **Automatic** goes back to choosing per question. **New chat** starts on the source you picked last, and the pick is kept while the browser tab is open.

On a channel's page, or watching one of its videos, Ask already knows the channel: with **Automatic** picked, the title reads **Ask \<channel\> or Horde**, and a question that names no channel is answered from the channel (the video you are watching first) unless it is about Horde itself, such as its settings, downloads or playlists. **Ask \<channel\>** on a channel's page opens a new conversation about that channel. Once an answer comes from a channel, the title shows it and follow-up questions stay on it without naming it again.

Answers come only from what the channels said. When the indexed videos do not cover the question, the answer says so. When several channels cover it, the answer says where they agree and where they disagree, and when a channel changed its mind over the years, it says that too.

### References

Every statement about what a channel said ends with a small number. Hover it to see the video and time; click it to open the video at that moment (your downloaded copy if you have one, otherwise the stream). Below the answer, the numbered list gives the channel, the video's title and year, the timestamp, and the caption line said there, so you can check the claim without opening anything.

The model never writes times itself. It only cites passages; Horde then finds the caption line within the passage that matches the sentence citing it and links a couple of seconds before it. A reference may still land a few seconds off when a point is spread over a minute of talking, and captions generated by YouTube misspell names, so treat the quoted line as the place to start watching.

## Conversations

Conversations are saved on the server for your account (nobody else sees them). **History** in Ask lists them, whether they were answered from Horde or from channels; **New chat** starts another.

## What it needs

| Part | Needs |
|------|-------|
| Indexing and **Said in videos** in search results | Nothing beyond Horde: no AI provider |
| Asking a channel | A chat model (Settings → AI). It uses the **Assistant model** when one is set |
| Finding passages by meaning, not just words | An embedding model; without one Ask searches by keyword (and by the spellings the chat model suggests) |

Small local models (around 3B) are told to compare at most two channels and get fewer passages; a 14B model or a cloud model gives noticeably better answers and follows the citation rules more reliably.

## Privacy and disk space

- With a **cloud embedding provider**, every caption passage is sent to it for embedding. With a **cloud chat model**, each question's passages are sent with it. Local providers keep everything on your network.
- A channel of 500 videos of about 25 minutes takes about 45 MB in Horde's database, and the nightly and pre-update backups copy the database, so count on about half a gigabyte of disk per channel. Turning a channel off frees the space for new data but does not shrink the database file.

How it works: [Channel knowledge](../design/channel-knowledge.md), [ADR 0022](../adr/0022-ask-channel-knowledge.md) and [ADR 0028](../adr/0028-one-ask.md).
