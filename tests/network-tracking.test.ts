import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installNetworkTracking,
  SESSION_HEADER,
  stripQuery,
  type NetworkTrackingOptions,
} from "../src/network-tracking";
import type { PulseLogLevel } from "../src/types";
import { resetTestEnvironment } from "./setup";

const ENDPOINT = "https://pulse.example.com";

describe("installNetworkTracking", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let requests: Array<[PulseLogLevel, Record<string, string>, unknown]>;
  let uninstall: () => void;

  function install(overrides: Partial<NetworkTrackingOptions> = {}): void {
    uninstall = installNetworkTracking({
      endpoint: ENDPOINT,
      propagateSessionTo: [],
      trackRequests: true,
      sessionId: () => "session-1",
      onRequest: (level, attributes, error) => {
        requests.push([level, attributes, error]);
      },
      ...overrides,
    });
  }

  /** Headers the wrapper handed to the underlying fetch for call `index`. */
  function sentHeaders(index = 0): Headers {
    const init = fetchMock.mock.calls[index]![1] as RequestInit | undefined;
    return new Headers(init?.headers);
  }

  beforeEach(() => {
    resetTestEnvironment();
    requests = [];
    fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    uninstall = () => undefined;
  });

  afterEach(() => {
    uninstall();
    vi.unstubAllGlobals();
  });

  it("records a successful request at debug level with the query stripped", async () => {
    install();

    const response = await fetch("https://api.example.com/users?token=secret#top");

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    const [level, attributes] = requests[0]!;
    expect(level).toBe("debug");
    expect(attributes._http_method).toBe("GET");
    expect(attributes._http_url).toBe("https://api.example.com/users");
    expect(attributes._http_status).toBe("200");
    expect(attributes._http_duration_ms).toMatch(/^\d+$/);
    expect(requests[0]![2]).toBeUndefined();
  });

  it("uses the method from the init object", async () => {
    install();

    await fetch("https://api.example.com/users", { method: "post" });

    expect(requests[0]![1]._http_method).toBe("POST");
  });

  it("warns on a failed status", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    install();

    await fetch("https://api.example.com/users");

    expect(requests[0]![0]).toBe("warn");
    expect(requests[0]![1]._http_status).toBe("500");
  });

  it("treats a redirect as healthy", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 304 }));
    install();

    await fetch("https://api.example.com/users");

    expect(requests[0]![0]).toBe("debug");
  });

  it("reports a network failure and rethrows it", async () => {
    const failure = new TypeError("Failed to fetch");
    fetchMock.mockRejectedValue(failure);
    install();

    await expect(fetch("https://api.example.com/users")).rejects.toBe(failure);

    expect(requests[0]![0]).toBe("error");
    expect(requests[0]![1]._http_status).toBe("0");
    expect(requests[0]![2]).toBe(failure);
  });

  it("records a request aborted mid-flight as a cancellation and rethrows it", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      controller.abort();
      return Promise.reject(init?.signal?.reason);
    });
    install();

    const pending = fetch("https://api.example.com/users", { signal: controller.signal });
    await expect(pending).rejects.toBe(controller.signal.reason);

    expect(requests[0]![0]).toBe("debug");
    expect(requests[0]![1]._http_status).toBe("0");
    expect(requests[0]![1]._http_method).toBe("GET");
    expect(requests[0]![1]._http_url).toBe("https://api.example.com/users");
    expect(requests[0]![1]._http_duration_ms).toMatch(/^\d+$/);
    expect(requests[0]![2]).toBe(controller.signal.reason);
  });

  it("records a pre-aborted signal as a cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.reject(init?.signal?.reason));
    install();

    await expect(fetch("https://api.example.com/users", { signal: controller.signal }))
      .rejects.toBe(controller.signal.reason);

    expect(requests[0]![0]).toBe("debug");
    expect(requests[0]![1]._http_status).toBe("0");
  });

  it("records a Request carrying an aborted signal as a cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = new Request("https://api.example.com/users", { signal: controller.signal });
    fetchMock.mockImplementation((input: Request) => Promise.reject(input.signal.reason));
    install();

    await expect(fetch(request)).rejects.toBe(controller.signal.reason);

    expect(requests[0]![0]).toBe("debug");
    expect(requests[0]![1]._http_status).toBe("0");
  });

  it.each([
    ["a timeout", new DOMException("The operation timed out", "TimeoutError")],
    ["a thrown string", "rejected"],
  ])("keeps %s at error level", async (_label, reason) => {
    fetchMock.mockRejectedValue(reason);
    install();

    await expect(fetch("https://api.example.com/users")).rejects.toBe(reason);

    expect(requests[0]![0]).toBe("error");
    expect(requests[0]![1]._http_status).toBe("0");
    expect(requests[0]![2]).toBe(reason);
  });

  it("reports a custom abort reason as a failure, not a cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("slow");
    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      controller.abort(reason);
      return Promise.reject(init?.signal?.reason);
    });
    install();

    await expect(fetch("https://api.example.com/users", { signal: controller.signal }))
      .rejects.toBe(reason);

    expect(requests[0]![0]).toBe("error");
    expect(requests[0]![2]).toBe(reason);
  });

  it("skips the sdk's own endpoint", async () => {
    install({ propagateSessionTo: [ENDPOINT] });

    await fetch(`${ENDPOINT}/v1/ingest`, { method: "POST" });

    expect(requests).toEqual([]);
    expect(sentHeaders().has(SESSION_HEADER)).toBe(false);
  });

  it("resolves relative urls against the page", async () => {
    install();

    await fetch("/api/orders?page=2");

    expect(requests[0]![1]._http_url).toBe("https://app.example.com/api/orders");
  });

  it("attaches the session header to matching prefixes only", async () => {
    install({ propagateSessionTo: ["/api"] });

    await fetch("/api/orders");
    await fetch("/static/logo.svg");

    expect(sentHeaders(0).get(SESSION_HEADER)).toBe("session-1");
    expect(sentHeaders(1).has(SESSION_HEADER)).toBe(false);
  });

  it("refuses a look-alike host that merely starts with the prefix", async () => {
    install({ propagateSessionTo: ["https://api.example.com"] });

    await fetch("https://api.example.com.attacker.tld/orders");
    await fetch("https://api.example.comx/orders");
    await fetch("https://api.example.com/orders");

    expect(sentHeaders(0).has(SESSION_HEADER)).toBe(false);
    expect(sentHeaders(1).has(SESSION_HEADER)).toBe(false);
    expect(sentHeaders(2).get(SESSION_HEADER)).toBe("session-1");
  });

  it("matches a relative prefix only at a path boundary", async () => {
    install({ propagateSessionTo: ["/api"] });

    await fetch("/api/orders");
    await fetch("/api");
    await fetch("/apixyz/orders");

    expect(sentHeaders(0).get(SESSION_HEADER)).toBe("session-1");
    expect(sentHeaders(1).get(SESSION_HEADER)).toBe("session-1");
    expect(sentHeaders(2).has(SESSION_HEADER)).toBe(false);
  });

  it("still tracks a host that merely starts with the sdk endpoint", async () => {
    install();

    await fetch(`${ENDPOINT}.attacker.tld/v1/ingest`);

    expect(requests).toHaveLength(1);
    expect(requests[0]![1]._http_url).toBe("https://pulse.example.com.attacker.tld/v1/ingest");
  });

  it("strips embedded credentials from the reported url", async () => {
    const failure = new TypeError("Failed to fetch");
    fetchMock.mockRejectedValue(failure);
    install();

    await expect(fetch("https://user:token@api.example.com/x?q=1")).rejects.toBe(failure);

    expect(requests[0]![1]._http_url).toBe("https://api.example.com/x");
  });

  it("keeps existing headers and the Request input intact", async () => {
    install({ propagateSessionTo: ["https://api.example.com"] });
    const request = new Request("https://api.example.com/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    await fetch(request);

    expect(fetchMock.mock.calls[0]![0]).toBe(request);
    expect(sentHeaders().get(SESSION_HEADER)).toBe("session-1");
    expect(sentHeaders().get("Content-Type")).toBe("application/json");
    expect(requests[0]![1]._http_method).toBe("POST");
  });

  it("omits the header when there is no session yet", async () => {
    install({ propagateSessionTo: ["/api"], sessionId: () => undefined });

    await fetch("/api/orders");

    expect(sentHeaders().has(SESSION_HEADER)).toBe(false);
  });

  it("propagates the session without emitting events when tracking is off", async () => {
    install({ trackRequests: false, propagateSessionTo: ["/api"] });

    await fetch("/api/orders");

    expect(requests).toEqual([]);
    expect(sentHeaders().get(SESSION_HEADER)).toBe("session-1");
  });

  it("restores the original fetch on uninstall", async () => {
    install();
    uninstall();

    await fetch("https://api.example.com/users");

    expect(globalThis.fetch).toBe(fetchMock);
    expect(requests).toEqual([]);
  });

  it("strips the query and fragment", () => {
    expect(stripQuery("https://a.example/b?c=1#d")).toBe("https://a.example/b");
    expect(stripQuery("https://a.example/b")).toBe("https://a.example/b");
  });
  it.each([
    ["https://user:password@api.example.com:8443/invite/secret?token=secret#fragment", "https://api.example.com:8443"],
    ["http://api.example.com:8080/profile/secret", "http://api.example.com:8080"],
    ["/api/private?token=secret#fragment", "https://app.example.com"],
    ["relative/private?secret", "https://app.example.com"],
    ["//api.example.com/private", "https://api.example.com"],
    ["https://[bad/private?secret", undefined],
    ["data:text/plain,secret", undefined],
    ["file:///private/secret", undefined],
    ["blob:https://api.example.com/private", undefined],
    ["javascript:secret", undefined],
  ])("reports only an HTTP(S) origin for %s", async (url, expected) => {
    install({ urlMode: "origin" });
    await fetch(url);
    expect(requests[0]![1]._http_url).toBe(expected);
    expect(requests[0]![1]._http_method).toBe("GET");
    expect(requests[0]![1]._http_status).toBe("200");
    expect(requests[0]![1]._http_duration_ms).toMatch(/^\d+$/);
    if (expected === undefined) expect(requests[0]![1]).not.toHaveProperty("_http_url");
    expect(JSON.stringify(requests)).not.toContain("secret");
  });

  it("sanitizes failed requests before delivering their metadata", async () => {
    const failure = new TypeError("private rejection");
    fetchMock.mockRejectedValue(failure);
    install({ urlMode: "origin" });
    await expect(fetch("https://user:password@api.example.com/invite/secret?token=secret")).rejects.toBe(failure);
    expect(requests[0]![1]._http_url).toBe("https://api.example.com");
    expect(requests[0]![1]._http_status).toBe("0");
    expect(JSON.stringify(requests)).not.toContain("secret");
  });

  it("preserves fetch receiver, argument count and request/response identity", async () => {
    const response = new Response("response body");
    const promise = Promise.resolve(response);
    fetchMock.mockReturnValue(promise);
    install({ urlMode: "origin" });
    const receiver = { marker: true };
    const request = new Request("https://api.example.com/private", { method: "POST", body: "private body" });
    const headers = new Headers({ Authorization: "app-secret" });
    const init = { headers, body: "unchanged body", method: "PUT" };
    const result = Reflect.apply(fetch, receiver, [request, init]);
    expect(await result).toBe(response);
    expect(fetchMock.mock.contexts[0]).toBe(receiver);
    expect(fetchMock.mock.calls[0]).toEqual([request, init]);
    expect(fetchMock.mock.calls[0]![0]).toBe(request);
    expect(fetchMock.mock.calls[0]![1]).toBe(init);
    expect(init.headers.get("Authorization")).toBe("app-secret");
    expect(request.bodyUsed).toBe(false);
    expect(await response.text()).toBe("response body");
    await fetch(new URL("https://api.example.com/private"));
    expect(fetchMock.mock.calls[1]).toHaveLength(1);
    await fetch("/api/private", undefined);
    expect(fetchMock.mock.calls[2]).toHaveLength(2);
    expect(requests[0]![1]._http_method).toBe("PUT");
  });

  it("does not change response or rejection when the telemetry callback throws", async () => {
    const failure = new TypeError("application failure");
    const response = new Response("ok");
    fetchMock.mockResolvedValueOnce(response).mockRejectedValueOnce(failure);
    install({ urlMode: "origin", onRequest: () => { throw new Error("collector failure"); } });
    expect(await fetch("/private")).toBe(response);
    await expect(fetch("/private")).rejects.toBe(failure);
  });

  it("preserves synchronous fetch failures", () => {
    const failure = new TypeError("bad receiver");
    const cancelled = new DOMException("aborted", "AbortError");
    fetchMock.mockImplementationOnce(() => { throw failure; })
      .mockImplementationOnce(() => { throw cancelled; });
    install({ urlMode: "origin" });
    expect(() => fetch("/private")).toThrow(failure);
    expect(requests[0]).toEqual(["error", expect.objectContaining({ _http_status: "0" }), failure]);
    expect(() => fetch("/private")).toThrow(cancelled);
    expect(requests[1]).toEqual(["debug", expect.objectContaining({ _http_status: "0" }), cancelled]);
  });

  it("omits unresolved relative origins and avoids extra coercion of unusual inputs", async () => {
    vi.stubGlobal("location", undefined);
    install({ urlMode: "origin" });
    await fetch("/private");
    expect(requests[0]![1]).not.toHaveProperty("_http_url");
    const input = { toString: vi.fn(() => "/private") };
    await fetch(input as unknown as RequestInfo);
    expect(input.toString).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[1]![0]).toBe(input);
    expect(requests[1]![1]).not.toHaveProperty("_http_url");
  });

  it("preserves ingest exclusion and opt-in propagation in origin mode", async () => {
    install({ urlMode: "origin", propagateSessionTo: [ENDPOINT, "/api"] });
    await fetch(`${ENDPOINT}/v1/ingest`);
    await fetch("/api/private", { headers: { Authorization: "app-secret" } });
    expect(requests).toHaveLength(1);
    expect(requests[0]![1]._http_url).toBe("https://app.example.com");
    expect(sentHeaders(0).has(SESSION_HEADER)).toBe(false);
    expect(sentHeaders(1).get(SESSION_HEADER)).toBe("session-1");
    expect(sentHeaders(1).get("Authorization")).toBe("app-secret");
  });

  it("does not report in-flight requests or annotate retained wrappers after uninstall", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((done) => { resolve = done; }));
    install({ urlMode: "origin", propagateSessionTo: ["/api"] });
    const retained = fetch;
    const pending = fetch("/api/private");
    uninstall();
    resolve(new Response("ok"));
    await pending;
    await retained("/api/other");
    expect(requests).toEqual([]);
    expect(sentHeaders(1).has(SESSION_HEADER)).toBe(false);
  });

});
