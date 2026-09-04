import { beforeEach, describe, expect, it } from "vitest";
import { MAX_OFFLINE_EVENTS, OfflineQueue } from "../src/offline-queue";
import { SafeStorage, STORAGE_PREFIX } from "../src/storage";
import type { LogEvent } from "../src/types";
import { MemoryStorage, resetTestEnvironment, testLocalStorage } from "./setup";

const QUEUE_KEY = `${STORAGE_PREFIX}offline_queue`;

function makeEvent(index: number): LogEvent {
  return {
    client_event_id: `event-${index}`,
    session_id: "11111111-1111-4111-8111-111111111111",
    level: "info",
    message: `event ${index}`,
    environment: "web",
    sdk_name: "pubky-pulse-web",
    sdk_version: "0.1.0",
    is_dev: true,
    timestamp: "2026-09-04T00:00:00.000Z",
  };
}

function makeEvents(count: number): LogEvent[] {
  return Array.from({ length: count }, (_, i) => makeEvent(i));
}

describe("OfflineQueue", () => {
  let queue: OfflineQueue;

  beforeEach(() => {
    resetTestEnvironment();
    queue = new OfflineQueue(new SafeStorage("local"));
  });

  it("starts empty", () => {
    expect(queue.read()).toEqual([]);
  });

  it("appends and drains events", () => {
    queue.append(makeEvents(2));
    queue.append([makeEvent(2)]);
    expect(queue.read()).toHaveLength(3);

    const drained = queue.drain();
    expect(drained.map((event) => event.client_event_id)).toEqual([
      "event-0",
      "event-1",
      "event-2",
    ]);
    expect(queue.read()).toEqual([]);
  });

  it("clears the key rather than storing an empty array", () => {
    queue.append(makeEvents(1));
    queue.write([]);
    expect(testLocalStorage.getItem(QUEUE_KEY)).toBeNull();
  });

  it("keeps the newest events when over the cap", () => {
    const events = makeEvents(MAX_OFFLINE_EVENTS + 5);
    queue.write(events);
    const stored = queue.read();
    expect(stored).toHaveLength(MAX_OFFLINE_EVENTS);
    expect(stored[0]?.client_event_id).toBe("event-5");
  });

  it("drops the oldest half and retries once when storage is over quota", () => {
    // Fails the first, full-size write and accepts the halved retry.
    class TightStorage extends MemoryStorage {
      limit = Number.POSITIVE_INFINITY;
      override setItem(key: string, value: string): void {
        if (value.length > this.limit) {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        }
        super.setItem(key, value);
      }
    }

    const tight = new TightStorage();
    Object.defineProperty(globalThis, "localStorage", { value: tight, configurable: true });
    try {
      const events = makeEvents(100);
      tight.limit = JSON.stringify(events).length - 1;
      const messages: string[] = [];
      const tightQueue = new OfflineQueue(new SafeStorage("local"), (m) => messages.push(m));

      tightQueue.write(events);

      const stored = tightQueue.read();
      expect(stored).toHaveLength(50);
      expect(stored[0]?.client_event_id).toBe("event-50");
      expect(messages[0]).toContain("dropped 50 events");
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        value: testLocalStorage,
        configurable: true,
      });
    }
  });

  it("keeps parked events in the memory fallback when localStorage is absent", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
    try {
      const messages: string[] = [];
      const fallbackQueue = new OfflineQueue(new SafeStorage("local"), (m) => messages.push(m));

      fallbackQueue.append(makeEvents(4));

      expect(fallbackQueue.read().map((event) => event.client_event_id)).toEqual([
        "event-0",
        "event-1",
        "event-2",
        "event-3",
      ]);
      expect(messages).toEqual(["offline queue not persisted, kept in memory"]);
      expect(fallbackQueue.drain()).toHaveLength(4);
    } finally {
      Object.defineProperty(globalThis, "localStorage", original);
    }
  });

  it("drops parked events only when the retry also hits quota", () => {
    testLocalStorage.throwOnSet = "quota";
    const messages: string[] = [];
    const quotaQueue = new OfflineQueue(new SafeStorage("local"), (m) => messages.push(m));

    quotaQueue.write(makeEvents(4));

    expect(messages).toEqual([
      "offline queue over quota, dropped 2 events",
      "offline queue could not be written, dropping parked events",
    ]);
    expect(testLocalStorage.getItem(QUEUE_KEY)).toBeNull();
    expect(quotaQueue.read()).toEqual([]);
  });

  it("discards a corrupt payload instead of failing every flush", () => {
    testLocalStorage.setItem(QUEUE_KEY, "{not json");
    expect(queue.read()).toEqual([]);
    expect(testLocalStorage.getItem(QUEUE_KEY)).toBeNull();
  });

  it("ignores a payload that is not an array", () => {
    testLocalStorage.setItem(QUEUE_KEY, JSON.stringify({ events: [] }));
    expect(queue.read()).toEqual([]);
  });
});
