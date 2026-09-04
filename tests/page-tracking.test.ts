import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageTracker } from "../src/page-tracking";
import { resetTestEnvironment, testHistory, testLocation, testWindow } from "./setup";

describe("PageTracker", () => {
  let appeared: ReturnType<typeof vi.fn>;
  let disappeared: ReturnType<typeof vi.fn>;
  let tracker: PageTracker;
  let originalPushState: typeof testHistory.pushState;
  let originalReplaceState: typeof testHistory.replaceState;

  beforeEach(() => {
    resetTestEnvironment();
    originalPushState = testHistory.pushState;
    originalReplaceState = testHistory.replaceState;
    appeared = vi.fn();
    disappeared = vi.fn();
    tracker = new PageTracker({ onAppeared: appeared, onDisappeared: disappeared });
  });

  afterEach(() => {
    tracker.restore();
    testHistory.pushState = originalPushState;
    testHistory.replaceState = originalReplaceState;
  });

  it("reports the page that is already open on install", () => {
    testLocation.pathname = "/pricing";
    tracker.install();

    expect(appeared).toHaveBeenCalledWith("/pricing");
    expect(disappeared).not.toHaveBeenCalled();
    expect(tracker.screenName).toBe("/pricing");
  });

  it("emits a screen change for a pushState navigation", () => {
    tracker.install();
    appeared.mockClear();

    history.pushState(null, "", "/checkout");

    expect(disappeared).toHaveBeenCalledTimes(1);
    expect(disappeared.mock.calls[0]![0]).toBe("/");
    expect(typeof disappeared.mock.calls[0]![1]).toBe("number");
    expect(appeared).toHaveBeenCalledWith("/checkout");
    expect(testLocation.pathname).toBe("/checkout");
  });

  it("emits a screen change for replaceState too", () => {
    tracker.install();
    appeared.mockClear();

    history.replaceState(null, "", "/checkout/payment");

    expect(appeared).toHaveBeenCalledWith("/checkout/payment");
  });

  it("ignores hash-only changes", () => {
    tracker.install();
    appeared.mockClear();

    history.pushState(null, "", "#features");

    expect(appeared).not.toHaveBeenCalled();
    expect(disappeared).not.toHaveBeenCalled();
  });

  it("ignores a navigation back to the same path", () => {
    tracker.install();
    appeared.mockClear();

    history.pushState(null, "", "/?ref=email");

    expect(appeared).not.toHaveBeenCalled();
  });

  it("keeps the original history behaviour", () => {
    tracker.install();

    history.pushState({ step: 2 }, "", "/wizard");

    expect(testHistory.state).toEqual({ step: 2 });
  });

  it("follows back and forward navigation", () => {
    tracker.install();
    history.pushState(null, "", "/checkout");
    appeared.mockClear();

    testLocation.pathname = "/";
    testWindow.dispatchEvent(new Event("popstate"));

    expect(appeared).toHaveBeenCalledWith("/");
  });

  it("tracks a screen reported by hand", () => {
    tracker.install();
    appeared.mockClear();

    tracker.trackScreen("Checkout modal");

    expect(appeared).toHaveBeenCalledWith("Checkout modal");
    expect(tracker.screenName).toBe("Checkout modal");
  });

  it("works without install so manual screens still set the default", () => {
    tracker.trackScreen("Onboarding");

    expect(tracker.screenName).toBe("Onboarding");
    expect(disappeared).not.toHaveBeenCalled();
  });

  it("ignores a repeat of the current screen", () => {
    tracker.trackScreen("Settings");
    appeared.mockClear();

    tracker.trackScreen("Settings");

    expect(appeared).not.toHaveBeenCalled();
    expect(disappeared).not.toHaveBeenCalled();
  });

  it("restores the history api and stops tracking on restore", () => {
    tracker.install();
    tracker.restore();
    appeared.mockClear();
    disappeared.mockClear();

    expect(testHistory.pushState).toBe(originalPushState);
    expect(testHistory.replaceState).toBe(originalReplaceState);

    history.pushState(null, "", "/after-shutdown");
    testWindow.dispatchEvent(new Event("popstate"));

    expect(appeared).not.toHaveBeenCalled();
    expect(disappeared).not.toHaveBeenCalled();
    expect(tracker.screenName).toBeUndefined();
  });

  it("patches history only once across installs", () => {
    tracker.install();
    const patched = testHistory.pushState;
    tracker.install();

    expect(testHistory.pushState).toBe(patched);

    appeared.mockClear();
    history.pushState(null, "", "/second");
    expect(appeared).toHaveBeenCalledTimes(1);
  });
});
