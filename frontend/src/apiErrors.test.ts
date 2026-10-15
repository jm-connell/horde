import { describe, expect, it } from "vitest";
import { formatValidationDetail } from "./apiErrors";

describe("formatValidationDetail", () => {
  it("formats FastAPI 422 arrays", () => {
    expect(
      formatValidationDetail([
        {
          type: "missing",
          loc: ["body", "url"],
          msg: "Field required",
          input: {},
        },
        {
          type: "int_parsing",
          loc: ["query", "limit"],
          msg: "Input should be a valid integer",
        },
        { type: "value_error", loc: ["body"], msg: "Value error, bad" },
      ])
    ).toBe(
      "url: Field required; limit: Input should be a valid integer; Value error, bad"
    );
  });

  it("keeps nested paths", () => {
    expect(
      formatValidationDetail([
        { loc: ["body", "ui", "items", 2, "name"], msg: "Too short" },
      ])
    ).toBe("ui.items.2.name: Too short");
  });

  it("returns null for other shapes", () => {
    expect(formatValidationDetail("nope")).toBeNull();
    expect(formatValidationDetail([])).toBeNull();
    expect(formatValidationDetail({ message: "x" })).toBeNull();
    expect(formatValidationDetail([{ loc: ["body"] }])).toBeNull();
  });
});
