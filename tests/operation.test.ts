import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSlugWarning } from "../src/metrics";
import { PulseOperation } from "../src/operation";
import type { PulseAttributes, PulseLogLevel } from "../src/types";

interface Logged {
  level: PulseLogLevel;
  message: string;
  attributes?: PulseAttributes;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let logged: Logged[];

function newOperation(metric = "photo-upload", attributes?: PulseAttributes): PulseOperation {
  return new PulseOperation(
    (level, message, attrs) => {
      logged.push({ level, message, attributes: attrs });
    },
    metric,
    attributes,
  );
}

describe("PulseOperation", () => {
  beforeEach(() => {
    logged = [];
    resetSlugWarning();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a start event carrying the tracking id and caller attributes", () => {
    const operation = newOperation("photo-upload", { size: "big" });

    expect(operation.trackingId).toMatch(UUID_PATTERN);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.level).toBe("info");
    expect(logged[0]?.message).toBe("metric:photo-upload:start");
    expect(logged[0]?.attributes).toEqual({ size: "big", tracking_id: operation.trackingId });
    expect(logged[0]?.attributes?.duration_ms).toBeUndefined();
  });

  it("normalises the slug once and reuses it for the terminal event", () => {
    const operation = newOperation("Photo Upload");
    operation.complete();

    expect(logged.map((entry) => entry.message)).toEqual([
      "metric:photo-upload:start",
      "metric:photo-upload:complete",
    ]);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("adds duration_ms and the tracking id when completing", () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_250);

    const operation = newOperation();
    operation.complete({ frames: "24" });

    expect(logged[1]?.level).toBe("info");
    expect(logged[1]?.attributes).toEqual({
      frames: "24",
      tracking_id: operation.trackingId,
      duration_ms: "250",
    });
  });

  it("logs a failure at error level with the error attribute", () => {
    const operation = newOperation();
    operation.fail(new TypeError("upload rejected"), { attempt: "2" });

    expect(logged[1]?.level).toBe("error");
    expect(logged[1]?.message).toBe("metric:photo-upload:fail");
    expect(logged[1]?.attributes?.error).toBe("upload rejected");
    expect(logged[1]?.attributes?.attempt).toBe("2");
    expect(logged[1]?.attributes?.tracking_id).toBe(operation.trackingId);
    expect(logged[1]?.attributes?.duration_ms).toBeDefined();
  });

  it("describes non-Error failures too", () => {
    newOperation().fail("network offline");
    expect(logged[1]?.attributes?.error).toBe("network offline");

    logged = [];
    newOperation().fail({ code: 500 });
    expect(logged[1]?.attributes?.error).toBe("[object Object]");
  });

  it("emits a cancel event at info level", () => {
    const operation = newOperation();
    operation.cancel({ reason: "user_left" });

    expect(logged[1]?.level).toBe("info");
    expect(logged[1]?.message).toBe("metric:photo-upload:cancel");
    expect(logged[1]?.attributes?.reason).toBe("user_left");
  });

  it("ignores every finish after the first", () => {
    const operation = newOperation();
    operation.complete();
    operation.complete();
    operation.fail("too late");
    operation.cancel();

    expect(logged).toHaveLength(2);
    expect(logged[1]?.message).toBe("metric:photo-upload:complete");
  });

  it("keeps the SDK-owned attributes when the caller passes the same keys", () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_040);

    const operation = newOperation("photo-upload", { tracking_id: "mine" });
    operation.complete({ tracking_id: "mine", duration_ms: "999" });

    expect(logged[0]?.attributes?.tracking_id).toBe(operation.trackingId);
    expect(logged[1]?.attributes?.tracking_id).toBe(operation.trackingId);
    expect(logged[1]?.attributes?.duration_ms).toBe("40");
  });
});
