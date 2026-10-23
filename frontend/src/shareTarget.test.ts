import { describe, expect, it } from "vitest";
import { bookmarkletHref, sharedUrlFromParams } from "./shareTarget";

const params = (query: string) => new URLSearchParams(query);

describe("sharedUrlFromParams", () => {
  it("takes a plain url parameter", () => {
    expect(
      sharedUrlFromParams(params("url=https%3A%2F%2Fyoutu.be%2Fxyz%3Ft%3D5"))
    ).toBe("https://youtu.be/xyz?t=5");
  });

  it("pulls the link out of Android's text parameter", () => {
    expect(
      sharedUrlFromParams(
        params(
          "title=Some+video&text=" +
            encodeURIComponent("Check this out https://youtu.be/xyz")
        )
      )
    ).toBe("https://youtu.be/xyz");
  });

  it("prefers url over text and text over title", () => {
    expect(
      sharedUrlFromParams(
        params("url=https://a.example/1&text=see+https://b.example/2")
      )
    ).toBe("https://a.example/1");
    expect(
      sharedUrlFromParams(
        params("text=see+https://b.example/2&title=https://c.example/3")
      )
    ).toBe("https://b.example/2");
    expect(sharedUrlFromParams(params("title=https://c.example/3"))).toBe(
      "https://c.example/3"
    );
  });

  it("drops trailing punctuation and keeps only the first link", () => {
    expect(
      sharedUrlFromParams(
        params(
          "text=" +
            encodeURIComponent(
              "Watch https://a.example/1. Then https://b.example/2"
            )
        )
      )
    ).toBe("https://a.example/1");
  });

  it("returns null for junk or non-http links", () => {
    for (const q of [
      "",
      "text=hello+there",
      "url=javascript%3Aalert(1)",
      "url=ftp%3A%2F%2Fexample.com%2Ff",
      "title=&text=&url=",
    ]) {
      expect(sharedUrlFromParams(params(q)), q).toBeNull();
    }
  });
});

describe("bookmarkletHref", () => {
  it("opens this origin's download page with the current address", () => {
    const href = bookmarkletHref("https://horde.lan:8686");
    expect(href.startsWith("javascript:")).toBe(true);
    expect(href).toContain('"https://horde.lan:8686/download?url="');
    expect(href).toContain("encodeURIComponent(location.href)");
  });

  it("escapes the origin so it cannot break out of the string", () => {
    const href = bookmarkletHref('http://x"y');
    expect(href).toContain('"http://x\\"y/download?url="');
  });
});
