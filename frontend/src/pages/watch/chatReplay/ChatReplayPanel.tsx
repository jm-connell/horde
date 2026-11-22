import { useId, useLayoutEffect, useRef, useState, type UIEvent } from "react";
import { button } from "../../../components/buttons";
import { ArrowIcon } from "../../../components/icons";
import LoadingIndicator from "../../../components/LoadingIndicator";
import type { ChatReplayItem } from "../../../types";
import type { ChatReplayState } from "./useChatReplay";

export type ChatPanelVariant =
  "sidebar" | "inline" | "beside-info" | "sideways" | "fullscreen";

/** Within this many pixels of the bottom counts as "at the newest message". */
const BOTTOM_SLACK_PX = 24;

const HEIGHT: Record<ChatPanelVariant, string> = {
  // About the player's height beside it.
  sidebar: "h-[min(40rem,calc(100vh-8rem))]",
  inline: "h-96",
  "beside-info": "h-96",
  // A third of a phone turned sideways, at most the sidebar's width.
  sideways: "h-full w-[min(24rem,33vw)]",
  fullscreen: "h-full w-[min(24rem,33vw)]",
};

function errorNote(code: string | null): string {
  if (code === "youtube_rate_limited") {
    return "YouTube is limiting requests right now.";
  }
  if (code === "youtube_unreachable") return "Could not reach YouTube.";
  return "Could not load the live chat.";
}

function AuthorName({ item }: { item: ChatReplayItem }) {
  const name = item.author || "Unknown";
  const badges = item.badges ?? [];
  if (badges.includes("owner")) {
    return (
      <span className="rounded-md bg-ink-800 px-1.5 py-0.5 font-medium text-accent">
        {name}
      </span>
    );
  }
  const role = badges.includes("moderator")
    ? "Moderator"
    : badges.includes("member")
      ? "Member"
      : null;
  return (
    <span
      className={
        role === "Moderator"
          ? "font-medium text-accent-soft"
          : role === "Member"
            ? "font-medium text-success"
            : "text-muted"
      }
      title={role ?? undefined}
    >
      {name}
      {role && <span className="sr-only"> ({role})</span>}
      {badges.includes("verified") && (
        <span className="ml-0.5" title="Verified">
          <span aria-hidden>✓</span>
          <span className="sr-only">verified</span>
        </span>
      )}
    </span>
  );
}

function Runs({ item }: { item: ChatReplayItem }) {
  return (
    <>
      {(item.runs ?? []).map((run, i) =>
        run.emoji_url ? (
          <img
            // Runs have no id and never reorder within a message.
            key={i}
            src={run.emoji_url}
            alt={run.emoji_alt ?? ""}
            title={run.emoji_alt ?? undefined}
            loading="lazy"
            className="inline h-[1.25em] w-auto align-text-bottom"
          />
        ) : (
          <span key={i}>{run.text}</span>
        )
      )}
    </>
  );
}

function ChatMessage({ item }: { item: ChatReplayItem }) {
  if (item.kind === "paid" || item.kind === "sticker") {
    return (
      <div
        data-id={item.id}
        data-kind={item.kind}
        className="rounded-r-md border-l-4 border-accent bg-ink-800 px-2 py-1.5"
        // YouTube's tier colour as the accent stripe only.
        style={item.color ? { borderLeftColor: item.color } : undefined}
      >
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <AuthorName item={item} />
          {item.amount && (
            <span className="font-semibold text-gray-100">{item.amount}</span>
          )}
        </div>
        {item.kind === "sticker" && item.sticker_url ? (
          <img
            src={item.sticker_url}
            alt={item.sticker_alt ?? "Sticker"}
            loading="lazy"
            className="mt-1 h-12 w-auto"
          />
        ) : (
          <p className="mt-0.5 break-words text-gray-200">
            <Runs item={item} />
          </p>
        )}
      </div>
    );
  }
  if (item.kind === "membership" || item.kind === "gift") {
    return (
      <div
        data-id={item.id}
        data-kind={item.kind}
        className="text-xs text-muted"
      >
        <AuthorName item={item} />
        {item.header && <span className="ml-1.5">{item.header}</span>}
        {(item.runs ?? []).length > 0 && (
          <p className="mt-0.5 break-words text-sm text-gray-200">
            <Runs item={item} />
          </p>
        )}
      </div>
    );
  }
  return (
    <div
      data-id={item.id}
      data-kind="text"
      className="break-words leading-snug"
    >
      <span className="mr-1.5 text-xs">
        <AuthorName item={item} />
      </span>
      <span className="text-gray-200">
        <Runs item={item} />
      </span>
    </div>
  );
}

/**
 * A past stream's chat replay, newest message at the bottom. It follows new
 * messages; scrolling up to read pauses that (the list stays put while
 * messages keep arriving) until **Jump to latest** or scrolling back down.
 */
export default function ChatReplayPanel({
  chat,
  variant,
  onHide,
}: {
  chat: ChatReplayState & { note?: string | null };
  variant: ChatPanelVariant;
  onHide: () => void;
}) {
  const headingId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  // The first message in view and its distance from the top, so the list can
  // stay put while paused even as old messages drop off the top.
  const anchorRef = useRef<{ id: string; top: number } | null>(null);
  const { items, status } = chat;

  const captureAnchor = (el: HTMLDivElement) => {
    for (const child of Array.from(el.children) as HTMLElement[]) {
      if (child.offsetTop + child.offsetHeight > el.scrollTop) {
        const id = child.dataset.id;
        anchorRef.current = id
          ? { id, top: child.offsetTop - el.scrollTop }
          : null;
        return;
      }
    }
    anchorRef.current = null;
  };

  const setPausedBoth = (value: boolean) => {
    pausedRef.current = value;
    setPaused(value);
  };

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX;
    if (atBottom !== !pausedRef.current) setPausedBoth(!atBottom);
    captureAnchor(el);
  };

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (!pausedRef.current) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    const anchor = anchorRef.current;
    if (!anchor) return;
    const node = Array.from(el.children).find(
      (child) => (child as HTMLElement).dataset.id === anchor.id
    ) as HTMLElement | undefined;
    if (node) el.scrollTop = node.offsetTop - anchor.top;
  }, [items]);

  const jumpToLatest = () => {
    setPausedBoth(false);
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  if (status === "idle" || status === "none" || status === "unavailable") {
    return null;
  }

  return (
    <section
      aria-labelledby={headingId}
      data-horde="chat-replay"
      data-variant={variant}
      className={`ui-panel flex min-h-0 flex-col rounded-xl border border-ink-700 bg-ink-900 ring-1 ring-ink-700 ${HEIGHT[variant]}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-ink-700 px-4 py-2">
        <h2 id={headingId} className="text-sm font-semibold text-gray-100">
          Live chat
        </h2>
        <button
          type="button"
          className={button("quiet", "xs")}
          onClick={onHide}
        >
          Hide
        </button>
      </div>
      {chat.note && (
        <p className="border-b border-ink-700 px-4 py-1.5 text-xs text-muted">
          {chat.note}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        {status === "error" ? (
          <div className="px-4 py-3 text-sm" role="status">
            <p className="text-warning">{errorNote(chat.errorCode)}</p>
            <button
              type="button"
              className={`${button("secondary", "xs")} mt-2`}
              onClick={chat.retry}
            >
              Retry
            </button>
          </div>
        ) : (
          <div
            ref={listRef}
            role="log"
            // A busy chat would otherwise be read aloud over the video.
            aria-live="off"
            aria-label="Live chat messages"
            data-horde="chat-replay-messages"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be keyboard-focusable (axe scrollable-region-focusable)
            tabIndex={0}
            onScroll={onScroll}
            className="horde-scrollbar relative h-full space-y-1.5 overflow-y-auto px-4 py-2 text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            {items.map((item) => (
              <ChatMessage key={item.id} item={item} />
            ))}
          </div>
        )}
        {status === "loading" && items.length === 0 && (
          <LoadingIndicator
            label="Loading live chat"
            className="absolute inset-0 py-0"
          />
        )}
        {paused && status !== "error" && (
          <button
            type="button"
            aria-label="Jump to latest"
            title="Jump to latest"
            onClick={jumpToLatest}
            className="ui-interactive absolute bottom-3 left-1/2 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-ink-600 bg-ink-800 text-gray-100 shadow-lg hover:border-accent hover:text-accent"
          >
            <ArrowIcon className="h-4 w-4 -rotate-90" />
          </button>
        )}
      </div>
    </section>
  );
}

/** Where the chat would be, while it is hidden: one click brings it back. */
export function ShowChatBar({
  onShow,
  vertical = false,
}: {
  onShow: () => void;
  vertical?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onShow}
      className={`${button("secondary", "sm")} ${
        vertical ? "h-full w-10 [writing-mode:vertical-rl]" : "w-full"
      } justify-center`}
    >
      Show live chat
    </button>
  );
}
