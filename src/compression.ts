/**
 * gzip request bodies with `CompressionStream`. The server accepts both, so
 * every failure path falls back to plain JSON rather than dropping the batch.
 */

/** Below this many bytes gzip costs more than it saves. */
export const GZIP_THRESHOLD_BYTES = 512;

export interface EncodedBody {
  body: Uint8Array<ArrayBuffer> | string;
  contentEncoding?: "gzip";
}

type CompressionStreamCtor = new (format: string) => {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

function getCompressionStream(): CompressionStreamCtor | undefined {
  return (globalThis as { CompressionStream?: CompressionStreamCtor }).CompressionStream;
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Returns null when gzip is unavailable or the stream fails mid-flight. */
export async function gzip(value: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const Ctor = getCompressionStream();
  if (!Ctor) return null;
  try {
    const stream = new Ctor("gzip");
    const writer = stream.writable.getWriter();
    // The rejections surface through the awaited read below; without these
    // no-op handlers a mid-flight codec failure escapes as an unhandled
    // rejection, which the SDK's own global hook would report as an app error.
    writer.write(new TextEncoder().encode(value)).catch(() => {});
    writer.close().catch(() => {});
    const buffer = await new Response(stream.readable).arrayBuffer();
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}

/**
 * Compress when enabled, available, and worth it. `allowCompression` is false
 * on the unload path, where the extra async hop would lose the request.
 */
export async function encodeBody(json: string, allowCompression: boolean): Promise<EncodedBody> {
  if (!allowCompression) return { body: json };
  if (byteLength(json) < GZIP_THRESHOLD_BYTES) return { body: json };
  const compressed = await gzip(json);
  if (!compressed) return { body: json };
  return { body: compressed, contentEncoding: "gzip" };
}
