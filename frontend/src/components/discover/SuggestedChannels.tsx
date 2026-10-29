import { useState } from "react";
import type { SuggestedChannel } from "../../types";
import { youtubeThumbnailUrl } from "../../utils";
import { button } from "../buttons";
import FadeImage from "../FadeImage";
import { CloseIcon } from "../icons";

/** "Channels you might like": follow one, open it, or say no. */
export default function SuggestedChannels({
  channels,
  onFollow,
  onDismiss,
  onOpen,
}: {
  channels: SuggestedChannel[];
  onFollow: (channel: SuggestedChannel) => Promise<void>;
  onDismiss: (channel: SuggestedChannel) => void;
  onOpen: (channel: SuggestedChannel) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  if (channels.length === 0) return null;
  return (
    <section
      aria-label="Channels you might like"
      className="col-span-full py-2 max-sm:px-3"
    >
      <h2 className="mb-2 text-sm font-medium text-gray-200">
        Channels you might like
      </h2>
      <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2 scrollbar-none [&::-webkit-scrollbar]:hidden">
        {channels.map((ch) => (
          <div
            key={ch.url}
            className="ui-panel relative flex w-64 shrink-0 flex-col gap-2 rounded-xl bg-ink-900 p-3 ring-1 ring-ink-700"
          >
            <button
              type="button"
              onClick={() => onDismiss(ch)}
              className="ui-interactive absolute right-2 top-2 rounded-lg p-1 text-muted hover:text-accent"
              aria-label={`Don't suggest ${ch.name}`}
              title="Don't suggest this channel"
            >
              <CloseIcon />
            </button>
            <button
              type="button"
              onClick={() => onOpen(ch)}
              className="ui-interactive grid grid-cols-3 gap-1 overflow-hidden rounded-lg text-left"
              aria-label={`Open ${ch.name}`}
            >
              {ch.videos.slice(0, 3).map((v) => (
                <FadeImage
                  key={v.id ?? v.url}
                  src={youtubeThumbnailUrl(v.id, v.thumbnail_url) ?? undefined}
                  alt=""
                  className="aspect-video w-full rounded-sm bg-ink-800 object-cover"
                />
              ))}
            </button>
            <div className="min-w-0 pr-6">
              <button
                type="button"
                onClick={() => onOpen(ch)}
                className="block max-w-full truncate text-left text-sm font-medium text-gray-100 hover:text-accent"
              >
                {ch.name}
              </button>
              {ch.reason && (
                <p className="truncate text-xs text-muted" title={ch.reason}>
                  {ch.reason}
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={busy === ch.url}
              onClick={() => {
                setBusy(ch.url);
                void onFollow(ch).finally(() => setBusy(null));
              }}
              className={`${button("secondary", "sm")} mt-auto`}
            >
              {busy === ch.url ? "Following…" : "Follow"}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
