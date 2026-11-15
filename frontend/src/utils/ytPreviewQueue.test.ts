import { describe, expect, it, vi } from "vitest";
import { enqueueYtPreview } from "./ytPreviewQueue";

describe("enqueueYtPreview", () => {
  it("runs tasks one at a time, in order", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = enqueueYtPreview(
      () =>
        new Promise<void>((resolve) => {
          order.push("first:start");
          releaseFirst = () => {
            order.push("first:end");
            resolve();
          };
        })
    );
    const second = enqueueYtPreview(async () => {
      order.push("second");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("skips a queued task whose signal aborted before its turn", async () => {
    let releaseFirst!: () => void;
    const first = enqueueYtPreview(
      () => new Promise<void>((resolve) => (releaseFirst = resolve))
    );
    const controller = new AbortController();
    const skipped = vi.fn(async () => "ran");
    const queued = enqueueYtPreview(skipped, controller.signal);
    const after = vi.fn(async () => "after");
    const next = enqueueYtPreview(after);

    // The first task starts on a later microtask.
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    controller.abort();
    releaseFirst();
    await first;

    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(skipped).not.toHaveBeenCalled();
    await expect(next).resolves.toBe("after");
  });

  it("waits for a started task even when its signal aborts", async () => {
    let releaseFirst!: () => void;
    const controller = new AbortController();
    // A task that would cancel its request if it were handed the signal.
    const first = enqueueYtPreview(
      (signal?: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          releaseFirst = resolve;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        }),
      controller.signal
    );
    const next = vi.fn(async () => "next");
    const second = enqueueYtPreview(next);

    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    // The card unmounts while its lookup is on the server.
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();

    releaseFirst();
    await first;
    await expect(second).resolves.toBe("next");
  });
});
