import { beforeEach, describe, expect, it, vi } from "vitest";
import { ANONYMOUS_ID_KEY, IdentityManager, USER_ID_KEY } from "../src/identity";
import { STORAGE_PREFIX } from "../src/storage";
import { resetTestEnvironment, testLocalStorage } from "./setup";

function stored(key: string): string | null {
  return testLocalStorage.getItem(STORAGE_PREFIX + key);
}

/** A promise plus the handles to settle it from the test body. */
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("IdentityManager", () => {
  let claims: Array<[string, string]>;
  let claim: ReturnType<typeof vi.fn>;
  let debugMessages: string[];

  function makeManager(): IdentityManager {
    return new IdentityManager({
      claim: claim as unknown as (anonymousId: string, userId: string) => Promise<void>,
      onDebug: (message) => debugMessages.push(message),
    });
  }

  beforeEach(() => {
    resetTestEnvironment();
    claims = [];
    debugMessages = [];
    claim = vi.fn((anonymousId: string, userId: string) => {
      claims.push([anonymousId, userId]);
      return Promise.resolve();
    });
  });

  it("creates and persists an anonymous id on first load", () => {
    const manager = makeManager();
    manager.load();

    expect(manager.anonymous).toMatch(/^pulse_anon_[0-9a-f-]{36}$/);
    expect(stored(ANONYMOUS_ID_KEY)).toBe(manager.anonymous);
    expect(manager.currentId).toBe(manager.anonymous);
    expect(claim).not.toHaveBeenCalled();
  });

  it("reuses the stored anonymous id on a later load", () => {
    const first = makeManager();
    first.load();

    const second = makeManager();
    second.load();

    expect(second.anonymous).toBe(first.anonymous);
  });

  it("adopts a persisted user id and re-claims it in the background", async () => {
    testLocalStorage.setItem(STORAGE_PREFIX + ANONYMOUS_ID_KEY, "pulse_anon_stored");
    testLocalStorage.setItem(STORAGE_PREFIX + USER_ID_KEY, "user-7");

    const manager = makeManager();
    manager.load();

    // The id is live immediately; the claim only repairs the server state.
    expect(manager.currentId).toBe("user-7");
    await manager.settled;
    expect(claims).toEqual([["pulse_anon_stored", "user-7"]]);
  });

  it("claims before switching the active id", async () => {
    const gate = deferred();
    claim = vi.fn((anonymousId: string, userId: string) => {
      claims.push([anonymousId, userId]);
      return gate.promise;
    });

    const manager = makeManager();
    manager.load();
    const anonymousId = manager.anonymous;

    const pending = manager.setUser("user-1");
    // The claim is in flight: events must still be anonymous, or the server
    // would never reassign them.
    expect(claims).toEqual([[anonymousId, "user-1"]]);
    expect(manager.currentId).toBe(anonymousId);
    expect(stored(USER_ID_KEY)).toBe("user-1");

    gate.resolve();
    await pending;
    expect(manager.currentId).toBe("user-1");
  });

  it("switches the id even when the claim fails, so the retry happens later", async () => {
    claim = vi.fn(() => Promise.reject(new Error("offline")));

    const manager = makeManager();
    manager.load();
    await manager.setUser("user-2");

    expect(manager.currentId).toBe("user-2");
    expect(stored(USER_ID_KEY)).toBe("user-2");
    expect(debugMessages).toContain("identity claim failed");
  });

  it("ignores a repeated setUser for the same identifier", async () => {
    const manager = makeManager();
    manager.load();
    await manager.setUser("user-3");
    await manager.setUser("user-3");

    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("trims the identifier and rejects an empty one", async () => {
    const manager = makeManager();
    manager.load();

    await expect(manager.setUser("   ")).rejects.toThrow(/non-empty user id/);
    await manager.setUser("  user-4  ");
    expect(manager.currentId).toBe("user-4");
  });

  it("reverts to the same anonymous id on clearUser", async () => {
    const manager = makeManager();
    manager.load();
    const anonymousId = manager.anonymous;
    await manager.setUser("user-5");

    manager.clearUser();

    expect(manager.currentId).toBe(anonymousId);
    expect(manager.anonymous).toBe(anonymousId);
    expect(stored(USER_ID_KEY)).toBeNull();
    expect(stored(ANONYMOUS_ID_KEY)).toBe(anonymousId);
  });

  it("mints a fresh anonymous id when asked to", async () => {
    const manager = makeManager();
    manager.load();
    const anonymousId = manager.anonymous;
    await manager.setUser("user-6");

    manager.clearUser({ newAnonymousId: true });

    expect(manager.anonymous).not.toBe(anonymousId);
    expect(manager.currentId).toBe(manager.anonymous);
    expect(stored(ANONYMOUS_ID_KEY)).toBe(manager.anonymous);
  });

  it("does not re-identify the user when clearUser lands during an in-flight claim", async () => {
    const gate = deferred();
    claim = vi.fn(() => gate.promise);

    const manager = makeManager();
    manager.load();
    const anonymousId = manager.anonymous;

    const pending = manager.setUser("user-8");
    manager.clearUser();
    gate.resolve();
    await pending;

    expect(manager.currentId).toBe(anonymousId);
    expect(stored(USER_ID_KEY)).toBeNull();
  });

  it("settles two overlapping setUser calls on the latest caller", async () => {
    const gate = deferred();
    claim = vi.fn(() => gate.promise);

    const manager = makeManager();
    manager.load();

    const pendingFirst = manager.setUser("user-9");
    const pendingSecond = manager.setUser("user-10");
    gate.resolve();
    await Promise.all([pendingFirst, pendingSecond]);

    expect(manager.currentId).toBe("user-10");
  });

  it("can identify a new user after clearing the previous one", async () => {
    const manager = makeManager();
    manager.load();
    await manager.setUser("user-a");
    manager.clearUser();
    await manager.setUser("user-b");

    expect(manager.currentId).toBe("user-b");
    expect(claims.map(([, userId]) => userId)).toEqual(["user-a", "user-b"]);
  });
});
