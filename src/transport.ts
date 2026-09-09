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
/** Ceiling on a server-requested `Retry-After`, so one header cannot stall a flush. */
export const MAX_RETRY_AFTER_MS = 60_000;
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

/**
 * Milliseconds asked for by a `Retry-After` header, which is either
 * delta-seconds or an HTTP-date. Null when the header is absent or is
 * something neither form explains; a date already in the past means "now".
 */
export function parseRetryAfter(header: string | null | undefined, now: number): number | null {
  const value = header?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;

  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * How long to wait before the next attempt. A `Retry-After` only ever
 * lengthens the ladder — the server asking for less does not make its next
 * failure cheaper — and is capped so a hostile header cannot park a flush.
 */
export function retryDelayMs(attempt: number, retryAfterMs: number | null): number {
  const backoff = backoffDelayMs(attempt);
  if (retryAfterMs === null) return backoff;
  return Math.min(Math.max(retryAfterMs, backoff), MAX_RETRY_AFTER_MS);
}

type BatchOutcome = "sent" | "dropped" | "park";

/**
 * Greedily take events that fit inside the keepalive budget. Returns the batch
 * to send and the remainder to park.
 */
export function sliceForKeepalive(
  events: LogEvent[],
  bundleId?: string,
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
  private readonly requests = new Map<AbortController, ReturnType<typeof setTimeout>>();
  private readonly delays = new Map<ReturnType<typeof setTimeout>, () => void>();
  /** Persisted events removed for replay, retained until delivery is confirmed. */
  private readonly replayed = new Set<LogEvent>();
  /**
   * The batch `sendBatch` is currently working through, including the seconds
   * it spends asleep in the retry ladder. It lives here so the unload flush can
   * take it with everything else instead of letting the page carry it away.
   */
  private inFlight: LogEvent[] | null = null;
  /** True once the unload flush took `inFlight`, so it is not parked twice. */
  private inFlightTaken = false;
  /**
   * The instant a `Retry-After` asked us to wait until, or 0 when no request
   * is serving one out. The unload flush honours it rather than resending the
   * sleeping batch straight away over keepalive.
   */
  private backoffUntil = 0;

  constructor(
    config: ValidatedConfig,
    queue: OfflineQueue,
    onDebug?: (message: string, detail?: unknown) => void,
  ) {
    this.config = config;
    this.queue = queue;
    let diagnosing = false;
    this.onDebug = (message, detail) => {
      if (diagnosing) return;
      diagnosing = true;
      try { onDebug?.(message, detail); } catch { /* Diagnostics cannot reject background delivery. */ }
      finally { diagnosing = false; }
    };
    this.timer = setInterval(() => {
      void this.flush();
    }, config.flushIntervalMs);
  }

  /** Stop immediately without flushing, replaying, or deleting persisted data. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      try { clearInterval(this.timer); } catch { /* A retained interval becomes inert after stop. */ }
    }
    this.timer = null;
    this.buffer = [];
    this.inFlight = null;
    for (const [controller, timer] of this.requests) {
      clearTimeout(timer);
      try { controller.abort(); } catch { /* Continue releasing every request. */ }
    }
    this.requests.clear();
    for (const [timer, resolve] of this.delays) {
      clearTimeout(timer);
      resolve();
    }
    this.delays.clear();
    // Restoring a replay already removed from storage preserves consent-era data.
    // Fresh in-memory telemetry is deliberately discarded.
    this.restoreReplay();
  }

  private restoreReplay(): void {
    if (this.replayed.size === 0) return;
    const events = [...this.replayed];
    this.replayed.clear();
    void this.queue.append(events).catch(() => undefined);
  }

  private forgetReplay(events: LogEvent[]): void {
    for (const event of events) this.replayed.delete(event);
  }

  private request(url: string, init: RequestInit): Promise<Response>;
  private request<T>(url: string, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T>;
  private request<T>(url: string, init: RequestInit, consume?: (response: Response) => Promise<T>): Promise<Response | T> {
    const controller = new AbortController();
    if (this.stopped) controller.abort();
    if (controller.signal.aborted) throw new Error("Pubky Pulse: transport stopped");
    const timer = setTimeout(() => {
      try { controller.abort(); } catch { /* A host abort adapter may be broken. */ }
    }, REQUEST_TIMEOUT_MS);
    this.requests.set(controller, timer);
    try {
      return fetch(url, { ...init, signal: controller.signal }).then<Response | T>((response) =>
        consume ? consume(response) : response,
      ).finally(() => {
        clearTimeout(timer);
        this.requests.delete(controller);
      });
    } catch (error) {
      clearTimeout(timer);
      this.requests.delete(controller);
      throw error;
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.delays.delete(timer);
        resolve();
      }, ms);
      this.delays.set(timer, resolve);
    });
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
    if (this.stopped) return Promise.resolve();
    if (this.flushing) return this.flushing;
    const run = this.runFlush().catch((error: unknown) => {
      this.onDebug?.("failed to flush events", error);
    }).finally(() => {
      this.flushing = null;
    });
    this.flushing = run;
    return run;
  }

  async shutdown(): Promise<void> {
    if (this.timer !== null) {
      try { clearInterval(this.timer); } catch { /* stop() also marks retained callbacks inert. */ }
      this.timer = null;
    }
    try {
      await this.flush();
      // The flush is a no-op while offline, so park what it could not send.
      const left = this.buffer.splice(0);
      if (!this.stopped && left.length > 0) await this.queue.append(left, () => !this.stopped);
    } catch (error) {
      this.onDebug?.("failed to park remaining events", error);
    } finally {
      // Feedback, identity requests, and their retry delays may still be active
      // after the event flush. Retiring a client must release those resources too.
      this.stop();
    }
  }

  /**
   * Synchronous best-effort send as the page goes away: one keepalive request
   * with whatever fits, the rest spilled to the offline queue. Nothing here
   * may read-modify-write the shared queue key — there is no turn left to
   * await the cross-tab lock in — so it neither drains it nor rewrites it.
   */
  flushOnUnload(): void {
    try { this.runUnloadFlush(); } catch (error) {
      this.onDebug?.("failed to flush on unload", error);
    }
  }

  private runUnloadFlush(): void {
    if (this.stopped) return;
    const now = Date.now();
    if (now - this.lastUnloadFlushAt < UNLOAD_DEBOUNCE_MS) return;
    this.lastUnloadFlushAt = now;

    const pending = [...this.takeInFlight(), ...this.buffer.splice(0)];
    if (pending.length === 0) return;

    if (!isOnline()) {
      // `visibilitychange` reaches this path on a page that stays alive, so
      // park everything rather than firing a request that cannot succeed.
      this.queue.spill(pending);
      this.forgetReplay(pending);
      this.onDebug?.("offline, skipping keepalive flush");
      return;
    }

    if (now < this.backoffUntil) {
      // The server asked for a delay and a hidden page is no reason to ignore
      // it. Park everything instead; it goes out on the next flush or load.
      this.queue.spill(pending);
      this.forgetReplay(pending);
      this.onDebug?.("waiting out Retry-After, skipping keepalive flush");
      return;
    }

    const { batch, rest } = sliceForKeepalive(pending, this.config.bundleId);
    if (rest.length > 0) {
      this.queue.spill(rest);
      this.forgetReplay(rest);
    }
    if (batch.length === 0) return;

    const body: IngestRequest = { bundle_id: this.config.bundleId, events: batch };
    try {
      void this.request(`${this.config.endpoint}/v1/ingest`, {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify(body),
        keepalive: true,
      })?.then(
        (response) => {
          // On a real unload neither continuation runs; on a live page re-park
          // the batch so it is retried. Ingest deduplicates on
          // `client_event_id`, and the append lands after `rest` because the
          // events carry a timestamp. A 4xx other than 429 is permanent, so it
          // drops here exactly as it does in `post()`.
          if (!this.stopped && !response.ok && (response.status >= 500 || response.status === 429)) {
            this.onDebug?.(`keepalive flush failed with ${response.status}`);
            void this.queue.append(batch, () => !this.stopped).then(() => this.forgetReplay(batch)).catch(() => undefined);
          } else if (!this.stopped) {
            this.forgetReplay(batch);
          }
        },
        () => {
          if (!this.stopped) void this.queue.append(batch, () => !this.stopped).then(() => this.forgetReplay(batch)).catch(() => undefined);
        },
      ).catch(() => undefined);
    } catch (err) {
      // Still inside the unload turn, so this one has to be the sync path.
      this.onDebug?.("keepalive flush failed", err);
      if (!this.stopped) {
        this.queue.spill(batch);
        this.forgetReplay(batch);
      }
    }
  }

  /**
   * Hand the in-flight batch to the unload flush, marking it taken so the
   * `sendBatch` still awaiting an answer does not park it a second time on a
   * page that survives.
   */
  private takeInFlight(): LogEvent[] {
    const batch = this.inFlight;
    if (!batch) return [];
    this.inFlight = null;
    this.inFlightTaken = true;
    return batch;
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
    let responseBody: unknown;
    try {
      ({ response, responseBody } = await this.request(`${this.config.endpoint}/v1/feedback`, {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify(body),
      }, async (response) => ({
        response,
        responseBody: response.ok
          ? await response.json().catch(() => undefined)
          : await response.text().catch(() => ""),
      })));
    } catch (err) {
      this.onDebug?.("network error during sendFeedback", err);
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Pubky Pulse: sendFeedback failed: ${detail}`);
    }

    if (!response.ok) {
      const text = responseBody;
      this.onDebug?.(`sendFeedback rejected with ${response.status}`);
      throw new Error(
        `Pubky Pulse: sendFeedback rejected (${response.status})${text ? `: ${text}` : ""}`,
      );
    }

    const payload = responseBody as
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

    const parked = await this.queue.drain(() => !this.stopped);
    for (const event of parked) this.replayed.add(event);
    if (this.stopped) {
      this.restoreReplay();
      return;
    }
    if (parked.length > 0) this.buffer.unshift(...parked);

    while (!this.stopped && this.buffer.length > 0) {
      const batch = this.buffer.splice(0, MAX_BATCH_SIZE);
      const outcome = await this.sendBatch(batch);
      if (this.stopped) return;
      if (outcome === "park") {
        // The endpoint is unreachable: park this batch and everything behind
        // it rather than burning retries on each remaining batch. An unload
        // flush that already took the batch has parked or sent it itself.
        const rest = this.buffer.splice(0);
        const toPark = this.inFlightTaken ? rest : [...batch, ...rest];
        await this.queue.append(toPark, () => !this.stopped);
        if (!this.stopped) this.forgetReplay(toPark);
        return;
      }
    }
  }

  private async sendBatch(events: LogEvent[]): Promise<BatchOutcome> {
    const request: IngestRequest = { bundle_id: this.config.bundleId, events };
    this.inFlight = events;
    this.inFlightTaken = false;
    let outcome: BatchOutcome;
    try {
      outcome = await this.post("/v1/ingest", request, `${events.length} events`);
    } finally {
      this.inFlight = null;
    }
    if (outcome !== "park" && !this.stopped) {
      this.forgetReplay(events);
    }
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
    if (this.stopped) return "dropped";
    if (!isOnline()) {
      // No attempt can succeed, and the retry ladder would stall the caller
      // for ~31s of backoff; park immediately as the flush paths do.
      this.onDebug?.(`offline, skipping ${label}`);
      return "park";
    }

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
      if (this.stopped) return "dropped";
      let retryAfterMs: number | null = null;
      try {
        const response = await this.request(`${this.config.endpoint}${path}`, {
          method: "POST",
          headers,
          body: encoded.body as BodyInit,
        });

        if (response.ok) return "sent";

        // 4xx other than 429 will fail identically forever: drop the batch.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          this.onDebug?.(`${path} rejected with ${response.status}`);
          return "dropped";
        }

        this.onDebug?.(`${path} failed with ${response.status}`);
        // The two statuses a Pulse server sends `Retry-After` with: it knows
        // when it will have room again, and guessing earlier only adds load.
        if (response.status === 429 || response.status === 503) {
          retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"), Date.now());
        }
      } catch (err) {
        this.onDebug?.(`network error during ${path}`, err);
      }

      if (this.stopped) return "dropped";
      if (attempt < MAX_RETRIES) {
        // The connection may have dropped mid-ladder: abandon the backoff
        // rather than sleeping through attempts that cannot succeed.
        if (!isOnline()) {
          this.onDebug?.(`offline, abandoning ${label}`);
          return "park";
        }
        const delay = retryDelayMs(attempt, retryAfterMs);
        // Only a delay the server asked for parks the unload flush; a plain
        // backoff is our own guess, which a page going away may cut short.
        // Cleared on the way out, so the next attempt — and the request
        // succeeding or the ladder ending — leaves nothing behind.
        if (retryAfterMs !== null) this.backoffUntil = Date.now() + delay;
        await this.sleep(delay);
        this.backoffUntil = 0;
      }
    }

    this.onDebug?.(`giving up on ${label} after ${MAX_RETRIES + 1} attempts`);
    return "park";
  }
}
