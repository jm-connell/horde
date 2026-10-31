import { useState } from "react";
import { api } from "../../api";
import { describeError } from "../../apiErrors";
import { button } from "../../components/buttons";
import { useAskChannelActions } from "../../queries/ask";
import type { AskChannelPreview } from "../../types";

/**
 * Turn Ask on for a channel: look it up first (name, uploads, live streams),
 * then confirm. Live streams are offered only when the channel has some, off
 * by default.
 */
export default function AddAskChannel({
  initialUrl = "",
  onAdded,
}: {
  initialUrl?: string;
  onAdded?: () => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [preview, setPreview] = useState<AskChannelPreview | null>(null);
  const [streams, setStreams] = useState(false);
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { add } = useAskChannelActions();

  const lookUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setLooking(true);
    setError(null);
    setPreview(null);
    setStreams(false);
    try {
      setPreview(await api.previewAskChannel(url.trim()));
    } catch (err) {
      setError(describeError(err, "Could not read that channel"));
    } finally {
      setLooking(false);
    }
  };

  const confirm = () => {
    if (!preview) return;
    add.mutate(
      { url: preview.channel_url, includeStreams: streams },
      {
        onSuccess: () => {
          setUrl("");
          setPreview(null);
          onAdded?.();
        },
        onError: (err) => setError(describeError(err, "Could not add channel")),
      }
    );
  };

  return (
    <div className="space-y-3">
      <form onSubmit={lookUp} className="flex gap-2">
        <label htmlFor="ask-add-url" className="sr-only">
          Channel link or @handle
        </label>
        <input
          id="ask-add-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Channel link or @handle"
          className="min-w-0 flex-1 rounded-lg bg-ink-800 px-3 py-2 text-sm text-gray-100 ring-1 ring-ink-700 placeholder:text-muted focus:outline-none focus:ring-accent"
        />
        <button
          type="submit"
          className={button("secondary")}
          disabled={looking || !url.trim()}
        >
          {looking ? "Looking up…" : "Look up"}
        </button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {preview && (
        <div className="space-y-3 rounded-lg bg-ink-800 p-3 ring-1 ring-ink-700">
          <div>
            <p className="font-medium text-gray-100">
              {preview.channel_name || preview.channel_url}
            </p>
            {preview.video_count != null && (
              <p className="text-sm text-muted">
                About {preview.video_count.toLocaleString()} videos. Indexing
                fetches each one's captions from YouTube, about four a minute,
                so a large channel takes hours.
              </p>
            )}
          </div>
          {preview.existing_id != null ? (
            <p className="text-sm text-muted">
              Ask is already on for this channel.
            </p>
          ) : (
            <>
              {preview.has_streams && (
                <label className="flex items-center gap-2 text-sm text-gray-300">
                  <input
                    type="checkbox"
                    checked={streams}
                    onChange={(e) => setStreams(e.target.checked)}
                  />
                  Also index past live streams
                </label>
              )}
              <button
                type="button"
                className={button("primary")}
                onClick={confirm}
                disabled={add.isPending}
              >
                {add.isPending ? "Turning on…" : "Turn on Ask"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
