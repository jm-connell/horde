import { useEffect, useId, useRef, useState } from "react";
import { type InfiniteData, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, type Page } from "../../api";
import { describeError } from "../../apiErrors";
import Collapse from "../../components/Collapse";
import FadeImage from "../../components/FadeImage";
import { useAuth } from "../../context/AuthContext";
import { useConfirm } from "../../context/ConfirmContext";
import { queryKeys } from "../../queries/keys";
import {
  invalidateAfterTrashChange,
  useTrashList,
  useTrashSummary,
} from "../../queries/trash";
import {
  daysLeft,
  daysLeftLabel,
  deletedLabel,
  trashSummaryLine,
  videoCount,
} from "../../trash";
import type { TrashItem } from "../../types";
import { formatSize } from "../../utils";
import { PANEL_BTN } from "./constants";
import { useSettingsPage } from "./context";
import { Section } from "./ui";

const TRASH_TERMS = [
  "trash",
  "bin",
  "recycle",
  "deleted videos",
  "restore",
  "undo",
  "empty trash",
  "delete forever",
];

const SMALL_BTN = `${PANEL_BTN} px-2.5! py-1! text-xs!`;
const DANGER_BTN =
  "ui-interactive rounded-lg border border-danger/40 px-3 py-1.5 text-sm text-danger hover:border-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50";
const DANGER_SMALL_BTN =
  "ui-interactive rounded-lg px-2.5 py-1 text-xs text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Deleted videos waiting to be erased: how much they take, emptying the trash,
 * and a list (collapsed by default) to restore or erase them one by one.
 */
export default function TrashSection() {
  const { match, showToast, showError } = useSettingsPage();
  const { can } = useAuth();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const allowed = can("delete_videos");
  const summaryQuery = useTrashSummary();
  const summary = summaryQuery.data;
  const [open, setOpen] = useState(false);
  const list = useTrashList(allowed && open);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [emptying, setEmptying] = useState(false);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  // Where focus goes once a row it was on has left the list.
  const [focusAfter, setFocusAfter] = useState<number | "toggle" | null>(null);

  const items = list.items;
  useEffect(() => {
    if (focusAfter === null) return;
    if (focusAfter === "toggle") {
      (toggleRef.current ?? summaryRef.current)?.focus();
    } else {
      listRef.current
        ?.querySelector<HTMLButtonElement>(
          `[data-trash-row="${focusAfter}"] button`
        )
        ?.focus();
    }
    setFocusAfter(null);
  }, [focusAfter, items]);

  /** Drop a row from the cached pages at once, and send focus to its neighbour. */
  const removeRow = (id: number) => {
    const index = items.findIndex((item) => item.id === id);
    const neighbour = items[index + 1] ?? items[index - 1];
    queryClient.setQueryData<InfiniteData<Page<TrashItem>>>(
      queryKeys.trash.list,
      (prev) =>
        prev && {
          ...prev,
          pages: prev.pages.map((page) => ({
            ...page,
            items: page.items.filter((item) => item.id !== id),
          })),
        }
    );
    setFocusAfter(neighbour ? neighbour.id : "toggle");
    invalidateAfterTrashChange(queryClient);
  };

  const restore = async (item: TrashItem) => {
    if (busyId !== null) return;
    setBusyId(item.id);
    try {
      await api.restoreFromTrash(item.id);
      removeRow(item.id);
      showToast(`Restored “${item.title}”`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        removeRow(item.id);
        showError(`“${item.title}” is no longer in the trash.`);
      } else if (err instanceof ApiError && err.code === "trash_conflict") {
        showError(`Could not restore “${item.title}”. ${err.message}`);
      } else {
        showError(`Could not restore “${item.title}”: ${describeError(err)}`);
      }
    } finally {
      setBusyId(null);
    }
  };

  const deleteForever = async (item: TrashItem) => {
    if (busyId !== null) return;
    const ok = await confirm({
      title: "Delete forever?",
      body: `“${item.title}”${
        item.size_bytes ? ` (${formatSize(item.size_bytes)})` : ""
      } will be permanently deleted. This can’t be undone.`,
      confirmLabel: "Delete forever",
      danger: true,
    });
    if (!ok) return;
    setBusyId(item.id);
    try {
      await api.deleteFromTrash(item.id);
      removeRow(item.id);
      showToast(`Deleted “${item.title}” forever`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) removeRow(item.id);
      else showError(`Could not delete “${item.title}”: ${describeError(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const emptyTrash = async () => {
    if (!summary?.count || emptying) return;
    const ok = await confirm({
      title: "Empty the trash?",
      body: `Permanently delete ${videoCount(summary.count)} (${
        formatSize(summary.total_bytes) || "0 B"
      })? This can’t be undone.`,
      confirmLabel: "Empty trash",
      danger: true,
    });
    if (!ok) return;
    setEmptying(true);
    try {
      const result = await api.emptyTrash();
      queryClient.setQueryData(queryKeys.trash.summary, {
        ...summary,
        count: 0,
        total_bytes: 0,
      });
      invalidateAfterTrashChange(queryClient);
      setOpen(false);
      setFocusAfter("toggle");
      showToast(
        result.freed_bytes
          ? `Trash emptied, ${formatSize(result.freed_bytes)} freed`
          : "Trash emptied"
      );
    } catch (err) {
      showError(`Could not empty the trash: ${describeError(err)}`);
    } finally {
      setEmptying(false);
    }
  };

  const count = summary?.count ?? 0;

  return (
    <Section title="Trash" hidden={!allowed || !match(...TRASH_TERMS)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p
          ref={summaryRef}
          tabIndex={-1}
          data-horde="trash-summary"
          className="text-sm text-gray-200 outline-hidden"
        >
          {summary
            ? trashSummaryLine(summary, formatSize)
            : summaryQuery.isError
              ? "Could not load the trash."
              : "Loading…"}
        </p>
        <button
          type="button"
          onClick={() => void emptyTrash()}
          disabled={!count || emptying}
          className={DANGER_BTN}
        >
          {emptying ? "Emptying…" : "Empty trash"}
        </button>
      </div>

      {count > 0 || open ? (
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
          className="mt-3 flex items-center gap-1.5 text-xs font-medium text-muted hover:text-gray-200"
        >
          <svg
            aria-hidden
            viewBox="0 0 20 20"
            className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}
            fill="currentColor"
          >
            <path d="M7.2 4.2a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4-1.4L11.5 10 7.2 5.6a1 1 0 0 1 0-1.4Z" />
          </svg>
          {open ? "Hide videos in the trash" : "Show videos in the trash"}
        </button>
      ) : null}

      <Collapse open={open}>
        <div id={listId} className="pt-3">
          {list.isPending && open ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : list.isError ? (
            <p className="text-sm text-danger">
              Could not load the trash: {describeError(list.error)}
            </p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted">The trash is empty.</p>
          ) : (
            <ul
              ref={listRef}
              aria-label="Videos in the trash"
              className="divide-y divide-ink-700 rounded-lg border border-ink-700 bg-ink-950/60"
            >
              {items.map((item) => (
                <TrashRow
                  key={item.id}
                  item={item}
                  busy={busyId === item.id}
                  disabled={busyId !== null || emptying}
                  onRestore={() => void restore(item)}
                  onDelete={() => void deleteForever(item)}
                />
              ))}
            </ul>
          )}
          {list.hasNextPage ? (
            <button
              type="button"
              onClick={() => void list.fetchNextPage()}
              disabled={list.isFetchingNextPage}
              className={`${SMALL_BTN} mt-3`}
            >
              {list.isFetchingNextPage ? "Loading…" : "Show more"}
            </button>
          ) : null}
        </div>
      </Collapse>
    </Section>
  );
}

function TrashRow({
  item,
  busy,
  disabled,
  onRestore,
  onDelete,
}: {
  item: TrashItem;
  busy: boolean;
  disabled: boolean;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const soon = daysLeft(item.expires_at) <= 1;
  return (
    <li
      data-trash-row={item.id}
      className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex aspect-video w-20 shrink-0 items-center justify-center overflow-hidden rounded-md bg-ink-800 sm:w-24">
          {item.thumbnail_url ? (
            <FadeImage
              src={item.thumbnail_url}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover opacity-80"
            />
          ) : (
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              className="h-5 w-5 text-ink-600"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="m10 9 5 3-5 3V9Z" fill="currentColor" />
            </svg>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-gray-200">
            {item.title}
          </p>
          <p className="truncate text-xs text-muted">
            {[item.channel, formatSize(item.size_bytes) || "0 B"]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p className="truncate text-xs text-muted">
            {item.reason || deletedLabel(item.trashed_at, item.trashed_by)}
            {" · "}
            <span className={soon ? "text-warning" : undefined}>
              {daysLeftLabel(item.expires_at)}
            </span>
          </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2 pl-23 sm:pl-0">
        <button
          type="button"
          onClick={onRestore}
          disabled={disabled}
          aria-label={`Restore ${item.title}`}
          className={SMALL_BTN}
        >
          {busy ? "Working…" : "Restore"}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled}
          aria-label={`Delete ${item.title} forever`}
          className={DANGER_SMALL_BTN}
        >
          Delete forever
        </button>
      </div>
    </li>
  );
}
