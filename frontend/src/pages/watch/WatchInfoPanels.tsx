import { Suspense } from "react";
import { api } from "../../api";
import LoadingIndicator from "../../components/LoadingIndicator";
import PlaybackQueue from "../../components/PlaybackQueue";
import { VideoAiPanel } from "../../components/lazy";
import WatchMeta from "../../components/WatchMeta";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { resolveLibraryChapters, stripChapterLines } from "../../utils";
import type { Video } from "../../types";
import type { WatchAi } from "./useWatchAi";
import type { WatchSource } from "./useWatchVideo";

/**
 * Under the title: the AI panel (summary, chat), description, chapters, tags
 * and notes, with the playback queue beside them when the sidebar is not shown.
 */
export default function WatchInfoPanels({
  source,
  ai,
  queueVisible,
  sidebarShown,
  onVideoUpdated,
}: {
  source: WatchSource;
  ai: WatchAi;
  queueVisible: boolean;
  sidebarShown: boolean;
  onVideoUpdated: (video: Video) => void;
}) {
  const { can } = useAuth();
  const { showToast } = useToast();
  const video = source.kind === "library" ? source.video : null;
  const description =
    source.kind === "library"
      ? source.video.description
      : source.meta.description;
  const chapters = video ? resolveLibraryChapters(video) : ai.streamChapters;
  const descriptionBody = stripChapterLines(description);

  return (
    <div
      className={
        !sidebarShown && queueVisible
          ? "mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_24rem]"
          : // Without the sidebar the column can be ~116rem wide; keep the
            // description and AI panel at a readable width.
            `mt-4 space-y-4 ${sidebarShown ? "" : "max-w-5xl"}`
      }
    >
      <div className="min-w-0 space-y-4">
        {ai.target && ai.showAiSection && can("use_ai") && (
          <Suspense fallback={<LoadingIndicator className="py-4" />}>
            <VideoAiPanel
              target={ai.target}
              canSummarize={ai.canAiSummarize}
              canChat={ai.canAiChat}
              showCosts={ai.showAiCosts}
              showToast={showToast}
            />
          </Suspense>
        )}

        <WatchMeta
          description={descriptionBody}
          chapters={chapters}
          queueVisible={queueVisible}
          notes={video ? video.notes : null}
          tags={video ? video.tags : []}
          aiTags={video ? video.ai_tags : []}
          userTags={video ? video.user_tags : []}
          chaptersSource={ai.chaptersSource}
          chapterGenerate={
            ai.showChapterActions
              ? {
                  generating: ai.chapterBusy,
                  hasExisting: ai.hasAiChapters,
                  showGenerate: ai.showChapterGenerate,
                  onGenerate: (force) => void ai.generateChapters(force),
                  error: ai.chapterError,
                }
              : null
          }
          onAddTag={
            video
              ? async (cleaned) => {
                  const updated = await api.updateVideo(video.id, {
                    tags: [...(video.tags || []), cleaned],
                    user_tag: cleaned,
                  });
                  onVideoUpdated(updated);
                }
              : undefined
          }
          onRemoveTag={
            video
              ? async (tag) => {
                  const next = (video.tags || []).filter(
                    (t) => t.toLowerCase() !== tag.toLowerCase()
                  );
                  const updated = await api.updateVideo(video.id, {
                    tags: next,
                  });
                  onVideoUpdated(updated);
                }
              : undefined
          }
          onTagError={(msg) => showToast(msg)}
        />
      </div>

      {!sidebarShown && queueVisible && (
        <PlaybackQueue className="lg:sticky lg:top-20 lg:self-start" />
      )}
    </div>
  );
}
