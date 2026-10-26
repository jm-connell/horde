import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { isYoutubeChannelUrl } from "../../../components/channelFeedYoutubeSearch";
import { useFocusTrap } from "../../../hooks/useFocusTrap";
import type { ChannelAutodownload } from "../../../types";
import { backdropClick } from "../../../utils";
import type { useChannelCatalog } from "../useChannelCatalog";
import AutoDownloadSection from "./AutoDownloadSection";
import FollowSection from "./FollowSection";
import ManageSection from "./ManageSection";
import RetentionSection from "./RetentionSection";
import SearchSection from "./SearchSection";
import { sectionId, type ChannelSettingsSection } from "./channelSettingsText";
import { CloseIcon } from "../../../components/icons";

/**
 * Every per-channel setting in one place: a side sheet on wide screens, a
 * full-height sheet on phones. Opens scrolled to `section` when given.
 */
export default function ChannelSettingsSheet({
  channel,
  channelUrl,
  section,
  catalog,
  onRename,
  onClose,
}: {
  channel: string;
  channelUrl: string | null;
  section: ChannelSettingsSection | null;
  catalog: ReturnType<typeof useChannelCatalog>;
  onRename: (newName: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, { onEscape: onClose });
  const titleId = useId();
  const youtube = isYoutubeChannelUrl(channelUrl);

  // Runs after the focus trap's own effect, so the section heading keeps focus.
  useEffect(() => {
    if (!section) return;
    const heading = document.getElementById(`${sectionId(section)}-title`);
    heading?.scrollIntoView({ block: "start" });
    heading?.focus({ preventScroll: true });
  }, [section]);

  const policy: ChannelAutodownload = catalog.autodownload ?? {
    configured: false,
    enabled: false,
    previous_mode: "none",
    previous_count: 10,
    quality_preset: "1080p",
    include_completed_streams: false,
    channel_url: channelUrl,
    channel_name: channel,
    pending_estimate: 0,
    catalog_max_videos: 1000,
  };

  return createPortal(
    <div
      className="fixed inset-0 z-60 flex justify-end bg-black/60"
      role="presentation"
      onClick={backdropClick(onClose)}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-horde="channel-settings"
        className="ui-panel ui-panel-legible flex h-full w-full flex-col bg-ink-900 shadow-2xl outline-hidden ring-1 ring-ink-700 sm:max-w-md sm:border-l sm:border-ink-700"
      >
        <header className="flex items-start justify-between gap-3 border-b border-ink-700 px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold text-gray-100">
              Channel settings
            </h2>
            <p className="truncate text-sm text-muted">{channel}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close channel settings"
            className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xl leading-none text-muted hover:bg-ink-800 hover:text-gray-200"
          >
            <CloseIcon />
          </button>
        </header>
        <div
          data-channel-settings-scroll
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]"
        >
          <AutoDownloadSection
            key={JSON.stringify(catalog.autodownload)}
            youtube={youtube}
            policy={policy}
            saving={catalog.autodownloadSaving}
            onSave={(payload) => void catalog.saveAutodownload(payload)}
          />
          <RetentionSection channel={channel} />
          <FollowSection channel={channel} channelUrl={channelUrl} />
          {youtube && (
            <SearchSection
              catalogProgress={catalog.catalogProgress}
              saving={catalog.youtubePrefSaving}
              onChange={(value) => void catalog.setChannelYoutubeSearch(value)}
            />
          )}
          <ManageSection
            key={channel}
            channel={channel}
            youtube={youtube}
            catalogProgress={catalog.catalogProgress}
            indexing={catalog.indexingChannel}
            onIndex={() => void catalog.triggerChannelIndex()}
            onRename={onRename}
          />
        </div>
      </div>
    </div>,
    document.body
  );
}
