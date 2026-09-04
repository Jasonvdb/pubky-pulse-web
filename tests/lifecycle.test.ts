import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLifecycle, UNLOAD_DEBOUNCE_MS } from "../src/lifecycle";
import { resetTestEnvironment, testDocument, testWindow } from "./setup";

describe("installLifecycle", () => {
  let onHidden: ReturnType<typeof vi.fn>;
  let onVisible: ReturnType<typeof vi.fn>;
  let uninstall: () => void;

  beforeEach(() => {
    resetTestEnvironment();
    vi.useFakeTimers({ toFake: ["Date"] });
    onHidden = vi.fn();
    onVisible = vi.fn();
    uninstall = installLifecycle({ onHidden, onVisible });
  });

  afterEach(() => {
    uninstall();
    vi.useRealTimers();
  });

  function hide(): void {
    testDocument.visibilityState = "hidden";
    testDocument.dispatchEvent(new Event("visibilitychange"));
  }

  function show(): void {
    testDocument.visibilityState = "visible";
    testDocument.dispatchEvent(new Event("visibilitychange"));
  }

  it("flushes on pagehide", () => {
    testWindow.dispatchEvent(new Event("pagehide"));
    expect(onHidden).toHaveBeenCalledTimes(1);
  });

  it("flushes when the page becomes hidden", () => {
    hide();
    expect(onHidden).toHaveBeenCalledTimes(1);
    expect(onVisible).not.toHaveBeenCalled();
  });

  it("debounces the two unload signals firing back to back", () => {
    hide();
    testWindow.dispatchEvent(new Event("pagehide"));
    expect(onHidden).toHaveBeenCalledTimes(1);
  });

  it("flushes again once the debounce window has passed", () => {
    hide();
    vi.setSystemTime(Date.now() + UNLOAD_DEBOUNCE_MS);
    show();
    hide();
    expect(onHidden).toHaveBeenCalledTimes(2);
  });

  it("checks the session when the page comes back into view", () => {
    hide();
    show();
    expect(onVisible).toHaveBeenCalledTimes(1);
  });

  it("stops listening after uninstall", () => {
    uninstall();
    testWindow.dispatchEvent(new Event("pagehide"));
    hide();
    show();
    expect(onHidden).not.toHaveBeenCalled();
    expect(onVisible).not.toHaveBeenCalled();
  });

  it("installs nothing without a window", () => {
    uninstall();
    const original = Object.getOwnPropertyDescriptor(globalThis, "window");
    Reflect.deleteProperty(globalThis, "window");
    try {
      const noop = installLifecycle({ onHidden, onVisible });
      hide();
      noop();
      expect(onHidden).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(globalThis, "window", original);
    }
  });
});
