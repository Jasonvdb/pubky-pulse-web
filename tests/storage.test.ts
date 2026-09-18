import { beforeEach, describe, expect, it } from "vitest";
import { isQuotaExceededError, SafeStorage, STORAGE_PREFIX } from "../src/storage";
import { MemoryStorage, resetTestEnvironment, testLocalStorage } from "./setup";

/** Every key held by the backend with its value, for a byte-identical compare. */
function snapshot(): Array<[string, string | null]> {
  return testLocalStorage.keys().map((key) => [key, testLocalStorage.getItem(key)]);
}

function withoutLocalStorage(run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    get() {
      throw new Error("access denied");
    },
    configurable: true,
  });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
  }
}

describe("SafeStorage", () => {
  beforeEach(() => {
    resetTestEnvironment();
  });

  it("namespaces every key it writes", () => {
    const store = new SafeStorage("local");
    expect(store.set("anonymous_id", "abc")).toBe("persisted");
    expect(testLocalStorage.keys()).toEqual([`${STORAGE_PREFIX}anonymous_id`]);
    expect(store.get("anonymous_id")).toBe("abc");
  });

  it("removes values from the backend", () => {
    const store = new SafeStorage("local");
    store.set("k", "v");
    store.remove("k");
    expect(store.get("k")).toBeNull();
    expect(testLocalStorage.keys()).toEqual([]);
  });

  it("falls back to memory when storage access throws", () => {
    withoutLocalStorage(() => {
      const store = new SafeStorage("local");
      expect(store.set("k", "v")).toBe("memory-only");
      expect(store.get("k")).toBe("v");
      expect(store.isFallback).toBe(true);
    });
  });

  it("keeps the value in memory when a write hits quota", () => {
    const store = new SafeStorage("local");
    testLocalStorage.throwOnSet = "quota";
    expect(store.set("k", "v")).toBe("quota");
    expect(store.isFallback).toBe(true);
    expect(store.get("k")).toBe("v");
  });

  it("reports a non-quota write failure as memory-only, not quota", () => {
    const store = new SafeStorage("local");
    testLocalStorage.throwOnSet = "error";
    expect(store.set("k", "v")).toBe("memory-only");
    expect(store.get("k")).toBe("v");
  });

  it("prefers the memory value over a stale backend value", () => {
    const store = new SafeStorage("local");
    store.set("k", "old");
    testLocalStorage.throwOnSet = "error";
    store.set("k", "new");
    expect(store.get("k")).toBe("new");
  });

  it("lists the keys under a prefix, unprefixed and without the host app's", () => {
    const store = new SafeStorage("local");
    store.set("queue:a", "1");
    store.set("queue:b", "2");
    store.set("anonymous_id", "abc");
    testLocalStorage.setItem("queue:c", "not ours");

    expect(store.keys("queue:").sort()).toEqual(["queue:a", "queue:b"]);
    expect(store.keys("nothing:")).toEqual([]);
  });

  it("lists keys held only in the memory fallback", () => {
    const store = new SafeStorage("local");
    store.set("queue:a", "1");
    testLocalStorage.throwOnSet = "error";
    store.set("queue:b", "2");

    // Persisted and fallback keys alike, each listed exactly once.
    expect(store.keys("queue:").sort()).toEqual(["queue:a", "queue:b"]);
  });

  it("lists nothing rather than throwing when storage is blocked", () => {
    withoutLocalStorage(() => {
      const store = new SafeStorage("local");
      expect(store.keys("queue:")).toEqual([]);
      expect(store.isFallback).toBe(true);
    });
  });

  it("clears every SDK key and leaves the host app's alone", () => {
    const store = new SafeStorage("local");
    store.set("anonymous_id", "abc");
    store.set("offline_queue:spill:1", "[]");
    testLocalStorage.setItem("app.theme", "dark");

    store.clear();

    expect(store.keys("")).toEqual([]);
    expect(store.get("anonymous_id")).toBeNull();
    expect(testLocalStorage.keys()).toEqual(["app.theme"]);
  });

  it("clears the memory fallback when storage is blocked", () => {
    withoutLocalStorage(() => {
      const store = new SafeStorage("local");
      store.set("anonymous_id", "abc");

      store.clear();

      expect(store.keys("")).toEqual([]);
      expect(store.get("anonymous_id")).toBeNull();
    });
  });

  it("holds the epoch steady across reads, writes and removals", () => {
    const store = new SafeStorage("local");
    const start = store.epoch;

    store.get("anonymous_id");
    store.set("anonymous_id", "abc");
    store.get("anonymous_id");
    store.keys("");
    store.remove("anonymous_id");

    expect(store.epoch).toBe(start);
  });

  it("advances the epoch once per clear, even with nothing stored", () => {
    const store = new SafeStorage("local");
    const start = store.epoch;

    store.clear();
    expect(store.epoch).toBe(start + 1);

    store.set("anonymous_id", "abc");
    store.clear();
    expect(store.epoch).toBe(start + 2);
  });

  it("advances the epoch once per invalidation", () => {
    const store = new SafeStorage("local");
    const start = store.epoch;

    store.invalidate();
    expect(store.epoch).toBe(start + 1);

    store.invalidate();
    expect(store.epoch).toBe(start + 2);
  });

  it("leaves the backend byte-identical when it invalidates", () => {
    const store = new SafeStorage("local");
    store.set("anonymous_id", "abc");
    store.set("offline_queue", "[]");
    testLocalStorage.setItem("app.theme", "dark");
    const before = snapshot();

    store.invalidate();

    // Another tab reads the same backend: an invalidation must not touch it.
    expect(snapshot()).toEqual(before);
  });

  it("drops the memory fallback when it invalidates", () => {
    const store = new SafeStorage("local");
    store.set("k", "backend");
    testLocalStorage.throwOnSet = "error";
    store.set("k", "memory");
    expect(store.get("k")).toBe("memory");

    store.invalidate();

    // The fallback value is gone, so the read falls through to the backend.
    expect(store.get("k")).toBe("backend");
  });

  it("keeps the epochs of two instances over one backend independent", () => {
    const tab = new SafeStorage("local");
    const otherTab = new SafeStorage("local");
    const before = otherTab.epoch;

    tab.invalidate();

    // One realm is one tab, so this epoch cannot reach another tab's writers.
    expect(tab.epoch).toBe(before + 1);
    expect(otherTab.epoch).toBe(before);
  });

  it("confirms a clear that left no SDK key behind", () => {
    const store = new SafeStorage("local");
    store.set("anonymous_id", "abc");
    testLocalStorage.setItem("app.theme", "dark");

    store.clear();

    // The host app's key is not ours, so it does not count against the check.
    expect(store.confirmCleared()).toBe(true);
  });

  it("refuses to confirm a clear a failed removal survived", () => {
    const store = new SafeStorage("local");
    store.set("anonymous_id", "abc");
    testLocalStorage.throwOnRemove = true;

    store.clear();

    expect(store.confirmCleared()).toBe(false);
  });

  it("refuses to confirm a clear when the backend cannot be reached", () => {
    withoutLocalStorage(() => {
      const store = new SafeStorage("local");
      store.clear();
      // "Could not look" is not "nothing is there".
      expect(store.confirmCleared()).toBe(false);
    });
  });

  it("refuses to confirm a clear when enumerating the backend throws", () => {
    class UnreadableStorage extends MemoryStorage {
      override key(): string | null {
        throw new Error("enumeration denied");
      }
    }

    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    Object.defineProperty(globalThis, "localStorage", {
      value: new UnreadableStorage(),
      configurable: true,
    });
    try {
      const store = new SafeStorage("local");
      store.set("anonymous_id", "abc");
      store.clear();
      expect(store.confirmCleared()).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "localStorage", original);
    }
  });

  it("refuses to confirm a clear while the memory fallback still holds a value", () => {
    const store = new SafeStorage("local");
    testLocalStorage.throwOnSet = "error";
    store.set("anonymous_id", "abc");
    testLocalStorage.throwOnSet = false;

    expect(store.confirmCleared()).toBe(false);

    store.clear();
    expect(store.confirmCleared()).toBe(true);
  });

  it("recognises the browser spellings of a quota failure", () => {
    expect(isQuotaExceededError(new DOMException("x", "QuotaExceededError"))).toBe(true);
    expect(isQuotaExceededError({ code: 22 })).toBe(true);
    expect(isQuotaExceededError({ name: "NS_ERROR_DOM_QUOTA_REACHED" })).toBe(true);
    expect(isQuotaExceededError(new Error("nope"))).toBe(false);
    expect(isQuotaExceededError(null)).toBe(false);
  });
});
