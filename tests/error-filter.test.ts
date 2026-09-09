import { describe, expect, it } from "vitest";
import { isIgnoredError, snapshotIgnoreErrors } from "../src/error-filter";

describe("error filtering", () => {
  it("matches strings, qualified names, and complete messages without truncation", () => {
    expect(isIgnoredError(["AbortError"], "cancelled", { _error_type: "AbortError" })).toBe(true);
    expect(isIgnoredError([/^TypeError: bad$/], "bad", { _error_type: "TypeError" })).toBe(true);
    expect(isIgnoredError(["tail"], "x".repeat(3000) + "tail")).toBe(true);
    expect(isIgnoredError(["abort"], "AbortError")).toBe(false);
  });

  it.each([/expected/g, /expected/y])("reuses %s deterministically without caller state", (rule) => {
    rule.lastIndex = 9;
    const rules = snapshotIgnoreErrors([rule]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(isIgnoredError(rules, "expected", { _error_type: "Error" })).toBe(true);
      expect(isIgnoredError(rules, "ordinary")).toBe(false);
      expect(rule.lastIndex).toBe(9);
    }
  });

  it("drops quietly when policy processing fails", () => {
    expect(isIgnoredError(["ignored"], "normal", { get _error_type() { throw new Error("private"); } })).toBe(true);
  });
});
