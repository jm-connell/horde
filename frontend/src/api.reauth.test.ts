import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  PERMISSION_DENIED_EVENT,
  REAUTH_REQUIRED_EVENT,
  api,
  type ReauthRequestDetail,
} from "./api";

const REAUTH_BODY = {
  detail: "Confirm your password to continue",
  code: "reauth_required",
};

function reply(status: number, body?: unknown): Response {
  return body === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
}

/** A window that answers a reauth request the way the dialog would. */
function stubWindow(answer: "confirm" | "cancel" | "nobody") {
  const target = new EventTarget();
  const denied: string[] = [];
  target.addEventListener(PERMISSION_DENIED_EVENT, (e) =>
    denied.push((e as CustomEvent<string>).detail)
  );
  let asked = 0;
  if (answer !== "nobody") {
    target.addEventListener(REAUTH_REQUIRED_EVENT, (e) => {
      asked += 1;
      const detail = (e as CustomEvent<ReauthRequestDetail>).detail;
      detail.handled = true;
      detail.settle(answer === "confirm");
    });
  }
  vi.stubGlobal("window", target);
  return { denied, asked: () => asked };
}

afterEach(() => vi.unstubAllGlobals());

describe("a 403 reauth_required", () => {
  it("asks for the password, then sends the same request once more", async () => {
    const win = stubWindow("confirm");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(403, REAUTH_BODY))
      .mockResolvedValueOnce(reply(201, { id: 7 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.createUser({ username: "kid", password: "kid-password-1" });

    expect(win.asked()).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[0][0]);
    expect(fetchMock.mock.calls[1][1].body).toBe(
      fetchMock.mock.calls[0][1].body
    );
    // The dialog handles it: no "not allowed" toast.
    expect(win.denied).toEqual([]);
  });

  it("fails with the error when the user cancels", async () => {
    stubWindow("cancel");
    const fetchMock = vi.fn(() => Promise.resolve(reply(403, REAUTH_BODY)));
    vi.stubGlobal("fetch", fetchMock);

    const err = await api
      .createUser({ username: "kid", password: "kid-password-1" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("reauth_required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails at once when nothing can ask", async () => {
    stubWindow("nobody");
    const fetchMock = vi.fn(() => Promise.resolve(reply(403, REAUTH_BODY)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.createUser({ username: "kid", password: "kid-password-1" })
    ).rejects.toMatchObject({ code: "reauth_required" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks only once per request, even if the retry is refused again", async () => {
    const win = stubWindow("confirm");
    const fetchMock = vi.fn(() => Promise.resolve(reply(403, REAUTH_BODY)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.createUser({ username: "kid", password: "kid-password-1" })
    ).rejects.toMatchObject({ code: "reauth_required" });
    expect(win.asked()).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("other 403s", () => {
  it("still announce their detail", async () => {
    const win = stubWindow("confirm");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          reply(403, { detail: "Admins only", code: "admin_required" })
        )
    );
    await expect(
      api.createUser({ username: "kid", password: "kid-password-1" })
    ).rejects.toBeInstanceOf(ApiError);
    expect(win.denied).toEqual(["Admins only"]);
    expect(win.asked()).toBe(0);
  });
});
