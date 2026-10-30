import { afterEach, describe, expect, it, vi } from "vitest";
import { api, parseTrashEntryIds, trashEntryIdsOfError } from "./api";
import {
  daysLeft,
  daysLeftLabel,
  deleteConfirmCopy,
  deletedLabel,
  trashSummaryLine,
} from "./trash";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

afterEach(() => vi.unstubAllGlobals());

describe("trash entry headers", () => {
  it("parses one id, several, and ignores junk", () => {
    expect(parseTrashEntryIds("7")).toEqual([7]);
    expect(parseTrashEntryIds("3, 4,5")).toEqual([3, 4, 5]);
    expect(parseTrashEntryIds("x,0,-1,2")).toEqual([2]);
    expect(parseTrashEntryIds(null)).toEqual([]);
    expect(parseTrashEntryIds("")).toEqual([]);
  });

  it("reads the entries of a delete and of a partly failed bulk delete", async () => {
    // A delete announces itself (VIDEOS_DELETED_EVENT) on window.
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, {
            status: 204,
            headers: { "X-Horde-Trash-Entry": "9" },
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ detail: "Could not", code: "trash_failed" }),
            {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                "X-Horde-Trash-Entries": "1,2",
              },
            }
          )
        )
    );
    expect(await api.deleteVideo(5, true)).toEqual({ trashEntryIds: [9] });
    const err = await api.bulkDeleteVideos([1, 2, 3], true).catch((e) => e);
    expect(trashEntryIdsOfError(err)).toEqual([1, 2]);
    expect(trashEntryIdsOfError(new Error("x"))).toEqual([]);
  });
});

describe("delete confirm copy", () => {
  it("offers the trash while it is on", () => {
    const copy = deleteConfirmCopy(7, { count: 1, title: "Aurora" });
    expect(copy.title).toBe("Move to trash?");
    expect(copy.body).toBe(
      "“Aurora” will be removed from your library. Deleted videos are kept for 7 days."
    );
    expect(copy.confirmLabel).toBe("Move to trash");
    expect(deleteConfirmCopy(1, { count: 3 }).title).toBe(
      "Move 3 videos to trash?"
    );
    expect(deleteConfirmCopy(1, { count: 3 }).body).toContain("1 day.");
  });

  it("says the delete is permanent when the trash is off", () => {
    const copy = deleteConfirmCopy(0, { count: 2 });
    expect(copy.title).toBe("Delete 2 videos?");
    expect(copy.body).toContain("permanently deleted");
    expect(copy.confirmLabel).toBe("Delete");
  });

  it("still says trash before the summary loads", () => {
    expect(deleteConfirmCopy(undefined, { count: 1 }).confirmLabel).toBe(
      "Move to trash"
    );
  });
});

describe("trash row labels", () => {
  it("counts the days left, rounding up", () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    expect(daysLeft(at(5 * DAY - 1000), NOW)).toBe(5);
    expect(daysLeftLabel(at(DAY / 2), NOW)).toBe("1 day left");
    expect(daysLeftLabel(at(-1000), NOW)).toBe("Erased soon");
  });

  it("says when and by whom, treating a bare timestamp as UTC", () => {
    expect(deletedLabel("2026-10-21T11:00:00", "jon", NOW)).toBe(
      "Deleted 2 days ago by jon"
    );
    expect(deletedLabel("2026-10-23T08:00:00Z", null, NOW)).toBe(
      "Deleted today"
    );
    expect(deletedLabel("2026-10-22T08:00:00Z", "ada", NOW)).toBe(
      "Deleted yesterday by ada"
    );
  });

  it("summarises the trash", () => {
    const size = (b: number) => `${b} B`;
    expect(
      trashSummaryLine({ count: 12, total_bytes: 40, retention_days: 7 }, size)
    ).toBe("12 videos · 40 B · deleted videos are kept for 7 days");
    expect(
      trashSummaryLine({ count: 0, total_bytes: 0, retention_days: 0 }, size)
    ).toBe("0 videos · the trash is off, so deletes are permanent");
  });
});
