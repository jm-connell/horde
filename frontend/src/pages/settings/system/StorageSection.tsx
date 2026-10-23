import { useState } from "react";
import { describeError } from "../../../apiErrors";
import HelpTip from "../../../components/HelpTip";
import { useUpdateAppSettings } from "../../../queries/app";
import type { StorageStats } from "../../../types";
import { formatSize } from "../../../utils";
import { INPUT_COMPACT, STORAGE_LIMIT_TIP } from "../constants";
import { useSettingsPage } from "../context";
import { Section } from "../ui";
import { useLoadedAppSettings } from "../useLoadedAppSettings";
import { inputToLimit, limitToInput, limitUsage } from "./storageLimit";

const BAR_COLOR = {
  ok: "bg-accent",
  warn: "bg-amber-500",
  full: "bg-red-500",
} as const;

/** What the library takes on disk, and the limit past which downloads wait. */
export default function StorageSection({
  storage,
}: {
  storage: StorageStats | null;
}) {
  const { match, showToast, showError } = useSettingsPage();
  const saveAppSettings = useUpdateAppSettings();
  const [input, setInput] = useState("");
  const [appSettings, setAppSettings] = useLoadedAppSettings((s) =>
    setInput(limitToInput(s.max_library_bytes))
  );
  const limit = appSettings?.max_library_bytes ?? null;
  const usage =
    storage && limit ? limitUsage(storage.total_bytes, limit) : null;

  const save = async () => {
    const next = inputToLimit(input);
    if (next === undefined) {
      setInput(limitToInput(limit));
      return;
    }
    setInput(limitToInput(next));
    if (next === limit) return;
    try {
      const updated = await saveAppSettings({ max_library_bytes: next });
      setAppSettings(updated);
      setInput(limitToInput(updated.max_library_bytes));
      showToast(
        updated.max_library_bytes
          ? "Disk usage limit saved"
          : "Disk usage limit removed"
      );
    } catch (err) {
      setInput(limitToInput(limit));
      showError(`Could not save setting: ${describeError(err)}`);
    }
  };

  return (
    <Section
      title="Storage"
      hidden={
        !match(
          "storage",
          "disk",
          "space",
          "library",
          "max disk usage",
          "limit",
          "quota"
        )
      }
    >
      {storage ? (
        <div className="flex items-baseline gap-3">
          <span className="text-2xl font-bold text-gray-100">
            {formatSize(storage.total_bytes) || "0 B"}
          </span>
          <span className="text-xs text-muted">
            {storage.video_count} video
            {storage.video_count === 1 ? "" : "s"}
          </span>
        </div>
      ) : (
        <p className="text-sm text-muted">Calculating...</p>
      )}
      <div className="mt-4">
        <label
          htmlFor="settings-max-library"
          className="mb-1 flex items-center gap-1.5 text-xs text-muted"
        >
          Max disk usage
          <HelpTip text={STORAGE_LIMIT_TIP} />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="settings-max-library"
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            placeholder="No limit"
            value={input}
            disabled={appSettings === null}
            onChange={(e) => setInput(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className={INPUT_COMPACT}
          />
          <span className="text-xs text-muted">GB · empty for no limit</span>
        </div>
        {usage && storage && limit ? (
          <div className="mt-3 max-w-md">
            <div
              role="progressbar"
              aria-label="Library size against the limit"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={usage.percent}
              className="h-1.5 overflow-hidden rounded-full bg-ink-700"
            >
              <div
                className={`h-full rounded-full ${BAR_COLOR[usage.level]}`}
                style={{ width: `${usage.percent}%` }}
              />
            </div>
            <p
              className={`mt-1 text-xs ${
                usage.level === "ok" ? "text-muted" : "text-amber-400/90"
              }`}
            >
              {formatSize(storage.total_bytes) || "0 B"} of{" "}
              {limitToInput(limit)} GB
              {usage.level === "full"
                ? " · downloads are waiting"
                : usage.level === "warn"
                  ? " · almost full"
                  : ""}
            </p>
          </div>
        ) : null}
      </div>
    </Section>
  );
}
