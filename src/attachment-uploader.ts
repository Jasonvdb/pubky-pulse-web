/**
 * Out-of-band upload of files attached to an event. Uploads run serially in a
 * background queue so a screenshot never delays the event itself; `flush()`
 * waits for the queue to empty, with a bounded wait for stalled host APIs.
 */

import type { ValidatedConfig } from "./configuration";
import { REQUEST_TIMEOUT_MS } from "./transport";
import type { PulseAttachment } from "./types";

/** Browser memory safety limits; the server may impose smaller quotas. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENT_QUEUE_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_QUEUE_ITEMS = 20;
/** Bounds both an item's background wait and one explicit flush call. */
export const MAX_ATTACHMENT_WAIT_MS = 120_000;

// Shared across uploader lifetimes: stopping or timing out cannot cancel an
// already running Blob read, digest, or a host fetch that ignores abort.
let retainedBytes = 0;
let retainedItems = 0;

/** Fixed part of an upload's budget, before the size allowance. */
export const UPLOAD_TIMEOUT_BASE_MS = 30_000;
/** Allowance per megabyte, generous enough for a slow mobile connection. */
export const UPLOAD_TIMEOUT_PER_MB_MS = 10_000;
/** Ceiling, so a stalled upload can never hold `flush()` open indefinitely. */
export const MAX_UPLOAD_TIMEOUT_MS = 80_000;

/**
 * The PUT gets a size-derived budget, up to 80 seconds for a 5 MiB file.
 */
export function uploadTimeoutMs(sizeBytes: number): number {
  const allowance = Math.ceil(sizeBytes / (1024 * 1024)) * UPLOAD_TIMEOUT_PER_MB_MS;
  return Math.min(UPLOAD_TIMEOUT_BASE_MS + allowance, MAX_UPLOAD_TIMEOUT_MS);
}

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
  ".pdf": "application/pdf",
};

export function inferContentType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return EXTENSION_CONTENT_TYPES[filename.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

interface PendingUpload {
  clientEventId: string;
  userId?: string;
  data: Blob | Uint8Array;
  filename: string;
  contentType: string;
  sizeBytes: number;
  cancelled: boolean;
  release(): void;
}

interface ReserveResponse {
  attachment_id: string;
  upload_url: string;
}

function isBlob(value: unknown): value is Blob {
  const BlobCtor = (globalThis as { Blob?: unknown }).Blob;
  return typeof BlobCtor === "function" && value instanceof (BlobCtor as typeof Blob);
}

/** `crypto.subtle` only exists in a secure context; without it we cannot hash. */
function subtleCrypto(): SubtleCrypto | undefined {
  return (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
}

async function sha256Hex(bytes: Uint8Array, subtle: SubtleCrypto): Promise<string> {
  // `digest` honours the view's byteOffset/byteLength, so a subarray hashes
  // exactly its own bytes; the cast only satisfies the narrowed lib type.
  const digest = await subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class AttachmentUploader {
  private readonly config: ValidatedConfig;
  private readonly onDebug: ((message: string, detail?: unknown) => void) | undefined;
  private pending: PendingUpload[] = [];
  private draining: Promise<void> | null = null;
  private stopped = false;
  private readonly requests = new Map<AbortController, { timer: ReturnType<typeof setTimeout>; owner: PendingUpload }>();
  private wakeDrain: (() => void) | null = null;

  constructor(config: ValidatedConfig, onDebug?: (message: string, detail?: unknown) => void) {
    this.config = config;
    this.onDebug = onDebug;
  }

  private debug(message: string, detail?: unknown): void {
    try {
      if (detail === undefined) this.onDebug?.(message);
      else this.onDebug?.(message, detail);
    } catch { /* Diagnostics must not reject background work or application calls. */ }
  }

  /** Discard pending uploads and abort active requests when consent is withdrawn. */
  stop(): void {
    this.stopped = true;
    for (const item of this.pending.splice(0)) item.release();
    this.wakeDrain?.();
    this.abortRequests();
  }

  private abortRequests(owner?: PendingUpload): void {
    for (const [controller, request] of this.requests) {
      if (owner && request.owner !== owner) continue;
      try { clearTimeout(request.timer); } catch { /* Continue aborting other work. */ }
      try { controller.abort(); } catch { /* A host may have replaced AbortController. */ }
    }
  }

  private async request<T = Response>(
    owner: PendingUpload,
    url: string,
    init: RequestInit,
    timeoutMs: number,
    consume?: (response: Response) => Promise<T>,
  ): Promise<Response | T> {
    if (this.stopped || owner.cancelled) throw new Error("Pubky Pulse: attachment uploader stopped");
    const controller = new AbortController();
    const timer = setTimeout(() => {
      try { controller.abort(); } catch { /* The end-to-end deadline still bounds waiting. */ }
    }, timeoutMs);
    this.requests.set(controller, { timer, owner });
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (this.stopped || owner.cancelled) throw new Error("Pubky Pulse: attachment upload cancelled");
      return consume ? await consume(response) : response;
    } finally {
      clearTimeout(timer);
      this.requests.delete(controller);
    }
  }

  /** Queue a bounded snapshot of each accepted attachment. Excess newest files are dropped. */
  enqueue(clientEventId: string, userId: string | undefined, attachments: PulseAttachment[]): void {
    try {
      if (this.stopped || !Array.isArray(attachments) || attachments.length === 0) return;
      if (!subtleCrypto()) {
        this.debug("crypto.subtle is unavailable (insecure context); skipping attachments");
        return;
      }
      const count = Math.min(attachments.length, MAX_ATTACHMENT_QUEUE_ITEMS);
      for (let index = 0; index < count; index++) {
        if (retainedItems >= MAX_ATTACHMENT_QUEUE_ITEMS) break;
        try {
          const item = this.snapshot(clientEventId, userId, attachments[index]!);
          if (item) this.pending.push(item);
        } catch (error) {
          this.debug("skipping invalid attachment", error);
        }
      }
      if (!this.draining && this.pending.length > 0) this.draining = this.drain();
    } catch (error) {
      this.debug("could not queue attachments", error);
    }
  }

  private snapshot(clientEventId: string, userId: string | undefined, attachment: PulseAttachment): PendingUpload | null {
    const source = attachment.data;
    const blob = isBlob(source);
    if (!blob && !(source instanceof Uint8Array)) {
      this.debug("attachment data must be a Blob, File or Uint8Array");
      return null;
    }
    const sizeBytes = blob ? source.size : source.byteLength;
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_ATTACHMENT_BYTES) {
      this.debug("skipping attachment: size exceeds the SDK cap or is invalid");
      return null;
    }
    if (sizeBytes === 0) {
      this.debug("skipping empty attachment");
      return null;
    }
    if (retainedBytes + sizeBytes > MAX_ATTACHMENT_QUEUE_BYTES) return null;
    if (blob) {
      const sizeGetter = Object.getOwnPropertyDescriptor(Blob.prototype, "size")?.get;
      const actualSize: unknown = sizeGetter ? Reflect.apply(sizeGetter, source, []) : undefined;
      if (actualSize !== sizeBytes) {
        this.debug("skipping attachment with inconsistent Blob size");
        return null;
      }
    }

    let filename = attachment.filename;
    let contentType = attachment.contentType;
    if (blob) {
      const fileName = (source as Blob & { name?: unknown }).name;
      filename ??= typeof fileName === "string" && fileName ? fileName : undefined;
      if (!contentType) contentType = source.type || undefined;
    }
    const name = filename ?? "attachment.bin";
    if (typeof name !== "string" || name.length > 1024 ||
        (contentType !== undefined && (typeof contentType !== "string" || contentType.length > 255))) {
      this.debug("skipping attachment with invalid or oversized metadata");
      return null;
    }
    const type = contentType ?? inferContentType(name);
    // Caller getters can re-enter enqueue or withdraw consent during snapshotting.
    if (this.stopped || retainedItems >= MAX_ATTACHMENT_QUEUE_ITEMS ||
        retainedBytes + sizeBytes > MAX_ATTACHMENT_QUEUE_BYTES) return null;
    retainedItems++;
    retainedBytes += sizeBytes;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      retainedItems--;
      retainedBytes -= sizeBytes;
    };
    try {
      // Copy every accepted typed array, including subarrays, so neither its
      // backing allocation nor later application writes affect queued data.
      let data: Blob | Uint8Array = source;
      if (!blob) {
        const copy = new Uint8Array(sizeBytes);
        Uint8Array.prototype.set.call(copy, source);
        data = copy;
      }
      return { clientEventId, userId, data, filename: name, contentType: type, sizeBytes, cancelled: false, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Wait for queued work, but return within two minutes even if a host API stalls. */
  async flush(): Promise<void> {
    const draining = this.draining;
    if (!draining) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        draining,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, MAX_ATTACHMENT_WAIT_MS); }),
      ]);
    } catch (error) {
      this.debug("attachment flush failed", error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async waitForWork(item: PendingUpload, work: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve) => {
        const cancel = () => {
          item.cancelled = true;
          this.abortRequests(item);
          resolve();
        };
        this.wakeDrain = cancel;
        timer = setTimeout(cancel, MAX_ATTACHMENT_WAIT_MS);
        void work.then(resolve, resolve);
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.wakeDrain = null;
    }
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopped) {
        const item = this.pending.shift();
        if (!item) break;
        // The reservation belongs to the actual work, never to its timeout.
        const work = this.uploadOne(item).catch((error: unknown) => {
          this.debug("attachment upload failed", error);
        }).finally(() => item.release());
        await this.waitForWork(item, work);
      }
    } catch (error) {
      this.debug("attachment queue failed", error);
    } finally {
      this.draining = null;
    }
  }

  private async uploadOne(item: PendingUpload): Promise<void> {
    const subtle = subtleCrypto();
    if (!subtle || this.stopped || item.cancelled) return;
    const blob = isBlob(item.data) ? item.data : null;
    const bytes = blob
      ? new Uint8Array(await Reflect.apply(Blob.prototype.arrayBuffer, blob, []) as ArrayBuffer)
      : item.data as Uint8Array;
    if (this.stopped || item.cancelled) return;
    if (bytes.byteLength !== item.sizeBytes) {
      this.debug("attachment bytes changed size while reading");
      return;
    }
    const sha256 = await sha256Hex(bytes, subtle);
    if (this.stopped || item.cancelled) return;
    const reserved = await this.reserve({
      clientEventId: item.clientEventId,
      userId: item.userId,
      filename: item.filename,
      contentType: item.contentType,
      sizeBytes: item.sizeBytes,
      sha256,
    }, item);
    if (this.stopped || item.cancelled || !reserved) return;
    await this.putBytes(reserved.upload_url, blob ?? bytes, item.sizeBytes, item.filename, item);
  }

  private async reserve(args: {
    clientEventId: string;
    userId?: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
  }, item: PendingUpload): Promise<ReserveResponse | null> {
    const payload: Record<string, unknown> = {
      client_event_id: args.clientEventId,
      original_filename: args.filename,
      content_type: args.contentType,
      size_bytes: args.sizeBytes,
      sha256: args.sha256,
      is_dev: this.config.isDev,
    };
    if (args.userId) payload.user_id = args.userId;

    try {
      const result = await this.request(item, `${this.config.endpoint}/v1/ingest/attachment`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(payload),
      }, REQUEST_TIMEOUT_MS, async (response) => ({
        response,
        body: response.ok ? await response.json() as ReserveResponse : null,
      }));
      const { response, body } = result as { response: Response; body: ReserveResponse | null };
      if (!response.ok) {
        this.debug(`attachment reserve for "${args.filename}" failed (${response.status})`);
        return null;
      }
      if (!body || typeof body.upload_url !== "string") {
        this.debug(`attachment reserve for "${args.filename}" returned no upload url`);
        return null;
      }
      return body;
    } catch (err) {
      this.debug("attachment reserve failed", err);
      return null;
    }
  }

  private async putBytes(
    url: string,
    body: Blob | Uint8Array,
    sizeBytes: number,
    name: string,
    item: PendingUpload,
  ): Promise<void> {
    try {
      const response = await this.request(item, url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: body as unknown as BodyInit,
      }, uploadTimeoutMs(sizeBytes));
      if (!response.ok) {
        this.debug(`attachment upload "${name}" failed (${response.status})`);
      }
    } catch (err) {
      this.debug("attachment upload failed", err);
    }
  }
}
