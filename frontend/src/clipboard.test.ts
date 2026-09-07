import { describe, expect, it } from "vitest";
import {
  clipboardEventToText,
  clipboardReadAvailable,
  clipboardTextToUrl,
  execPasteInto,
  pasteTextFromButtonClick,
  readClipboardText,
  shouldCapturePagePaste,
} from "./clipboard";

describe("clipboardTextToUrl", () => {
  it("trims and keeps a bare URL", () => {
    expect(clipboardTextToUrl("  https://youtu.be/dQw4w9WgXcQ  \n")).toBe(
      "https://youtu.be/dQw4w9WgXcQ"
    );
  });

  it("pulls the first URL out of surrounding text", () => {
    expect(
      clipboardTextToUrl("watch this\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ extra")
    ).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("returns the first line when there is no URL", () => {
    expect(clipboardTextToUrl("not a link\nsecond")).toBe("not a link");
  });

  it("keeps only the URL token on a mixed first line", () => {
    expect(
      clipboardTextToUrl("https://youtu.be/dQw4w9WgXcQ copied from YouTube.")
    ).toBe("https://youtu.be/dQw4w9WgXcQ");
  });
});

describe("clipboardEventToText", () => {
  it("prefers text/plain", () => {
    expect(
      clipboardEventToText({
        getData: (type) => (type === "text/plain" ? " https://youtu.be/a " : ""),
      })
    ).toBe(" https://youtu.be/a ");
  });

  it("falls back to an href in text/html", () => {
    expect(
      clipboardEventToText({
        getData: (type) =>
          type === "text/html"
            ? '<a href="https://youtu.be/dQw4w9WgXcQ">video</a>'
            : "",
      })
    ).toBe("https://youtu.be/dQw4w9WgXcQ");
  });
});

describe("clipboardReadAvailable", () => {
  it("is false when the Clipboard API is missing (HTTP LAN / live deploy)", () => {
    expect(clipboardReadAvailable({})).toBe(false);
    expect(clipboardReadAvailable({ clipboard: {} })).toBe(false);
  });

  it("is true when readText or read exists (localhost / HTTPS)", () => {
    expect(
      clipboardReadAvailable({ clipboard: { readText: async () => "" } })
    ).toBe(true);
    expect(clipboardReadAvailable({ clipboard: { read: async () => [] } })).toBe(
      true
    );
  });
});

describe("shouldCapturePagePaste", () => {
  const urlInput = { tagName: "INPUT" };

  it("lets the URL field handle native paste", () => {
    expect(shouldCapturePagePaste(urlInput, urlInput)).toBe(false);
  });

  it("does not steal paste from other fields", () => {
    expect(shouldCapturePagePaste({ tagName: "INPUT" }, urlInput)).toBe(false);
    expect(shouldCapturePagePaste({ tagName: "TEXTAREA" }, urlInput)).toBe(false);
    expect(
      shouldCapturePagePaste({ tagName: "DIV", isContentEditable: true }, urlInput)
    ).toBe(false);
  });

  it("captures paste from the page or the Paste button", () => {
    expect(shouldCapturePagePaste({ tagName: "BUTTON" }, urlInput)).toBe(true);
    expect(shouldCapturePagePaste({ tagName: "BODY" }, urlInput)).toBe(true);
    expect(shouldCapturePagePaste(null, urlInput)).toBe(true);
  });
});

describe("execPasteInto", () => {
  it("focuses the field then runs execCommand in the same turn", () => {
    const order: string[] = [];
    const el = {
      focus: () => order.push("focus"),
      select: () => order.push("select"),
    };
    const ok = execPasteInto(el, (command) => {
      order.push(command);
      return true;
    });
    expect(ok).toBe(true);
    expect(order).toEqual(["focus", "select", "paste"]);
  });

  it("returns false when there is no field", () => {
    expect(execPasteInto(null, () => true)).toBe(false);
  });
});

describe("pasteTextFromButtonClick", () => {
  it("runs execPaste synchronously when the Clipboard API is missing", async () => {
    const order: string[] = [];
    let readCalled = false;
    const pending = pasteTextFromButtonClick({
      clipboardReadAvailable: false,
      readClipboard: async () => {
        readCalled = true;
        order.push("read");
        return "https://youtu.be/dQw4w9WgXcQ";
      },
      execPaste: () => {
        order.push("exec");
        return true;
      },
    });
    // Must not wait on a microtask — that is the live-deploy HTTP failure mode.
    expect(order).toEqual(["exec"]);
    expect(await pending).toBe("");
    expect(readCalled).toBe(false);
  });

  it("reads the clipboard and does not execCommand when the API exists", async () => {
    let exec = false;
    const text = await pasteTextFromButtonClick({
      clipboardReadAvailable: true,
      readClipboard: async () => "https://youtu.be/dQw4w9WgXcQ",
      execPaste: () => {
        exec = true;
        return true;
      },
    });
    expect(text).toBe("https://youtu.be/dQw4w9WgXcQ");
    expect(exec).toBe(false);
  });
});

describe("readClipboardText", () => {
  it("returns empty when the Clipboard API is missing", async () => {
    expect(await readClipboardText()).toBe("");
  });

  it("returns clipboard text when readText succeeds", async () => {
    const previous = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          readText: async () => "  https://youtu.be/dQw4w9WgXcQ  ",
        },
      },
    });
    try {
      expect(await readClipboardText()).toBe("  https://youtu.be/dQw4w9WgXcQ  ");
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: previous,
      });
    }
  });

  it("returns empty when readText is denied", async () => {
    const previous = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          readText: async () => {
            throw new Error("NotAllowedError");
          },
          read: async () => [{ types: ["text/plain"] }],
        },
      },
    });
    try {
      expect(await readClipboardText()).toBe("");
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: previous,
      });
    }
  });

  it("reads an href from HTML when text/plain is empty", async () => {
    const previous = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          readText: async () => "  ",
          read: async () => [
            {
              types: ["text/html"],
              getType: async () => ({
                text: async () =>
                  '<a href="https://youtu.be/dQw4w9WgXcQ">video</a>',
              }),
            },
          ],
        },
      },
    });
    try {
      expect(await readClipboardText()).toBe("https://youtu.be/dQw4w9WgXcQ");
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: previous,
      });
    }
  });
});
