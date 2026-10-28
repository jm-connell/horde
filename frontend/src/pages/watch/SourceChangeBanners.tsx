import { api } from "../../api";
import { describeError } from "../../apiErrors";
import { useToast } from "../../context/ToastContext";
import type { Video } from "../../types";
import { button } from "../../components/buttons";

/** Offers to take over a changed source title or description when the user kept their own. */
export default function SourceChangeBanners({
  video,
  onVideoUpdated,
}: {
  video: Video;
  onVideoUpdated: (video: Video) => void;
}) {
  const { showError } = useToast();
  return (
    <>
      {video.title_is_custom &&
        video.source_title &&
        video.source_title !== video.title && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-ink-800 px-4 py-3 ring-1 ring-ink-600">
            <p className="text-sm text-gray-300">
              Source title changed:{" "}
              <span className="text-gray-400 line-through">{video.title}</span>{" "}
              → <span className="text-gray-200">{video.source_title}</span>
            </p>
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  const updated = await api
                    .updateVideo(video.id, {
                      title: video.source_title!,
                      title_is_custom: false,
                    })
                    .catch((err) => {
                      showError(`Could not save: ${describeError(err)}`);
                      return null;
                    });
                  if (updated) onVideoUpdated(updated);
                }}
                className={button("primary", "xs")}
              >
                Use source
              </button>
              <button
                onClick={async () => {
                  const updated = await api
                    .updateVideo(video.id, {
                      title: video.title,
                      title_is_custom: true,
                    })
                    .catch((err) => {
                      showError(`Could not save: ${describeError(err)}`);
                      return null;
                    });
                  if (updated) onVideoUpdated(updated);
                }}
                className="rounded-lg bg-ink-700 px-3 py-1.5 text-xs font-medium text-gray-200 hover:bg-ink-600"
              >
                Keep mine
              </button>
            </div>
          </div>
        )}

      {video.description_is_custom &&
        video.source_description != null &&
        video.source_description !== (video.description ?? "") && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-ink-800 px-4 py-3 ring-1 ring-ink-600">
            <p className="text-sm text-gray-300">
              Source description changed while your custom description is kept.
            </p>
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  const updated = await api
                    .updateVideo(video.id, {
                      description: video.source_description ?? undefined,
                      description_is_custom: false,
                    })
                    .catch((err) => {
                      showError(`Could not save: ${describeError(err)}`);
                      return null;
                    });
                  if (updated) onVideoUpdated(updated);
                }}
                className={button("primary", "xs")}
              >
                Use source
              </button>
              <button
                onClick={async () => {
                  const updated = await api
                    .updateVideo(video.id, {
                      description: video.description ?? undefined,
                      description_is_custom: true,
                    })
                    .catch((err) => {
                      showError(`Could not save: ${describeError(err)}`);
                      return null;
                    });
                  if (updated) onVideoUpdated(updated);
                }}
                className="rounded-lg bg-ink-700 px-3 py-1.5 text-xs font-medium text-gray-200 hover:bg-ink-600"
              >
                Keep mine
              </button>
            </div>
          </div>
        )}
    </>
  );
}
