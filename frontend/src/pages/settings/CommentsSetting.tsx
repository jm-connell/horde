import { button } from "../../components/buttons";
import { useConfirm } from "../../context/ConfirmContext";
import {
  useCommentsStorage,
  useDeleteSavedComments,
} from "../../queries/comments";
import { describeError } from "../../apiErrors";
import { formatSize } from "../../utils";
import { Toggle } from "./ui";

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/**
 * The one switch for YouTube comments, how much space the saved ones take, and
 * the button that deletes them (only while comments are off, or they would be
 * fetched again). Administrators only.
 */
export default function CommentsSetting({
  enabled,
  onToggle,
  showError,
  showToast,
}: {
  enabled: boolean;
  onToggle: (on: boolean) => void;
  showError: (message: string) => void;
  showToast: (message: string) => void;
}) {
  const confirm = useConfirm();
  const storage = useCommentsStorage(true);
  const remove = useDeleteSavedComments();
  const used = storage.data;
  const none = used !== undefined && used.comments === 0;

  const deleteAll = async () => {
    if (!used) return;
    const ok = await confirm({
      title: "Delete saved comments?",
      body: `Delete the ${plural(used.comments, "comment", "comments")} saved for ${plural(used.videos, "video", "videos")} (${formatSize(used.bytes)}). If you turn comments on again, Horde fetches them from YouTube afresh.`,
      confirmLabel: "Delete comments",
      danger: true,
    });
    if (!ok) return;
    remove.mutate(undefined, {
      onSuccess: () => showToast("Saved comments deleted"),
      onError: (err) =>
        showError(`Could not delete the comments: ${describeError(err)}`),
    });
  };

  let usage: string;
  if (storage.isError) usage = "Could not work out how much space they take.";
  else if (!used) usage = "Working out how much space they take…";
  else if (none) usage = "No comments are saved.";
  else
    usage = `Saved comments take ${formatSize(used.bytes)} (${plural(used.comments, "comment", "comments")} of ${plural(used.videos, "video", "videos")}).${
      enabled ? " Turn comments off to delete them." : ""
    }`;

  return (
    <div data-setting="comments" className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-gray-200">Comments</p>
          <p className="text-xs text-muted">
            Shows YouTube comments under videos. Horde saves the top 100 of
            every YouTube video in the library, with replies to the most popular
            ones, in the background, and uses them in search and video chat. Off
            hides them everywhere and stops fetching; saved comments are kept
            and come back when it is on again.
          </p>
        </div>
        <Toggle
          checked={enabled}
          onChange={() => onToggle(!enabled)}
          label="Comments"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={button("danger", "sm")}
          disabled={enabled || none || !used || remove.isPending}
          onClick={() => void deleteAll()}
        >
          {remove.isPending ? "Deleting…" : "Delete saved comments"}
        </button>
        <span className="text-xs text-muted">{usage}</span>
      </div>
    </div>
  );
}
