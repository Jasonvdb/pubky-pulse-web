import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateConfiguration, type ValidatedConfig } from "../src/configuration";
import { OfflineQueue } from "../src/offline-queue";
import { SafeStorage } from "../src/storage";
import {
  backoffDelayMs,
  KEEPALIVE_BODY_LIMIT_BYTES,
  MAX_BATCH_SIZE,
  MAX_INGEST_EVENTS,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  retryDelayMs,
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

describe("parseRetryAfter", () => {
  const now = Date.UTC(2026, 8, 4, 10, 0, 0);

  it("reads delta-seconds", () => {
    expect(parseRetryAfter("5", now)).toBe(5000);
    expect(parseRetryAfter(" 120 ", now)).toBe(120_000);
    expect(parseRetryAfter("0", now)).toBe(0);
  });

  it("reads an HTTP-date as the distance from now", () => {
    expect(parseRetryAfter(new Date(now + 30_000).toUTCString(), now)).toBe(30_000);
  });

  it("clamps a date already in the past to zero", () => {
    expect(parseRetryAfter(new Date(now - 60_000).toUTCString(), now)).toBe(0);
  });

  it("returns null for an absent, empty or unparsable header", () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter(undefined, now)).toBeNull();
    expect(parseRetryAfter("   ", now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
  });
});

describe("retryDelayMs", () => {
  it("falls back to the ladder without a header", () => {
    expect(retryDelayMs(0, null)).toBe(backoffDelayMs(0));
    expect(retryDelayMs(3, null)).toBe(backoffDelayMs(3));
  });

  it("waits the longer of the header and the ladder", () => {
    expect(retryDelayMs(0, 5000)).toBe(5000);
    // A server asking for less does not make its next failure any cheaper.
    expect(retryDelayMs(2, 1000)).toBe(4000);
    expect(retryDelayMs(2, 0)).toBe(4000);
  });

  it("caps an outlandish header", () => {
    expect(retryDelayMs(0, 3_600_000)).toBe(MAX_RETRY_AFTER_MS);
    expect(retryDelayMs(5, 45_000)).toBe(45_000);
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

  it("stops at the server's event limit when the bytes still fit", () => {
    const events = Array.from({ length: 150 }, (_, i) => makeEvent(i));
    const { batch, rest } = sliceForKeepalive(events, BUNDLE_ID);

    expect(batch).toHaveLength(MAX_INGEST_EVENTS);
    expect(rest).toHaveLength(150 - MAX_INGEST_EVENTS);
    // The count branch bit, not the byte budget.
    const size = JSON.stringify({ bundle_id: BUNDLE_ID, events }).length;
    expect(size).toBeLessThan(KEEPALIVE_BODY_LIMIT_BYTES);
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
    await queue.append([makeEvent(90), makeEvent(91)]);
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

  it("keeps sending later batches after a 4xx drop", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }))
      .mockResolvedValue(ok());
    const tx = createTransport({ flushThreshold: 1000, maxBufferSize: 1000 });
    for (let i = 0; i < 25; i += 1) tx.enqueue(makeEvent(i));

    await tx.flush();

    // A permanent rejection drops its own batch only; the flush carries on.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(fetchMock.mock.calls[1]!).events.map((e) => e.client_event_id)).toEqual([
      "event-20",
      "event-21",
      "event-22",
      "event-23",
      "event-24",
    ]);
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

  describe("Retry-After", () => {
    function retryAfter(status: number, value: string): Response {
      return new Response("later", { status, headers: { "Retry-After": value } });
    }

    /** Assert the next attempt lands exactly `delay` ms after the first. */
    async function expectNextAttemptAfter(tx: Transport, delay: number): Promise<void> {
      tx.enqueue(makeEvent(0));
      const pending = tx.flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Let the ladder run out so the flush never outlives the test.
      await vi.advanceTimersByTimeAsync(6 * MAX_RETRY_AFTER_MS);
      await pending;
    }

    it("waits the delta-seconds a 429 asked for", async () => {
      fetchMock.mockResolvedValue(retryAfter(429, "5"));
      // The bare ladder would have retried after 1s.
      await expectNextAttemptAfter(createTransport({ flushThreshold: 1000 }), 5000);
    });

    it("waits until the HTTP-date a 503 asked for", async () => {
      const at = new Date(Date.now() + 7000).toUTCString();
      fetchMock.mockResolvedValue(retryAfter(503, at));
      await expectNextAttemptAfter(
        createTransport({ flushThreshold: 1000 }),
        Date.parse(at) - Date.now(),
      );
    });

    it("caps the wait so one header cannot stall the flush", async () => {
      fetchMock.mockResolvedValue(retryAfter(503, "3600"));
      await expectNextAttemptAfter(createTransport({ flushThreshold: 1000 }), MAX_RETRY_AFTER_MS);
    });

    it("keeps the ladder when the header asks for less", async () => {
      fetchMock.mockResolvedValue(retryAfter(429, "0"));
      await expectNextAttemptAfter(createTransport({ flushThreshold: 1000 }), backoffDelayMs(0));
    });

    it("keeps the ladder when the header is unparsable", async () => {
      fetchMock.mockResolvedValue(retryAfter(503, "very soon"));
      await expectNextAttemptAfter(createTransport({ flushThreshold: 1000 }), backoffDelayMs(0));
    });

    it("ignores the header on a status that is not 429 or 503", async () => {
      fetchMock.mockResolvedValue(retryAfter(500, "5"));
      await expectNextAttemptAfter(createTransport({ flushThreshold: 1000 }), backoffDelayMs(0));
    });
  });

  describe("the in-flight batch", () => {
    /**
     * Leave a batch asleep in the retry ladder, as a slow 503 does. The flush
     * is handed back wrapped, so awaiting this helper does not await it.
     */
    async function startStalledFlush(tx: Transport): Promise<{ flushed: Promise<void> }> {
      fetchMock.mockResolvedValue(new Response("boom", { status: 503 }));
      tx.enqueue(makeEvent(0));
      const flushed = tx.flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      return { flushed };
    }

    it("goes out with the unload flush instead of dying with the page", async () => {
      const tx = createTransport({ flushThreshold: 1000, flushIntervalMs: 600_000 });
      const { flushed } = await startStalledFlush(tx);

      tx.flushOnUnload();

      const unload = fetchMock.mock.calls[1]!;
      expect((unload[1] as RequestInit).keepalive).toBe(true);
      expect(requestBody(unload).events.map((e) => e.client_event_id)).toEqual(["event-0"]);

      await vi.advanceTimersByTimeAsync(31_000);
      await flushed;

      // The keepalive 503 parks it; the ladder must not park a second copy.
      expect(queue.read().map((e) => e.client_event_id)).toEqual(["event-0"]);
    });

    it("is not parked again by a ladder that gives up after the unload sent it", async () => {
      const tx = createTransport({ flushThreshold: 1000, flushIntervalMs: 600_000 });
      const { flushed } = await startStalledFlush(tx);

      fetchMock.mockResolvedValueOnce(ok());
      tx.flushOnUnload();
      await vi.advanceTimersByTimeAsync(31_000);
      await flushed;

      expect(queue.read()).toEqual([]);
    });

    it("is parked once when the unload flush cannot send it at all", async () => {
      const tx = createTransport({ flushThreshold: 1000, flushIntervalMs: 600_000 });
      const { flushed } = await startStalledFlush(tx);

      testNavigator.onLine = false;
      tx.flushOnUnload();
      await vi.advanceTimersByTimeAsync(31_000);
      await flushed;

      // Nothing was sent on the unload path, and exactly one copy is parked.
      const keepalives = fetchMock.mock.calls.filter(
        (call) => (call[1] as RequestInit).keepalive === true,
      );
      expect(keepalives).toEqual([]);
      expect(queue.read().map((e) => e.client_event_id)).toEqual(["event-0"]);
    });

    it("is spilled, not resent, while a Retry-After the server asked for runs", async () => {
      fetchMock.mockResolvedValue(
        new Response("later", { status: 429, headers: { "Retry-After": "30" } }),
      );
      const tx = createTransport({ flushThreshold: 1000, flushIntervalMs: 600_000 });
      tx.enqueue(makeEvent(0));
      const flushed = tx.flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      tx.flushOnUnload();

      // The server asked for thirty seconds and a hidden page is no reason to
      // ignore it: nothing is sent, and the batch is parked for a later flush.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(queue.read().map((e) => e.client_event_id)).toEqual(["event-0"]);

      await vi.advanceTimersByTimeAsync(6 * MAX_RETRY_AFTER_MS);
      await flushed;

      // The ladder gave up on a batch the unload took: still exactly one copy.
      expect(queue.read().map((e) => e.client_event_id)).toEqual(["event-0"]);
    });

    it("is parked by the ladder as usual when no unload took it", async () => {
      const tx = createTransport({ flushThreshold: 1000, flushIntervalMs: 600_000 });
      const { flushed } = await startStalledFlush(tx);

      await vi.advanceTimersByTimeAsync(31_000);
      await flushed;

      expect(queue.read().map((e) => e.client_event_id)).toEqual(["event-0"]);
    });
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

  it("parks the buffer on shutdown while the browser is offline", async () => {
    testNavigator.onLine = false;
    const tx = createTransport({ flushThreshold: 1000, maxBufferSize: 1000 });
    for (let i = 0; i < 3; i += 1) tx.enqueue(makeEvent(i));

    await tx.shutdown();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(queue.read().map((event) => event.client_event_id)).toEqual([
      "event-0",
      "event-1",
      "event-2",
    ]);
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

    it("parks everything and sends nothing while offline", () => {
      const tx = createTransport({ flushThreshold: 1000, maxBufferSize: 1000 });
      for (let i = 0; i < 5; i += 1) tx.enqueue(makeEvent(i));
      testNavigator.onLine = false;

      tx.flushOnUnload();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(queue.read().map((event) => event.client_event_id)).toEqual([
        "event-0",
        "event-1",
        "event-2",
        "event-3",
        "event-4",
      ]);
      expect(tx.bufferSize).toBe(0);
    });

    it("re-parks the batch when the keepalive request fails", async () => {
      fetchMock.mockRejectedValue(new TypeError("network error"));
      const tx = createTransport({ flushThreshold: 1000, maxBufferSize: 1000 });
      for (let i = 0; i < 3; i += 1) tx.enqueue(makeEvent(i));

      tx.flushOnUnload();
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(queue.read().map((event) => event.client_event_id)).toEqual([
        "event-0",
        "event-1",
        "event-2",
      ]);
    });

    it("re-parks the batch when the server answers with a 5xx", async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
      const tx = createTransport({ flushThreshold: 1000, maxBufferSize: 1000 });
      for (let i = 0; i < 3; i += 1) tx.enqueue(makeEvent(i));

      tx.flushOnUnload();
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(queue.read().map((event) => event.client_event_id)).toEqual([
        "event-0",
        "event-1",
        "event-2",
      ]);
    });

    it("re-parks the batch when the server answers with a 429", async () => {
      fetchMock.mockResolvedValue(new Response("slow down", { status: 429 }));
      const tx = createTransport({ flushThreshold: 1000, maxBufferSize: 1000 });
      tx.enqueue(makeEvent(0));

      tx.flushOnUnload();
      await vi.advanceTimersByTimeAsync(0);

      expect(queue.read().map((event) => event.client_event_id)).toEqual(["event-0"]);
    });

    it("drops the batch on a 4xx other than 429", async () => {
      fetchMock.mockResolvedValue(new Response("bad request", { status: 400 }));
      const tx = createTransport({ flushThreshold: 1000, maxBufferSize: 1000 });
      tx.enqueue(makeEvent(0));

      tx.flushOnUnload();
      await vi.advanceTimersByTimeAsync(0);

      // Permanent rejection: recycling it through the queue would retry it on
      // every later unload.
      expect(queue.read()).toEqual([]);
    });

    it("re-parks the batch exactly once when the request rejects", async () => {
      fetchMock.mockRejectedValue(new TypeError("network error"));
      const tx = createTransport({ flushThreshold: 1000, maxBufferSize: 1000 });
      tx.enqueue(makeEvent(0));

      tx.flushOnUnload();
      await vi.advanceTimersByTimeAsync(0);

      expect(queue.read().map((event) => event.client_event_id)).toEqual(["event-0"]);
    });

    it("never gzips, even with compression enabled and a large body", () => {
      const tx = createTransport({
        compressionEnabled: true,
        flushThreshold: 1000,
        maxBufferSize: 1000,
      });
      for (let i = 0; i < 5; i += 1) tx.enqueue(makeEvent(i, "m".repeat(2000)));

      tx.flushOnUnload();

      // Asserted without awaiting: the unload path has to fire in this tick.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(typeof init.body).toBe("string");
      expect(requestHeaders(fetchMock.mock.calls[0]!)["Content-Encoding"]).toBeUndefined();
    });

    it("re-parks the batch when fetch throws synchronously", () => {
      fetchMock.mockImplementation(() => {
        throw new TypeError("blocked");
      });
      const tx = createTransport({ flushThreshold: 1000, maxBufferSize: 1000 });
      tx.enqueue(makeEvent(0));

      tx.flushOnUnload();

      expect(queue.read().map((event) => event.client_event_id)).toEqual(["event-0"]);
    });

    it("does nothing when there is nothing to send", () => {
      const tx = createTransport();
      tx.flushOnUnload();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("identity", () => {
    it("flushes buffered events before posting the claim", async () => {
      const tx = createTransport({ flushThreshold: 1000 });
      tx.enqueue(makeEvent(0));

      await expect(tx.claimIdentity("pulse_anon_1", "user-1")).resolves.toBe(true);

      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
        "https://pulse.example.com/v1/ingest",
        "https://pulse.example.com/v1/identity/claim",
      ]);
      const claim = fetchMock.mock.calls[1]!;
      expect(JSON.parse((claim[1] as RequestInit).body as string)).toEqual({
        anonymous_id: "pulse_anon_1",
        user_id: "user-1",
      });
      expect(requestHeaders(claim).Authorization).toBe("Bearer pulse_client_abc");
    });

    it("retries a claim on a 5xx and reports success", async () => {
      fetchMock
        .mockResolvedValueOnce(new Response("", { status: 500 }))
        .mockResolvedValueOnce(ok());
      const tx = createTransport();

      const claimed = tx.claimIdentity("pulse_anon_1", "user-1");
      await vi.advanceTimersByTimeAsync(backoffDelayMs(0));

      await expect(claimed).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not retry a claim the server rejected with a 4xx", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 400 }));
      const tx = createTransport();

      await expect(tx.claimIdentity("pulse_anon_1", "user-1")).resolves.toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("returns immediately while the browser reports itself offline", async () => {
      testNavigator.onLine = false;
      const tx = createTransport();

      await expect(tx.claimIdentity("pulse_anon_1", "user-1")).resolves.toBe(false);
      await expect(tx.setUserProperties("user-1", { plan: "pro" })).resolves.toBe(false);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("abandons the retry ladder when the connection drops mid-flight", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 500 }));
      const tx = createTransport();

      const claimed = tx.claimIdentity("pulse_anon_1", "user-1");
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      testNavigator.onLine = false;
      await vi.advanceTimersByTimeAsync(backoffDelayMs(0));

      await expect(claimed).resolves.toBe(false);
      // Without the guard this would burn all six attempts and 31s of backoff.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("posts user properties without flushing first", async () => {
      const tx = createTransport();

      await expect(tx.setUserProperties("user-1", { plan: "pro" })).resolves.toBe(true);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe("https://pulse.example.com/v1/identity/properties");
      expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
        user_id: "user-1",
        properties: { plan: "pro" },
      });
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

describe("Transport.submitFeedback", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let transport: Transport;

  const body = {
    bundle_id: BUNDLE_ID,
    message: "the export button is hiding",
    sdk_name: "pubky-pulse-web",
    sdk_version: "0.1.0",
    environment: "web" as const,
    is_dev: true,
  };

  beforeEach(() => {
    resetTestEnvironment();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    transport = new Transport(makeConfig({ flushIntervalMs: 60_000 }), new OfflineQueue(new SafeStorage("local")));
  });

  afterEach(async () => {
    await transport.shutdown();
    vi.unstubAllGlobals();
  });

  it("posts the submission and parses the receipt", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "fb_1", created_at: "2026-09-04T10:00:00.000Z" }), {
        status: 201,
      }),
    );

    const receipt = await transport.submitFeedback(body);

    expect(receipt.id).toBe("fb_1");
    expect(receipt.createdAt.toISOString()).toBe("2026-09-04T10:00:00.000Z");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://pulse.example.com/v1/feedback");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer pulse_client_abc");
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it("throws without retrying when the server rejects", async () => {
    fetchMock.mockResolvedValue(new Response("message is required", { status: 400 }));

    await expect(transport.submitFeedback(body)).rejects.toThrow(
      /sendFeedback rejected \(400\): message is required/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("makes a single attempt on a 5xx", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

    await expect(transport.submitFeedback(body)).rejects.toThrow(/sendFeedback rejected \(500\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("wraps a network failure", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));

    await expect(transport.submitFeedback(body)).rejects.toThrow(
      "Pubky Pulse: sendFeedback failed: offline",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed receipt", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 7 }), { status: 201 }));

    await expect(transport.submitFeedback(body)).rejects.toThrow(/malformed response/);
  });
});
