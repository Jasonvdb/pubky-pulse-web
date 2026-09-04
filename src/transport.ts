import { encodeBody, byteLength, type EncodedBody } from "./compression";
import type { ValidatedConfig } from "./configuration";
import { isOnline } from "./device-info";
import type { OfflineQueue } from "./offline-queue";
import type {
  FeedbackSubmission,
  IngestRequest,
  LogEvent,
  PulseFeedbackReceipt,
} from "./types";

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

  /** Headers every request to the Pulse endpoint carries. */
  private jsonHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };
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

    if (!isOnline()) {
      // `visibilitychange` reaches this path on a page that stays alive, so
      // park everything rather than firing a request that cannot succeed.
      this.queue.write(pending);
      this.onDebug?.("offline, skipping keepalive flush");
      return;
    }

    const { batch, rest } = sliceForKeepalive(pending, this.config.bundleId);
    if (rest.length > 0) this.queue.write(rest);
    if (batch.length === 0) return;

    const body: IngestRequest = { bundle_id: this.config.bundleId, events: batch };
    try {
      void fetch(`${this.config.endpoint}/v1/ingest`, {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify(body),
        keepalive: true,
      })?.catch(() => {
        // On a real unload this never runs; on a live page re-park the batch
        // so it is retried. Ingest deduplicates on `client_event_id`, and the
        // append lands after `rest` because the events carry a timestamp.
        this.queue.append(batch);
      });
    } catch (err) {
      this.onDebug?.("keepalive flush failed", err);
      this.queue.append(batch);
    }
  }

  /**
   * Reassign this browser's anonymous events to a real user. Pending events
   * are flushed first so the server's `UPDATE` sees them; anything still
   * buffered afterwards is already stamped with the new id by the caller.
   */
  async claimIdentity(anonymousId: string, userId: string): Promise<boolean> {
    await this.flush();
    const outcome = await this.post(
      "/v1/identity/claim",
      { anonymous_id: anonymousId, user_id: userId },
      "identity claim",
    );
    return outcome === "sent";
  }

  /** Merge properties onto the user server-side. An empty value deletes a key. */
  async setUserProperties(userId: string, properties: Record<string, string>): Promise<boolean> {
    const outcome = await this.post(
      "/v1/identity/properties",
      { user_id: userId, properties },
      "user properties",
    );
    return outcome === "sent";
  }

  /**
   * Submit one feedback row. A person is waiting on this, so it is a single
   * attempt with no retry and no offline parking: a failure is thrown for the
   * caller's UI to show.
   */
  async submitFeedback(body: FeedbackSubmission): Promise<PulseFeedbackReceipt> {
    let response: Response;
    try {
      response = await fetch(`${this.config.endpoint}/v1/feedback`, {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      this.onDebug?.("network error during sendFeedback", err);
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Pubky Pulse: sendFeedback failed: ${detail}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      this.onDebug?.(`sendFeedback rejected with ${response.status}`);
      throw new Error(
        `Pubky Pulse: sendFeedback rejected (${response.status})${text ? `: ${text}` : ""}`,
      );
    }

    const payload = (await response.json().catch(() => undefined)) as
      | { id?: unknown; created_at?: unknown }
      | undefined;
    if (!payload || typeof payload.id !== "string") {
      throw new Error("Pubky Pulse: sendFeedback returned a malformed response");
    }
    const createdAt =
      typeof payload.created_at === "string" ? new Date(payload.created_at) : new Date(NaN);
    if (Number.isNaN(createdAt.getTime())) {
      throw new Error("Pubky Pulse: sendFeedback returned an invalid created_at");
    }

    return { id: payload.id, createdAt };
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
    const outcome = await this.post("/v1/ingest", request, `${events.length} events`);
    if (outcome === "dropped") {
      this.onDebug?.(`dropping ${events.length} events`);
    }
    return outcome;
  }

  /**
   * POST a JSON body with the shared retry policy: 2xx succeeds, a 4xx other
   * than 429 is permanent and drops the payload, everything else is retried
   * with exponential backoff before the caller decides what to do.
   */
  private async post(path: string, payload: unknown, label: string): Promise<BatchOutcome> {
    let encoded: EncodedBody;
    try {
      encoded = await encodeBody(JSON.stringify(payload), this.config.compressionEnabled);
    } catch (err) {
      this.onDebug?.(`failed to encode ${label}`, err);
      return "dropped";
    }

    const headers = this.jsonHeaders();
    if (encoded.contentEncoding) headers["Content-Encoding"] = encoded.contentEncoding;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetch(`${this.config.endpoint}${path}`, {
          method: "POST",
          headers,
          body: encoded.body as BodyInit,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (response.ok) return "sent";

        // 4xx other than 429 will fail identically forever: drop the batch.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          this.onDebug?.(`${path} rejected with ${response.status}`);
          return "dropped";
        }

        this.onDebug?.(`${path} failed with ${response.status}`);
      } catch (err) {
        this.onDebug?.(`network error during ${path}`, err);
      }

      if (attempt < MAX_RETRIES) {
        await sleep(backoffDelayMs(attempt));
      }
    }

    this.onDebug?.(`giving up on ${label} after ${MAX_RETRIES + 1} attempts`);
    return "park";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
