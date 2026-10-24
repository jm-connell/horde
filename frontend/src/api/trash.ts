import type {
  TrashEmptied,
  TrashItem,
  TrashRestored,
  TrashSummary,
} from "../types";
import { ApiError, type Page, type ReadOptions, request } from "./client";

/** Set by the delete endpoints when the video went to the trash (bulk: comma separated). */
export const TRASH_ENTRY_HEADER = "X-Horde-Trash-Entry";
export const TRASH_ENTRIES_HEADER = "X-Horde-Trash-Entries";

/** The trash entry ids in a delete reply's header; [] when it has none. */
export function parseTrashEntryIds(value: string | null | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
}

/** What a delete put in the trash, so the caller can offer Undo. */
export interface DeleteResult {
  trashEntryIds: number[];
}

/**
 * The videos a failed bulk delete still moved to the trash (its error reply
 * lists them), so Undo can be offered for those.
 */
export function trashEntryIdsOfError(err: unknown): number[] {
  if (!(err instanceof ApiError)) return [];
  return parseTrashEntryIds(err.headers?.get(TRASH_ENTRIES_HEADER));
}

export const trashApi = {
  trashSummary(opts?: ReadOptions): Promise<TrashSummary> {
    return request<TrashSummary>("/api/trash/summary", opts);
  },

  /** One page of the trash, newest first. */
  listTrashPage(
    params: {
      cursor?: string | null;
      limit?: number;
      signal?: AbortSignal;
    } = {}
  ): Promise<Page<TrashItem>> {
    const qs = new URLSearchParams();
    if (params.cursor) qs.set("cursor", params.cursor);
    if (params.limit) qs.set("limit", String(params.limit));
    return request<Page<TrashItem>>(
      `/api/trash?${qs.toString()}`,
      params.signal ? { signal: params.signal } : undefined
    );
  },

  restoreFromTrash(entryId: number): Promise<TrashRestored> {
    return request<TrashRestored>(`/api/trash/${entryId}/restore`, {
      method: "POST",
    });
  },

  deleteFromTrash(entryId: number): Promise<void> {
    return request<void>(`/api/trash/${entryId}`, { method: "DELETE" });
  },

  emptyTrash(): Promise<TrashEmptied> {
    return request<TrashEmptied>("/api/trash/empty", { method: "POST" });
  },
};
