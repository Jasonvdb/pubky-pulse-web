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
    vi.restoreAllMocks();
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

  it("maps initial load and every navigation type using only the pathname", () => {
    const mapper = vi.fn((pathname: string) => pathname.split("/")[1]!);
    tracker = new PageTracker({ onAppeared: appeared, onDisappeared: disappeared }, mapper);
    history.replaceState(null, "", "/profile/public-key?tab=posts#latest");
    tracker.install();
    history.pushState(null, "", "/post/user-id/post-id?view=full#comments");
    history.replaceState(null, "", "/collections/user-id/post-id");
    testLocation.pathname = "/invite/invitation-code";
    testWindow.dispatchEvent(new Event("popstate"));

    expect(mapper.mock.calls).toEqual([
      ["/profile/public-key"],
      ["/post/user-id/post-id"],
      ["/collections/user-id/post-id"],
      ["/invite/invitation-code"],
    ]);
    expect(appeared.mock.calls).toEqual([["profile"], ["post"], ["collections"], ["invite"]]);
    expect(disappeared.mock.calls.map(([name]) => name)).toEqual(["profile", "post", "collections"]);
    expect(tracker.screenName).toBe("invite");
  });

  it("keeps the original duration when two paths map to the same name", () => {
    let at = 100;
    vi.spyOn(performance, "now").mockImplementation(() => at);
    tracker = new PageTracker(
      { onAppeared: appeared, onDisappeared: disappeared },
      (pathname) => pathname.split("/")[1]!,
    );
    testLocation.pathname = "/profile/first-key";
    tracker.install();
    at = 500;
    history.pushState(null, "", "/profile/second-key");
    expect(appeared).toHaveBeenCalledTimes(1);
    expect(disappeared).not.toHaveBeenCalled();

    at = 1500;
    history.pushState(null, "", "/post/user-id/post-id");
    expect(disappeared).toHaveBeenCalledWith("profile", 1400);
  });

  it("preserves nonblank mapped names exactly", () => {
    tracker = new PageTracker(
      { onAppeared: appeared, onDisappeared: disappeared },
      () => " Profile ",
    );
    tracker.install();
    expect(tracker.screenName).toBe(" Profile ");
    expect(appeared).toHaveBeenCalledWith(" Profile ");
  });

  const failedMappings: [string, () => unknown][] = [
    ["thrown error", () => {
      throw new Error("mapping failed");
    }],
    ["empty string", () => ""],
    ["whitespace", () => " \t\n"],
    ["undefined", () => undefined],
    ["null", () => null],
    ["number", () => 123],
    ["object", () => ({ name: "profile" })],
    ["promise", () => Promise.resolve("profile")],
  ];

  it.each(failedMappings)("leaves an initially failed mapping unattributed: %s", (_label, fail) => {
    testLocation.pathname = "/invite/private-code";
    tracker = new PageTracker(
      { onAppeared: appeared, onDisappeared: disappeared },
      fail as (pathname: string) => string,
    );
    expect(() => tracker.install()).not.toThrow();
    expect(appeared).not.toHaveBeenCalled();
    expect(disappeared).not.toHaveBeenCalled();
    expect(tracker.screenName).toBeUndefined();
  });

  it.each(failedMappings)("ends the old screen and recovers after mapping failure: %s", (_label, fail) => {
    let at = 100;
    vi.spyOn(performance, "now").mockImplementation(() => at);
    tracker = new PageTracker(
      { onAppeared: appeared, onDisappeared: disappeared },
      (pathname) => (pathname.startsWith("/invite/") ? fail() as string : "profile"),
    );
    testLocation.pathname = "/profile/public-key";
    tracker.install();
    at = 600;
    expect(() => history.pushState({ step: 2 }, "", "/invite/private-code")).not.toThrow();
    expect(testHistory.state).toEqual({ step: 2 });
    expect(testLocation.pathname).toBe("/invite/private-code");
    expect(disappeared.mock.calls).toEqual([["profile", 500]]);
    expect(appeared.mock.calls).toEqual([["profile"]]);
    expect(tracker.screenName).toBeUndefined();

    at = 1000;
    expect(() => history.replaceState(null, "", "/invite/another-code")).not.toThrow();
    expect(disappeared).toHaveBeenCalledTimes(1);
    expect(appeared).toHaveBeenCalledTimes(1);
    expect(tracker.screenName).toBeUndefined();

    at = 1500;
    history.pushState(null, "", "/profile/another-key");
    expect(appeared.mock.calls).toEqual([["profile"], ["profile"]]);
    expect(tracker.screenName).toBe("profile");
    at = 1800;
    tracker.trackScreen("Settings");
    expect(disappeared.mock.calls).toEqual([["profile", 500], ["profile", 300]]);
  });

  it("does not map manual screen names", () => {
    const mapper = vi.fn(() => "profile");
    tracker = new PageTracker({ onAppeared: appeared, onDisappeared: disappeared }, mapper);
    tracker.install();
    mapper.mockClear();
    tracker.trackScreen("Checkout modal");
    expect(mapper).not.toHaveBeenCalled();
    expect(tracker.screenName).toBe("Checkout modal");
    expect(appeared).toHaveBeenLastCalledWith("Checkout modal");
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
