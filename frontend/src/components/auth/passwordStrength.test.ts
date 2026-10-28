import { describe, expect, it } from "vitest";
import { passwordStrength } from "./passwordStrength";

describe("passwordStrength", () => {
  it("rates short and common passwords very weak", () => {
    expect(passwordStrength("a")).toBe(0);
    expect(passwordStrength("password")).toBe(0);
    expect(passwordStrength("Password1!")).toBe(0);
    expect(passwordStrength("aaaaaaaaaaaa")).toBe(0);
  });

  it("rises with length and variety", () => {
    expect(passwordStrength("sunflower")).toBe(1);
    expect(passwordStrength("Sunflower42")).toBe(2);
    expect(passwordStrength("correct horse battery staple")).toBe(3);
    expect(passwordStrength("T7#qL9!vR2@m")).toBe(3);
  });
});
