import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateConfiguration } from "../src/configuration";
import { jsonByteLength, stringByteLength } from "../src/event-size";
import { normalizeAttributes } from "../src/event-builder";
import { Pulse } from "../src/index";
import { OfflineQueue } from "../src/offline-queue";
import { SafeStorage, STORAGE_PREFIX } from "../src/storage";
import { Transport } from "../src/transport";
import type { LogEvent } from "../src/types";
import { resetTestEnvironment, testLocalStorage } from "./setup";

const EVENT_BYTES = 128 * 1024;
const BUFFER_BYTES = 4 * 1024 * 1024;
const OFFLINE_BYTES = 1024 * 1024;
const config = {
  endpoint: "https://pulse.example.com",
  apiKey: "pulse_client_resources",
  consoleLogging: false,
  compressionEnabled: false,
  trackPageViews: false,
  flushThreshold: 1000,
};

function event(index: number, size = 0): LogEvent {
  return {
    client_event_id: `event-${index}`,
    session_id: "11111111-1111-4111-8111-111111111111",
    message: `event ${index}`,
    level: "info",
    environment: "web",
    sdk_name: "pubky-pulse-web",
    sdk_version: "0.6.0",
    is_dev: true,
    timestamp: "2026-09-09T00:00:00.000Z",
    source_module: "x".repeat(size),
  };
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function persistedBytes(): number {
  return testLocalStorage.keys()
    .filter((key) => key.startsWith(`${STORAGE_PREFIX}offline_queue`))
    .reduce((sum, key) => sum + Buffer.byteLength(testLocalStorage.getItem(key)!), 0);
}

describe("event resource safety", () => {
  let tx: Transport | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetTestEnvironment();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    fetchMock = vi.fn(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    Pulse.init({ enabled: false });
    tx?.stop();
    tx = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function sent(): LogEvent[] {
    return fetchMock.mock.calls.flatMap((call) => {
      const body = JSON.parse((call[1] as RequestInit).body as string);
      return body.events ?? [];
    });
  }

  it("reads at most 100 own attribute values", () => {
    const attrs = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key-${i}`, "value"]));
    const extra = vi.fn(() => "extra");
    Object.defineProperty(attrs, "extra", { enumerable: true, get: extra });
    expect(Object.keys(normalizeAttributes(attrs)!)).toHaveLength(100);
    expect(extra).not.toHaveBeenCalled();
  });

  it("skips oversized attribute names without reading their values or renaming them", () => {
    const getter = vi.fn(() => "secret");
    const attrs = { ordinary: "kept" };
    Object.defineProperty(attrs, "x".repeat(257), { enumerable: true, get: getter });
    expect(normalizeAttributes(attrs)).toEqual({ ordinary: "kept" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("drops an oversized event before console output and delivery", async () => {
    Pulse.configure({ ...config, consoleLogging: true });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    Pulse.info("oversized", {}, { screenName: "x".repeat(EVENT_BYTES) });
    await Pulse.flush();
    expect(output).not.toHaveBeenCalled();
    expect(sent().some((item) => item.message === "oversized")).toBe(false);
  });

  it("bounds hook-produced metadata while retaining full input strings for sanitization", async () => {
    let observed = "";
    Pulse.configure({ ...config, beforeSend: (item) => {
      if (item.message.startsWith("sanitize")) {
        observed = item.message;
        return { ...item, message: "sanitized" };
      }
      if (item.message === "oversized-hook") return { ...item, source_module: "x".repeat(EVENT_BYTES) };
      return item;
    } });
    const full = "sanitize" + "x".repeat(EVENT_BYTES);
    Pulse.info(full);
    Pulse.info("oversized-hook");
    await Pulse.flush();
    expect(observed).toBe(full);
    expect(sent().filter((item) => !item.message.startsWith("sdk:")).map((item) => item.message)).toEqual(["sanitized"]);
  });

  it("applies the serialized event boundary including UTF-8 and JSON escapes", () => {
    const queue = new OfflineQueue(new SafeStorage("local"));
    tx = new Transport(validateConfiguration(config), queue);
    const exact = event(0);
    exact.source_module = "😀é\n\u0000\ud800";
    exact.source_module += "x".repeat(EVENT_BYTES - bytes(exact));
    expect(bytes(exact)).toBe(EVENT_BYTES);
    tx.enqueue(exact);
    tx.enqueue({ ...exact, source_module: exact.source_module + "x" });
    expect(tx.bufferSize).toBe(1);
  });

  it("bounds the retained buffer by bytes and keeps the newest events", async () => {
    tx = new Transport(validateConfiguration(config), new OfflineQueue(new SafeStorage("local")));
    const each = 120 * 1024;
    for (let i = 0; i < 70; i += 1) tx.enqueue(event(i, each));
    expect(tx.bufferSize).toBeLessThanOrEqual(Math.floor(BUFFER_BYTES / each));
    await tx.flush();
    const messages = sent().map((item) => item.message);
    expect(messages.at(-1)).toBe("event 69");
    expect(messages).not.toContain("event 0");
    expect(sent().reduce((sum, item) => sum + bytes(item), 0)).toBeLessThanOrEqual(BUFFER_BYTES);
  });

  it("admits offline replay through the configured lower count limit", async () => {
    const queue = new OfflineQueue(new SafeStorage("local"));
    await queue.append(Array.from({ length: 6 }, (_, i) => event(i)));
    tx = new Transport(validateConfiguration({ ...config, maxBufferSize: 2, flushThreshold: 2 }), queue);
    tx.enqueue(event(6));
    await tx.flush();
    expect(sent().map((item) => item.message)).toEqual(["event 5", "event 6"]);
  });

  it("bounds persisted and fallback queues by bytes while keeping newest events", async () => {
    for (const absent of [false, true]) {
      if (absent) vi.stubGlobal("localStorage", undefined);
      const queue = new OfflineQueue(new SafeStorage("local"));
      await queue.append(Array.from({ length: 30 }, (_, i) => event(i, 120 * 1024)));
      const kept = queue.read();
      expect(bytes(kept)).toBeLessThanOrEqual(OFFLINE_BYTES);
      expect(kept.at(-1)?.message).toBe("event 29");
      if (!absent) expect(persistedBytes()).toBeLessThanOrEqual(OFFLINE_BYTES);
    }
  });

  it("limits shared and spill payloads collectively without changing the shared key", async () => {
    const queue = new OfflineQueue(new SafeStorage("local"));
    await queue.append(Array.from({ length: 6 }, (_, i) => event(i, 100 * 1024)));
    const shared = testLocalStorage.getItem(`${STORAGE_PREFIX}offline_queue`);
    queue.spill(Array.from({ length: 10 }, (_, i) => event(i + 6, 100 * 1024)));
    expect(persistedBytes()).toBeLessThanOrEqual(OFFLINE_BYTES);
    expect(testLocalStorage.getItem(`${STORAGE_PREFIX}offline_queue`)).toBe(shared);
    expect(queue.read().at(-1)?.message).toBe("event 15");
  });

  it("rejects oversized legacy storage before JSON parsing", () => {
    const raw = JSON.stringify([event(0, OFFLINE_BYTES)]);
    testLocalStorage.setItem(`${STORAGE_PREFIX}offline_queue`, raw);
    const parse = vi.spyOn(JSON, "parse");
    expect(new OfflineQueue(new SafeStorage("local")).read()).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
    expect(testLocalStorage.getItem(`${STORAGE_PREFIX}offline_queue`)).toBeNull();
  });


  it("bounds exception attributes before merging while preserving reserved error details", async () => {
    Pulse.configure(config);
    const attrs = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key-${i}`, "value"]));
    const extra = vi.fn(() => "extra");
    Object.defineProperty(attrs, "extra", { enumerable: true, get: extra });
    const error = new Error("exception attributes");
    error.stack = "s".repeat(16000);
    Pulse.captureException(error, { attributes: attrs });
    await Pulse.flush();
    expect(extra).not.toHaveBeenCalled();
    const captured = sent().find((item) => item.message === error.message)!;
    expect(captured.custom_attributes?._error_stack).toHaveLength(16000);
    expect(Object.keys(captured.custom_attributes!)).toHaveLength(100);
  });

  it.each(["plain", "é漢😀", "\n\r\t\b\f\u0000\u001f", "\ud800", "\udfff", "\ud800A\udfff", '\"\\'])
    ("counts serialized UTF-8 and escape boundaries for %j", (value) => {
      const sample = { value, nested: [value, true, false, null, -0, 1e30, undefined], missing: undefined };
      const exact = bytes(sample);
      expect(jsonByteLength(sample, exact)).toBe(exact);
      expect(jsonByteLength(sample, exact - 1)).toBeNull();
      expect(stringByteLength(value, Buffer.byteLength(value))).toBe(Buffer.byteLength(value));
    });

  it("accepts string attributes named toJSON without invoking JSON conversions", async () => {
    Pulse.configure(config);
    Pulse.info("json-name", { toJSON: "ordinary attribute", __proto__: "ignored prototype syntax" });
    await Pulse.flush();
    expect(sent().find((item) => item.message === "json-name")?.custom_attributes?.toJSON).toBe("ordinary attribute");
    const conversion = vi.fn(() => "not called");
    expect(jsonByteLength({ toJSON: conversion })).toBeNull();
    expect(conversion).not.toHaveBeenCalled();
  });

  it("rejects oversized data before serializing or visiting later accessors", () => {
    const extra = vi.fn(() => "extra");
    const data = { huge: "x".repeat(EVENT_BYTES) };
    Object.defineProperty(data, "extra", { enumerable: true, get: extra });
    const stringify = vi.spyOn(JSON, "stringify");
    expect(jsonByteLength(data)).toBeNull();
    expect(stringify).not.toHaveBeenCalled();
    expect(extra).not.toHaveBeenCalled();
  });

  it("bounds an active batch separately from newly buffered events and releases the budget after delivery", async () => {
    let release!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    tx = new Transport(validateConfiguration(config), new OfflineQueue(new SafeStorage("local")));
    for (let i = 0; i < 20; i += 1) tx.enqueue(event(i, 120 * 1024));
    const flushing = tx.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent()).toHaveLength(20);
    expect(sent().reduce((sum, item) => sum + bytes(item), 0)).toBeLessThanOrEqual(20 * EVENT_BYTES);
    for (let i = 20; i < 90; i += 1) tx.enqueue(event(i, 120 * 1024));
    expect(tx.bufferSize).toBeLessThanOrEqual(Math.floor(BUFFER_BYTES / (120 * 1024)));
    release(new Response("{}"));
    await flushing;
    expect(tx.bufferSize).toBe(0);
    expect(sent().at(-1)?.message).toBe("event 89");
    tx.enqueue(event(90, 120 * 1024));
    await tx.flush();
    expect(sent().at(-1)?.message).toBe("event 90");
  });

  it("keeps an append within the collective offline budget after earlier spills", async () => {
    const queue = new OfflineQueue(new SafeStorage("local"));
    queue.spill(Array.from({ length: 8 }, (_, i) => event(i, 100 * 1024)));
    await queue.append(Array.from({ length: 8 }, (_, i) => event(i + 8, 100 * 1024)));
    expect(persistedBytes()).toBeLessThanOrEqual(OFFLINE_BYTES);
    expect(queue.read().at(-1)?.message).toBe("event 15");
  });

  it("rejects a flush interval that would overflow a browser timer", () => {
    expect(() => validateConfiguration({ ...config, flushIntervalMs: 2 ** 31 })).toThrow(/flushIntervalMs/);
    expect(validateConfiguration({ ...config, flushIntervalMs: 2 ** 31 - 1 }).flushIntervalMs).toBe(2 ** 31 - 1);
  });

  it.each(["complete", "fail", "cancel"] as const)(
    "retains operation correlation and %s details when caller attributes fill the budget", async (phase) => {
      Pulse.configure(config);
      vi.spyOn(performance, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1250);
      const attributes = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field-${index}`, "value"]));
      const operation = Pulse.startOperation("bounded-operation", attributes);
      if (phase === "fail") operation.fail("actual failure", attributes);
      else operation[phase](attributes);
      await Pulse.flush();

      const metricEvents = sent().filter((item) => item.message.startsWith("metric:"));
      expect(metricEvents).toHaveLength(2);
      for (const item of metricEvents) {
        expect(Object.keys(item.custom_attributes!)).toHaveLength(100);
        expect(item.custom_attributes?.tracking_id).toBe(operation.trackingId);
      }
      expect(metricEvents[1]?.custom_attributes?.duration_ms).toBe("250");
      if (phase === "fail") expect(metricEvents[1]?.custom_attributes?.error).toBe("actual failure");
    },
  );

  it.each(["complete", "fail", "cancel"] as const)(
    "preserves full admitted operation strings for beforeSend sanitization through %s", async (phase) => {
      const full = "sensitive-prefix:" + "x".repeat(150000);
      const observed: string[] = [];
      Pulse.configure({ ...config, beforeSend: (item) => {
        if (item.message.startsWith("metric:")) {
          observed.push(item.custom_attributes!.detail!);
          item.custom_attributes!.detail = "redacted";
        }
        return item;
      } });
      const operation = Pulse.startOperation("sanitize-operation", { detail: full });
      if (phase === "fail") operation.fail("failure", { detail: full });
      else operation[phase]({ detail: full });
      await Pulse.flush();

      expect(observed).toEqual([full, full]);
      const metricEvents = sent().filter((item) => item.message.startsWith("metric:"));
      expect(metricEvents).toHaveLength(2);
      expect(metricEvents.map((item) => item.custom_attributes?.detail)).toEqual(["redacted", "redacted"]);
    },
  );


  it("keeps reserved exception fields when numeric caller keys enumerate before them", async () => {
    Pulse.configure(config);
    const attributes = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [String(index), "value"]));
    const error = new TypeError("numeric exception attributes");
    error.stack = "s".repeat(16000);
    Pulse.captureException(error, { attributes });
    await Pulse.flush();

    const captured = sent().find((item) => item.message === error.message)!;
    expect(captured.custom_attributes?._error_type).toBe("TypeError");
    expect(captured.custom_attributes?._error_stack).toBe(error.stack);
    expect(Object.keys(captured.custom_attributes!)).toHaveLength(100);
    expect(captured.custom_attributes?.["97"]).toBe("value");
    expect(captured.custom_attributes?.["98"]).toBeUndefined();
  });

  it("reserves all present exception fields before reading numerically ordered caller getters", async () => {
    Pulse.configure(config);
    const attributes: Record<string, unknown> = {};
    const reads: number[] = [];
    // JavaScript visits integer keys in numeric order, regardless of insertion order.
    for (let index = 99; index >= 0; index -= 1) {
      Object.defineProperty(attributes, String(index), {
        enumerable: true,
        get() { reads.push(index); return "value"; },
      });
    }
    const error = new TypeError("numeric getter admission", { cause: new Error("original cause") });
    error.stack = "reserved stack";
    Object.defineProperty(error, "code", { value: "E_TEST" });
    Pulse.captureException(error, { attributes });
    await Pulse.flush();

    expect(reads).toEqual(Array.from({ length: 95 }, (_, index) => index));
    const captured = sent().find((item) => item.message === error.message)!;
    expect(captured.custom_attributes).toMatchObject({
      _error_type: "TypeError",
      _error_stack: "reserved stack",
      _error_code: "E_TEST",
      _error_cause_1_type: "Error",
      _error_cause_1_message: "original cause",
    });
    expect(Object.keys(captured.custom_attributes!)).toHaveLength(100);
  });

  it("preserves full admitted numeric exception values for beforeSend while reserving error fields", async () => {
    const full = "sensitive-prefix:" + "x".repeat(150000);
    let observed: string | undefined;
    let observedType: string | undefined;
    Pulse.configure({ ...config, beforeSend: (item) => {
      if (item.message === "sanitize numeric exception") {
        observed = item.custom_attributes?.["0"];
        observedType = item.custom_attributes?._error_type;
        return { ...item, custom_attributes: { ...item.custom_attributes, "0": "redacted" } };
      }
      return item;
    } });
    const attributes = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [String(index), index === 0 ? full : "value"]));
    const error = new Error("sanitize numeric exception");
    error.stack = "reserved stack";
    Pulse.captureException(error, { attributes });
    await Pulse.flush();

    expect(observed).toBe(full);
    expect(observedType).toBe("Error");
    const captured = sent().find((item) => item.message === error.message)!;
    expect(captured.custom_attributes).toMatchObject({
      "0": "redacted", _error_type: "Error", _error_stack: "reserved stack",
    });
    expect(Object.keys(captured.custom_attributes!)).toHaveLength(100);
  });

});
