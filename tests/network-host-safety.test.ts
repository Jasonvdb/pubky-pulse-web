import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installNetworkTracking, SESSION_HEADER } from "../src/network-tracking";
import { PageTracker } from "../src/page-tracking";
import { resetTestEnvironment, testHistory, testLocation } from "./setup";

let uninstall = () => {};
let tracker: PageTracker | undefined;
let push: History["pushState"];
let replace: History["replaceState"];
beforeEach(() => {
  resetTestEnvironment();
  push = history.pushState;
  replace = history.replaceState;
});
afterEach(() => {
  uninstall();
  uninstall = () => {};
  tracker?.restore();
  tracker = undefined;
  Object.defineProperty(testHistory, "pushState", { value: push, writable: true, configurable: true });
  Object.defineProperty(testHistory, "replaceState", { value: replace, writable: true, configurable: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function install(propagate = true): void {
  uninstall = installNetworkTracking({
    endpoint: "https://pulse.example.com", propagateSessionTo: propagate ? ["https://app.example.com/api"] : [],
    trackRequests: true, sessionId: () => "session", onRequest() {},
  });
}

describe("request behavior with instrumentation", () => {
  it.each(["inherited", "non-enumerable"])("preserves %s request fields and cancellation during propagation", async (kind) => {
    const signal = new AbortController().signal;
    const fields = { method: "POST", body: "payload", credentials: "include", signal };
    const init = kind === "inherited" ? Object.create(fields) : Object.defineProperties({},
      Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }])));
    let sent!: Request;
    vi.stubGlobal("fetch", vi.fn(async (input, options) => {
      expect(options?.signal).toBe(signal);
      sent = new Request(input, options);
      return new Response("ok");
    }));
    install();
    await fetch("https://app.example.com/api/orders", init);
    expect(sent.method).toBe("POST");
    expect(sent.credentials).toBe("include");
    expect(await sent.text()).toBe("payload");
    expect(sent.headers.get(SESSION_HEADER)).toBe("session");
  });
  it.each([false, true])("preserves accessor order, counts and receivers with propagation=%s", async (propagate) => {
    const reads: string[] = [];
    let methodReads = 0;
    const init = {
      get method() { expect(this).toBe(init); reads.push("method"); return ++methodReads === 1 ? "POST" : "DELETE"; },
      get headers() { expect(this).toBe(init); reads.push("headers"); return { "X-App": "yes" }; },
      get credentials() { expect(this).toBe(init); reads.push("credentials"); return "include" as const; },
    };
    const baseline = new Request("https://app.example.com/api/orders", init);
    const baselineReads = [...reads];
    reads.length = 0;
    methodReads = 0;
    let sent!: Request;
    vi.stubGlobal("fetch", vi.fn(async (input, options) => {
      if (!propagate) expect(options).toBe(init);
      sent = new Request(input, options);
      return new Response("ok");
    }));
    install(propagate);
    await fetch("https://app.example.com/api/orders", init);
    expect(sent.method).toBe(baseline.method);
    expect(reads).toEqual(baselineReads);
    expect(sent.headers.get("X-App")).toBe("yes");
    expect(sent.headers.has(SESSION_HEADER)).toBe(propagate);
  });
  it("keeps stream ownership and the original request while forwarding its session", async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("payload")); controller.close(); } });
    const request = new Request("https://app.example.com/api/orders", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    let sent!: Request;
    vi.stubGlobal("fetch", vi.fn(async (input, options) => {
      expect(input).toBe(request);
      expect(request.bodyUsed).toBe(false);
      expect(stream.locked).toBe(false);
      sent = new Request(input, options);
      return new Response("ok");
    }));
    install();
    await fetch(request);
    expect(await sent.text()).toBe("payload");
    expect(sent.headers.get(SESSION_HEADER)).toBe("session");
  });
  it("preserves own options through another wrapper that spreads the init dictionary", async () => {
    let sent!: Request;
    vi.stubGlobal("fetch", vi.fn(async (input, options) => {
      sent = new Request(input, { ...options });
      return new Response("ok");
    }));
    install();
    await fetch("https://app.example.com/api/orders", { method: "POST", body: "payload" });
    expect(sent.method).toBe("POST");
    expect(await sent.text()).toBe("payload");
    expect(sent.headers.get(SESSION_HEADER)).toBe("session");
  });
  it("preserves frozen init objects and iterable header consumption", async () => {
    let iterations = 0;
    const headers = {
      *[Symbol.iterator]() { iterations++; yield ["X-App", "yes"]; },
    } as HeadersInit;
    const init = Object.freeze({ method: "POST", headers });
    let sent!: Request;
    vi.stubGlobal("fetch", vi.fn(async (input, options) => {
      sent = new Request(input, options);
      return new Response("ok");
    }));
    install();
    await fetch("https://app.example.com/api/orders", init);
    expect(iterations).toBe(1);
    expect(sent.headers.get("X-App")).toBe("yes");
    expect(sent.headers.get(SESSION_HEADER)).toBe("session");
  });
  it("keeps an aborted signal and its rejection unchanged", async () => {
    const controller = new AbortController();
    const failure = new Error("application cancelled");
    controller.abort(failure);
    vi.stubGlobal("fetch", vi.fn(async (_input, options) => {
      expect(options.signal).toBe(controller.signal);
      options.signal.throwIfAborted();
      return new Response("ok");
    }));
    install();
    await expect(fetch("https://app.example.com/api/orders", { signal: controller.signal })).rejects.toBe(failure);
  });
  it("does not convert an invalid primitive init into an accepted request", async () => {
    let failure: unknown;
    try { new Request("https://app.example.com/api/orders", "invalid" as RequestInit); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TypeError);
    vi.stubGlobal("fetch", vi.fn(async (input, options) => { new Request(input, options); return new Response("ok"); }));
    install();
    await expect(fetch("https://app.example.com/api/orders", "invalid" as RequestInit)).rejects.toBeInstanceOf(TypeError);
  });
  it("contains a response metadata getter failure", async () => {
    const response = new Response("ok");
    Object.defineProperty(response, "status", { get() { throw new Error("metadata failed"); } });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    install(false);
    expect(await fetch("https://app.example.com/api/orders")).toBe(response);
  });
});

describe("navigation behavior with instrumentation", () => {
  it("retains later router wrappers and never reactivates retired hooks", () => {
    const oldAppeared = vi.fn();
    tracker = new PageTracker({ onAppeared: oldAppeared, onDisappeared() {} });
    tracker.install();
    const retained = history.pushState;
    const router = vi.fn(function (this: History, ...args: Parameters<History["pushState"]>) {
      return Reflect.apply(retained, this, args);
    });
    history.pushState = router;
    tracker.restore();
    expect(history.pushState).toBe(router);
    oldAppeared.mockClear();
    const appeared = vi.fn();
    tracker = new PageTracker({ onAppeared: appeared, onDisappeared() {} });
    tracker.install();
    appeared.mockClear();
    history.pushState(null, "", "/checkout");
    expect(router).toHaveBeenCalledTimes(1);
    expect(appeared).toHaveBeenCalledTimes(1);
    expect(oldAppeared).not.toHaveBeenCalled();
    tracker.restore();
    expect(history.pushState).toBe(router);
  });
  it("contains failed screen callbacks while retaining successful navigation", () => {
    tracker = new PageTracker({ onAppeared() { throw new Error("collector failed"); }, onDisappeared() { throw new Error("collector failed"); } });
    expect(() => tracker!.install()).not.toThrow();
    expect(() => history.pushState(null, "", "/checkout")).not.toThrow();
    expect(testLocation.pathname).toBe("/checkout");
    expect(tracker.screenName).toBe("/checkout");
  });
  it("preserves a host wrapper return value and its original exception", () => {
    const failure = new Error("router failure");
    const host = vi.fn().mockReturnValueOnce(42).mockImplementationOnce(() => { throw failure; });
    history.pushState = host;
    tracker = new PageTracker({ onAppeared() {}, onDisappeared() {} });
    tracker.install();
    expect(history.pushState(null, "", "/checkout")).toBe(42);
    expect(() => history.pushState(null, "", "/checkout")).toThrow(failure);
  });
  it("still invokes the original with its receiver when the location getter fails", () => {
    const original = vi.fn(function (this: unknown) { return this; });
    history.pushState = original;
    tracker = new PageTracker({ onAppeared() {}, onDisappeared() {} });
    tracker.install();
    const brokenLocation = { get pathname() { throw new Error("location unavailable"); } };
    vi.stubGlobal("location", brokenLocation);
    const receiver = { marker: true };
    expect(Reflect.apply(history.pushState, receiver, [null, "", "/checkout"])).toBe(receiver);
    expect(original).toHaveBeenCalledTimes(1);
  });
  it("restores an installed method when its sibling is read-only", () => {
    Object.defineProperty(testHistory, "replaceState", { value: replace, writable: false, configurable: true });
    tracker = new PageTracker({ onAppeared() {}, onDisappeared() {} });
    expect(() => tracker!.install()).not.toThrow();
    tracker.restore();
    expect(history.pushState).toBe(push);
    expect(history.replaceState).toBe(replace);
  });
});
