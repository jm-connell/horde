import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { describeError } from "../../apiErrors";
import { useConfirm } from "../../context/ConfirmContext";
import { useToast } from "../../context/ToastContext";
import { appSettingsQuery, useUpdateAppSettings } from "../../queries/app";
import { queryKeys } from "../../queries/keys";
import {
  ASK_LIMIT_MAX,
  ASK_LIMIT_MIN,
} from "../library/channelSettings/AskLimit";
import { INPUT_COMPACT } from "./constants";

/** The app-wide number of newest videos Ask indexes per channel. */
export default function AskLimitSetting() {
  const confirm = useConfirm();
  const { showError } = useToast();
  const queryClient = useQueryClient();
  const saved = useQuery(appSettingsQuery()).data?.ask_max_videos;
  const saveAppSettings = useUpdateAppSettings();
  const [value, setValue] = useState("");
  useEffect(() => {
    if (saved != null) setValue(String(saved));
  }, [saved]);

  const commit = async () => {
    if (saved == null) return;
    const n = parseInt(value, 10);
    if (isNaN(n)) {
      setValue(String(saved));
      return;
    }
    const next = Math.max(ASK_LIMIT_MIN, Math.min(ASK_LIMIT_MAX, n));
    setValue(String(next));
    if (next === saved) return;
    if (next < saved) {
      const ok = await confirm({
        title: `Index only the newest ${next.toLocaleString()} videos of every channel?`,
        body: "Older videos are removed from Ask for every channel without a limit of its own. Raising the limit later fetches their captions again.",
        confirmLabel: "Lower the limit",
        danger: true,
      });
      if (!ok) {
        setValue(String(saved));
        return;
      }
    }
    try {
      await saveAppSettings({ ask_max_videos: next });
      void queryClient.invalidateQueries({ queryKey: queryKeys.ask.channels });
    } catch (err) {
      setValue(String(saved));
      showError(`Could not save setting: ${describeError(err)}`);
    }
  };

  return (
    <div data-setting="ask-limit">
      <label
        htmlFor="settings-ask-limit"
        className="mb-1 block text-xs text-muted"
      >
        Videos indexed per channel
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="settings-ask-limit"
          type="number"
          min={ASK_LIMIT_MIN}
          max={ASK_LIMIT_MAX}
          step={50}
          value={value}
          disabled={saved == null}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => void commit()}
          className={INPUT_COMPACT}
        />
        <span className="text-xs text-muted">
          {ASK_LIMIT_MIN}–{ASK_LIMIT_MAX.toLocaleString()}
        </span>
      </div>
      <p className="mt-1.5 text-xs text-muted">
        Ask indexes this many of each channel's newest videos. A channel can
        have its own limit in its channel settings. Fetching captions takes
        about a day per 5,000 videos.
      </p>
    </div>
  );
}
