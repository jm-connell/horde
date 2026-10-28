import { useId, useState, type FormEvent } from "react";
import HelpTip from "../../../components/HelpTip";
import { useAuth } from "../../../context/AuthContext";
import {
  FEED_INDEX_TIP,
  formatCatalogProgress,
  showChannelIndexButton,
  type CatalogProgress,
} from "../../libraryCatalogProgress";
import SettingsSection, {
  fieldLabel,
  secondaryButton,
} from "./SettingsSection";

const box = "rounded-lg border border-ink-700 bg-ink-950/50 p-4";

/** Rare actions: rename the channel and (re)build its search index. */
export default function ManageSection({
  channel,
  youtube,
  catalogProgress,
  indexing,
  onIndex,
  onRename,
}: {
  channel: string;
  youtube: boolean;
  catalogProgress: CatalogProgress | null;
  indexing: boolean;
  onIndex: () => void;
  onRename: (newName: string) => Promise<void>;
}) {
  const { can } = useAuth();
  const canRename = can("edit_metadata");
  const canIndex = can("download");
  const [name, setName] = useState(channel);
  const [renaming, setRenaming] = useState(false);
  const nameId = useId();
  const trimmed = name.trim();

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || trimmed === channel) return;
    setRenaming(true);
    try {
      await onRename(trimmed);
    } finally {
      setRenaming(false);
    }
  };

  if (!canRename && !youtube) return null;
  return (
    <SettingsSection
      id="manage"
      title="Manage"
      description="Less common changes to the channel itself."
    >
      <div className="space-y-3">
        {canRename && (
          <form className={box} onSubmit={(e) => void submitRename(e)}>
            <label htmlFor={nameId} className={fieldLabel}>
              Channel name
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id={nameId}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-950 px-3 py-1.5 text-sm text-gray-100 outline-hidden focus:border-accent"
              />
              <button
                type="submit"
                disabled={renaming || !trimmed || trimmed === channel}
                className={secondaryButton}
              >
                {renaming ? "Renaming…" : "Rename"}
              </button>
            </div>
            <p className="mt-1.5 text-xs text-muted">
              Changes the channel name on every video in it.
            </p>
          </form>
        )}

        {youtube && catalogProgress && (
          <div className={box}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="flex items-center gap-1.5 text-sm font-medium text-gray-200">
                  Search index
                  <HelpTip text={FEED_INDEX_TIP} placement="bottom" />
                </p>
                <p
                  className={`text-xs ${
                    catalogProgress.status === "error"
                      ? "text-danger"
                      : "text-muted"
                  }`}
                >
                  {formatCatalogProgress(catalogProgress)}
                </p>
              </div>
              {canIndex &&
                (indexing || showChannelIndexButton(catalogProgress)) && (
                  <button
                    type="button"
                    onClick={onIndex}
                    disabled={indexing}
                    className={secondaryButton}
                  >
                    {indexing ? "Queuing…" : "Index channel"}
                  </button>
                )}
            </div>
            {catalogProgress.lastError && (
              <p className="mt-1.5 text-xs text-danger">
                {catalogProgress.lastError}
              </p>
            )}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
