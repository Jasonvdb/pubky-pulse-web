import { describe, expect, it } from "vitest";
import { byteLength, encodeBody, GZIP_THRESHOLD_BYTES, gzip } from "../src/compression";

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  return new Response(stream.readable).text();
}

/** A gzip stand-in whose transform fails after the writer accepted the chunk. */
class FailingCompressionStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;

  constructor() {
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform() {
        throw new Error("codec failed");
      },
    });
    this.readable = transform.readable;
    this.writable = transform.writable;
  }
}

async function withCompressionStream<T>(ctor: unknown, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "CompressionStream");
  Object.defineProperty(globalThis, "CompressionStream", {
    configurable: true,
    writable: true,
    value: ctor,
  });
  try {
    return await run();
  } finally {
    Reflect.deleteProperty(globalThis, "CompressionStream");
    if (original) Object.defineProperty(globalThis, "CompressionStream", original);
  }
}

async function withoutCompressionStream<T>(run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "CompressionStream");
  Reflect.deleteProperty(globalThis, "CompressionStream");
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(globalThis, "CompressionStream", original);
  }
}

const large = JSON.stringify({ events: "a".repeat(GZIP_THRESHOLD_BYTES) });
const small = JSON.stringify({ events: "a" });

describe("byteLength", () => {
  it("counts utf-8 bytes, not code units", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
  });
});

describe("gzip", () => {
  it("round-trips through the platform gzip codec", async () => {
    const compressed = await gzip(large);
    expect(compressed).toBeInstanceOf(Uint8Array);
    expect(await gunzip(compressed as Uint8Array<ArrayBuffer>)).toBe(large);
  });

  it("returns null without leaking an unhandled rejection when the codec fails", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await withCompressionStream(FailingCompressionStream, async () => {
        expect(await gzip(large)).toBeNull();
      });
      // Node reports an unhandled rejection a macrotask after it settles.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("returns null when the platform has no CompressionStream", async () => {
    await withoutCompressionStream(async () => {
      expect(await gzip(large)).toBeNull();
    });
  });
});

describe("encodeBody", () => {
  it("leaves small bodies uncompressed", async () => {
    expect(byteLength(small)).toBeLessThan(GZIP_THRESHOLD_BYTES);
    expect(await encodeBody(small, true)).toEqual({ body: small });
  });

  it("compresses bodies at or above the threshold", async () => {
    const encoded = await encodeBody(large, true);
    expect(encoded.contentEncoding).toBe("gzip");
    expect(encoded.body).toBeInstanceOf(Uint8Array);
    expect((encoded.body as Uint8Array).length).toBeLessThan(byteLength(large));
  });

  it("skips compression when it is disabled", async () => {
    expect(await encodeBody(large, false)).toEqual({ body: large });
  });

  it("falls back to plain json when the codec is missing", async () => {
    await withoutCompressionStream(async () => {
      expect(await encodeBody(large, true)).toEqual({ body: large });
    });
  });
});
