/**
 * Out-of-band upload of files attached to an event. Uploads run serially in a
 * background queue so a screenshot never delays the event itself; `flush()`
 * waits for the queue to empty.
 */

import type { ValidatedConfig } from "./configuration";
import { REQUEST_TIMEOUT_MS } from "./transport";
import type { PulseAttachment } from "./types";

/** Absolute SDK safety net. Real limits are the project's server-side quotas. */
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;

/** Fixed part of an upload's budget, before the size allowance. */
export const UPLOAD_TIMEOUT_BASE_MS = 30_000;
/** Allowance per megabyte, generous enough for a slow mobile connection. */
export const UPLOAD_TIMEOUT_PER_MB_MS = 10_000;
/** Ceiling, so a stalled upload can never hold `flush()` open indefinitely. */
export const MAX_UPLOAD_TIMEOUT_MS = 30 * 60_000;

/**
 * Attachments run to 2 GiB, so the 10s ingest budget would abort legitimate
 * large uploads; the PUT gets a size-derived budget instead.
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
  attachment: PulseAttachment;
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

  constructor(config: ValidatedConfig, onDebug?: (message: string, detail?: unknown) => void) {
    this.config = config;
    this.onDebug = onDebug;
  }

  /** Queue every attachment of one event. Returns immediately. */
  enqueue(clientEventId: string, userId: string | undefined, attachments: PulseAttachment[]): void {
    if (attachments.length === 0) return;

    if (!subtleCrypto()) {
      this.onDebug?.("crypto.subtle is unavailable (insecure context); skipping attachments");
      return;
    }

    for (const attachment of attachments) {
      this.pending.push({ clientEventId, userId, attachment });
    }
    if (!this.draining) this.draining = this.drain();
  }

  /** Resolve once the queue is empty. Resolves immediately when it is idle. */
  async flush(): Promise<void> {
    while (this.draining) {
      await this.draining;
    }
  }

  private async drain(): Promise<void> {
    try {
      let next = this.pending.shift();
      while (next) {
        try {
          await this.uploadOne(next);
        } catch (err) {
          this.onDebug?.("attachment upload failed", err);
        }
        next = this.pending.shift();
      }
    } finally {
      this.draining = null;
    }
  }

  private async uploadOne(item: PendingUpload): Promise<void> {
    const subtle = subtleCrypto();
    if (!subtle) return;

    const source = item.attachment.data;
    const blob = isBlob(source) ? source : null;
    let filename = item.attachment.filename;
    let contentType = item.attachment.contentType;

    if (blob) {
      const asFile = blob as Blob & { name?: string };
      filename ??= typeof asFile.name === "string" && asFile.name ? asFile.name : undefined;
      if (!contentType && blob.type) contentType = blob.type;
    } else if (!(source instanceof Uint8Array)) {
      this.onDebug?.("attachment data must be a Blob, File or Uint8Array");
      return;
    }

    const name = filename ?? "attachment.bin";
    const type = contentType ?? inferContentType(name);
    // `Blob.size` is known without reading the file, so an empty or over-cap
    // attachment is rejected before it is materialised in the heap.
    const sizeBytes = blob ? blob.size : (source as Uint8Array).length;

    if (sizeBytes === 0) {
      this.onDebug?.(`skipping empty attachment "${name}"`);
      return;
    }
    if (sizeBytes > MAX_ATTACHMENT_BYTES) {
      this.onDebug?.(`skipping attachment "${name}": ${sizeBytes} bytes exceeds the SDK cap`);
      return;
    }

    const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : (source as Uint8Array);
    const sha256 = await sha256Hex(bytes, subtle);
    const reserved = await this.reserve({
      clientEventId: item.clientEventId,
      userId: item.userId,
      filename: name,
      contentType: type,
      sizeBytes,
      sha256,
    });
    if (!reserved) return;

    // The Blob itself is the body: the browser streams it instead of copying
    // the hashed buffer into the request, which can then be collected.
    await this.putBytes(reserved.upload_url, blob ?? bytes, sizeBytes, name);
  }

  private async reserve(args: {
    clientEventId: string;
    userId?: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
  }): Promise<ReserveResponse | null> {
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
      const response = await fetch(`${this.config.endpoint}/v1/ingest/attachment`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.onDebug?.(`attachment reserve for "${args.filename}" failed (${response.status})`);
        return null;
      }
      const body = (await response.json()) as ReserveResponse;
      if (!body || typeof body.upload_url !== "string") {
        this.onDebug?.(`attachment reserve for "${args.filename}" returned no upload url`);
        return null;
      }
      return body;
    } catch (err) {
      this.onDebug?.("attachment reserve failed", err);
      return null;
    }
  }

  private async putBytes(
    url: string,
    body: Blob | Uint8Array,
    sizeBytes: number,
    name: string,
  ): Promise<void> {
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: body as unknown as BodyInit,
        signal: AbortSignal.timeout(uploadTimeoutMs(sizeBytes)),
      });
      if (!response.ok) {
        this.onDebug?.(`attachment upload "${name}" failed (${response.status})`);
      }
    } catch (err) {
      this.onDebug?.("attachment upload failed", err);
    }
  }
}
