import { describe, expect, it, vi } from "vitest";
import { confirmPendingOnLeave } from "./useChannelDownloadQueue";

describe("confirmPendingOnLeave", () => {
  it("submits every pending download that is still counting down", () => {
    const submit = vi.fn();
    confirmPendingOnLeave(
      [
        { tempId: 1, submitting: false },
        { tempId: 2, submitting: false },
        { tempId: 3, submitting: false },
      ],
      submit
    );
    expect(submit.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  it("skips items already submitting and does nothing when empty", () => {
    const submit = vi.fn();
    confirmPendingOnLeave(
      [
        { tempId: 1, submitting: true },
        { tempId: 2, submitting: false },
      ],
      submit
    );
    expect(submit.mock.calls.map((c) => c[0])).toEqual([2]);

    submit.mockClear();
    confirmPendingOnLeave([], submit);
    expect(submit).not.toHaveBeenCalled();
  });
});
