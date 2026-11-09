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

  it("hands the signal to the task so it can cancel its request", async () => {
    const controller = new AbortController();
    const seen = await enqueueYtPreview(
      async (signal) => signal,
      controller.signal
    );
    expect(seen).toBe(controller.signal);
  });
});
