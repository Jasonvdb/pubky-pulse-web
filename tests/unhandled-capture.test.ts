import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installUnhandledCapture, type UnhandledKind } from "../src/unhandled-capture";
import { resetTestEnvironment, testWindow } from "./setup";

/** The browser's ErrorEvent is not a Node global; the fields are what matter. */
function errorEvent(fields: { error?: unknown; message?: string }): Event {
  return Object.assign(new Event("error"), fields);
}

function rejectionEvent(reason: unknown): Event {
  return Object.assign(new Event("unhandledrejection"), { reason });
}

describe("installUnhandledCapture", () => {
  let captured: Array<[unknown, UnhandledKind]>;
  let uninstall: () => void;

  beforeEach(() => {
    resetTestEnvironment();
    captured = [];
    uninstall = installUnhandledCapture((value, kind) => {
      captured.push([value, kind]);
    });
  });

  afterEach(() => {
    uninstall();
  });

  it("captures an uncaught exception with its error value", () => {
    const error = new TypeError("boom");
    testWindow.dispatchEvent(errorEvent({ error, message: "Uncaught TypeError: boom" }));

    expect(captured).toEqual([[error, "uncaught_exception"]]);
  });

  it("falls back to the message when the error object is unavailable", () => {
    testWindow.dispatchEvent(errorEvent({ message: "Script error." }));

    expect(captured).toEqual([["Script error.", "uncaught_exception"]]);
  });

  it("captures an unhandled rejection with its reason", () => {
    const reason = new Error("no network");
    testWindow.dispatchEvent(rejectionEvent(reason));

    expect(captured).toEqual([[reason, "unhandled_rejection"]]);
  });

  it("captures a non-error rejection reason", () => {
    testWindow.dispatchEvent(rejectionEvent("nope"));

    expect(captured).toEqual([["nope", "unhandled_rejection"]]);
  });

  it("never swallows the error", () => {
    const event = errorEvent({ error: new Error("boom") });
    const preventDefault = vi.spyOn(event, "preventDefault");
    const stopPropagation = vi.spyOn(event, "stopPropagation");
    const other = vi.fn();
    testWindow.addEventListener("error", other);

    testWindow.dispatchEvent(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledTimes(1);
    testWindow.removeEventListener("error", other);
  });

  it("does not let a failing handler break the page", () => {
    uninstall();
    uninstall = installUnhandledCapture(() => {
      throw new Error("reporting failed");
    });

    expect(() => testWindow.dispatchEvent(errorEvent({ message: "x" }))).not.toThrow();
  });

  it("stops capturing after uninstall", () => {
    uninstall();

    testWindow.dispatchEvent(errorEvent({ error: new Error("late") }));
    testWindow.dispatchEvent(rejectionEvent("late"));

    expect(captured).toEqual([]);
  });

  it("installs nothing without a window", () => {
    uninstall();
    const original = Object.getOwnPropertyDescriptor(globalThis, "window");
    Reflect.deleteProperty(globalThis, "window");
    try {
      const noop = installUnhandledCapture(() => {
        captured.push(["unexpected", "uncaught_exception"]);
      });
      noop();
      expect(captured).toEqual([]);
    } finally {
      if (original) Object.defineProperty(globalThis, "window", original);
    }
  });
});
