import { useState } from "react";
import { button } from "../../components/buttons";
import LoadingIndicator from "../../components/LoadingIndicator";
import { useAskChannels } from "../../queries/ask";
import AddAskChannel from "../ask/AddAskChannel";
import AskChannelRow from "../ask/AskChannelRow";

/** The channels whose captions Ask indexes: progress, and adding or changing them. */
export default function AskChannelsSection() {
  const channels = useAskChannels(true, { poll: true });
  const [adding, setAdding] = useState(false);
  const items = channels.data?.items ?? [];

  return (
    <div className="space-y-3">
      {channels.data && !channels.data.available && (
        <p
          role="alert"
          className="rounded-lg bg-danger/10 p-3 text-sm text-danger"
        >
          This server's SQLite has no full-text search (FTS5), so Ask cannot
          index or search. The official Horde images include it.
        </p>
      )}
      {adding ? (
        <div className="ui-panel rounded-xl bg-ink-900 p-4 ring-1 ring-ink-700">
          <AddAskChannel onAdded={() => setAdding(false)} />
          <button
            type="button"
            className={`${button("quiet", "sm")} mt-2`}
            onClick={() => setAdding(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={button("secondary", "sm")}
          onClick={() => setAdding(true)}
        >
          Add channel
        </button>
      )}
      {channels.isLoading ? (
        <LoadingIndicator />
      ) : items.length === 0 ? (
        <p className="py-4 text-sm text-muted">
          No channels yet. Add one to start indexing its captions.
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((c) => (
            <AskChannelRow key={c.id} channel={c} />
          ))}
        </ul>
      )}
    </div>
  );
}
