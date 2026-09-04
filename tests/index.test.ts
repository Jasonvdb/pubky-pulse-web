import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pulse } from "../src/index";
import type { IngestRequest, LogEvent } from "../src/types";
import { resetTestEnvironment, testDocument, testWindow } from "./setup";

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
  return fetchMock.mock.calls.flatMap(
    (call) => (JSON.parse((call[1] as RequestInit).body as string) as IngestRequest).events,
  );
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

    const events = sentEvents();
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

    const event = sentEvents()[0];
    expect(event?.session_id).toBe(Pulse.sessionId);
    expect(event?.user_id).toMatch(/^pulse_anon_/);
  });

  it("reuses the anonymous id across configure calls", async () => {
    Pulse.configure(config);
    Pulse.info("first");
    await Pulse.flush();
    const first = sentEvents()[0]?.user_id;

    await Pulse.shutdown();
    Pulse.configure(config);
    Pulse.info("second");
    await Pulse.flush();

    expect(sentEvents().at(-1)?.user_id).toBe(first);
  });

  it("records an error value with its reserved attributes", async () => {
    Pulse.configure(config);
    Pulse.error(new TypeError("bad input"), "checkout failed", { step: "pay" });
    await Pulse.flush();

    const event = sentEvents()[0];
    expect(event?.level).toBe("error");
    expect(event?.message).toBe("checkout failed");
    expect(event?.custom_attributes?._error_type).toBe("TypeError");
    expect(event?.custom_attributes?.step).toBe("pay");
  });

  it("lets sdk error attributes win over caller attributes", async () => {
    Pulse.configure(config);
    Pulse.error(new RangeError("nope"), undefined, { _error_type: "Spoofed" });
    await Pulse.flush();

    expect(sentEvents()[0]?.custom_attributes?._error_type).toBe("RangeError");
  });

  it("supports the plain message error overload", async () => {
    Pulse.configure(config);
    Pulse.error("payment_declined", { code: "insufficient_funds" });
    await Pulse.flush();

    const event = sentEvents()[0];
    expect(event?.message).toBe("payment_declined");
    expect(event?.custom_attributes).toEqual({ code: "insufficient_funds" });
  });

  it("applies a screen name from the log options", async () => {
    Pulse.configure(config);
    Pulse.debug("rendered", undefined, { screenName: "Checkout" });
    await Pulse.flush();

    expect(sentEvents()[0]?.screen_name).toBe("Checkout");
  });

  it("flushes with keepalive when the page is hidden or unloaded", () => {
    Pulse.configure(config);
    Pulse.info("last_event");

    testDocument.visibilityState = "hidden";
    testDocument.dispatchEvent(new Event("visibilitychange"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).keepalive).toBe(true);
  });

  it("stops listening after shutdown", async () => {
    Pulse.configure(config);
    await Pulse.shutdown();
    fetchMock.mockClear();

    testWindow.dispatchEvent(new Event("pagehide"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Pulse.sessionId).toBeUndefined();
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
