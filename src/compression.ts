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

export function isCompressionAvailable(): boolean {
  return typeof getCompressionStream() === "function";
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
    void writer.write(new TextEncoder().encode(value));
    void writer.close();
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
