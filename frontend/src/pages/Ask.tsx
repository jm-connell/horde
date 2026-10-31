import { useState } from "react";
import { button } from "../components/buttons";
import LoadingIndicator from "../components/LoadingIndicator";
import { useAuth } from "../context/AuthContext";
import { useAskChannels } from "../queries/ask";
import AddAskChannel from "./ask/AddAskChannel";
import AskChannelRow from "./ask/AskChannelRow";
import AskSearch from "./ask/AskSearch";

/**
 * Ask: the channels whose captions Horde indexes, and search over what they
 * said. Questions are asked in the chat panel.
 */
export default function Ask() {
  const { can } = useAuth();
  const manage = can("manage_ask");
  const channels = useAskChannels();
  const [adding, setAdding] = useState(false);
  const items = channels.data?.items ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="mb-1 text-2xl font-bold text-gray-100">Ask</h1>
        <p className="text-sm text-gray-400">
          Horde indexes what these channels say in their videos. Search it here,
          or ask in the chat panel by naming a channel, for example{" "}
          <q>
            What does {items[0]?.channel_name || "The Car Care Nut"} say about
            timing belts?
          </q>
        </p>
      </div>

      {channels.data && !channels.data.available && (
        <p
          role="alert"
          className="rounded-lg bg-danger/10 p-3 text-sm text-danger"
        >
          This server's SQLite has no full-text search (FTS5), so Ask cannot
          index or search. The official Horde images include it.
        </p>
      )}

      {items.some((c) => c.passages > 0) && <AskSearch channels={items} />}

      <section aria-labelledby="ask-channels-title" className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2
            id="ask-channels-title"
            className="text-sm font-semibold tracking-wide text-gray-300"
          >
            Channels
          </h2>
          {manage && !adding && (
            <button
              type="button"
              className={button("secondary", "sm")}
              onClick={() => setAdding(true)}
            >
              Add channel
            </button>
          )}
        </div>
        {adding && (
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
        )}
        {channels.isLoading ? (
          <LoadingIndicator />
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted">
            {manage
              ? "No channels yet. Add one to start indexing its captions."
              : "No channels yet. An administrator can turn Ask on for channels."}
          </p>
        ) : (
          <ul className="space-y-3">
            {items.map((c) => (
              <AskChannelRow key={c.id} channel={c} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
