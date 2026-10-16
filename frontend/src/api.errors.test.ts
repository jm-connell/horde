import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";

function respondWith(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    )
  );
}

async function failure(): Promise<ApiError> {
  try {
    await api.getVideo(1);
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected the request to fail");
}

afterEach(() => vi.unstubAllGlobals());

describe("ApiError", () => {
  it("reads detail, code and extra from the error envelope", async () => {
    respondWith(409, {
      detail: "Already in library",
      code: "already_in_library",
      extra: { error_kind: "unknown" },
    });
    const err = await failure();
    expect(err.message).toBe("Already in library");
    expect(err.code).toBe("already_in_library");
    expect(err.status).toBe(409);
    expect(err.errorKind).toBe("unknown");
  });

  it("keeps the field list of a validation error", async () => {
    respondWith(422, {
      detail: "url: Field required",
      code: "validation_error",
      fields: [{ loc: ["body", "url"], msg: "Field required" }],
    });
    const err = await failure();
    expect(err.message).toBe("url: Field required");
    expect(err.fields).toEqual([
      { loc: ["body", "url"], msg: "Field required" },
    ]);
  });

  it("falls back to the status text for a body that is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>", { status: 502, statusText: "Bad Gateway" })
        )
    );
    const err = await failure();
    expect(err.message).toBe("Bad Gateway");
    expect(err.status).toBe(502);
  });
});
