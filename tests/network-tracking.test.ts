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
  let requests: Array<[PulseLogLevel, Record<string, string>]>;
  let uninstall: () => void;

  function install(overrides: Partial<NetworkTrackingOptions> = {}): void {
    uninstall = installNetworkTracking({
      endpoint: ENDPOINT,
      propagateSessionTo: [],
      trackRequests: true,
      sessionId: () => "session-1",
      onRequest: (level, attributes) => {
        requests.push([level, attributes]);
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
});
