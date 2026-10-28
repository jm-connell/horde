import { useId, useState } from "react";
import Collapse from "../../../components/Collapse";
import ThemedSelect from "../../../components/ThemedSelect";
import { useAuth } from "../../../context/AuthContext";
import { PRESET_LABELS, PRESET_ORDER } from "../../../presets";
import type { ChannelAutodownload } from "../../../types";
import { Toggle } from "../../settings/ui";
import type { AutodownloadPayload } from "../useChannelCatalog";
import SettingsSection, {
  fieldLabel,
  numberInput,
  primaryButton,
} from "./SettingsSection";

type PreviousMode = ChannelAutodownload["previous_mode"];

const QUALITY_OPTIONS = PRESET_ORDER.map((p) => ({
  value: p as string,
  label: PRESET_LABELS[p] ?? p,
}));

/** Download new uploads (and optionally older ones) of a YouTube channel on their own. */
export default function AutoDownloadSection({
  youtube,
  policy,
  saving,
  onSave,
}: {
  /** Only YouTube channels can download on their own. */
  youtube: boolean;
  policy: ChannelAutodownload;
  saving: boolean;
  onSave: (payload: AutodownloadPayload) => void;
}) {
  const { can } = useAuth();
  const editable = can("download");
  return (
    <SettingsSection
      id="autodownload"
      title="Automatic downloads"
      description="Download this channel’s new uploads as they appear, and optionally some older ones."
      readOnlyNote={
        youtube && !editable
          ? "Changing this needs the Download permission."
          : null
      }
    >
      {youtube ? (
        <AutoDownloadForm
          policy={policy}
          saving={saving}
          editable={editable}
          onSave={onSave}
        />
      ) : (
        <p className="text-sm text-gray-400">
          Only YouTube channels can download automatically.
        </p>
      )}
    </SettingsSection>
  );
}

function AutoDownloadForm({
  policy,
  saving,
  editable,
  onSave,
}: {
  policy: ChannelAutodownload;
  saving: boolean;
  editable: boolean;
  onSave: (payload: AutodownloadPayload) => void;
}) {
  const [enabled, setEnabled] = useState(policy.enabled);
  const [previousMode, setPreviousMode] = useState<PreviousMode>(
    policy.previous_mode
  );
  const [previousCount, setPreviousCount] = useState(
    String(
      policy.previous_count && policy.previous_count > 0
        ? policy.previous_count
        : 10
    )
  );
  const [quality, setQuality] = useState(policy.quality_preset || "1080p");
  const [includeStreams, setIncludeStreams] = useState(
    policy.include_completed_streams
  );
  const radioName = useId();
  const countId = useId();

  const countNum = Math.max(
    1,
    Math.min(500, parseInt(previousCount, 10) || 10)
  );
  const payload: AutodownloadPayload = {
    enabled,
    previous_mode: previousMode,
    previous_count: countNum,
    quality_preset: quality,
    include_completed_streams: includeStreams,
  };
  const dirty =
    enabled !== policy.enabled ||
    previousMode !== policy.previous_mode ||
    (previousMode === "count" && countNum !== policy.previous_count) ||
    quality !== policy.quality_preset ||
    includeStreams !== policy.include_completed_streams;

  return (
    <div className="space-y-4">
      <label className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium text-gray-200">
          Download new uploads automatically
        </span>
        <Toggle
          checked={enabled}
          disabled={!editable}
          onChange={() => setEnabled((v) => !v)}
        />
      </label>

      <Collapse open={enabled}>
        <div className="space-y-4">
          <fieldset className="space-y-2" disabled={!editable}>
            <legend className={fieldLabel}>Older videos</legend>
            <label className="flex items-center gap-2 text-sm text-gray-200">
              <input
                type="radio"
                name={radioName}
                checked={previousMode === "none"}
                onChange={() => setPreviousMode("none")}
              />
              None, only new uploads
            </label>
            <div className="flex flex-wrap items-center gap-2 text-sm text-gray-200">
              <input
                type="radio"
                name={radioName}
                aria-label="The latest older videos"
                checked={previousMode === "count"}
                onChange={() => setPreviousMode("count")}
              />
              <label htmlFor={countId}>The latest</label>
              <input
                id={countId}
                type="number"
                min={1}
                max={500}
                value={previousCount}
                onChange={(e) => setPreviousCount(e.target.value)}
                onFocus={() => setPreviousMode("count")}
                className={numberInput}
              />
              <span>older videos</span>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-200">
              <input
                type="radio"
                name={radioName}
                checked={previousMode === "all"}
                onChange={() => setPreviousMode("all")}
              />
              All indexed videos
            </label>
          </fieldset>

          <div>
            <span className={fieldLabel}>Resolution</span>
            <ThemedSelect
              aria-label="Auto-download resolution"
              value={quality}
              options={QUALITY_OPTIONS}
              onChange={setQuality}
              disabled={!editable}
              className="w-full"
              buttonClassName="w-full"
            />
          </div>

          <label className="flex items-start justify-between gap-4">
            <span>
              <span className="block text-sm font-medium text-gray-200">
                Include finished livestreams
              </span>
              <span className="block text-xs text-muted">
                Streams are never downloaded while live or upcoming.
              </span>
            </span>
            <Toggle
              checked={includeStreams}
              disabled={!editable}
              onChange={() => setIncludeStreams((v) => !v)}
            />
          </label>

          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200/90">
            {previousMode === "all"
              ? `All indexed videos can use a lot of storage. It is limited to the channel catalog cap (${policy.catalog_max_videos} videos).`
              : "Automatic downloads can use a lot of storage over time."}
            {policy.pending_estimate > 0 &&
              ` About ${policy.pending_estimate} catalog video${
                policy.pending_estimate === 1 ? "" : "s"
              } not in your library would be queued now.`}
          </p>
        </div>
      </Collapse>

      {editable && (
        <button
          type="button"
          onClick={() => onSave(payload)}
          disabled={saving || !dirty}
          className={primaryButton}
        >
          {saving ? "Saving…" : "Save automatic downloads"}
        </button>
      )}
    </div>
  );
}
