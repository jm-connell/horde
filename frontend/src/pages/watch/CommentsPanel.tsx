import { useId, useState } from "react";
import { ApiError } from "../../api";
import { button } from "../../components/buttons";
import { ExternalIcon, HeartIcon } from "../../components/icons";
import LinkifiedText from "../../components/LinkifiedText";
import LoadingIndicator from "../../components/LoadingIndicator";
import { useLiveComments, useVideoComments } from "../../queries/comments";
import type { CommentItem, VideoComments } from "../../types";
import {
  formatCompactCount,
  formatDate,
  formatRelative,
  safeHref,
} from "../../utils";

/** Threads shown at first, and how many more each "Show more" adds. */
const FIRST = 5;
const STEP = 20;
/** The first read from YouTube when nothing is saved (top comments). */
const FIRST_LIVE_LIMIT = 100;
/** Longer comments start clamped to a few lines. */
const LONG_CHARS = 500;
const LONG_LINES = 8;

function youtubeUrl(youtubeId: string, commentId?: string): string {
  const base = `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}`;
  return commentId ? `${base}&lc=${encodeURIComponent(commentId)}` : base;
}

/** Why the panel has no (or only older) comments, from the saved status. */
function savedNote(data: VideoComments, empty: boolean): string | null {
  const saved = data.fetched_at ? formatDate(data.fetched_at) : "";
  switch (data.status) {
    case "pending":
      return empty
        ? "Horde saves the top comments in the background; they will show up here soon."
        : null;
    case "off":
      return "Saving comments is turned off (Settings → Library).";
    case "failed":
      return empty ? "Horde could not fetch the comments from YouTube." : null;
    case "disabled":
      return empty
        ? "Comments are turned off for this video."
        : `Comments are turned off on YouTube now; these were saved ${saved}.`;
    case "unavailable":
      return empty
        ? "This video is no longer available on YouTube."
        : `This video is no longer available on YouTube; these comments were saved ${saved}.`;
    default:
      return empty ? "No comments yet." : null;
  }
}

function liveError(error: unknown): string {
  if (error instanceof ApiError && error.code === "youtube_rate_limited") {
    return "YouTube is limiting requests right now; try again later.";
  }
  return "Could not load comments from YouTube.";
}

function Comment({
  comment,
  youtubeId,
  reply = false,
}: {
  comment: CommentItem;
  youtubeId: string;
  reply?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showReplies, setShowReplies] = useState(false);
  const repliesId = useId();
  const long =
    comment.text.length > LONG_CHARS ||
    comment.text.split("\n").length > LONG_LINES;
  const replies = comment.replies ?? [];
  const likes = comment.like_count ?? 0;

  return (
    <li data-comment-id={comment.id}>
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span
          className={
            comment.author_is_uploader
              ? "rounded-md bg-ink-800 px-1.5 py-0.5 font-medium text-accent"
              : "font-medium text-gray-200"
          }
        >
          {comment.author || "Unknown"}
        </span>
        {comment.is_pinned && <span className="text-muted">Pinned</span>}
        {comment.published_at && (
          <a
            href={safeHref(youtubeUrl(youtubeId, comment.id))}
            target="_blank"
            rel="noreferrer"
            className="text-muted hover:text-accent"
            title="Open this comment on YouTube"
          >
            {formatRelative(comment.published_at)}
          </a>
        )}
      </div>
      <p
        className={`mt-1 whitespace-pre-wrap break-words text-sm text-gray-300 ${
          long && !expanded ? "line-clamp-6" : ""
        }`}
      >
        <LinkifiedText text={comment.text} />
      </p>
      {(long || likes > 0 || comment.is_hearted || replies.length > 0) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {long && (
            <button
              type="button"
              className="ui-interactive text-accent hover:underline"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Show less" : "Read more"}
            </button>
          )}
          {likes > 0 && (
            <span>
              {formatCompactCount(likes)} {likes === 1 ? "like" : "likes"}
            </span>
          )}
          {comment.is_hearted && (
            <span className="inline-flex items-center gap-1 text-accent">
              <HeartIcon /> by the creator
            </span>
          )}
          {!reply && replies.length > 0 && (
            <button
              type="button"
              className="ui-interactive font-medium text-accent hover:underline"
              aria-expanded={showReplies}
              aria-controls={repliesId}
              onClick={() => setShowReplies((v) => !v)}
            >
              {showReplies
                ? "Hide replies"
                : `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
            </button>
          )}
        </div>
      )}
      {!reply && showReplies && (
        <ol
          id={repliesId}
          className="mt-3 ml-1 space-y-3 border-l border-ink-700 pl-3"
        >
          {replies.map((r) => (
            <Comment key={r.id} comment={r} youtubeId={youtubeId} reply />
          ))}
        </ol>
      )}
    </li>
  );
}

/**
 * Comments under the video: the ones saved with a library video, then more
 * read from YouTube on request ("Show more" past the saved ones). A streamed
 * video has none saved, so its comments load when asked for.
 */
export default function CommentsPanel({
  videoId,
  streamYoutubeId,
}: {
  /** A library video: its saved comments. */
  videoId: number | null;
  /** A streamed YouTube video (when `videoId` is null). */
  streamYoutubeId: string | null;
}) {
  const headingId = useId();
  const saved = useVideoComments(videoId);
  const youtubeId =
    videoId !== null ? (saved.data?.youtube_id ?? null) : streamYoutubeId;
  const [liveLimit, setLiveLimit] = useState<number | null>(null);
  const live = useLiveComments(youtubeId, liveLimit);
  const [shown, setShown] = useState(FIRST);

  // Shown once the server says the video has comments to show (not for a file
  // that never came from YouTube), so the panel never flashes in and out.
  if (
    videoId !== null &&
    (saved.isPending || saved.data?.status === "not_youtube")
  )
    return null;
  if (videoId === null && !streamYoutubeId) return null;

  const savedItems = saved.data?.items ?? [];
  const liveData = live.data?.status === "ok" ? live.data : null;
  const seen = new Set(savedItems.map((c) => c.id));
  const items = [
    ...savedItems,
    ...(liveData?.items ?? []).filter((c) => !seen.has(c.id)),
  ];
  const nextLimit =
    liveLimit === null
      ? (saved.data?.next_limit ?? null)
      : (live.data?.next_limit ?? null);
  const total = live.data?.total_count ?? saved.data?.total_count ?? null;
  const loadingLive = live.isFetching;

  let note: string | null = null;
  if (live.data && live.data.status !== "ok" && items.length === 0) {
    note =
      live.data.status === "disabled"
        ? "Comments are turned off for this video."
        : "This video is no longer available on YouTube.";
  } else if (saved.data && liveData === null) {
    note = savedNote(saved.data, items.length === 0);
  }
  // Nothing saved (yet): offer to read them from YouTube now.
  const canLoadNow =
    youtubeId !== null &&
    liveLimit === null &&
    items.length === 0 &&
    (videoId === null ||
      saved.data?.status === "pending" ||
      saved.data?.status === "off" ||
      saved.data?.status === "failed");

  return (
    <section
      aria-labelledby={headingId}
      data-horde="comments"
      className="ui-panel rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 ring-1 ring-ink-700"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={headingId} className="text-sm font-semibold text-gray-100">
          Comments
          {total !== null && total > 0 && (
            <span className="ml-1.5 font-normal text-muted">
              {formatCompactCount(total)}
            </span>
          )}
        </h2>
        {youtubeId && (
          <a
            href={safeHref(youtubeUrl(youtubeId))}
            target="_blank"
            rel="noreferrer"
            className="ui-interactive inline-flex items-center gap-1 text-xs text-muted hover:text-accent"
          >
            On YouTube <ExternalIcon />
          </a>
        )}
      </div>

      {saved.isError && (
        <p className="mt-2 text-sm text-muted">Could not load the comments.</p>
      )}
      {note && <p className="mt-2 text-sm text-muted">{note}</p>}

      {items.length > 0 && youtubeId && (
        <ol className="mt-3 space-y-4">
          {items.slice(0, shown).map((c) => (
            <Comment key={c.id} comment={c} youtubeId={youtubeId} />
          ))}
        </ol>
      )}

      {live.isError && (
        <p className="mt-3 text-sm text-warning" role="status">
          {liveError(live.error)}
        </p>
      )}
      {loadingLive && items.length === 0 && (
        <LoadingIndicator className="py-3" />
      )}

      <div className="mt-3 flex flex-wrap gap-2 empty:hidden">
        {canLoadNow && (
          <button
            type="button"
            className={button("secondary", "xs")}
            disabled={loadingLive}
            onClick={() => setLiveLimit(FIRST_LIVE_LIMIT)}
          >
            {videoId === null ? "Load comments" : "Load them now from YouTube"}
          </button>
        )}
        {shown < items.length ? (
          <button
            type="button"
            className={button("secondary", "xs")}
            onClick={() => setShown((n) => n + STEP)}
          >
            Show more comments
          </button>
        ) : (
          items.length > 0 &&
          nextLimit !== null && (
            <button
              type="button"
              className={button("secondary", "xs")}
              disabled={loadingLive}
              onClick={() => {
                setLiveLimit(nextLimit);
                setShown((n) => n + STEP);
              }}
            >
              {loadingLive ? "Loading from YouTube…" : "Show more comments"}
            </button>
          )
        )}
      </div>
    </section>
  );
}
