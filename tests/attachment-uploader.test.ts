import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentUploader, inferContentType } from "../src/attachment-uploader";
import { validateConfiguration, type ValidatedConfig } from "../src/configuration";
import { resetTestEnvironment } from "./setup";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

function makeConfig(): ValidatedConfig {
  return validateConfiguration({
    endpoint: "https://pulse.example.com",
    apiKey: "pulse_client_abc",
    bundleId: "com.example.web",
    isDev: false,
  });
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
