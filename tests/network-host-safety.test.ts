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
function install(propagate = true, onRequest: (level: unknown, attributes: Record<string, string>) => void = () => {}): void {
  uninstall = installNetworkTracking({
    endpoint: "https://pulse.example.com", propagateSessionTo: propagate ? ["https://app.example.com/api"] : [],
    trackRequests: true, sessionId: () => "session", onRequest,
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
      // Lazy observation uses a facade; native reads still use the original receiver.
      expect(options === init).toBe(false);
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
  it("forwards original headers when the optional Headers adapter fails before conversion", async () => {
    const reads: string[] = [];
    const init = {
      get headers() { expect(this).toBe(init); reads.push("headers"); return { "X-App": "yes" }; },
      get method() { expect(this).toBe(init); reads.push("method"); return "POST"; },
    };
    const baseline = new Request("https://app.example.com/api/orders", init);
    const baselineReads = [...reads];
    reads.length = 0;
    let sent!: Request;
    vi.stubGlobal("fetch", vi.fn(async (input, options) => { sent = new Request(input, options); return new Response("ok"); }));
    vi.stubGlobal("Headers", class { constructor() { throw new Error("header adapter unavailable"); } });
    install();
    await expect(fetch("https://app.example.com/api/orders", init)).resolves.toBeInstanceOf(Response);
    expect(sent.method).toBe(baseline.method);
    expect(sent.headers.get("X-App")).toBe("yes");
    expect(reads).toEqual(baselineReads);
  });
  it("does not replay throwing native header getters or iterable conversion", async () => {
    const failure = new Error("application header failure");
    const getHeaders = vi.fn(() => { throw failure; });
    const getIterator = vi.fn(() => { throw failure; });
    const badIterable = Object.defineProperty({}, Symbol.iterator, { get: getIterator });
    vi.stubGlobal("fetch", vi.fn(async (input, options) => { new Request(input, options); return new Response("ok"); }));
    install();
    await expect(fetch("https://app.example.com/api/orders", Object.defineProperty({}, "headers", { get: getHeaders }))).rejects.toBe(failure);
    await expect(fetch("https://app.example.com/api/orders", { headers: badIterable })).rejects.toBe(failure);
    expect(getHeaders).toHaveBeenCalledTimes(1);
    expect(getIterator).toHaveBeenCalledTimes(1);
  });
  it("does not inspect RequestInit proxy descriptors or prototypes before native conversion", async () => {
    let method = "POST";
    const descriptors = vi.fn(() => { method = "DELETE"; return undefined; });
    const prototypes = vi.fn(() => { method = "DELETE"; return null; });
    const init = new Proxy({}, {
      get(_target, key) { return key === "method" ? method : undefined; },
      getOwnPropertyDescriptor: descriptors,
      getPrototypeOf: prototypes,
    });
    let sent!: Request;
    const reported = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input, options) => { sent = new Request(input, options); return new Response("ok"); }));
    install(false, reported);
    await fetch("https://app.example.com/api/orders", init);
    expect(sent.method).toBe("POST");
    expect(descriptors).not.toHaveBeenCalled();
    expect(prototypes).not.toHaveBeenCalled();
    expect(reported.mock.calls[0]![1]._http_method).toBe("POST");
  });
  it("observes method getter results only on the underlying fetch read", async () => {
    const getter = vi.fn(function (this: unknown) { expect(this).toBe(init); return "post"; });
    const init = Object.defineProperty({}, "method", { get: getter });
    const reported = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input, options) => {
      expect(getter).not.toHaveBeenCalled();
      const sent = new Request(input, options);
      expect(sent.method).toBe("POST");
      return new Response("ok");
    }));
    install(false, reported);
    await fetch("https://app.example.com/api/orders", init);
    expect(getter).toHaveBeenCalledTimes(1);
    expect(reported.mock.calls[0]![1]._http_method).toBe("POST");
  });
  it.each([false, true])("retains an explicit inherited abort signal through wrapper presence checks, propagation=%s", async (propagate) => {
    const controller = new AbortController();
    const failure = new Error("caller cancelled");
    controller.abort(failure);
    const init = Object.create({ signal: controller.signal });
    vi.stubGlobal("fetch", vi.fn(async (_input, options) => {
      if (!("signal" in options)) options.signal = new AbortController().signal;
      expect(Object.hasOwn(options, "signal")).toBe(false);
      expect(options.signal).toBe(controller.signal);
      options.signal.throwIfAborted();
      return new Response("ok");
    }));
    install(propagate);
    await expect(fetch("https://app.example.com/api/orders", init)).rejects.toBe(failure);
  });
  it.each([false, true])("respects wrapper deletion, replacement and enumeration, propagation=%s", async (propagate) => {
    const init: RequestInit = { method: "POST", body: "before", credentials: "include" };
    let sent!: Request;
    vi.stubGlobal("fetch", vi.fn(async (input, options) => {
      delete options.credentials;
      delete options.body;
      options.method = "PUT";
      expect("credentials" in options).toBe(false);
      expect(Object.keys(options)).not.toContain("body");
      sent = new Request(input, { ...options });
      return new Response("ok");
    }));
    install(propagate);
    await fetch("https://app.example.com/api/orders", init);
    expect(sent.method).toBe("PUT");
    expect(sent.credentials).toBe("same-origin");
    expect(await sent.text()).toBe("");
    expect(init).toEqual(propagate ? { method: "POST", body: "before", credentials: "include" } : { method: "PUT" });
  });
  it.each([false, true])("converts frozen RequestInit values and inherited methods, propagation=%s", async (propagate) => {
    const signal = new AbortController().signal;
    const init = Object.freeze(Object.assign(Object.create({ method: "POST" }), { signal, body: "payload" }));
    let sent!: Request;
    const reported = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input, options) => {
      expect(options.signal).toBe(signal);
      sent = new Request(input, options);
      return new Response("ok");
    }));
    install(propagate, reported);
    await fetch("https://app.example.com/api/orders", init);
    expect(sent.method).toBe("POST");
    expect(await sent.text()).toBe("payload");
    expect(reported.mock.calls[0]![1]._http_method).toBe("POST");
    expect(Object.keys(init)).toEqual(["signal", "body"]);
  });
  it("forwards tracking-only setters, deletion and freezing to the original options", async () => {
    let method = "POST";
    const init: RequestInit = { body: "payload", get method() { return method; }, set method(value) { expect(this).toBe(init); method = value!; } };
    let sent!: Request;
    vi.stubGlobal("fetch", vi.fn(async (input, options) => {
      options.method = "PUT";
      delete options.body;
      Object.freeze(options);
      expect(Object.isFrozen(init)).toBe(true);
      expect(Object.isFrozen(options)).toBe(true);
      sent = new Request(input, options);
      return new Response("ok");
    }));
    install(false);
    await fetch("https://app.example.com/api/orders", init);
    expect(sent.method).toBe("PUT");
    expect(await sent.text()).toBe("");
  });
  it("supports a wrapper freezing the propagation facade without changing native options", async () => {
    let methodReads = 0;
    const init = Object.create({ credentials: "include" });
    Object.defineProperty(init, "method", { enumerable: true, configurable: true, get() { expect(this).toBe(init); methodReads++; return "POST"; } });
    let sent!: Request;
    vi.stubGlobal("fetch", vi.fn(async (input, options) => {
      Object.freeze(options);
      expect(Object.isFrozen(options)).toBe(true);
      expect(methodReads).toBe(0);
      sent = new Request(input, options);
      return new Response("ok");
    }));
    install();
    await fetch("https://app.example.com/api/orders", init);
    expect(sent.method).toBe("POST");
    expect(sent.credentials).toBe("include");
    expect(methodReads).toBe(1);
  });
  it.each([false, true])("classifies cancellation after native conversion without disrupting a throwing hook, propagation=%s", async (propagate) => {
    const controller = new AbortController();
    controller.abort();
    const method = vi.fn(() => "POST");
    const init = Object.create({ signal: controller.signal });
    Object.defineProperty(init, "method", { get: method });
    const reported = vi.fn(() => { throw new Error("collector failed"); });
    vi.stubGlobal("fetch", vi.fn(async (input, options) => {
      if (!("signal" in options)) options.signal = new AbortController().signal;
      const request = new Request(input, options);
      request.signal.throwIfAborted();
      return new Response("ok");
    }));
    install(propagate, reported);
    await expect(fetch("https://app.example.com/api/orders", init)).rejects.toBe(controller.signal.reason);
    expect(method).toHaveBeenCalledTimes(1);
    expect(reported).toHaveBeenCalledExactlyOnceWith("debug", expect.objectContaining({
      _http_method: "POST", _http_status: "0",
    }), { originalException: controller.signal.reason });
  });
  it.each([false, true])("contains rejection metadata getters and preserves the original rejection, propagation=%s", async (propagate) => {
    const name = vi.fn(() => { throw new Error("classification failed"); });
    const failure = Object.defineProperty({}, "name", { get: name });
    vi.stubGlobal("fetch", vi.fn(async () => { throw failure; }));
    install(propagate);
    await expect(fetch("https://app.example.com/api/orders")).rejects.toBe(failure);
    expect(name).toHaveBeenCalledTimes(1);
  });
  it("preserves unusual fetch return values when attaching the observer fails", () => {
    const result = Object.defineProperty({}, "then", { get() { throw new Error("observer unavailable"); } });
    vi.stubGlobal("fetch", vi.fn(() => result));
    install(false);
    expect(fetch("https://app.example.com/api/orders")).toBe(result);
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
