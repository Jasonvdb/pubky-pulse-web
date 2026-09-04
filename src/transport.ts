import { encodeBody, byteLength, type EncodedBody } from "./compression";
import type { ValidatedConfig } from "./configuration";
import { isOnline } from "./device-info";
import type { OfflineQueue } from "./offline-queue";
import type { IngestRequest, LogEvent } from "./types";

/** Events per request. The server accepts up to 100; 20 keeps bodies small. */
export const MAX_BATCH_SIZE = 20;
/** Server-side hard limit on events in one ingest request. */
export const MAX_INGEST_EVENTS = 100;
export const MAX_RETRIES = 5;
export const MAX_BACKOFF_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 10_000;
/**
 * Keepalive requests share a small per-origin budget (64 KB in Chrome), so the
 * unload flush sends under it and parks whatever does not fit.
 */
export const KEEPALIVE_BODY_LIMIT_BYTES = 60 * 1024;
/** `pagehide` and `visibilitychange` usually fire back to back. */
const UNLOAD_DEBOUNCE_MS = 1000;

/** `min(2^attempt, 30)` seconds, matching the other Pulse SDKs. */
export function backoffDelayMs(attempt: number): number {
  return Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);
}

type BatchOutcome = "sent" | "dropped" | "park";

/**
 * Greedily take events that fit inside the keepalive budget. Returns the batch
 * to send and the remainder to park.
 */
export function sliceForKeepalive(
  events: LogEvent[],
  bundleId: string,
): { batch: LogEvent[]; rest: LogEvent[] } {
  const overhead = byteLength(JSON.stringify({ bundle_id: bundleId, events: [] }));
  let size = overhead;
  let count = 0;

  for (const event of events) {
    if (count >= MAX_INGEST_EVENTS) break;
    // +1 for the comma separating this event from the previous one.
    const next = size + byteLength(JSON.stringify(event)) + 1;
    if (count > 0 && next > KEEPALIVE_BODY_LIMIT_BYTES) break;
    size = next;
    count += 1;
  }

  return { batch: events.slice(0, count), rest: events.slice(count) };
}

export class Transport {
  private readonly config: ValidatedConfig;
  private readonly queue: OfflineQueue;
  private readonly onDebug: ((message: string, detail?: unknown) => void) | undefined;
  private buffer: LogEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private lastUnloadFlushAt = 0;
  private stopped = false;

  constructor(
    config: ValidatedConfig,
    queue: OfflineQueue,
    onDebug?: (message: string, detail?: unknown) => void,
  ) {
    this.config = config;
    this.queue = queue;
    this.onDebug = onDebug;
    this.timer = setInterval(() => {
      void this.flush();
    }, config.flushIntervalMs);
  }

  get bufferSize(): number {
    return this.buffer.length;
  }

  enqueue(event: LogEvent): void {
    if (this.stopped) return;
    if (this.buffer.length >= this.config.maxBufferSize) {
      this.buffer.shift();
      this.onDebug?.("buffer full, dropped oldest event");
    }
    this.buffer.push(event);

    if (this.buffer.length >= this.config.flushThreshold) {
      void this.flush();
    }
  }

  /**
   * Drain the offline queue and the in-memory buffer. Concurrent callers await
   * the in-flight pass instead of interleaving batches.
   */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const run = this.runFlush().finally(() => {
      this.flushing = null;
    });
    this.flushing = run;
    return run;
  }

  async shutdown(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    this.stopped = true;
  }

  /**
   * Synchronous best-effort send as the page goes away: one keepalive request
   * with whatever fits, the rest written back to the offline queue.
   */
  flushOnUnload(): void {
    const now = Date.now();
    if (now - this.lastUnloadFlushAt < UNLOAD_DEBOUNCE_MS) return;
    this.lastUnloadFlushAt = now;

    const pending = [...this.queue.drain(), ...this.buffer.splice(0)];
    if (pending.length === 0) return;

    const { batch, rest } = sliceForKeepalive(pending, this.config.bundleId);
    if (rest.length > 0) this.queue.write(rest);
    if (batch.length === 0) return;

    const body: IngestRequest = { bundle_id: this.config.bundleId, events: batch };
    try {
      void fetch(`${this.config.endpoint}/v1/ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        keepalive: true,
      })?.catch(() => {
        // The page is unloading; there is nothing left to recover to.
      });
    } catch (err) {
      this.onDebug?.("keepalive flush failed", err);
    }
  }

  private async runFlush(): Promise<void> {
    if (!isOnline()) {
      this.onDebug?.("offline, skipping flush");
      return;
    }

    const parked = this.queue.drain();
    if (parked.length > 0) this.buffer.unshift(...parked);

    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, MAX_BATCH_SIZE);
      const outcome = await this.sendBatch(batch);
      if (outcome === "park") {
        // The endpoint is unreachable: park this batch and everything behind
        // it rather than burning retries on each remaining batch.
        this.queue.append([...batch, ...this.buffer.splice(0)]);
        return;
      }
    }
  }

  private async sendBatch(events: LogEvent[]): Promise<BatchOutcome> {
    const request: IngestRequest = { bundle_id: this.config.bundleId, events };
    let encoded: EncodedBody;
    try {
      encoded = await encodeBody(JSON.stringify(request), this.config.compressionEnabled);
    } catch (err) {
      this.onDebug?.("failed to encode batch", err);
      return "dropped";
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };
    if (encoded.contentEncoding) headers["Content-Encoding"] = encoded.contentEncoding;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetch(`${this.config.endpoint}/v1/ingest`, {
          method: "POST",
          headers,
          body: encoded.body as BodyInit,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (response.ok) return "sent";

        // 4xx other than 429 will fail identically forever: drop the batch.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          this.onDebug?.(`ingest rejected with ${response.status}, dropping ${events.length} events`);
          return "dropped";
        }

        this.onDebug?.(`ingest failed with ${response.status}`);
      } catch (err) {
        this.onDebug?.("network error during ingest", err);
      }

      if (attempt < MAX_RETRIES) {
        await sleep(backoffDelayMs(attempt));
      }
    }

    this.onDebug?.(`parking ${events.length} events after ${MAX_RETRIES + 1} attempts`);
    return "park";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
