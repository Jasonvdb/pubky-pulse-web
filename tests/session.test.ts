import { beforeEach, describe, expect, it } from "vitest";
import {
  launchDurationMs,
  SESSION_ACTIVITY_KEY,
  SESSION_ID_KEY,
  SessionManager,
} from "../src/session";
import { STORAGE_PREFIX } from "../src/storage";
import { resetTestEnvironment, testSessionStorage } from "./setup";

const TIMEOUT_MS = 30_000;
const T0 = 1_700_000_000_000;

function storedId(): string | null {
  return testSessionStorage.getItem(STORAGE_PREFIX + SESSION_ID_KEY);
}

function storedActivity(): string | null {
  return testSessionStorage.getItem(STORAGE_PREFIX + SESSION_ACTIVITY_KEY);
}

describe("launchDurationMs", () => {
  it("reports a non-negative duration when performance is available", () => {
    const value = launchDurationMs();
    expect(typeof value).toBe("number");
    expect(value!).toBeGreaterThanOrEqual(0);
  });

  it("returns undefined without a performance object", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "performance");
    Reflect.deleteProperty(globalThis, "performance");
    try {
      expect(launchDurationMs()).toBeUndefined();
    } finally {
      if (original) Object.defineProperty(globalThis, "performance", original);
    }
  });
});

describe("SessionManager", () => {
  let started: Array<{ id: string; launchMs?: number }>;
  let ended: string[];

  function makeManager(timeoutMs = TIMEOUT_MS): SessionManager {
    return new SessionManager(timeoutMs, {
      onStarted: (id, launchMs) => started.push({ id, launchMs }),
      onEnded: (id) => ended.push(id),
    });
  }

  beforeEach(() => {
    resetTestEnvironment();
    started = [];
    ended = [];
  });

  it("mints and persists a session on the first start", () => {
    const id = makeManager().start(T0);

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(storedId()).toBe(id);
    expect(storedActivity()).toBe(String(T0));
    expect(started).toEqual([{ id, launchMs: expect.any(Number) as unknown as number }]);
    expect(ended).toEqual([]);
  });

  it("resumes the stored session when the idle gap is under the timeout", () => {
    const first = makeManager().start(T0);
    started = [];

    const resumed = makeManager();
    expect(resumed.start(T0 + TIMEOUT_MS - 1)).toBe(first);
    expect(resumed.isResumed).toBe(true);
    // A resumed session was already announced by the page that started it.
    expect(started).toEqual([]);
    expect(storedActivity()).toBe(String(T0 + TIMEOUT_MS - 1));
  });

  it("rotates a resumed session silently when it expires", () => {
    const first = makeManager().start(T0);
    started = [];

    const resumed = makeManager();
    expect(resumed.start(T0 + TIMEOUT_MS - 1)).toBe(first);
    expect(resumed.isResumed).toBe(true);

    const next = resumed.touch(T0 + (2 * TIMEOUT_MS));

    expect(next).not.toBe(first);
    expect(started.map((entry) => entry.id)).toEqual([next]);
    // We never saw the inherited session start, so we do not end it either.
    expect(ended).toEqual([]);
    expect(resumed.id).toBe(next);
    expect(storedId()).toBe(next);
  });

  it("starts a fresh session when the stored one has gone stale", () => {
    const first = makeManager().start(T0);
    started = [];

    const next = makeManager().start(T0 + TIMEOUT_MS);

    expect(next).not.toBe(first);
    expect(started.map((entry) => entry.id)).toEqual([next]);
    // The stale session belonged to an earlier page load, so nothing ends it.
    expect(ended).toEqual([]);
  });

  it("keeps the session and refreshes activity while calls keep coming", () => {
    const manager = makeManager();
    const id = manager.start(T0);
    started = [];

    expect(manager.touch(T0 + TIMEOUT_MS - 1)).toBe(id);
    expect(manager.touch(T0 + (2 * TIMEOUT_MS) - 2)).toBe(id);

    expect(storedActivity()).toBe(String(T0 + (2 * TIMEOUT_MS) - 2));
    expect(started).toEqual([]);
    expect(ended).toEqual([]);
  });

  it("ends the expired session and starts a new one after the timeout", () => {
    const manager = makeManager();
    const first = manager.start(T0);
    started = [];

    const second = manager.touch(T0 + TIMEOUT_MS);

    expect(second).not.toBe(first);
    expect(ended).toEqual([first]);
    // No launch timing on a renewal: the page was not just loaded.
    expect(started).toEqual([{ id: second, launchMs: undefined }]);
    expect(manager.id).toBe(second);
    expect(storedId()).toBe(second);
  });

  it("does not recurse when a lifecycle callback logs an event", () => {
    const seen: string[] = [];
    const manager: SessionManager = new SessionManager(TIMEOUT_MS, {
      onStarted: (id) => {
        seen.push(`start:${id}`);
        // A lifecycle event goes through the normal log path, which touches.
        manager.touch(T0 + TIMEOUT_MS);
      },
      onEnded: (id) => {
        seen.push(`end:${id}`);
        manager.touch(T0 + TIMEOUT_MS);
      },
    });

    const first = manager.start(T0);
    const second = manager.touch(T0 + TIMEOUT_MS);

    expect(seen).toEqual([`start:${first}`, `end:${first}`, `start:${second}`]);
  });

  it("starts a session lazily when touched before start", () => {
    const manager = makeManager();
    const id = manager.touch(T0);

    expect(manager.id).toBe(id);
    expect(started.map((entry) => entry.id)).toEqual([id]);
  });

  it("treats a stored id without an activity stamp as expired", () => {
    testSessionStorage.setItem(STORAGE_PREFIX + SESSION_ID_KEY, "orphaned-id");

    const id = makeManager().start(T0);

    expect(id).not.toBe("orphaned-id");
    expect(started.map((entry) => entry.id)).toEqual([id]);
  });
});
