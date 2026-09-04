import { describe, expect, it } from "vitest";
import { extractErrorAttributes } from "../src/error-extraction";

describe("extractErrorAttributes", () => {
  it("reads the type, message and stack from an Error", () => {
    const error = new TypeError("bad input");
    const { message, attributes } = extractErrorAttributes(error);
    expect(message).toBe("bad input");
    expect(attributes._error_type).toBe("TypeError");
    expect(attributes._error_stack).toContain("bad input");
  });

  it("lets a caller supplied message win", () => {
    const { message } = extractErrorAttributes(new Error("raw"), "  checkout failed  ");
    expect(message).toBe("checkout failed");
  });

  it("ignores a blank caller message", () => {
    expect(extractErrorAttributes(new Error("raw"), "   ").message).toBe("raw");
  });

  it("clips a huge stack to the reserved limit", () => {
    const error = new Error("boom");
    error.stack = "x".repeat(20000);
    expect(extractErrorAttributes(error).attributes._error_stack).toHaveLength(16000);
  });

  it("walks the cause chain", () => {
    const root = new RangeError("root cause");
    const middle = new Error("middle", { cause: root });
    const top = new Error("top", { cause: middle });

    const { attributes } = extractErrorAttributes(top);
    expect(attributes._error_cause_1_type).toBe("Error");
    expect(attributes._error_cause_1_message).toBe("middle");
    expect(attributes._error_cause_2_type).toBe("RangeError");
    expect(attributes._error_cause_2_message).toBe("root cause");
    expect(attributes._error_cause_3_type).toBeUndefined();
  });

  it("stops the cause chain at five levels", () => {
    let error = new Error("level-8");
    for (let i = 7; i >= 0; i -= 1) {
      error = new Error(`level-${i}`, { cause: error });
    }
    const { attributes } = extractErrorAttributes(error);
    expect(attributes._error_cause_5_message).toBe("level-5");
    expect(attributes._error_cause_6_message).toBeUndefined();
  });

  it("survives a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    const { attributes } = extractErrorAttributes(a);
    expect(attributes._error_cause_1_message).toBe("b");
    expect(attributes._error_cause_2_type).toBeUndefined();
  });

  it("records a non-Error cause without recursing further", () => {
    const { attributes } = extractErrorAttributes(new Error("top", { cause: "just a string" }));
    expect(attributes._error_cause_1_type).toBe("string");
    expect(attributes._error_cause_1_message).toBe("just a string");
  });

  it("handles thrown primitives and objects", () => {
    expect(extractErrorAttributes("boom")).toEqual({
      message: "boom",
      attributes: { _error_type: "string" },
    });
    expect(extractErrorAttributes(null).attributes._error_type).toBe("null");
    expect(extractErrorAttributes(undefined).message).toBe("undefined");
    expect(extractErrorAttributes(42).message).toBe("42");
  });

  it("surfaces the first error of an AggregateError", () => {
    const aggregate = new AggregateError([new Error("first"), new Error("second")], "all failed");
    const { attributes } = extractErrorAttributes(aggregate);
    expect(attributes._error_aggregate_count).toBe("2");
    expect(attributes._error_aggregate_first_type).toBe("Error");
    expect(attributes._error_aggregate_first_message).toBe("first");
  });

  it("records a string error code when present", () => {
    const error = Object.assign(new Error("nope"), { code: "ERR_ABORTED" });
    expect(extractErrorAttributes(error).attributes._error_code).toBe("ERR_ABORTED");
  });
});
