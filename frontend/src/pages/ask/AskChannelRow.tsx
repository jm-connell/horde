import { useAuth } from "../../context/AuthContext";
import { useConfirm } from "../../context/ConfirmContext";
import { button } from "../../components/buttons";
import { isAskChannelBusy, useAskChannelActions } from "../../queries/ask";
import type { AskChannel } from "../../types";
import { askProgressText } from "./askLinks";

const STATUS_LABEL: Record<string, string> = {
  queued: "Waiting to start",
  listing: "Listing videos",
  indexing: "Fetching captions",
  ready: "Ready",
  paused: "Paused",
  error: "Could not list videos",
};

export default function AskChannelRow({ channel }: { channel: AskChannel }) {
  const { can } = useAuth();
  const manage = can("manage_ask");
  const confirm = useConfirm();
  const { pause, resume, remove, setStreams } = useAskChannelActions();
  const done = channel.videos - channel.pending;
  const pct = channel.videos ? Math.round((done / channel.videos) * 100) : 0;
  const name = channel.channel_name || channel.channel_url;

  const onRemove = async () => {
    const ok = await confirm({
      title: `Turn off Ask for ${name}?`,
      body: "Everything indexed for this channel is deleted. Turning it on again fetches every video's captions again.",
      confirmLabel: "Turn off",
      danger: true,
    });
    if (ok) remove.mutate(channel.id);
  };

  const onStreams = async (include: boolean) => {
    if (!include) {
      const ok = await confirm({
        title: "Stop indexing live streams?",
        body: "Captions already indexed from this channel's live streams are deleted.",
        confirmLabel: "Stop",
        danger: true,
      });
      if (!ok) return;
    }
    setStreams.mutate({ id: channel.id, includeStreams: include });
  };

  return (
    <li className="ui-panel rounded-xl bg-ink-900 p-4 ring-1 ring-ink-700">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <a
            href={channel.channel_url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-gray-100 hover:text-accent"
          >
            {name}
          </a>
          <p className="text-sm text-muted">
            {STATUS_LABEL[channel.status] ?? channel.status}
            {channel.include_streams && " · includes live streams"}
          </p>
        </div>
        {manage && (
          <div className="flex flex-wrap gap-2">
            {channel.status === "paused" ? (
              <button
                type="button"
                className={button("secondary", "xs")}
                onClick={() => resume.mutate(channel.id)}
              >
                Resume
              </button>
            ) : (
              <button
                type="button"
                className={button("secondary", "xs")}
                onClick={() => pause.mutate(channel.id)}
              >
                Pause
              </button>
            )}
            <button
              type="button"
              className={button("danger", "xs")}
              onClick={onRemove}
            >
              Turn off
            </button>
          </div>
        )}
      </div>
      {channel.videos > 0 && (
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink-700"
          role="progressbar"
          aria-label={`${name} indexing progress`}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`h-full rounded-full ${isAskChannelBusy(channel) ? "bg-accent" : "bg-accent/60"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <p className="mt-2 text-xs text-muted">{askProgressText(channel)}</p>
      {channel.last_error && (
        <p className="mt-1 text-xs text-danger">{channel.last_error}</p>
      )}
      {manage && (
        <label className="mt-3 flex items-center gap-2 text-xs text-gray-300">
          <input
            type="checkbox"
            checked={channel.include_streams}
            disabled={setStreams.isPending}
            onChange={(e) => void onStreams(e.target.checked)}
          />
          Index past live streams
        </label>
      )}
    </li>
  );
}
