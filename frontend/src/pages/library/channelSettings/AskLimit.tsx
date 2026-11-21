import { useState } from "react";
import { button } from "../../../components/buttons";
import { describeError } from "../../../apiErrors";
import { useAuth } from "../../../context/AuthContext";
import { useConfirm } from "../../../context/ConfirmContext";
import { useToast } from "../../../context/ToastContext";
import { useUpdateAppSettings } from "../../../queries/app";
import { useAskChannelActions } from "../../../queries/ask";
import type { AskChannel } from "../../../types";
import { fieldLabel, numberInput } from "./SettingsSection";

export const ASK_LIMIT_MIN = 50;
export const ASK_LIMIT_MAX = 5000;

type Scope = "channel" | "all";

/**
 * How many of the channel's newest videos Ask indexes: a limit of its own, or
 * (for an administrator) the app-wide limit every channel without one follows.
 */
export default function AskLimit({ channel }: { channel: AskChannel }) {
  const { isAdmin } = useAuth();
  const confirm = useConfirm();
  const { showError } = useToast();
  const { setLimit } = useAskChannelActions();
  const saveAppSettings = useUpdateAppSettings();
  const [value, setValue] = useState(String(channel.limit));
  const [scope, setScope] = useState<Scope>("channel");
  const [saving, setSaving] = useState(false);

  const parsed = parseInt(value, 10);
  const valid =
    Number.isFinite(parsed) &&
    parsed >= ASK_LIMIT_MIN &&
    parsed <= ASK_LIMIT_MAX;
  const own = channel.max_videos != null;
  const changed =
    valid && (parsed !== channel.limit || (scope === "all" && own));
  const name = channel.channel_name || "this channel";

  const save = async () => {
    if (!changed) return;
    if (parsed < channel.limit) {
      const ok = await confirm({
        title:
          scope === "all"
            ? `Index only the newest ${parsed.toLocaleString()} videos of every channel?`
            : `Index only the newest ${parsed.toLocaleString()} videos?`,
        body:
          scope === "all"
            ? "Older videos are removed from Ask for every channel without a limit of its own. Raising the limit later fetches their captions again."
            : `Older videos of ${name} are removed from Ask. Raising the limit later fetches their captions again.`,
        confirmLabel: "Lower the limit",
        danger: true,
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      if (scope === "all") {
        await saveAppSettings({ ask_max_videos: parsed });
        // This channel follows the new app-wide limit too.
        await setLimit.mutateAsync({ id: channel.id, maxVideos: null });
      } else {
        await setLimit.mutateAsync({ id: channel.id, maxVideos: parsed });
      }
      setScope("channel");
    } catch (err) {
      showError(`Could not change the limit: ${describeError(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const followDefault = async () => {
    try {
      await setLimit.mutateAsync({ id: channel.id, maxVideos: null });
    } catch (err) {
      showError(`Could not change the limit: ${describeError(err)}`);
    }
  };

  return (
    <form
      className="mt-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor="ask-limit" className={fieldLabel}>
        Newest videos to index
      </label>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <input
          id="ask-limit"
          type="number"
          min={ASK_LIMIT_MIN}
          max={ASK_LIMIT_MAX}
          step={50}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-describedby="ask-limit-hint"
          className={numberInput}
        />
        {isAdmin && (
          <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-200">
            <legend className="sr-only">Apply the limit to</legend>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="ask-limit-scope"
                checked={scope === "channel"}
                onChange={() => setScope("channel")}
              />
              This channel
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="ask-limit-scope"
                checked={scope === "all"}
                onChange={() => setScope("all")}
              />
              Every channel
            </label>
          </fieldset>
        )}
        <button
          type="submit"
          disabled={!changed || saving}
          className={button("secondary", "sm")}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <p id="ask-limit-hint" className="mt-1.5 text-xs text-muted">
        {own
          ? "This channel has its own limit."
          : "This channel follows the limit for every channel."}{" "}
        {ASK_LIMIT_MIN}–{ASK_LIMIT_MAX.toLocaleString()}.
        {channel.channel_total != null &&
          ` The channel has ${channel.channel_total.toLocaleString()} videos.`}
        {own && (
          <>
            {" "}
            <button
              type="button"
              onClick={() => void followDefault()}
              disabled={setLimit.isPending}
              className="text-accent hover:underline disabled:opacity-50"
            >
              Use the limit for every channel
            </button>
          </>
        )}
      </p>
    </form>
  );
}
