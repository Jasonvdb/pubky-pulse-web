import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateConfiguration, type ValidatedConfig } from "../src/configuration";
import { OfflineQueue } from "../src/offline-queue";
import { SafeStorage } from "../src/storage";
import {
  backoffDelayMs,
  KEEPALIVE_BODY_LIMIT_BYTES,
  MAX_BATCH_SIZE,
  sliceForKeepalive,
  Transport,
} from "../src/transport";
import type { IngestRequest, LogEvent, PulseConfiguration } from "../src/types";
import { resetTestEnvironment, testNavigator } from "./setup";

const BUNDLE_ID = "com.example.web";

function makeConfig(overrides: Partial<PulseConfiguration> = {}): ValidatedConfig {
  return validateConfiguration({
    endpoint: "https://pulse.example.com",
    apiKey: "pulse_client_abc",
    bundleId: BUNDLE_ID,
    // Compression is exercised in its own suite; gzip streams and fake timers
    // do not mix well.
    compressionEnabled: false,
    ...overrides,
  });
}

function makeEvent(index: number, message = `event ${index}`): LogEvent {
  return {
    client_event_id: `event-${index}`,
    session_id: "11111111-1111-4111-8111-111111111111",
    level: "info",
    message,
    environment: "web",
    sdk_name: "pubky-pulse-web",
    sdk_version: "0.1.0",
    is_dev: true,
    timestamp: "2026-09-04T00:00:00.000Z",
  };
}

function requestBody(call: unknown[]): IngestRequest {
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string) as IngestRequest;
}

function requestHeaders(call: unknown[]): Record<string, string> {
  return (call[1] as RequestInit).headers as Record<string, string>;
}

describe("backoffDelayMs", () => {
  it("doubles each attempt and caps at 30 seconds", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });
});

describe("sliceForKeepalive", () => {
  it("takes everything when it fits", () => {
    const events = [makeEvent(0), makeEvent(1)];
    expect(sliceForKeepalive(events, BUNDLE_ID)).toEqual({ batch: events, rest: [] });
  });

  it("stops under the keepalive budget and parks the rest", () => {
    const events = Array.from({ length: 60 }, (_, i) => makeEvent(i, "m".repeat(2000)));
    const { batch, rest } = sliceForKeepalive(events, BUNDLE_ID);

    expect(batch.length).toBeGreaterThan(0);
    expect(batch.length + rest.length).toBe(events.length);
    expect(rest.length).toBeGreaterThan(0);
    const size = JSON.stringify({ bundle_id: BUNDLE_ID, events: batch }).length;
    expect(size).toBeLessThanOrEqual(KEEPALIVE_BODY_LIMIT_BYTES);
  });

  it("always sends at least one event, even an oversized one", () => {
    const huge = makeEvent(0, "m".repeat(KEEPALIVE_BODY_LIMIT_BYTES * 2));
    expect(sliceForKeepalive([huge], BUNDLE_ID).batch).toHaveLength(1);
  });
});

describe("Transport", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let queue: OfflineQueue;
  let transport: Transport | null = null;

  function createTransport(overrides: Partial<PulseConfiguration> = {}): Transport {
    transport = new Transport(makeConfig(overrides), queue);
    return transport;
  }

  function ok(): Response {
    return new Response(JSON.stringify({ accepted: 1, rejected: 0 }), { status: 200 });
  }

  beforeEach(() => {
    resetTestEnvironment();
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    queue = new OfflineQueue(new SafeStorage("local"));
    fetchMock = vi.fn(() => Promise.resolve(ok()));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    transport = null;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends buffered events in batches of twenty", async () => {
    const tx = createTransport({ flushThreshold: 1000, maxBufferSize: 1000 });
    for (let i = 0; i < 45; i += 1) tx.enqueue(makeEvent(i));

    await tx.flush();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sizes = fetchMock.mock.calls.map((call) => requestBody(call).events.length);
    expect(sizes).toEqual([MAX_BATCH_SIZE, MAX_BATCH_SIZE, 5]);
    expect(requestBody(fetchMock.mock.calls[0]!).bundle_id).toBe(BUNDLE_ID);
    expect(requestHeaders(fetchMock.mock.calls[0]!).Authorization).toBe("Bearer pulse_client_abc");
    expect(tx.bufferSize).toBe(0);
  });

  it("flushes as soon as the threshold is reached", async () => {
    const tx = createTransport({ flushThreshold: 3 });
    tx.enqueue(makeEvent(0));
    tx.enqueue(makeEvent(1));
    expect(fetchMock).not.toHaveBeenCalled();

    tx.enqueue(makeEvent(2));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody(fetchMock.mock.calls[0]!).events).toHaveLength(3);
  });

  it("flushes on the configured interval", async () => {
    const tx = createTransport({ flushIntervalMs: 5000, flushThreshold: 1000 });
    tx.enqueue(makeEvent(0));

    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops the oldest event once the buffer is full", async () => {
    testNavigator.onLine = false;
    const tx = createTransport({ flushThreshold: 5, maxBufferSize: 5 });
    for (let i = 0; i < 8; i += 1) tx.enqueue(makeEvent(i));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tx.bufferSize).toBe(5);

    testNavigator.onLine = true;
    await tx.flush();
    expect(requestBody(fetchMock.mock.calls[0]!).events.map((e) => e.client_event_id)).toEqual([
      "event-3",
      "event-4",
      "event-5",
      "event-6",
      "event-7",
    ]);
  });

  it("skips sending while the browser reports itself offline", async () => {
    testNavigator.onLine = false;
    const tx = createTransport({ flushThreshold: 1000 });
    tx.enqueue(makeEvent(0));

    await tx.flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tx.bufferSize).toBe(1);
  });

  it("drains the offline queue ahead of new events", async () => {
    queue.append([makeEvent(90), makeEvent(91)]);
    const tx = createTransport({ flushThreshold: 1000 });
    tx.enqueue(makeEvent(0));

    await tx.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody(fetchMock.mock.calls[0]!).events.map((e) => e.client_event_id)).toEqual([
      "event-90",
      "event-91",
      "event-0",
    ]);
    expect(queue.read()).toEqual([]);
  });

  it("drops a batch the server rejected with a 4xx, without retrying", async () => {
    fetchMock.mockResolvedValue(new Response("bad request", { status: 400 }));
    const tx = createTransport({ flushThreshold: 1000 });
    tx.enqueue(makeEvent(0));

    await tx.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queue.read()).toEqual([]);
    expect(tx.bufferSize).toBe(0);
  });

  it("retries a 429 with exponential backoff, then parks the batch", async () => {
    fetchMock.mockResolvedValue(new Response("slow down", { status: 429 }));
    const tx = createTransport({ flushThreshold: 1000, flushIntervalMs: 600_000 });
    tx.enqueue(makeEvent(0));

    const pending = tx.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    for (const [index, delay] of [1000, 2000, 4000, 8000, 16000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetchMock).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(index + 2);
    }

    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(queue.read().map((e) => e.client_event_id)).toEqual(["event-0"]);
  });

  it("parks the whole backlog when the network keeps failing", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const tx = createTransport({ flushThreshold: 1000, maxBufferSize: 1000 });
    for (let i = 0; i < 25; i += 1) tx.enqueue(makeEvent(i));

    const pending = tx.flush();
    await vi.advanceTimersByTimeAsync(31_000);
    await pending;

    // Six attempts on the first batch only; the rest is parked untried.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(queue.read()).toHaveLength(25);
    expect(tx.bufferSize).toBe(0);
  });

  it("retries a 5xx and succeeds on a later attempt", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValue(ok());
    const tx = createTransport({ flushThreshold: 1000, flushIntervalMs: 600_000 });
    tx.enqueue(makeEvent(0));

    const pending = tx.flush();
    await vi.advanceTimersByTimeAsync(1000);
    await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(queue.read()).toEqual([]);
  });

  it("coalesces concurrent flushes", async () => {
    const tx = createTransport({ flushThreshold: 1000 });
    tx.enqueue(makeEvent(0));

    await Promise.all([tx.flush(), tx.flush()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops the interval and drains on shutdown", async () => {
    const tx = createTransport({ flushThreshold: 1000, flushIntervalMs: 1000 });
    tx.enqueue(makeEvent(0));

    await tx.shutdown();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    tx.enqueue(makeEvent(1));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tx.bufferSize).toBe(0);
  });

  describe("flushOnUnload", () => {
    it("sends a keepalive request and parks the overflow", () => {
      const tx = createTransport({ flushThreshold: 1000, maxBufferSize: 1000 });
      for (let i = 0; i < 60; i += 1) tx.enqueue(makeEvent(i, "m".repeat(2000)));

      tx.flushOnUnload();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(init.keepalive).toBe(true);
      expect(requestHeaders(fetchMock.mock.calls[0]!)["Content-Encoding"]).toBeUndefined();
      expect(typeof init.body).toBe("string");
      expect((init.body as string).length).toBeLessThanOrEqual(KEEPALIVE_BODY_LIMIT_BYTES);

      const sent = requestBody(fetchMock.mock.calls[0]!).events.length;
      expect(queue.read()).toHaveLength(60 - sent);
      expect(tx.bufferSize).toBe(0);
    });

    it("debounces back-to-back pagehide and visibilitychange", () => {
      const tx = createTransport({ flushThreshold: 1000 });
      tx.enqueue(makeEvent(0));

      tx.flushOnUnload();
      tx.enqueue(makeEvent(1));
      tx.flushOnUnload();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does nothing when there is nothing to send", () => {
      const tx = createTransport();
      tx.flushOnUnload();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe("Transport compression", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gzips bodies above the threshold", async () => {
    resetTestEnvironment();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const queue = new OfflineQueue(new SafeStorage("local"));
    const transport = new Transport(
      validateConfiguration({
        endpoint: "https://pulse.example.com",
        apiKey: "pulse_client_abc",
        bundleId: BUNDLE_ID,
        flushThreshold: 1000,
      }),
      queue,
    );

    for (let i = 0; i < 5; i += 1) transport.enqueue(makeEvent(i, "m".repeat(500)));
    await transport.flush();
    await transport.shutdown();

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Content-Encoding"]).toBe("gzip");
    expect(init.body).toBeInstanceOf(Uint8Array);
  });

  it("sends plain json for a small body", async () => {
    resetTestEnvironment();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const queue = new OfflineQueue(new SafeStorage("local"));
    const transport = new Transport(
      validateConfiguration({
        endpoint: "https://pulse.example.com",
        apiKey: "pulse_client_abc",
        bundleId: BUNDLE_ID,
        flushThreshold: 1000,
      }),
      queue,
    );

    transport.enqueue(makeEvent(0, "hi"));
    await transport.flush();
    await transport.shutdown();

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Content-Encoding"]).toBeUndefined();
    expect(typeof init.body).toBe("string");
  });
});
