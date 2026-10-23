import { useEffect, useId, useState } from "react";
import { describeError } from "../../../apiErrors";
import { useAuth } from "../../../context/AuthContext";
import { useToast } from "../../../context/ToastContext";
import {
  useChannelRetention,
  useRetentionPreview,
  useSaveChannelRetention,
} from "../../../queries/channelRetention";
import type { ChannelRetention, RetentionLimits } from "../../../types";
import { formatDate } from "../../../utils";
import { Toggle } from "../../settings/ui";
import { parseLimit, retentionPreviewLine } from "./channelSettingsText";
import SettingsSection, { numberInput, primaryButton } from "./SettingsSection";

/** Upper bounds the API accepts (schemas.RetentionLimits). */
const MAX_KEEP = 100_000;
const MAX_DAYS = 3650;
const PREVIEW_DEBOUNCE_MS = 400;

type LimitKey = keyof RetentionLimits;

const LIMIT_ROWS: {
  key: LimitKey;
  before: string;
  after: string;
  max: number;
  fallback: number;
  hint?: string;
}[] = [
  {
    key: "keep_latest",
    before: "Keep only the newest",
    after: "videos",
    max: MAX_KEEP,
    fallback: 20,
  },
  {
    key: "max_age_days",
    before: "Remove videos added over",
    after: "days ago",
    max: MAX_DAYS,
    fallback: 30,
  },
  {
    key: "remove_watched_after_days",
    before: "Remove finished videos after",
    after: "days",
    max: MAX_DAYS,
    fallback: 7,
    hint: "Finished by anyone. Counts only videos finished since this version of Horde.",
  },
];

/** Move a channel's old videos to the trash on their own (retention rule). */
export default function RetentionSection({ channel }: { channel: string }) {
  const { can } = useAuth();
  const query = useChannelRetention(channel);
  const editable = can("delete_videos");
  return (
    <SettingsSection
      id="retention"
      title="Clean up old videos"
      description="Move this channel's older videos to the trash on a schedule, so it does not pile up. You can restore them from the trash."
      readOnlyNote={
        editable ? null : "Changing this needs the Delete videos permission."
      }
    >
      {query.data ? (
        <RetentionForm
          key={channel}
          channel={channel}
          rule={query.data}
          editable={editable}
        />
      ) : query.isError ? (
        <p className="text-sm text-red-400">
          Could not load the cleanup rule: {describeError(query.error)}
        </p>
      ) : (
        <p className="text-sm text-muted">Loading…</p>
      )}
    </SettingsSection>
  );
}

function RetentionForm({
  channel,
  rule,
  editable,
}: {
  channel: string;
  rule: ChannelRetention;
  editable: boolean;
}) {
  const { showToast } = useToast();
  const save = useSaveChannelRetention();
  const [enabled, setEnabled] = useState(rule.enabled);
  const [checked, setChecked] = useState<Record<LimitKey, boolean>>(() => ({
    keep_latest: rule.keep_latest != null,
    max_age_days: rule.max_age_days != null,
    remove_watched_after_days: rule.remove_watched_after_days != null,
  }));
  const [text, setText] = useState<Record<LimitKey, string>>(() => {
    const out = {} as Record<LimitKey, string>;
    for (const row of LIMIT_ROWS)
      out[row.key] = String(rule[row.key] ?? row.fallback);
    return out;
  });
  const [error, setError] = useState<string | null>(null);
  const idBase = useId();

  const limits: RetentionLimits = {
    keep_latest: null,
    max_age_days: null,
    remove_watched_after_days: null,
  };
  const invalid: string[] = [];
  for (const row of LIMIT_ROWS) {
    if (!checked[row.key]) continue;
    const value = parseLimit(text[row.key], row.max);
    if (value == null) invalid.push(row.key);
    limits[row.key] = value;
  }
  const anyLimit = LIMIT_ROWS.some((row) => limits[row.key] != null);
  const debounced = useDebounced(limits, PREVIEW_DEBOUNCE_MS);
  const preview = useRetentionPreview(channel, debounced);

  const dirty =
    enabled !== rule.enabled ||
    LIMIT_ROWS.some((row) => limits[row.key] !== (rule[row.key] ?? null));

  const submit = () => {
    if (invalid.length) {
      setError("Enter a whole number for each limit that is ticked.");
      return;
    }
    if (enabled && !anyLimit) {
      setError("Tick at least one limit before turning cleanup on.");
      return;
    }
    setError(null);
    save.mutate(
      { channel, enabled, ...limits },
      {
        onSuccess: (row) =>
          showToast(row.enabled ? "Cleanup rule saved" : "Cleanup turned off"),
        onError: (err) => setError(describeError(err, "Could not save")),
      }
    );
  };

  return (
    <div className="space-y-4">
      {!rule.trash_enabled && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200/90">
          The trash is turned off on this server (HORDE_TRASH_DAYS=0), so this
          rule removes nothing. Horde never deletes videos for good on its own.
        </p>
      )}

      <label className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium text-gray-200">
          Clean up this channel automatically
        </span>
        <Toggle
          checked={enabled}
          disabled={!editable}
          onChange={() => setEnabled((v) => !v)}
        />
      </label>

      <fieldset className="space-y-3" disabled={!editable}>
        <legend className="sr-only">Limits</legend>
        {LIMIT_ROWS.map((row) => {
          const boxId = `${idBase}-${row.key}`;
          const bad = checked[row.key] && invalid.includes(row.key);
          return (
            <div key={row.key}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-gray-200">
                <input
                  id={boxId}
                  type="checkbox"
                  checked={checked[row.key]}
                  onChange={(e) =>
                    setChecked((c) => ({ ...c, [row.key]: e.target.checked }))
                  }
                />
                <label htmlFor={boxId}>{row.before}</label>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={row.max}
                  aria-label={`${row.before} … ${row.after}`}
                  aria-invalid={bad || undefined}
                  value={text[row.key]}
                  disabled={!editable || !checked[row.key]}
                  onChange={(e) =>
                    setText((t) => ({ ...t, [row.key]: e.target.value }))
                  }
                  className={`${numberInput} ${bad ? "border-red-500" : ""}`}
                />
                <span className={checked[row.key] ? "" : "text-muted"}>
                  {row.after}
                </span>
              </div>
              {row.hint && (
                <p className="mt-1 pl-6 text-xs text-muted">{row.hint}</p>
              )}
            </div>
          );
        })}
      </fieldset>

      {editable && anyLimit && (
        <p
          className="rounded-lg bg-ink-950/60 px-3 py-2 text-sm text-gray-200"
          role="status"
          aria-live="polite"
        >
          {preview.data
            ? `${retentionPreviewLine(preview.data)}${
                preview.data.kept_by_exception > 0
                  ? ` ${preview.data.kept_by_exception} more ${
                      preview.data.kept_by_exception === 1 ? "is" : "are"
                    } kept by the exceptions below.`
                  : ""
              }`
            : preview.isError
              ? `Could not check what this would remove: ${describeError(preview.error)}`
              : "Checking what this would remove…"}
        </p>
      )}

      {rule.last_removed_at && rule.last_removed_count > 0 && (
        <p className="text-xs text-muted">
          Last cleanup on {formatDate(rule.last_removed_at)} moved{" "}
          {rule.last_removed_count} video
          {rule.last_removed_count === 1 ? "" : "s"} to the trash.
        </p>
      )}

      <div className="text-xs text-muted">
        <p>Always kept, whatever the limits say:</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {rule.always_kept.map((item) => (
            <li key={item.code}>{item.label}</li>
          ))}
        </ul>
      </div>

      {error && (
        <p className="text-sm text-red-400" role="alert">
          {error}
        </p>
      )}

      {editable && (
        <button
          type="button"
          onClick={submit}
          disabled={save.isPending || !dirty}
          className={primaryButton}
        >
          {save.isPending ? "Saving…" : "Save cleanup rule"}
        </button>
      )}
    </div>
  );
}

/** `value` once it has stopped changing for `ms` (compared by JSON). */
function useDebounced<T>(value: T, ms: number): T {
  const json = JSON.stringify(value);
  const [settled, setSettled] = useState(json);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(json), ms);
    return () => window.clearTimeout(timer);
  }, [json, ms]);
  return JSON.parse(settled) as T;
}
