import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pulse } from "../src/index";
import type { IngestRequest, LogEvent } from "../src/types";
import { ANONYMOUS_ID_KEY, USER_ID_KEY } from "../src/identity";
import { resetSlugWarning } from "../src/metrics";
import { STORAGE_PREFIX } from "../src/storage";
import {
  resetTestEnvironment,
  testDocument,
  testLocalStorage,
  testLocation,
  testNavigator,
  testWindow,
} from "./setup";

const config = {
  endpoint: "https://pulse.example.com/",
  apiKey: "pulse_client_abc",
  bundleId: "com.example.web",
  consoleLogging: false,
  compressionEnabled: false,
  flushThreshold: 1000,
};

let fetchMock: ReturnType<typeof vi.fn>;

function sentEvents(): LogEvent[] {
  return fetchMock.mock.calls
    .filter((call) => (call[0] as string).endsWith("/v1/ingest"))
    .flatMap(
      (call) => (JSON.parse((call[1] as RequestInit).body as string) as IngestRequest).events,
    );
}

/** Bodies posted to one of the identity endpoints. */
function identityPosts(path: string): unknown[] {
  return fetchMock.mock.calls
    .filter((call) => (call[0] as string).endsWith(path))
    .map((call) => JSON.parse((call[1] as RequestInit).body as string) as unknown);
}

/** Every request path, in the order the SDK issued them. */
function requestPaths(): string[] {
  return fetchMock.mock.calls.map((call) => new URL(call[0] as string).pathname);
}

/** Events the host app logged, without the SDK's own lifecycle chatter. */
function appEvents(): LogEvent[] {
  return sentEvents().filter((event) => !event.message.startsWith("sdk:"));
}

describe("Pulse", () => {
  beforeEach(() => {
    resetTestEnvironment();
    resetSlugWarning();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await Pulse.shutdown();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("ignores log calls made before configure", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    Pulse.info("too early");
    await Pulse.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("buffers events and sends them on flush", async () => {
    Pulse.configure(config);
    Pulse.info("signed_up", { plan: "pro" });
    Pulse.warn("slow_response");

    await Pulse.flush();

    const events = appEvents();
    expect(events.map((e) => e.message)).toEqual(["signed_up", "slow_response"]);
    expect(events[0]?.level).toBe("info");
    expect(events[0]?.custom_attributes).toEqual({ plan: "pro" });
    expect(events[1]?.level).toBe("warn");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://pulse.example.com/v1/ingest");
  });

  it("sanitizes enriched manual and automatic errors before console and delivery", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const beforeSend = vi.fn((event: LogEvent) => {
      expect(event.session_id).toBe(Pulse.sessionId);
      expect(event.user_id).toBe(Pulse.currentUserId);
      event.message = event.message.replaceAll("private@example.com", "[redacted]");
      for (const key of Object.keys(event.custom_attributes ?? {})) {
        event.custom_attributes![key] = event.custom_attributes![key]!.replaceAll(
          "private@example.com", "[redacted]",
        );
      }
      return event;
    });
    Pulse.configure({ ...config, beforeSend, consoleLogging: true });
    const error = new Error("private@example.com", { cause: new Error("private@example.com") });
    Pulse.error(error);
    testWindow.dispatchEvent(Object.assign(new Event("error"), { error }));
    testWindow.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: error }));
    await Pulse.flush();
    expect(appEvents()).toHaveLength(3);
    expect(JSON.stringify(sentEvents())).not.toContain("private@example.com");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("private@example.com");
    expect(appEvents()[1]?.custom_attributes?._error_stack).toContain("[redacted]");
    expect(beforeSend).toHaveBeenCalledTimes(sentEvents().length);
  });

  it("uses transformed severity and detaches buffered data from callback references", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    let retained: LogEvent | undefined;
    Pulse.configure({
      ...config,
      consoleLogging: true,
      supportedLanguages: ["en"],
      beforeSend(event) {
        if (event.message === "original") {
          event.message = "clean";
          event.level = "warn";
          event.custom_attributes = { detail: "safe" };
          retained = event;
        }
        return event;
      },
    });
    Pulse.info("original");
    expect(console.warn).toHaveBeenCalledWith("[pulse] WARN  clean {detail=safe}");
    retained!.message = "late-private";
    retained!.custom_attributes!.detail = "late-private";
    retained!.supported_languages![0] = "late-private";
    Pulse.info("next");
    await Pulse.flush();
    expect(JSON.stringify(sentEvents())).not.toContain("late-private");
    expect(appEvents()[0]).toMatchObject({ message: "clean", level: "warn" });
    expect(appEvents()[1]?.supported_languages).toEqual(["en"]);
  });

  it.each([
    ["null", () => null],
    ["throw", () => { throw new Error("private-hook-error"); }],
    ["undefined", () => undefined],
    ["invalid object", () => ({ message: "private" })],
    ["wrong attributes", (event: LogEvent) => ({ ...event, custom_attributes: { bad: {} } })],
    ["async", async () => { throw new Error("private-hook-error"); }],
  ])("silently drops a %s hook result and allows later events", async (_label, invalid) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    Pulse.configure({
      ...config,
      debug: true,
      consoleLogging: true,
      beforeSend: (event) => event.message === "private" ? invalid(event) as LogEvent | null : event,
    });
    expect(() => Pulse.info("private")).not.toThrow();
    Pulse.info("healthy");
    await Pulse.flush();
    expect(appEvents().map((event) => event.message)).toEqual(["healthy"]);
    expect(consoleError).not.toHaveBeenCalled();
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain("private");
  });

  it("ignores recursive logging from the hook", async () => {
    const beforeSend = vi.fn((event: LogEvent) => {
      Pulse.error("recursive");
      return event;
    });
    Pulse.configure({ ...config, beforeSend });
    Pulse.info("healthy");
    await Pulse.flush();
    expect(appEvents().map((event) => event.message)).toEqual(["healthy"]);
    expect(beforeSend).toHaveBeenCalledTimes(sentEvents().length);
  });

  it("transforms automatic network URLs without changing the request or response", async () => {
    Pulse.configure({
      ...config,
      networkTracking: true,
      beforeSend(event) {
        if (event.custom_attributes?._http_url) event.custom_attributes._http_url = "/post/:id";
        return event;
      },
    });
    const response = await fetch("https://api.example.com/post/private?token=secret");
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.com/post/private?token=secret");
    await Pulse.flush();
    expect(sentEvents().find((event) => event.message === "sdk:network_request")
      ?.custom_attributes?._http_url).toBe("/post/:id");
  });

  it("persists and unloads only processed events, without processing retries again", async () => {
    vi.useFakeTimers();
    const beforeSend = vi.fn((event: LogEvent) => ({ ...event, message: "sanitized" }));
    Pulse.configure({ ...config, beforeSend });
    Pulse.info("private");
    testNavigator.onLine = false;
    testWindow.dispatchEvent(new Event("pagehide"));
    const parked = testLocalStorage.keys().filter((key) => key.includes("offline_queue"))
      .map((key) => testLocalStorage.getItem(key)).join("");
    expect(parked).toContain("sanitized");
    expect(parked).not.toContain("private");
    const calls = beforeSend.mock.calls.length;
    testNavigator.onLine = true;
    await Pulse.flush();
    expect(beforeSend).toHaveBeenCalledTimes(calls);
    Pulse.info("private");
    vi.advanceTimersByTime(1001);
    testWindow.dispatchEvent(new Event("pagehide"));
    expect(JSON.stringify(sentEvents())).not.toContain("private");
    expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit).keepalive)).toBe(true);
  });

  it("reapplies message and attribute caps to transformed events", async () => {
    Pulse.configure({
      ...config,
      beforeSend: (event) => ({
        ...event,
        message: "x".repeat(2100),
        custom_attributes: { detail: "x".repeat(300), _error_stack: "x".repeat(17000) },
      }),
    });
    Pulse.info("original");
    await Pulse.flush();
    expect(sentEvents()[0]?.message).toHaveLength(2000);
    expect(sentEvents()[0]?.custom_attributes?.detail).toHaveLength(200);
    expect(sentEvents()[0]?.custom_attributes?._error_stack).toHaveLength(16000);
  });

  it("stamps a session id and an anonymous user id on every event", async () => {
    Pulse.configure(config);
    Pulse.info("hello");
    await Pulse.flush();

    const event = appEvents()[0];
    expect(event?.session_id).toBe(Pulse.sessionId);
    expect(event?.user_id).toMatch(/^pulse_anon_/);
  });

  it("reuses the anonymous id across configure calls", async () => {
    Pulse.configure(config);
    Pulse.info("first");
    await Pulse.flush();
    const first = appEvents()[0]?.user_id;

    await Pulse.shutdown();
    Pulse.configure(config);
    Pulse.info("second");
    await Pulse.flush();

    expect(appEvents().at(-1)?.user_id).toBe(first);
  });

  it("records an error value with its reserved attributes", async () => {
    Pulse.configure(config);
    Pulse.error(new TypeError("bad input"), "checkout failed", { step: "pay" });
    await Pulse.flush();

    const event = appEvents()[0];
    expect(event?.level).toBe("error");
    expect(event?.message).toBe("checkout failed");
    expect(event?.custom_attributes?._error_type).toBe("TypeError");
    expect(event?.custom_attributes?.step).toBe("pay");
  });

  it("lets sdk error attributes win over caller attributes", async () => {
    Pulse.configure(config);
    Pulse.error(new RangeError("nope"), undefined, { _error_type: "Spoofed" });
    await Pulse.flush();

    expect(appEvents()[0]?.custom_attributes?._error_type).toBe("RangeError");
  });

  it("supports the plain message error overload", async () => {
    Pulse.configure(config);
    Pulse.error("payment_declined", { code: "insufficient_funds" });
    await Pulse.flush();

    const event = appEvents()[0];
    expect(event?.message).toBe("payment_declined");
    expect(event?.custom_attributes).toEqual({ code: "insufficient_funds" });
  });

  it("applies a screen name from the log options", async () => {
    Pulse.configure(config);
    Pulse.debug("rendered", undefined, { screenName: "Checkout" });
    await Pulse.flush();

    expect(appEvents()[0]?.screen_name).toBe("Checkout");
  });

  it("flushes with keepalive when the page is hidden or unloaded", () => {
    Pulse.configure(config);
    Pulse.info("last_event");

    testDocument.visibilityState = "hidden";
    testDocument.dispatchEvent(new Event("visibilitychange"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).keepalive).toBe(true);
  });

  it("emits a session start event with the launch duration", async () => {
    Pulse.configure(config);
    await Pulse.flush();

    const started = sentEvents().find((e) => e.message === "sdk:session_started");
    expect(started?.session_id).toBe(Pulse.sessionId);
    expect(started?.custom_attributes?._launch_ms).toMatch(/^\d+$/);
  });

  it("resumes the session on a later configure without a second start event", async () => {
    Pulse.configure(config);
    const first = Pulse.sessionId;
    await Pulse.shutdown();

    Pulse.configure(config);
    Pulse.info("after_reload");
    await Pulse.flush();

    expect(Pulse.sessionId).toBe(first);
    expect(sentEvents().filter((e) => e.message === "sdk:session_started")).toHaveLength(1);
  });

  it("renews the session after the idle timeout", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    Pulse.configure({ ...config, sessionTimeoutMs: 60_000 });
    Pulse.info("before_idle");
    const first = Pulse.sessionId;

    vi.setSystemTime(Date.now() + 60_000);
    Pulse.info("after_idle");
    await Pulse.flush();

    const second = Pulse.sessionId;
    expect(second).not.toBe(first);

    const lifecycle = sentEvents().filter((e) => e.message.startsWith("sdk:session_"));
    expect(lifecycle.map((e) => [e.message, e.session_id])).toEqual([
      ["sdk:session_started", first],
      ["sdk:session_ended", first],
      ["sdk:session_started", second],
    ]);
    expect(appEvents().map((e) => [e.message, e.session_id])).toEqual([
      ["before_idle", first],
      ["after_idle", second],
    ]);
  });

  it("flushes anonymous events before claiming them for the new user", async () => {
    Pulse.configure(config);
    const anonymousId = Pulse.currentUserId;
    Pulse.info("browsed");

    await Pulse.setUser("user-42");
    Pulse.info("purchased");
    await Pulse.flush();

    expect(requestPaths()).toEqual(["/v1/ingest", "/v1/identity/claim", "/v1/ingest"]);
    expect(identityPosts("/v1/identity/claim")).toEqual([
      { anonymous_id: anonymousId, user_id: "user-42" },
    ]);
    expect(Pulse.currentUserId).toBe("user-42");

    const byMessage = new Map(appEvents().map((e) => [e.message, e.user_id]));
    expect(byMessage.get("browsed")).toBe(anonymousId);
    expect(byMessage.get("purchased")).toBe("user-42");
  });

  it("claims a persisted user id in the background on configure", async () => {
    testLocalStorage.setItem(STORAGE_PREFIX + ANONYMOUS_ID_KEY, "pulse_anon_saved");
    testLocalStorage.setItem(STORAGE_PREFIX + USER_ID_KEY, "user-99");

    Pulse.configure(config);
    expect(Pulse.currentUserId).toBe("user-99");

    await vi.waitFor(() => {
      expect(identityPosts("/v1/identity/claim")).toEqual([
        { anonymous_id: "pulse_anon_saved", user_id: "user-99" },
      ]);
    });
  });

  it("reverts to the anonymous id on clearUser", async () => {
    Pulse.configure(config);
    const anonymousId = Pulse.currentUserId;
    await Pulse.setUser("user-1");

    Pulse.clearUser();

    expect(Pulse.currentUserId).toBe(anonymousId);
    expect(testLocalStorage.getItem(STORAGE_PREFIX + USER_ID_KEY)).toBeNull();
  });

  it("mints a fresh anonymous id when clearUser is asked to", async () => {
    Pulse.configure(config);
    const anonymousId = Pulse.currentUserId;
    await Pulse.setUser("user-1");

    Pulse.clearUser({ newAnonymousId: true });

    expect(Pulse.currentUserId).toMatch(/^pulse_anon_/);
    expect(Pulse.currentUserId).not.toBe(anonymousId);
  });

  it("posts user properties for the current identity", async () => {
    Pulse.configure(config);
    await Pulse.setUser("user-5");

    await Pulse.setUserProperties({ plan: "pro", legacy_flag: "" });

    expect(identityPosts("/v1/identity/properties")).toEqual([
      { user_id: "user-5", properties: { plan: "pro", legacy_flag: "" } },
    ]);
  });

  it("ignores identity calls made before configure", async () => {
    await Pulse.setUser("user-1");
    await Pulse.setUserProperties({ plan: "pro" });
    Pulse.clearUser();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(Pulse.currentUserId).toBeUndefined();
  });

  it("stops listening after shutdown", async () => {
    Pulse.configure(config);
    await Pulse.shutdown();
    fetchMock.mockClear();

    testWindow.dispatchEvent(new Event("pagehide"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Pulse.sessionId).toBeUndefined();
  });

  it("reports the page that is open when configure runs", async () => {
    testLocation.pathname = "/pricing";
    Pulse.configure(config);
    Pulse.info("viewed_plans");
    await Pulse.flush();

    const appeared = sentEvents().find((e) => e.message === "sdk:screen_appeared");
    expect(appeared?.level).toBe("debug");
    expect(appeared?.screen_name).toBe("/pricing");
    expect(appEvents()[0]?.screen_name).toBe("/pricing");
  });

  it("tracks a history navigation as a screen change", async () => {
    Pulse.configure(config);
    history.pushState(null, "", "/checkout");
    Pulse.info("started_checkout");
    await Pulse.flush();

    const screens = sentEvents().filter((e) => e.message.startsWith("sdk:screen_"));
    expect(screens.map((e) => [e.message, e.screen_name])).toEqual([
      ["sdk:screen_appeared", "/"],
      ["sdk:screen_disappeared", "/"],
      ["sdk:screen_appeared", "/checkout"],
    ]);
    expect(screens[1]?.custom_attributes?._duration_ms).toMatch(/^\d+$/);
    expect(appEvents()[0]?.screen_name).toBe("/checkout");
  });

  it("uses mapped names in automatic events, durations, and subsequent logs", async () => {
    testLocation.pathname = "/profile/public-key";
    Pulse.configure({ ...config, screenNameForPath: (pathname) => pathname.split("/")[1]! });
    Pulse.info("viewed_profile");
    history.pushState(null, "", "/post/user-id/post-id");
    Pulse.info("viewed_post");
    history.replaceState(null, "", "/collections/user-id/post-id");
    Pulse.info("viewed_collection");
    testLocation.pathname = "/invite/private-code";
    testWindow.dispatchEvent(new Event("popstate"));
    Pulse.info("viewed_invite");
    await Pulse.flush();

    const screens = sentEvents().filter((e) => e.message.startsWith("sdk:screen_"));
    expect(screens.map((e) => [e.message, e.screen_name])).toEqual([
      ["sdk:screen_appeared", "profile"],
      ["sdk:screen_disappeared", "profile"],
      ["sdk:screen_appeared", "post"],
      ["sdk:screen_disappeared", "post"],
      ["sdk:screen_appeared", "collections"],
      ["sdk:screen_disappeared", "collections"],
      ["sdk:screen_appeared", "invite"],
    ]);
    for (const event of screens.filter((e) => e.message === "sdk:screen_disappeared")) {
      expect(event.custom_attributes?._duration_ms).toMatch(/^\d+$/);
    }
    expect(appEvents().map((e) => e.screen_name)).toEqual(["profile", "post", "collections", "invite"]);
    for (const event of sentEvents()) {
      if (event.screen_name) {
        expect(["profile", "post", "collections", "invite"]).toContain(event.screen_name);
      }
    }
  });

  it("clears event attribution after a mapper throws and recovers on the next valid route", async () => {
    testLocation.pathname = "/profile/public-key";
    Pulse.configure({
      ...config,
      screenNameForPath: (pathname) => {
        if (pathname.startsWith("/invite/")) throw new Error("cannot map private-code");
        return "profile";
      },
    });
    expect(() => history.pushState(null, "", "/invite/private-code")).not.toThrow();
    Pulse.info("unmapped_page");
    history.pushState(null, "", "/profile/another-key");
    Pulse.info("mapped_again");
    await Pulse.flush();

    expect(appEvents().map((e) => [e.message, e.screen_name])).toEqual([
      ["unmapped_page", undefined],
      ["mapped_again", "profile"],
    ]);
    const screens = sentEvents().filter((e) => e.message.startsWith("sdk:screen_"));
    expect(screens.map((e) => [e.message, e.screen_name])).toEqual([
      ["sdk:screen_appeared", "profile"],
      ["sdk:screen_disappeared", "profile"],
      ["sdk:screen_appeared", "profile"],
    ]);
    expect(JSON.stringify(sentEvents())).not.toContain("private-code");
  });

  const invalidAsyncMappers: [string, (pathname: string) => unknown][] = [
    ["async throw", async (pathname) => { throw new Error(pathname); }],
    ["rejected promise", (pathname) => Promise.reject(new Error(pathname))],
    ["rejecting thenable", (pathname) => ({
      then(_resolve: unknown, reject: (reason: unknown) => void) {
        reject(new Error(pathname));
      },
    })],
    ["throwing then getter", (pathname) => ({
      get then() { throw new Error(pathname); },
    })],
    ["resolved promise", () => Promise.resolve("invalid_async_name")],
  ];

  it.each(invalidAsyncMappers)("contains invalid mapper results without error telemetry: %s", async (_label, invalidMapper) => {
    // These tests use a fake window; bridge Node's rejection event to browser capture.
    const onUnhandled = vi.fn((reason: unknown) => {
      testWindow.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }));
    });
    process.on("unhandledRejection", onUnhandled);
    try {
      testLocation.pathname = "/profile/public-key";
      Pulse.configure({
        ...config,
        screenNameForPath: ((pathname: string) => pathname.startsWith("/invite/")
          ? invalidMapper(pathname)
          : "profile") as (pathname: string) => string,
      });
      expect(() => history.pushState(null, "", "/invite/private-code")).not.toThrow();
      Pulse.info("unmapped_page");
      // Allow promise assimilation and the unhandled-rejection checkpoint to finish.
      await new Promise((resolve) => setTimeout(resolve, 0));
      Pulse.info("still_unmapped");
      await Pulse.flush();

      expect(onUnhandled).not.toHaveBeenCalled();
      expect(appEvents().map((e) => [e.message, e.screen_name])).toEqual([
        ["unmapped_page", undefined],
        ["still_unmapped", undefined],
      ]);
      const screens = sentEvents().filter((e) => e.message.startsWith("sdk:screen_"));
      expect(screens.map((e) => [e.message, e.screen_name])).toEqual([
        ["sdk:screen_appeared", "profile"],
        ["sdk:screen_disappeared", "profile"],
      ]);
      expect(sentEvents().some((e) => e.custom_attributes?._unhandled)).toBe(false);
      expect(JSON.stringify(sentEvents())).not.toContain("private-code");
      expect(JSON.stringify(sentEvents())).not.toContain("invalid_async_name");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("preserves explicit event and manual screen names with automatic mapping enabled", async () => {
    const mapper = vi.fn(() => "profile");
    Pulse.configure({ ...config, screenNameForPath: mapper });
    Pulse.info("explicit", undefined, { screenName: "Checkout" });
    Pulse.trackScreen("Checkout modal");
    Pulse.info("manual");
    await Pulse.flush();

    expect(mapper).toHaveBeenCalledTimes(1);
    expect(appEvents().map((e) => e.screen_name)).toEqual(["Checkout", "Checkout modal"]);
    const screens = sentEvents().filter((e) => e.message.startsWith("sdk:screen_"));
    expect(screens.map((e) => [e.message, e.screen_name])).toEqual([
      ["sdk:screen_appeared", "profile"],
      ["sdk:screen_disappeared", "profile"],
      ["sdk:screen_appeared", "Checkout modal"],
    ]);
  });

  it("does not call the mapper when automatic tracking is disabled", async () => {
    const mapper = vi.fn(() => {
      throw new Error("must not run");
    });
    Pulse.configure({ ...config, trackPageViews: false, screenNameForPath: mapper });
    history.pushState(null, "", "/invite/private-code");
    Pulse.info("before_manual_screen");
    Pulse.trackScreen("Checkout modal");
    Pulse.info("manual");
    await Pulse.flush();

    expect(mapper).not.toHaveBeenCalled();
    expect(appEvents().map((e) => e.screen_name)).toEqual([undefined, "Checkout modal"]);
  });

  it("replaces the mapper on reconfigure and removes it on shutdown", async () => {
    const oldMapper = vi.fn(() => "old");
    const newMapper = vi.fn(() => "new");
    Pulse.configure({ ...config, screenNameForPath: oldMapper });
    Pulse.configure({ ...config, screenNameForPath: newMapper });
    history.pushState(null, "", "/profile/public-key");
    Pulse.info("reconfigured");
    await Pulse.flush();
    expect(oldMapper).toHaveBeenCalledTimes(1);
    expect(newMapper).toHaveBeenCalledTimes(2);
    expect(appEvents().find((e) => e.message === "reconfigured")?.screen_name).toBe("new");

    await Pulse.shutdown();
    history.pushState(null, "", "/post/user-id/post-id");
    testWindow.dispatchEvent(new Event("popstate"));
    expect(newMapper).toHaveBeenCalledTimes(2);
    Pulse.configure(config);
    Pulse.info("without_mapper");
    await Pulse.flush();
    expect(appEvents().find((e) => e.message === "without_mapper")?.screen_name).toBe(
      "/post/user-id/post-id",
    );
  });

  it("leaves the history api alone when page tracking is off", async () => {
    Pulse.configure({ ...config, trackPageViews: false });
    history.pushState(null, "", "/checkout");
    await Pulse.flush();

    expect(sentEvents().filter((e) => e.message.startsWith("sdk:screen_"))).toEqual([]);
    expect(testLocation.pathname).toBe("/checkout");
  });

  it("takes the default screen name from trackScreen", async () => {
    Pulse.configure({ ...config, trackPageViews: false });
    Pulse.trackScreen("Checkout modal");
    Pulse.info("paid");
    await Pulse.flush();

    expect(sentEvents().find((e) => e.message === "sdk:screen_appeared")?.screen_name).toBe(
      "Checkout modal",
    );
    expect(appEvents()[0]?.screen_name).toBe("Checkout modal");
  });

  it("captures an uncaught exception", async () => {
    Pulse.configure(config);
    testWindow.dispatchEvent(
      Object.assign(new Event("error"), { error: new TypeError("boom") }),
    );
    await Pulse.flush();

    const event = appEvents()[0];
    expect(event?.level).toBe("error");
    expect(event?.message).toBe("boom");
    expect(event?.custom_attributes?._error_type).toBe("TypeError");
    expect(event?.custom_attributes?._unhandled).toBe("uncaught_exception");
  });

  it("captures an unhandled rejection", async () => {
    Pulse.configure(config);
    testWindow.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), { reason: new Error("no network") }),
    );
    await Pulse.flush();

    expect(appEvents()[0]?.custom_attributes?._unhandled).toBe("unhandled_rejection");
  });

  it("does not capture unhandled errors when the option is off", async () => {
    Pulse.configure({ ...config, captureUnhandled: false });
    testWindow.dispatchEvent(Object.assign(new Event("error"), { error: new Error("boom") }));
    await Pulse.flush();

    expect(appEvents()).toEqual([]);
  });

  it("records app fetch calls but not its own ingest traffic", async () => {
    Pulse.configure({ ...config, networkTracking: true });
    await fetch("https://api.example.com/orders?token=secret");
    await Pulse.flush();

    const network = sentEvents().filter((e) => e.message === "sdk:network_request");
    expect(network).toHaveLength(1);
    expect(network[0]?.level).toBe("debug");
    expect(network[0]?.custom_attributes?._http_url).toBe("https://api.example.com/orders");
    expect(network[0]?.custom_attributes?._http_status).toBe("200");
  });

  it("propagates the session id to the configured prefixes", async () => {
    Pulse.configure({ ...config, propagateSessionTo: ["/api"] });
    await fetch("/api/orders");
    await Pulse.flush();

    const call = fetchMock.mock.calls.find((c) => c[0] === "/api/orders");
    const headers = new Headers((call?.[1] as RequestInit | undefined)?.headers);
    expect(headers.get("X-Pulse-Session-Id")).toBe(Pulse.sessionId);
    // Propagation alone must not turn on request events.
    expect(sentEvents().filter((e) => e.message === "sdk:network_request")).toEqual([]);
  });

  it("restores the wrapped fetch on shutdown", async () => {
    Pulse.configure({ ...config, networkTracking: true });
    await Pulse.shutdown();

    expect(globalThis.fetch).toBe(fetchMock);
  });

  it("replaces the pipeline when configure runs again without shutdown", async () => {
    Pulse.configure({ ...config, networkTracking: true });
    const firstSession = Pulse.sessionId;
    Pulse.configure({ ...config, networkTracking: true });

    expect(Pulse.sessionId).toBe(firstSession);

    testWindow.dispatchEvent(Object.assign(new Event("error"), { error: new Error("boom") }));
    await fetch("https://api.example.com/orders");
    await Pulse.flush();

    // A second install without the matching uninstall would double every hook.
    expect(sentEvents().filter((e) => e.custom_attributes?._unhandled)).toHaveLength(1);
    expect(sentEvents().filter((e) => e.message === "sdk:network_request")).toHaveLength(1);

    await Pulse.shutdown();
    expect(globalThis.fetch).toBe(fetchMock);
  });

  it("omits the supported languages when they are not configured", async () => {
    Pulse.configure(config);
    Pulse.info("signed_up");
    await Pulse.flush();

    expect(appEvents()[0]?.supported_languages).toBeUndefined();
  });

  it("sends the configured supported languages on every event", async () => {
    Pulse.configure({ ...config, supportedLanguages: ["fr", "de"] });
    Pulse.info("signed_up");
    await Pulse.flush();

    expect(appEvents()[0]?.supported_languages).toEqual(["fr", "de"]);
  });

  it("renews an expired session when the page comes back into view", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    Pulse.configure({ ...config, sessionTimeoutMs: 60_000 });
    const first = Pulse.sessionId;

    testDocument.visibilityState = "hidden";
    testDocument.dispatchEvent(new Event("visibilitychange"));

    vi.setSystemTime(Date.now() + 120_000);
    testDocument.visibilityState = "visible";
    testDocument.dispatchEvent(new Event("visibilitychange"));

    expect(Pulse.sessionId).not.toBe(first);
    await Pulse.flush();
    expect(
      sentEvents().filter((e) => e.message === "sdk:session_started").map((e) => e.session_id),
    ).toEqual([first, Pulse.sessionId]);
  });

  it("sends a metric operation as a start and a terminal event", async () => {
    Pulse.configure(config);
    const operation = Pulse.startOperation("photo-upload", { size: "big" });
    operation.complete({ frames: "24" });
    await Pulse.flush();

    const events = appEvents();
    expect(events.map((e) => e.message)).toEqual([
      "metric:photo-upload:start",
      "metric:photo-upload:complete",
    ]);
    expect(events[0]?.custom_attributes?.tracking_id).toBe(operation.trackingId);
    expect(events[0]?.custom_attributes?.size).toBe("big");
    expect(events[1]?.custom_attributes?.tracking_id).toBe(operation.trackingId);
    expect(events[1]?.custom_attributes?.duration_ms).toMatch(/^\d+$/);
  });

  it("sends a failed operation at error level with the error attribute", async () => {
    Pulse.configure(config);
    Pulse.startOperation("photo upload").fail(new Error("upload rejected"));
    await Pulse.flush();

    const failure = appEvents()[1];
    expect(failure?.message).toBe("metric:photo-upload:fail");
    expect(failure?.level).toBe("error");
    expect(failure?.custom_attributes?.error).toBe("upload rejected");
  });

  it("ignores a second finish on the same operation", async () => {
    Pulse.configure(config);
    const operation = Pulse.startOperation("checkout");
    operation.complete();
    operation.complete();
    operation.fail("too late");
    await Pulse.flush();

    expect(appEvents().map((e) => e.message)).toEqual([
      "metric:checkout:start",
      "metric:checkout:complete",
    ]);
  });

  it("sends single-shot metrics and funnel steps", async () => {
    Pulse.configure(config);
    Pulse.recordMetric("Cache Hit", { source: "memory" });
    Pulse.step("checkout_started", { cart_size: "3" });
    await Pulse.flush();

    const events = appEvents();
    expect(events.map((e) => e.message)).toEqual([
      "metric:cache-hit:record",
      "step:checkout_started",
    ]);
    expect(events.every((e) => e.level === "info")).toBe(true);
    expect(events[0]?.custom_attributes).toEqual({ source: "memory" });
    expect(events[1]?.custom_attributes).toEqual({ cart_size: "3" });
  });

  it("suppresses metric starts in the console but prints the terminal event", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    Pulse.configure({ ...config, consoleLogging: true });

    Pulse.startOperation("photo-upload").complete();
    Pulse.recordMetric("cache-hit");

    const printed = log.mock.calls.map((call) => String(call[0]));
    expect(printed.some((line) => line.includes("metric:photo-upload:start"))).toBe(false);
    expect(printed.some((line) => line.includes("metric:photo-upload:complete"))).toBe(true);
    expect(printed.some((line) => line.includes("metric:cache-hit:record"))).toBe(true);
  });

  it("routes console output by level and renders sorted attributes", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    log.mockClear();
    warn.mockClear();
    error.mockClear();

    Pulse.configure({ ...config, consoleLogging: true });
    Pulse.info("signed_up", { plan: "pro", region: "eu" });
    Pulse.warn("slow_response", { ms: "900" });
    Pulse.error("checkout_failed", { step: "pay" });

    // Padding around the level is not pinned; the parts and routing are.
    const lines = (spy: typeof log): string[] =>
      spy.mock.calls.map((call) => String(call[0]).replace(/\s+/g, " "));

    expect(lines(log)).toEqual(["[pulse] INFO signed_up {plan=pro, region=eu}"]);
    expect(lines(warn)).toEqual(["[pulse] WARN slow_response {ms=900}"]);
    expect(lines(error)).toEqual(["[pulse] ERROR checkout_failed {step=pay}"]);
  });

  it("ignores metric calls before configure", () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    expect(() => Pulse.startOperation("photo-upload").complete()).not.toThrow();
    expect(() => Pulse.recordMetric("photo-upload")).not.toThrow();
    expect(() => Pulse.step("checkout_started")).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores trackScreen before configure", () => {
    expect(() => Pulse.trackScreen("Nowhere")).not.toThrow();
  });

  it("does not install anything without a window", () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const original = Object.getOwnPropertyDescriptor(globalThis, "window");
    Reflect.deleteProperty(globalThis, "window");
    try {
      Pulse.configure(config);
      Pulse.info("ignored");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(Pulse.sessionId).toBeUndefined();
    } finally {
      if (original) Object.defineProperty(globalThis, "window", original);
    }
  });

  it("still validates the configuration during server rendering", () => {
    expect(() => Pulse.configure({ ...config, apiKey: "nope" })).toThrow(/pulse_client_/);
  });
});

describe("Pulse feedback, questionnaires and attachments", () => {
  beforeEach(() => {
    resetTestEnvironment();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock = vi.fn((url: string) => {
      if (url.endsWith("/v1/feedback")) {
        return Promise.resolve(
          new Response(JSON.stringify({ id: "fb_1", created_at: "2026-09-04T10:00:00.000Z" }), {
            status: 201,
          }),
        );
      }
      if (url.includes("/v1/questionnaires/dismiss")) {
        return Promise.resolve(
          new Response(JSON.stringify({ dismissed_at: "2026-09-04T11:00:00.000Z" }), {
            status: 200,
          }),
        );
      }
      if (url.includes("/responses")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "r1",
              created_at: "2026-09-04T10:00:00.000Z",
              was_submitted: true,
            }),
            { status: 201 },
          ),
        );
      }
      if (url.includes("/v1/questionnaires/")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              eligible: true,
              questionnaire: {
                id: "q1",
                slug: "nps-2026",
                name: "NPS",
                description: null,
                schema: {
                  version: 1,
                  questions: [
                    { id: "score", type: "nps", title: "Recommend us?", required: true },
                  ],
                },
              },
            }),
            { status: 200 },
          ),
        );
      }
      if (url.includes("/v1/ingest/attachment")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              attachment_id: "att_1",
              upload_url: "https://uploads.example.com/att_1",
            }),
            { status: 201 },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await Pulse.shutdown();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("submits feedback and records the audit event", async () => {
    Pulse.configure(config);

    const receipt = await Pulse.sendFeedback("  the export button is hiding  ", {
      email: " ada@example.com ",
    });
    await Pulse.flush();

    expect(receipt.id).toBe("fb_1");
    expect(receipt.createdAt.toISOString()).toBe("2026-09-04T10:00:00.000Z");

    const call = fetchMock.mock.calls.find((c) => (c[0] as string).endsWith("/v1/feedback"))!;
    const body = JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.message).toBe("the export button is hiding");
    expect(body.submitter_email).toBe("ada@example.com");
    expect(body).not.toHaveProperty("submitter_name");
    expect(body.bundle_id).toBe("com.example.web");
    expect(body.session_id).toBe(Pulse.sessionId);
    expect(body.user_id).toBe(Pulse.currentUserId);
    expect(body.environment).toBe("web");

    const audit = sentEvents().find((event) => event.message === "sdk:feedback_submitted");
    expect(audit?.custom_attributes).toEqual({ has_email: "true", has_name: "false" });
  });

  it("rejects an empty or oversized feedback message without calling the server", async () => {
    Pulse.configure(config);

    await expect(Pulse.sendFeedback("   ")).rejects.toThrow(/feedback message is required/);
    await expect(Pulse.sendFeedback("m".repeat(4001))).rejects.toThrow(/at most 4000/);
    expect(fetchMock.mock.calls.some((c) => (c[0] as string).endsWith("/v1/feedback"))).toBe(
      false,
    );
  });

  it("refuses feedback and questionnaire calls before configure", async () => {
    await expect(Pulse.sendFeedback("hi")).rejects.toThrow(/before configure/);
    await expect(Pulse.fetchQuestionnaire("nps-2026")).rejects.toMatchObject({
      reason: "not_configured",
    });
    await expect(Pulse.saveQuestionnaireResponse("nps-2026", {}, false)).rejects.toMatchObject({
      reason: "not_configured",
    });
    await expect(Pulse.dismissQuestionnaires()).rejects.toMatchObject({
      reason: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches, saves and dismisses questionnaires with the configured identity", async () => {
    Pulse.configure(config);

    const result = await Pulse.fetchQuestionnaire("nps-2026");
    expect(result.questionnaire?.slug).toBe("nps-2026");
    const fetched = new URL(
      fetchMock.mock.calls.find((c) => (c[0] as string).includes("/v1/questionnaires/nps"))![0] as
        string,
    );
    expect(fetched.searchParams.get("bundle_id")).toBe("com.example.web");
    expect(fetched.searchParams.get("user_id")).toBe(Pulse.currentUserId);

    const receipt = await Pulse.saveQuestionnaireResponse("nps-2026", { score: 9 }, true);
    expect(receipt.wasSubmitted).toBe(true);
    const saveCall = fetchMock.mock.calls.find((c) => (c[0] as string).endsWith("/responses"))!;
    const saved = JSON.parse((saveCall[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(saved.answers).toEqual({ score: 9 });
    expect(saved.is_complete).toBe(true);
    expect(saved.session_id).toBe(Pulse.sessionId);

    const dismissedAt = await Pulse.dismissQuestionnaires();
    expect(dismissedAt).toEqual(new Date("2026-09-04T11:00:00.000Z"));
  });

  it("uploads attachments for the event that carried them", async () => {
    Pulse.configure(config);

    Pulse.error("upload_failed", undefined, {
      attachments: [{ data: new Uint8Array([1, 2, 3]), filename: "trace.log" }],
    });
    await Pulse.flush();

    const event = appEvents().find((e) => e.message === "upload_failed");
    const reserve = fetchMock.mock.calls.find((c) =>
      (c[0] as string).includes("/v1/ingest/attachment"),
    )!;
    const body = JSON.parse((reserve[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.client_event_id).toBe(event?.client_event_id);
    expect(body.original_filename).toBe("trace.log");
    expect(
      fetchMock.mock.calls.some((c) => (c[0] as string).startsWith("https://uploads.example.com/")),
    ).toBe(true);
  });

  it("does not schedule attachments when beforeSend drops their event", async () => {
    Pulse.configure({ ...config, beforeSend: () => null });
    Pulse.error("expected", undefined, {
      attachments: [{ data: new Uint8Array([1, 2, 3]), filename: "private.log" }],
    });
    await Pulse.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses processed event and user identifiers when reserving attachments", async () => {
    const eventId = "1a680a20-a00b-401f-8121-46168056ef01";
    Pulse.configure({
      ...config,
      beforeSend: (event) => ({ ...event, client_event_id: eventId, user_id: undefined }),
    });
    Pulse.error("handled", undefined, {
      attachments: [{ data: new Uint8Array([1, 2, 3]), filename: "trace.log" }],
    });
    await Pulse.flush();
    const reserve = fetchMock.mock.calls.find((call) =>
      (call[0] as string).endsWith("/v1/ingest/attachment"),
    )!;
    const body = JSON.parse((reserve[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.client_event_id).toBe(eventId);
    expect(body.user_id).toBeUndefined();
    expect(appEvents()[0]?.user_id).toBeUndefined();
  });
});
