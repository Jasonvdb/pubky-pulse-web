import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_OFFLINE_BYTES } from "../src/event-size";
import { MAX_OFFLINE_EVENTS, OfflineQueue } from "../src/offline-queue";
import { SafeStorage, STORAGE_PREFIX } from "../src/storage";
import type { LogEvent } from "../src/types";
import {
  MemoryStorage,
  resetTestEnvironment,
  TestLockManager,
  testLocalStorage,
  testNavigator,
} from "./setup";

const QUEUE_KEY = `${STORAGE_PREFIX}offline_queue`;
const SPILL_PREFIX = `${STORAGE_PREFIX}offline_queue:spill:`;
/** The lock name the queue asks for; asserted so it cannot drift silently. */
const LOCK_NAME = "pulse_offline_queue";

function spillKeys(): string[] {
  return testLocalStorage.keys().filter((key) => key.startsWith(SPILL_PREFIX));
}

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
  return makeRange(0, count);
}

/** `count` events numbered from `start`, so two batches stay tellable apart. */
function makeRange(start: number, count: number): LogEvent[] {
  return Array.from({ length: count }, (_, i) => makeEvent(start + i));
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

  it("appends and drains events", async () => {
    await queue.append(makeEvents(2));
    await queue.append([makeEvent(2)]);
    expect(queue.read()).toHaveLength(3);

    const drained = await queue.drain();
    expect(drained.map((event) => event.client_event_id)).toEqual([
      "event-0",
      "event-1",
      "event-2",
    ]);
    expect(queue.read()).toEqual([]);
  });

  it("removes the key on drain rather than leaving an empty array", async () => {
    await queue.append(makeEvents(1));
    await queue.drain();
    expect(testLocalStorage.getItem(QUEUE_KEY)).toBeNull();
  });

  it("keeps the newest events when over the cap", async () => {
    await queue.append(makeEvents(MAX_OFFLINE_EVENTS + 5));
    const stored = queue.read();
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.length).toBeLessThan(MAX_OFFLINE_EVENTS);
    expect(stored).toEqual(makeRange(MAX_OFFLINE_EVENTS + 5 - stored.length, stored.length));
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThanOrEqual(MAX_OFFLINE_BYTES);
  });

  it("drops the oldest half and retries once when storage is over quota", async () => {
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

      await tightQueue.append(events);

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

  it("keeps parked events in the memory fallback when localStorage is absent", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
    try {
      const messages: string[] = [];
      const fallbackQueue = new OfflineQueue(new SafeStorage("local"), (m) => messages.push(m));

      await fallbackQueue.append(makeEvents(4));

      expect(fallbackQueue.read().map((event) => event.client_event_id)).toEqual([
        "event-0",
        "event-1",
        "event-2",
        "event-3",
      ]);
      expect(messages).toEqual(["offline queue not persisted, kept in memory"]);
      expect(await fallbackQueue.drain()).toHaveLength(4);
    } finally {
      Object.defineProperty(globalThis, "localStorage", original);
    }
  });

  it("drops parked events only when the retry also hits quota", async () => {
    testLocalStorage.throwOnSet = "quota";
    const messages: string[] = [];
    const quotaQueue = new OfflineQueue(new SafeStorage("local"), (m) => messages.push(m));

    await quotaQueue.append(makeEvents(4));

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

  describe("spill", () => {
    it("writes a key of its own instead of the shared one", async () => {
      await queue.append([makeEvent(0)]);
      queue.spill([makeEvent(1)]);

      // The shared key is untouched, so a concurrent tab's queue survives.
      expect(JSON.parse(testLocalStorage.getItem(QUEUE_KEY)!)).toHaveLength(1);
      expect(spillKeys()).toHaveLength(1);
      expect(queue.read().map((event) => event.client_event_id)).toEqual(["event-0", "event-1"]);
    });

    it("uses a fresh key per call so two spills cannot clobber each other", () => {
      queue.spill([makeEvent(0)]);
      queue.spill([makeEvent(1)]);

      expect(new Set(spillKeys()).size).toBe(2);
      expect(queue.read()).toHaveLength(2);
    });

    it("is folded back in and removed by the next drain", async () => {
      await queue.append([makeEvent(0)]);
      queue.spill([makeEvent(1), makeEvent(2)]);

      const drained = await queue.drain();

      expect(drained.map((event) => event.client_event_id)).toEqual([
        "event-0",
        "event-1",
        "event-2",
      ]);
      expect(testLocalStorage.keys()).toEqual([]);
      expect(queue.read()).toEqual([]);
    });

    it("keeps only the newest events when over the cap", () => {
      queue.spill(makeEvents(MAX_OFFLINE_EVENTS + 3));

      const stored = queue.read();
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.length).toBeLessThan(MAX_OFFLINE_EVENTS);
      expect(stored).toEqual(makeRange(MAX_OFFLINE_EVENTS + 3 - stored.length, stored.length));
      expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThanOrEqual(MAX_OFFLINE_BYTES);
    });

    it("writes nothing for an empty batch", () => {
      queue.spill([]);
      expect(testLocalStorage.keys()).toEqual([]);
    });
  });

  describe("the aggregate cap", () => {
    /** Spill at a distinct instant, so the keys sort in the order written. */
    function spillAt(second: number, events: LogEvent[]): void {
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 4, 0, 0, second)));
      queue.spill(events);
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("assembles spills oldest first whatever order storage lists the keys", async () => {
      // `localStorage` promises nothing about key order; this one is hostile.
      class ReversedStorage extends MemoryStorage {
        override key(index: number): string | null {
          const all = this.keys();
          return all[all.length - 1 - index] ?? null;
        }
      }

      Object.defineProperty(globalThis, "localStorage", {
        value: new ReversedStorage(),
        configurable: true,
      });
      try {
        for (const index of [0, 1, 2]) spillAt(index, [makeEvent(index)]);

        const ids = ["event-0", "event-1", "event-2"];
        expect(queue.read().map((event) => event.client_event_id)).toEqual(ids);
        expect((await queue.drain()).map((event) => event.client_event_id)).toEqual(ids);
      } finally {
        Object.defineProperty(globalThis, "localStorage", {
          value: testLocalStorage,
          configurable: true,
        });
      }
    });

    it("drops the oldest whole spill rather than growing past the byte cap", () => {
      const half = 6;
      const wideRange = (start: number, count: number) => makeRange(start, count)
        .map((event) => ({ ...event, source_module: "x".repeat(80 * 1024) }));
      spillAt(0, wideRange(0, half));
      spillAt(1, wideRange(half, half));
      // Two batches fit; the third costs the oldest spill its key.
      spillAt(2, wideRange(half * 2, 1));

      const stored = queue.read();
      expect(spillKeys()).toHaveLength(2);
      expect(stored).toHaveLength(half + 1);
      expect(stored[0]?.client_event_id).toBe(`event-${half}`);
      expect(stored.at(-1)?.client_event_id).toBe(`event-${half * 2}`);
      expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThanOrEqual(MAX_OFFLINE_BYTES);
    });

    it("preserves the locked shared queue when no additional spill event can fit", async () => {
      await queue.append(makeRange(0, MAX_OFFLINE_EVENTS));
      const before = queue.read();
      const raw = testLocalStorage.getItem(QUEUE_KEY);
      // The shared queue nearly fills its byte budget. Unload cannot rewrite
      // that key, so newer incoming spill events are dropped when no room remains.
      spillAt(0, makeRange(MAX_OFFLINE_EVENTS, 100));

      expect(queue.read()).toEqual(before);
      expect(testLocalStorage.getItem(QUEUE_KEY)).toBe(raw);
      expect(spillKeys()).toHaveLength(0);
      expect(await queue.drain()).toEqual(before);
      expect(testLocalStorage.keys()).toEqual([]);
    });
  });

  describe("with the Web Locks API", () => {
    let locks: TestLockManager;

    beforeEach(() => {
      locks = new TestLockManager();
      testNavigator.locks = locks;
    });

    it("holds the lock across the whole read-modify-write", async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Another tab is mid-drain and holds the lock.
      void locks.request(LOCK_NAME, () => held);

      const appended = queue.append([makeEvent(0)]);
      await Promise.resolve();
      expect(testLocalStorage.getItem(QUEUE_KEY)).toBeNull();

      release();
      await appended;

      expect(queue.read()).toHaveLength(1);
      expect(locks.requested).toEqual([LOCK_NAME, LOCK_NAME]);
    });

    it("takes the lock for a drain as well", async () => {
      await queue.append([makeEvent(0)]);
      locks.requested.length = 0;

      await expect(queue.drain()).resolves.toHaveLength(1);
      expect(locks.requested).toEqual([LOCK_NAME]);
    });

    it("writes unlocked when the lock request is refused", async () => {
      locks.rejectWith = new Error("document is not fully active");
      const messages: string[] = [];
      const refusedQueue = new OfflineQueue(new SafeStorage("local"), (m) => messages.push(m));

      await refusedQueue.append([makeEvent(0)]);

      expect(refusedQueue.read()).toHaveLength(1);
      expect(messages).toEqual(["offline queue lock unavailable, writing unlocked"]);
    });

    it("does not take the lock for a spill, which has no turn to await it", () => {
      queue.spill([makeEvent(0)]);
      expect(locks.requested).toEqual([]);
      expect(spillKeys()).toHaveLength(1);
    });
  });
});
