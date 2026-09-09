import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pulse } from "../src/index";
import { PulseOperation } from "../src/operation";
import { nowMs } from "../src/clock";
import { randomUuid } from "../src/event-builder";
import { installLifecycle } from "../src/lifecycle";
import { resetSlugWarning } from "../src/metrics";
import { SafeStorage } from "../src/storage";
import { OfflineQueue } from "../src/offline-queue";
import { Transport } from "../src/transport";
import { validateConfiguration } from "../src/configuration";
import type { LogEvent, PulseAttributes } from "../src/types";
import { resetTestEnvironment, testLocalStorage, testNavigator, testWindow, testDocument } from "./setup";

const config = {
  endpoint: "https://pulse.example.com",
  apiKey: "pulse_client_test",
  consoleLogging: false,
  compressionEnabled: false,
  trackPageViews: false,
  captureUnhandled: false,
  flushThreshold: 1000,
};
let request: ReturnType<typeof vi.fn>;
function events(): LogEvent[] {
  return request.mock.calls.filter(([url]) => String(url).endsWith("/v1/ingest"))
    .flatMap(([, init]) => (JSON.parse(init.body as string) as { events: LogEvent[] }).events);
}
const hostile = (): never => { throw new Error("host API unavailable"); };

describe("runtime host safety", () => {
  beforeEach(() => {
    resetTestEnvironment();
    resetSlugWarning();
    request = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", request);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", request);
    await Pulse.shutdown();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps log calls and subsequent delivery working when UUID generation fails", async () => {
    Pulse.configure(config);
    vi.spyOn(crypto, "randomUUID").mockImplementation(hostile);
    expect(() => Pulse.info("after-uuid-failure")).not.toThrow();
    await Pulse.flush();
    expect(events().some((event) => event.message === "after-uuid-failure")).toBe(true);
    expect(randomUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("falls back from throwing monotonic clocks to finite elapsed time", () => {
    vi.spyOn(performance, "now").mockImplementation(hostile);
    expect(Number.isFinite(nowMs())).toBe(true);
    expect(() => Pulse.startOperation("clock").complete()).not.toThrow();
  });

  it("contains throwing error properties and attribute getters on operation handles", () => {
    const log = vi.fn();
    const operation = new PulseOperation(log, "upload");
    const error = new Error("original application error");
    Object.defineProperty(error, "message", { get: hostile });
    expect(() => operation.fail(error)).not.toThrow();
    expect(log).toHaveBeenCalledTimes(2);
    const bad = { get invalid(): string { return hostile(); } };
    expect(() => new PulseOperation(log, "upload", bad)).not.toThrow();
    const another = new PulseOperation(log, "upload");
    expect(() => another.complete(bad)).not.toThrow();
    expect(() => another.cancel()).not.toThrow();
  });

  it("keeps disabled operation handles inert without accessing metadata, clocks, crypto or console", () => {
    Pulse.init({ enabled: false });
    const getter = vi.fn(hostile);
    const attributes = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    const uuid = vi.spyOn(crypto, "randomUUID").mockImplementation(hostile);
    const clock = vi.spyOn(performance, "now").mockImplementation(hostile);
    expect(() => {
      const operation = Pulse.startOperation("BAD METRIC", attributes);
      operation.fail(attributes, attributes);
      operation.complete(attributes);
      Pulse.recordMetric("BAD METRIC", attributes);
    }).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("contains diagnostic failures and preserves later healthy telemetry", async () => {
    Pulse.configure({ ...config, debug: true });
    vi.spyOn(console, "error").mockImplementation(hostile);
    expect(() => Pulse.info("bad", { get value(): string { return hostile(); } })).not.toThrow();
    Pulse.info("healthy");
    await Pulse.flush();
    expect(events().some((event) => event.message === "healthy")).toBe(true);
  });

  it("contains console mirror failure without dropping the event", async () => {
    Pulse.configure({ ...config, consoleLogging: true });
    vi.spyOn(console, "log").mockImplementation(hostile);
    expect(() => Pulse.info("mirrored")).not.toThrow();
    await Pulse.flush();
    expect(events().some((event) => event.message === "mirrored")).toBe(true);
  });

  it("suppresses reentrant console telemetry before it repeats host adapter work", async () => {
    Pulse.configure({ ...config, consoleLogging: true });
    let calls = 0;
    vi.spyOn(console, "log").mockImplementation(() => {
      calls += 1;
      if (calls < 5) Pulse.info("recursive-console");
    });
    Pulse.info("outer-console");
    await Pulse.flush();
    expect(calls).toBe(1);
    expect(events().filter((event) => !event.message.startsWith("sdk:"))).toHaveLength(1);
  });

  it("suppresses reentrant attribute conversion and keeps the original event", async () => {
    Pulse.configure(config);
    let reads = 0;
    const attributes: PulseAttributes = { get value() {
      reads += 1;
      if (reads < 5) Pulse.info("recursive-getter", attributes);
      return "safe";
    } };
    Pulse.info("outer-getter", attributes);
    await Pulse.flush();
    expect(reads).toBe(1);
    expect(events().filter((event) => !event.message.startsWith("sdk:"))).toHaveLength(1);
  });

  it("contains quota classification getters and retains the storage fallback", () => {
    const store = new SafeStorage("local");
    vi.spyOn(testLocalStorage, "setItem").mockImplementation(() => { throw { get name() { return hostile(); } }; });
    expect(() => store.set("host-safety", "retained")).not.toThrow();
    expect(store.get("host-safety")).toBe("retained");
  });

  it("contains lifecycle callback failures and keeps listeners usable", () => {
    const addWindow = vi.spyOn(testWindow, "addEventListener");
    const addDocument = vi.spyOn(testDocument, "addEventListener");
    const visible = vi.fn(hostile);
    const cleanup = installLifecycle({ onHidden: hostile, onVisible: visible });
    try {
      const hide = addWindow.mock.calls.find(([type]) => type === "pagehide")![1] as EventListener;
      const show = addDocument.mock.calls.find(([type]) => type === "visibilitychange")![1] as EventListener;
      expect(() => hide(new Event("pagehide"))).not.toThrow();
      expect(() => show(new Event("visibilitychange"))).not.toThrow();
      expect(() => show(new Event("visibilitychange"))).not.toThrow();
      expect(visible).toHaveBeenCalledTimes(2);
    } finally { cleanup(); }
  });

  it("contains failed background flushes and recovers on the next pass", async () => {
    const queue = new OfflineQueue(new SafeStorage("local"));
    const drain = vi.spyOn(queue, "drain").mockRejectedValueOnce(new Error("queue failed"));
    const tx = new Transport(validateConfiguration(config), queue, hostile);
    try {
      await expect(tx.flush()).resolves.toBeUndefined();
      await expect(tx.flush()).resolves.toBeUndefined();
      expect(drain).toHaveBeenCalledTimes(2);
    } finally { tx.stop(); }
  });

  it("treats inaccessible connectivity state as unknown and continues delivery", async () => {
    Pulse.configure(config);
    const original = Object.getOwnPropertyDescriptor(testNavigator, "onLine")!;
    Object.defineProperty(testNavigator, "onLine", { configurable: true, get: hostile });
    try {
      Pulse.info("connectivity-unknown");
      await expect(Pulse.flush()).resolves.toBeUndefined();
      expect(events().some((event) => event.message === "connectivity-unknown")).toBe(true);
    } finally { Object.defineProperty(testNavigator, "onLine", original); }
  });

  it("continues listener cleanup when a transport abort adapter throws", async () => {
    Pulse.configure(config);
    Pulse.info("pending");
    let started!: () => void;
    const inRequest = new Promise<void>((resolve) => { started = resolve; });
    request.mockImplementation(async () => { started(); return new Response("{}", { status: 200 }); });
    const flush = Pulse.flush();
    await inRequest;
    vi.spyOn(AbortController.prototype, "abort").mockImplementation(hostile);
    expect(Pulse.init({ enabled: false })).toEqual({ status: "disabled", reason: "disabled" });
    await flush;
  });
});
