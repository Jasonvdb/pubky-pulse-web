import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentUploader } from "../src/attachment-uploader";
import { validateConfiguration } from "../src/configuration";
import type { PulseAttachment } from "../src/types";

const MIB = 1024 * 1024;
const config = validateConfiguration({ endpoint: "https://pulse.example.com", apiKey: "pulse_client_test" });
let uploaders: AttachmentUploader[];
let releases: Array<() => void>;
let fetchMock: ReturnType<typeof vi.fn>;
function uploader(debug?: (message: string) => void): AttachmentUploader {
  const value = new AttachmentUploader(config, debug);
  uploaders.push(value);
  return value;
}
function stalledDigest(): ReturnType<typeof vi.fn> {
  let release!: (value: ArrayBuffer) => void;
  const pending = new Promise<ArrayBuffer>((resolve) => { release = resolve; });
  releases.push(() => release(new ArrayBuffer(32)));
  const digest = vi.fn((_algorithm: string, _bytes: BufferSource) => pending);
  vi.stubGlobal("crypto", { subtle: { digest } });
  return digest;
}
function reservations(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/v1/ingest/attachment"))
    .map(([, init]) => JSON.parse(init.body));
}
beforeEach(() => {
  uploaders = [];
  releases = [];
  vi.stubGlobal("crypto", { subtle: { digest: async () => new ArrayBuffer(32) } });
  fetchMock = vi.fn(async (url: string) => url.endsWith("/v1/ingest/attachment")
    ? new Response(JSON.stringify({ upload_url: "https://upload.example.com/file" }))
    : new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  for (const value of uploaders) value.stop();
  for (const release of releases) release();
  for (const value of uploaders) await value.flush().catch(() => {});
  for (let i = 0; i < 20; i++) await Promise.resolve();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("bounded attachment resources", () => {
  it("accepts exactly 5 MiB and rejects larger Blobs before reading", async () => {
    const value = uploader();
    const oversized = new Blob(["small"]);
    Object.defineProperty(oversized, "size", { value: 5 * MIB + 1 });
    const read = vi.spyOn(oversized, "arrayBuffer").mockRejectedValue(new Error("must not read"));
    value.enqueue("event", undefined, [{ data: new Uint8Array(5 * MIB) }, { data: oversized }]);
    await value.flush();
    expect(read).not.toHaveBeenCalled();
    expect(reservations().map((item) => item.size_bytes)).toEqual([5 * MIB]);
  });
  it("admits at most 20 items including the active hash", async () => {
    stalledDigest();
    const value = uploader();
    for (let i = 0; i < 21; i++) value.enqueue("event", undefined, [{ data: new Uint8Array([i]), filename: `${i}.bin` }]);
    releases[0]!();
    await value.flush();
    expect(reservations().map((item) => item.original_filename)).toEqual(Array.from({ length: 20 }, (_, i) => `${i}.bin`));
  });
  it("admits exactly 20 MiB across active and pending files", async () => {
    stalledDigest();
    const value = uploader();
    for (let i = 0; i < 5; i++) value.enqueue("event", undefined, [{ data: new Uint8Array(5 * MIB) }]);
    releases[0]!();
    await value.flush();
    expect(reservations()).toHaveLength(4);
  });
  it("copies only an accepted subarray's bytes and snapshots mutable metadata", async () => {
    const digest = stalledDigest();
    const value = uploader();
    const backing = new Uint8Array(MIB);
    backing[12] = 7;
    const attachment: PulseAttachment = { data: backing.subarray(12, 13), filename: "original.txt", contentType: "text/plain" };
    value.enqueue("event", undefined, [attachment]);
    const hashed = digest.mock.calls[0]![1] as Uint8Array;
    expect(hashed.buffer.byteLength).toBe(1);
    attachment.filename = "changed.bin";
    attachment.contentType = "application/changed";
    backing[12] = 9;
    releases[0]!();
    await value.flush();
    expect(reservations()[0]).toMatchObject({ original_filename: "original.txt", content_type: "text/plain" });
    const put = fetchMock.mock.calls.find(([url]) => String(url).includes("upload.example.com"))!;
    expect(Array.from(put[1].body as Uint8Array)).toEqual([7]);
  });
  it("retains stopped in-flight hash reservations across new uploader instances", async () => {
    const digest = stalledDigest();
    for (let i = 0; i < 4; i++) {
      const value = uploader();
      value.enqueue("event", undefined, [{ data: new Uint8Array(5 * MIB) }]);
      value.stop();
    }
    const replacement = uploader();
    replacement.enqueue("event", undefined, [{ data: new Uint8Array([1]) }]);
    expect(digest).toHaveBeenCalledTimes(4);
    releases[0]!();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    replacement.enqueue("event", undefined, [{ data: new Uint8Array([2]) }]);
    await replacement.flush();
    expect(reservations()).toHaveLength(1);
  });
  it("bounds flush waits without freeing memory still held by stalled hashes", async () => {
    vi.useFakeTimers();
    const digest = stalledDigest();
    const value = uploader();
    for (let i = 0; i < 4; i++) value.enqueue("event", undefined, [{ data: new Uint8Array(5 * MIB) }]);
    let finished = false;
    void value.flush().then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(finished).toBe(true);
    const replacement = uploader();
    replacement.enqueue("event", undefined, [{ data: new Uint8Array([1]) }]);
    expect(digest.mock.calls.length).toBeLessThanOrEqual(2);
    expect(reservations()).toEqual([]);
  });
  it("contains poison metadata and diagnostics and accepts later valid work", async () => {
    const value = uploader(() => { throw new Error("diagnostics failed"); });
    const poison = { get data() { throw new Error("data failed"); } } as unknown as PulseAttachment;
    expect(() => value.enqueue("event", undefined, [poison, { data: new Uint8Array([1]) }])).not.toThrow();
    await expect(value.flush()).resolves.toBeUndefined();
    expect(reservations()).toHaveLength(1);
  });
  it("snapshots queued files before callers mutate their attachment objects", async () => {
    stalledDigest();
    const value = uploader();
    const second = { data: new Uint8Array([2]), filename: "before.txt", contentType: "text/plain" };
    value.enqueue("event", undefined, [{ data: new Uint8Array([1]) }, second]);
    second.filename = "after.bin";
    second.contentType = "application/changed";
    second.data[0] = 9;
    releases[0]!();
    await value.flush();
    expect(reservations()[1]).toMatchObject({ original_filename: "before.txt", content_type: "text/plain" });
    const puts = fetchMock.mock.calls.filter(([url]) => String(url).includes("upload.example.com"));
    expect(Array.from(puts[1]![1].body as Uint8Array)).toEqual([2]);
  });
  it("rejects a genuinely oversized Blob whose public size was falsified", async () => {
    const value = uploader();
    const blob = new Blob([new Uint8Array(6 * MIB)]);
    Object.defineProperty(blob, "size", { value: 1 });
    const read = vi.spyOn(Blob.prototype, "arrayBuffer");
    value.enqueue("event", undefined, [{ data: blob }]);
    await value.flush();
    expect(read).not.toHaveBeenCalled();
    expect(reservations()).toEqual([]);
  });
  it("keeps a stalled Blob read budget reserved after stop until the read settles", async () => {
    let release!: (buffer: ArrayBuffer) => void;
    const reading = new Promise<ArrayBuffer>((resolve) => { release = resolve; });
    releases.push(() => release(new ArrayBuffer(5 * MIB)));
    vi.spyOn(Blob.prototype, "arrayBuffer").mockReturnValue(reading);
    for (let i = 0; i < 4; i++) {
      const value = uploader();
      value.enqueue("event", undefined, [{ data: new Blob([new Uint8Array(5 * MIB)]) }]);
      value.stop();
    }
    const replacement = uploader();
    replacement.enqueue("event", undefined, [{ data: new Uint8Array([1]) }]);
    await replacement.flush();
    expect(fetchMock).not.toHaveBeenCalled();
    releases[0]!();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    replacement.enqueue("event", undefined, [{ data: new Uint8Array([1]) }]);
    await replacement.flush();
    expect(reservations()).toHaveLength(1);
  });
  it("drops pending files on stop while retaining only the active file budget", async () => {
    const digest = stalledDigest();
    const value = uploader();
    value.enqueue("event", undefined, Array.from({ length: 4 }, () => ({ data: new Uint8Array(5 * MIB) })));
    value.stop();
    const replacement = uploader();
    for (let i = 0; i < 4; i++) replacement.enqueue("event", undefined, [{ data: new Uint8Array(5 * MIB) }]);
    releases[0]!();
    await replacement.flush();
    expect(digest).toHaveBeenCalledTimes(4);
    expect(reservations()).toHaveLength(3);
  });
  it("contains a late hash rejection after its wait deadline and admits later work", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const pending = new Promise<ArrayBuffer>((_resolve, fail) => { reject = fail; });
    releases.push(() => reject(new Error("late digest failure")));
    vi.stubGlobal("crypto", { subtle: { digest: () => pending } });
    const value = uploader(() => { throw new Error("debug failed"); });
    value.enqueue("event", undefined, [{ data: new Uint8Array(5 * MIB) }]);
    const flushing = value.flush();
    await vi.advanceTimersByTimeAsync(120_000);
    await flushing;
    releases[0]!();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    vi.stubGlobal("crypto", { subtle: { digest: async () => new ArrayBuffer(32) } });
    value.enqueue("event", undefined, [{ data: new Uint8Array([1]) }]);
    await value.flush();
    expect(reservations()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains reservations for aborted requests that ignore cancellation", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    releases.push(() => finish(new Response(JSON.stringify({ upload_url: "https://upload.example.com/file" }))));
    fetchMock.mockReturnValue(pending);
    for (let i = 0; i < 4; i++) {
      const value = uploader();
      value.enqueue("event", undefined, [{ data: new Uint8Array(5 * MIB) }]);
      for (let tick = 0; tick < 5; tick++) await Promise.resolve();
      value.stop();
    }
    const replacement = uploader();
    replacement.enqueue("event", undefined, [{ data: new Uint8Array([1]) }]);
    await replacement.flush();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.every(([, init]) => init.signal.aborted)).toBe(true);
    releases[0]!();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    replacement.enqueue("event", undefined, [{ data: new Uint8Array([1]) }]);
    await replacement.flush();
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
  it("rejects oversized metadata and observes withdrawal during an attachment getter", async () => {
    const value = uploader();
    value.enqueue("event", undefined, [
      { data: new Uint8Array([1]), filename: "x".repeat(1025) },
      { data: new Uint8Array([1]), contentType: "x".repeat(256) },
    ]);
    await value.flush();
    expect(reservations()).toEqual([]);
    value.enqueue("event", undefined, [{ get data() { value.stop(); return new Uint8Array([1]); } }]);
    await value.flush();
    expect(reservations()).toEqual([]);
    const replacement = uploader();
    replacement.enqueue("event", undefined, Array.from({ length: 4 }, () => ({ data: new Uint8Array(5 * MIB) })));
    await replacement.flush();
    expect(reservations()).toHaveLength(4);
  });
  it("releases successful and failed work so future batches can use the full budget", async () => {
    const value = uploader();
    const batch = () => Array.from({ length: 4 }, () => ({ data: new Uint8Array(5 * MIB) }));
    value.enqueue("event", undefined, batch());
    await value.flush();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    value.enqueue("event", undefined, batch());
    await value.flush();
    value.enqueue("event", undefined, batch());
    await value.flush();
    expect(reservations()).toHaveLength(12);
  });
});
