import { beforeEach, describe, expect, it } from "vitest";
import { isQuotaExceededError, SafeStorage, STORAGE_PREFIX } from "../src/storage";
import { resetTestEnvironment, testLocalStorage } from "./setup";

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

  it("recognises the browser spellings of a quota failure", () => {
    expect(isQuotaExceededError(new DOMException("x", "QuotaExceededError"))).toBe(true);
    expect(isQuotaExceededError({ code: 22 })).toBe(true);
    expect(isQuotaExceededError({ name: "NS_ERROR_DOM_QUOTA_REACHED" })).toBe(true);
    expect(isQuotaExceededError(new Error("nope"))).toBe(false);
    expect(isQuotaExceededError(null)).toBe(false);
  });
});
