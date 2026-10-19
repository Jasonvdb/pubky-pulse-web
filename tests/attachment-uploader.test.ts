import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentUploader,
  inferContentType,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_QUEUE_ITEMS,
  MAX_UPLOAD_TIMEOUT_MS,
  uploadTimeoutMs,
} from "../src/attachment-uploader";
import { validateConfiguration, type ValidatedConfig } from "../src/configuration";
import { createDeliveryGate } from "../src/delivery-gate";
import { REQUEST_TIMEOUT_MS } from "../src/transport";
import { resetTestEnvironment } from "./setup";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

function makeConfig(canDeliver?: () => boolean): ValidatedConfig {
  return validateConfiguration({
    endpoint: "https://pulse.example.com",
    apiKey: "pulse_client_abc",
    bundleId: "com.example.web",
    isDev: false,
    canDeliver,
  });
}

/** An uploader asking `config.canDeliver` through the gate `Pulse` builds for each client. */
function gatedUploader(config: ValidatedConfig, onDebug?: (message: string, detail?: unknown) => void): AttachmentUploader {
  return new AttachmentUploader(config, onDebug, createDeliveryGate(config.canDeliver, onDebug));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

let fetchMock: ReturnType<typeof vi.fn>;
let debug: ReturnType<typeof vi.fn>;

/** Reserve responses in order, then a 200 for each upload PUT. */
function respondWithUploadUrls(): void {
  let reserved = 0;
  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith("/v1/ingest/attachment")) {
      reserved += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            attachment_id: `att_${reserved}`,
            upload_url: `https://uploads.example.com/att_${reserved}`,
          }),
          { status: 201 },
        ),
      );
    }
    return Promise.resolve(new Response("", { status: 200 }));
  });
}

function callsTo(fragment: string): [string, RequestInit][] {
  return fetchMock.mock.calls.filter((call) =>
    (call[0] as string).includes(fragment),
  ) as [string, RequestInit][];
}

describe("inferContentType", () => {
  it("maps known extensions and falls back to octet-stream", () => {
    expect(inferContentType("shot.PNG")).toBe("image/png");
    expect(inferContentType("trace.log")).toBe("text/plain");
    expect(inferContentType("mystery")).toBe("application/octet-stream");
    expect(inferContentType("archive.tar.zst")).toBe("application/octet-stream");
  });
});

describe("uploadTimeoutMs", () => {
  it("scales with size and stays under the ceiling", () => {
    expect(uploadTimeoutMs(1)).toBeGreaterThan(REQUEST_TIMEOUT_MS);
    expect(uploadTimeoutMs(8 * 1024 * 1024)).toBeGreaterThan(uploadTimeoutMs(1024));
    expect(uploadTimeoutMs(MAX_ATTACHMENT_BYTES)).toBe(MAX_UPLOAD_TIMEOUT_MS);
  });
});

describe("AttachmentUploader", () => {
  beforeEach(() => {
    resetTestEnvironment();
    fetchMock = vi.fn();
    debug = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    respondWithUploadUrls();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["reserve", "put"])("aborts a stalled %s request at its timeout", async (stage) => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", { subtle: { digest: async () => new ArrayBuffer(32) } });
    const uploader = new AttachmentUploader(makeConfig(), debug);
    const bytes = new Uint8Array(3 * 1024 * 1024);
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      if (stage === "put" && url.endsWith("/v1/ingest/attachment")) {
        return Promise.resolve(new Response(JSON.stringify({ upload_url: "https://uploads.example.com/file" })));
      }
      signal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    uploader.enqueue(EVENT_ID, undefined, [{ data: bytes, filename: "big.bin" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(false);
    const deadline = stage === "reserve" ? REQUEST_TIMEOUT_MS : uploadTimeoutMs(bytes.length);
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await uploader.flush();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it.each(["timeout", "stop"])("keeps reservation response-body reads abortable until %s", async (ending) => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", { subtle: { digest: async () => new ArrayBuffer(32) } });
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      const response = new Response("", { status: 201 });
      response.json = () => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("body aborted")));
      });
      return Promise.resolve(response);
    });
    const uploader = new AttachmentUploader(makeConfig(), debug);
    uploader.enqueue(EVENT_ID, undefined, [{ data: new Uint8Array([1]) }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(false);
    if (ending === "stop") uploader.stop();
    else await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await uploader.flush();
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("discards pending attachments and stops after an in-progress hash when disabled", async () => {
    let finishHash!: (bytes: ArrayBuffer) => void;
    vi.stubGlobal("crypto", { subtle: { digest: () => new Promise<ArrayBuffer>((resolve) => { finishHash = resolve; }) } });
    const uploader = new AttachmentUploader(makeConfig(), debug);
    uploader.enqueue(EVENT_ID, undefined, [{ data: new Uint8Array([1]) }, { data: new Uint8Array([2]) }]);
    uploader.stop();
    finishHash(new ArrayBuffer(32));
    await uploader.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts an active reservation and never starts its upload after stop", async () => {
    vi.stubGlobal("crypto", { subtle: { digest: async () => new ArrayBuffer(32) } });
    let signal: AbortSignal | undefined;
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise<Response>((resolve) => { finish = resolve; });
    });
    const uploader = new AttachmentUploader(makeConfig(), debug);
    uploader.enqueue(EVENT_ID, undefined, [{ data: new Uint8Array([1]) }]);
    await Promise.resolve();
    await Promise.resolve();
    uploader.stop();
    expect(signal?.aborted).toBe(true);
    finish(new Response(JSON.stringify({ upload_url: "https://uploads.example.com/file" })));
    await uploader.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hashes only the bytes a view spans, not its backing buffer", async () => {
    const uploader = new AttachmentUploader(makeConfig(), debug);
    const backing = new Uint8Array([9, 9, 1, 2, 3, 4, 9, 9]);
    const view = backing.subarray(2, 6);

    uploader.enqueue(EVENT_ID, undefined, [{ data: view, filename: "slice.bin" }]);
    await uploader.flush();

    const body = JSON.parse(callsTo("/v1/ingest/attachment")[0]![1].body as string) as {
      sha256: string;
      size_bytes: number;
    };
    expect(body.size_bytes).toBe(4);
    expect(body.sha256).toBe(sha256(new Uint8Array([1, 2, 3, 4])));
  });

  it("reserves then uploads a Uint8Array", async () => {
    const uploader = new AttachmentUploader(makeConfig(), debug);
    const bytes = new Uint8Array([1, 2, 3, 4]);

    uploader.enqueue(EVENT_ID, "user-1", [{ data: bytes, filename: "trace.log" }]);
    await uploader.flush();

    const [reserveUrl, reserveInit] = callsTo("/v1/ingest/attachment")[0]!;
    expect(reserveUrl).toBe("https://pulse.example.com/v1/ingest/attachment");
    expect((reserveInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer pulse_client_abc",
    );
    expect(JSON.parse(reserveInit.body as string)).toEqual({
      client_event_id: EVENT_ID,
      user_id: "user-1",
      original_filename: "trace.log",
      content_type: "text/plain",
      size_bytes: 4,
      sha256: sha256(bytes),
      is_dev: false,
    });

    const [putUrl, putInit] = callsTo("uploads.example.com")[0]!;
    expect(putUrl).toBe("https://uploads.example.com/att_1");
    expect(putInit.method).toBe("PUT");
    expect((putInit.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/octet-stream",
    );
    expect((putInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer pulse_client_abc",
    );
    expect(new Uint8Array(putInit.body as Uint8Array)).toEqual(bytes);
  });

  it("puts the Blob itself rather than a copy of its bytes", async () => {
    const uploader = new AttachmentUploader(makeConfig(), debug);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const blob = new Blob([bytes], { type: "text/plain" });

    uploader.enqueue(EVENT_ID, undefined, [{ data: blob, filename: "note.txt" }]);
    await uploader.flush();

    const body = JSON.parse(callsTo("/v1/ingest/attachment")[0]![1].body as string) as {
      size_bytes: number;
      sha256: string;
    };
    expect(body.size_bytes).toBe(blob.size);
    expect(body.sha256).toBe(sha256(bytes));
    // The browser streams the Blob instead of copying it into the request.
    expect(callsTo("uploads.example.com")[0]![1].body).toBe(blob);
  });

  it("rejects an over-cap Blob without reading it", async () => {
    const uploader = new AttachmentUploader(makeConfig(), debug);
    const blob = new Blob([new Uint8Array([1])]);
    const read = vi.fn(() => Promise.resolve(new ArrayBuffer(1)));
    Object.defineProperty(blob, "size", { value: MAX_ATTACHMENT_BYTES + 1 });
    Object.defineProperty(blob, "arrayBuffer", { value: read });

    uploader.enqueue(EVENT_ID, undefined, [{ data: blob, filename: "huge.bin" }]);
    await uploader.flush();

    expect(read).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("exceeds the SDK cap"));
  });

  it("skips an empty Blob without reading it", async () => {
    const uploader = new AttachmentUploader(makeConfig(), debug);
    const blob = new Blob([]);
    const read = vi.fn(() => Promise.resolve(new ArrayBuffer(0)));
    Object.defineProperty(blob, "arrayBuffer", { value: read });

    uploader.enqueue(EVENT_ID, undefined, [{ data: blob, filename: "empty.bin" }]);
    await uploader.flush();

    expect(read).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("empty attachment"));
  });

  it("takes the name and type from a File", async () => {
    const uploader = new AttachmentUploader(makeConfig(), debug);
    const file = new File([new Uint8Array([9, 9])], "shot.png", { type: "image/png" });

    uploader.enqueue(EVENT_ID, undefined, [{ data: file }]);
    await uploader.flush();

    const body = JSON.parse(callsTo("/v1/ingest/attachment")[0]![1].body as string) as Record<
      string,
      unknown
    >;
    expect(body.original_filename).toBe("shot.png");
    expect(body.content_type).toBe("image/png");
    expect(body.size_bytes).toBe(2);
    expect(body).not.toHaveProperty("user_id");
  });

  it("uploads queued attachments one at a time", async () => {
    const uploader = new AttachmentUploader(makeConfig(), debug);

    uploader.enqueue(EVENT_ID, undefined, [
      { data: new Uint8Array([1]), filename: "one.bin" },
      { data: new Uint8Array([2]), filename: "two.bin" },
    ]);
    await uploader.flush();

    const order = fetchMock.mock.calls.map((call) =>
      (call[0] as string).includes("/v1/ingest/attachment") ? "reserve" : "put",
    );
    expect(order).toEqual(["reserve", "put", "reserve", "put"]);
  });

  it("skips every attachment when crypto.subtle is unavailable", async () => {
    vi.stubGlobal("crypto", {});
    const uploader = new AttachmentUploader(makeConfig(), debug);

    uploader.enqueue(EVENT_ID, undefined, [{ data: new Uint8Array([1]), filename: "a.bin" }]);
    await uploader.flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("crypto.subtle is unavailable"));
  });

  it("skips an empty attachment", async () => {
    const uploader = new AttachmentUploader(makeConfig(), debug);

    uploader.enqueue(EVENT_ID, undefined, [{ data: new Uint8Array(), filename: "empty.bin" }]);
    await uploader.flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("empty attachment"));
  });

  it("does not upload when the reservation is refused", async () => {
    fetchMock.mockResolvedValue(new Response("over quota", { status: 413 }));
    const uploader = new AttachmentUploader(makeConfig(), debug);

    uploader.enqueue(EVENT_ID, undefined, [{ data: new Uint8Array([1]), filename: "a.bin" }]);
    await uploader.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("(413)"));
  });

  it("keeps draining after one attachment fails", async () => {
    let reserved = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/v1/ingest/attachment")) {
        reserved += 1;
        if (reserved === 1) return Promise.reject(new Error("offline"));
        return Promise.resolve(
          new Response(
            JSON.stringify({ attachment_id: "att_2", upload_url: "https://uploads.example.com/2" }),
            { status: 201 },
          ),
        );
      }
      return Promise.resolve(new Response("", { status: 200 }));
    });
    const uploader = new AttachmentUploader(makeConfig(), debug);

    uploader.enqueue(EVENT_ID, undefined, [
      { data: new Uint8Array([1]), filename: "one.bin" },
      { data: new Uint8Array([2]), filename: "two.bin" },
    ]);
    await uploader.flush();

    expect(callsTo("uploads.example.com")).toHaveLength(1);
  });

  it("flush resolves immediately when nothing is queued", async () => {
    const uploader = new AttachmentUploader(makeConfig(), debug);

    await expect(uploader.flush()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AttachmentUploader canDeliver gate", () => {
  let allowed: boolean;
  const canDeliver = () => allowed;

  beforeEach(() => {
    resetTestEnvironment();
    fetchMock = vi.fn();
    debug = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    respondWithUploadUrls();
    allowed = false;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** How many attachments an ungated uploader can still retain, given the shared caps. */
  async function freeRetentionSlots(): Promise<number> {
    const probe = gatedUploader(makeConfig(), debug);
    const before = callsTo("/v1/ingest/attachment").length;
    probe.enqueue(EVENT_ID, undefined, Array.from({ length: MAX_ATTACHMENT_QUEUE_ITEMS }, (_, index) => ({
      data: new Uint8Array([index + 1]),
      filename: `probe-${index}.bin`,
    })));
    await probe.flush();
    return callsTo("/v1/ingest/attachment").length - before;
  }

  function reservedFilenames(): string[] {
    return callsTo("/v1/ingest/attachment").map(
      ([, init]) => (JSON.parse(init.body as string) as { original_filename: string }).original_filename,
    );
  }

  it("holds a vetoed attachment in the queue, retained, until a later flush delivers it once", async () => {
    const uploader = gatedUploader(makeConfig(canDeliver), debug);

    uploader.enqueue(EVENT_ID, undefined, [{ data: new Uint8Array([1]), filename: "one.bin" }]);
    uploader.enqueue(EVENT_ID, undefined, [{ data: new Uint8Array([2]), filename: "two.bin" }]);
    await uploader.flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("canDeliver vetoed"), undefined);
    // Both held items still count against the shared retention cap.
    expect(await freeRetentionSlots()).toBe(MAX_ATTACHMENT_QUEUE_ITEMS - 2);
    fetchMock.mockClear();

    allowed = true;
    await uploader.flush();
    expect(reservedFilenames()).toEqual(["one.bin", "two.bin"]);
    expect(callsTo("uploads.example.com")).toHaveLength(2);

    await uploader.flush();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(await freeRetentionSlots()).toBe(MAX_ATTACHMENT_QUEUE_ITEMS);
  });

  it("puts an item vetoed just before its reservation back at the head of the queue", async () => {
    let checks = 0;
    // Allow the item to leave the queue, then veto its reservation.
    const uploader = gatedUploader(makeConfig(() => (checks += 1) === 1 || allowed), debug);

    uploader.enqueue(EVENT_ID, undefined, [
      { data: new Uint8Array([1]), filename: "one.bin" },
      { data: new Uint8Array([2]), filename: "two.bin" },
    ]);
    await uploader.flush();
    // The drain's check, the reservation's veto, then the settling drain's one restart check.
    expect(checks).toBe(3);
    expect(fetchMock).not.toHaveBeenCalled();

    allowed = true;
    await uploader.flush();
    expect(reservedFilenames()).toEqual(["one.bin", "two.bin"]);
    expect(callsTo("uploads.example.com")).toHaveLength(2);
  });

  it("abandons and releases an item vetoed between its reservation and its PUT", async () => {
    allowed = true;
    const uploader = gatedUploader(makeConfig(canDeliver), debug);
    const reserve = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      allowed = false;
      return reserve(url, init);
    });

    uploader.enqueue(EVENT_ID, undefined, [{ data: new Uint8Array([1]), filename: "one.bin" }]);
    await uploader.flush();

    expect(callsTo("/v1/ingest/attachment")).toHaveLength(1);
    expect(callsTo("uploads.example.com")).toHaveLength(0);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("abandoning"));

    allowed = true;
    fetchMock.mockImplementation(reserve);
    await uploader.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await freeRetentionSlots()).toBe(MAX_ATTACHMENT_QUEUE_ITEMS);
  });

  it("does not strand an item enqueued while a vetoed drain is still settling", async () => {
    const uploader = gatedUploader(makeConfig(canDeliver), debug);

    // The veto ends this drain synchronously, but it is cleared only in a later microtask.
    uploader.enqueue(EVENT_ID, undefined, [{ data: new Uint8Array([1]), filename: "one.bin" }]);
    allowed = true;
    uploader.enqueue(EVENT_ID, undefined, [{ data: new Uint8Array([2]), filename: "two.bin" }]);

    // No flush(): the settling drain must restart on its own.
    await vi.waitFor(() => expect(callsTo("uploads.example.com")).toHaveLength(2));
    expect(reservedFilenames()).toEqual(["one.bin", "two.bin"]);
  });

  it("does not restart a settling drain while delivery stays vetoed", async () => {
    let checks = 0;
    const uploader = gatedUploader(makeConfig(() => { checks += 1; return false; }), debug);

    uploader.enqueue(EVENT_ID, undefined, [{ data: new Uint8Array([1]), filename: "one.bin" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // One check in the drain, one in its settling restart check, then nothing.
    expect(checks).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    uploader.stop();
  });

  it("releases held attachments on stop and never sends them", async () => {
    const uploader = gatedUploader(makeConfig(canDeliver), debug);

    uploader.enqueue(EVENT_ID, undefined, [{ data: new Uint8Array([1]), filename: "held.bin" }]);
    await uploader.flush();
    uploader.stop();

    allowed = true;
    await uploader.flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await freeRetentionSlots()).toBe(MAX_ATTACHMENT_QUEUE_ITEMS);
    expect(reservedFilenames()).not.toContain("held.bin");
  });

  it.each([
    ["a throw", () => { throw new Error("consent store unavailable"); }],
    ["1", () => 1],
    ["'yes'", () => "yes"],
    ["undefined", () => undefined],
    ["a Promise", () => Promise.resolve(true)],
  ])("treats %s from canDeliver as a veto", async (_label, result) => {
    const uploader = gatedUploader(makeConfig(result as unknown as () => boolean), debug);

    uploader.enqueue(EVENT_ID, undefined, [{ data: new Uint8Array([1]), filename: "a.bin" }]);
    await uploader.flush();

    expect(fetchMock).not.toHaveBeenCalled();
    uploader.stop();
  });

  it("uploads as before when canDeliver is omitted", async () => {
    const config = makeConfig();
    expect(config.canDeliver).toBeUndefined();
    const uploader = gatedUploader(config, debug);

    uploader.enqueue(EVENT_ID, undefined, [{ data: new Uint8Array([1]), filename: "a.bin" }]);
    await uploader.flush();

    expect(reservedFilenames()).toEqual(["a.bin"]);
    expect(callsTo("uploads.example.com")).toHaveLength(1);
  });
});
