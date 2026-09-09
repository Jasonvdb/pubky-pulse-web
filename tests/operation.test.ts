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

  it.each(["start", "complete", "fail", "cancel"] as const)(
    "bounds caller-attribute reads before constructing the %s event", (phase) => {
      const attributes = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field-${index}`, "value"]));
      const overflow = vi.fn(() => "not admitted");
      Object.defineProperty(attributes, "overflow", { enumerable: true, get: overflow });
      const operation = newOperation("bounded-operation", phase === "start" ? attributes : undefined);
      if (phase === "complete") operation.complete(attributes);
      if (phase === "fail") operation.fail("failure", attributes);
      if (phase === "cancel") operation.cancel(attributes);

      expect(overflow).not.toHaveBeenCalled();
      const emitted = logged.at(-1)!.attributes!;
      expect(Object.keys(emitted)).toHaveLength(100);
      expect(emitted.tracking_id).toBe(operation.trackingId);
      if (phase !== "start") expect(emitted.duration_ms).toBeDefined();
      if (phase === "fail") expect(emitted.error).toBe("failure");
    },
  );

  it.each(["start", "complete", "fail", "cancel"] as const)(
    "skips oversized and inherited attribute keys for %s without evaluating their getters", (phase) => {
      const skipped = vi.fn(() => "not admitted");
      const inherited = { get parent() { return skipped(); } };
      const attributes: PulseAttributes = Object.create(inherited) as PulseAttributes;
      attributes["x".repeat(256)] = "boundary key";
      Object.defineProperty(attributes, "__proto__", { enumerable: true, value: "ordinary own attribute" });
      Object.defineProperty(attributes, "x".repeat(257), { enumerable: true, get: skipped });
      Object.defineProperty(attributes, "hidden", { enumerable: false, get: skipped });
      const operation = newOperation("bounded-operation", phase === "start" ? attributes : undefined);
      if (phase === "complete") operation.complete(attributes);
      if (phase === "fail") operation.fail("failure", attributes);
      if (phase === "cancel") operation.cancel(attributes);

      expect(skipped).not.toHaveBeenCalled();
      const emitted = logged.at(-1)!.attributes!;
      expect(emitted["x".repeat(256)]).toBe("boundary key");
      expect(emitted["x".repeat(257)]).toBeUndefined();
      expect(Object.hasOwn(emitted, "__proto__")).toBe(true);
      expect(emitted["__proto__"]).toBe("ordinary own attribute");
      expect(emitted.parent).toBeUndefined();
      expect(emitted.hidden).toBeUndefined();
    },
  );

  it.each(["start", "complete", "fail", "cancel"] as const)(
    "reserves %s operation fields without reading caller attempts to replace them", (phase) => {
      const spoof = vi.fn(() => "spoofed");
      const attributes: PulseAttributes = {};
      const reserved = phase === "start" ? ["tracking_id"] : ["tracking_id", "duration_ms"];
      if (phase === "fail") reserved.push("error");
      for (const key of reserved) Object.defineProperty(attributes, key, { enumerable: true, get: spoof });
      const operation = newOperation("bounded-operation", phase === "start" ? attributes : undefined);
      if (phase === "complete") operation.complete(attributes);
      if (phase === "fail") operation.fail("actual failure", attributes);
      if (phase === "cancel") operation.cancel(attributes);

      expect(spoof).not.toHaveBeenCalled();
      expect(logged.at(-1)?.attributes?.tracking_id).toBe(operation.trackingId);
      if (phase !== "start") expect(logged.at(-1)?.attributes?.duration_ms).not.toBe("spoofed");
      if (phase === "fail") expect(logged.at(-1)?.attributes?.error).toBe("actual failure");
    },
  );

});
