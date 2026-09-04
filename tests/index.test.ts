import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pulse } from "../src/index";
import type { IngestRequest, LogEvent } from "../src/types";
import { ANONYMOUS_ID_KEY, USER_ID_KEY } from "../src/identity";
import { STORAGE_PREFIX } from "../src/storage";
import {
  resetTestEnvironment,
  testDocument,
  testLocalStorage,
  testLocation,
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
