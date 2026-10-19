import { describe, expect, it, vi } from "vitest";
import { createDeliveryGate } from "../src/delivery-gate";

describe("createDeliveryGate", () => {
  it("always allows when canDeliver is omitted", () => {
    const onDebug = vi.fn();
    const gate = createDeliveryGate(undefined, onDebug);
    expect(gate()).toBe(true);
    expect(gate()).toBe(true);
    expect(onDebug).not.toHaveBeenCalled();
  });

  it("allows a literal true and asks the callback on every check", () => {
    const canDeliver = vi.fn(() => true);
    const onDebug = vi.fn();
    const gate = createDeliveryGate(canDeliver, onDebug);
    expect(gate()).toBe(true);
    expect(gate()).toBe(true);
    expect(canDeliver).toHaveBeenCalledTimes(2);
    expect(onDebug).not.toHaveBeenCalled();
  });

  it("follows the callback as its answer changes", () => {
    let allowed = true;
    const gate = createDeliveryGate(() => allowed);
    expect(gate()).toBe(true);
    allowed = false;
    expect(gate()).toBe(false);
    allowed = true;
    expect(gate()).toBe(true);
  });

  it("vetoes false and logs the veto", () => {
    const onDebug = vi.fn();
    expect(createDeliveryGate(() => false, onDebug)()).toBe(false);
    expect(onDebug).toHaveBeenCalledWith("canDeliver vetoed delivery, holding events", undefined);
  });

  it.each([
    ["1", 1],
    ["'yes'", "yes"],
    ["'true'", "true"],
    ["undefined", undefined],
    ["null", null],
    ["an object", {}],
    ["a resolved Promise", Promise.resolve(true)],
    ["a thenable", { then: (resolve: (value: boolean) => void) => resolve(true) }],
  ])("vetoes a non-boolean result: %s", (_label, value) => {
    const onDebug = vi.fn();
    const gate = createDeliveryGate(() => value as unknown as boolean, onDebug);
    expect(gate()).toBe(false);
    expect(onDebug).toHaveBeenCalledTimes(1);
  });

  it("vetoes a rejected Promise without leaving an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", listener);
    try {
      const gate = createDeliveryGate(() => Promise.reject(new Error("x")) as unknown as boolean);
      expect(gate()).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("vetoes a thenable whose then throws", () => {
    const thenable = { then: () => { throw new Error("hostile"); } };
    expect(createDeliveryGate(() => thenable as unknown as boolean)()).toBe(false);
  });

  it("vetoes a throwing callback and logs the error", () => {
    const error = new Error("consent store unavailable");
    const onDebug = vi.fn();
    const gate = createDeliveryGate(() => { throw error; }, onDebug);
    expect(gate()).toBe(false);
    expect(onDebug).toHaveBeenCalledWith("canDeliver threw, holding events", error);
  });

  it("vetoes a re-entrant call and recovers once the outer call returns", () => {
    const nested: boolean[] = [];
    let gate: () => boolean = () => true;
    gate = createDeliveryGate(() => {
      nested.push(gate());
      return true;
    });
    expect(gate()).toBe(true);
    expect(nested).toEqual([false]);
    expect(gate()).toBe(true);
    expect(nested).toEqual([false, false]);
  });

  it("releases the re-entrancy guard after a throw", () => {
    let fail = true;
    const gate = createDeliveryGate(() => {
      if (fail) throw new Error("once");
      return true;
    });
    expect(gate()).toBe(false);
    fail = false;
    expect(gate()).toBe(true);
  });

  it("still answers when the debug callback throws", () => {
    const onDebug = vi.fn(() => { throw new Error("console broken"); });
    expect(createDeliveryGate(() => false, onDebug)()).toBe(false);
    expect(createDeliveryGate(() => { throw new Error("x"); }, onDebug)()).toBe(false);
    expect(onDebug).toHaveBeenCalledTimes(2);
  });

  it("vetoes a check that the debug callback re-enters", () => {
    let gate: () => boolean = () => true;
    const nested: boolean[] = [];
    gate = createDeliveryGate(() => false, () => { nested.push(gate()); });
    expect(gate()).toBe(false);
    expect(nested).toEqual([false]);
  });
});
