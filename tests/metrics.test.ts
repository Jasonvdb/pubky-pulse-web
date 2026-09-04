import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metricMessage, normalizeSlug, resetSlugWarning, stepMessage } from "../src/metrics";

describe("metric messages", () => {
  beforeEach(() => {
    resetSlugWarning();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formats each metric phase", () => {
    expect(metricMessage("photo-upload", "start")).toBe("metric:photo-upload:start");
    expect(metricMessage("photo-upload", "complete")).toBe("metric:photo-upload:complete");
    expect(metricMessage("photo-upload", "fail")).toBe("metric:photo-upload:fail");
    expect(metricMessage("photo-upload", "cancel")).toBe("metric:photo-upload:cancel");
    expect(metricMessage("photo-upload", "record")).toBe("metric:photo-upload:record");
  });

  it("formats funnel steps and keeps the name verbatim", () => {
    expect(stepMessage("Checkout Started")).toBe("step:Checkout Started");
  });

  it("leaves an already valid slug alone and stays silent", () => {
    expect(normalizeSlug("photo-upload-2")).toBe("photo-upload-2");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("normalises case, invalid characters, runs and edges", () => {
    expect(normalizeSlug("Photo Upload")).toBe("photo-upload");
    expect(normalizeSlug("photo__upload")).toBe("photo-upload");
    expect(normalizeSlug("Checkout / Pay!!")).toBe("checkout-pay");
    expect(normalizeSlug("--api.request--")).toBe("api-request");
    expect(normalizeSlug("Ünïcode")).toBe("n-code");
  });

  it("normalises a slug of only invalid characters to an empty string", () => {
    // Matches the Swift and Node SDKs rather than inventing a name here.
    expect(normalizeSlug("!!!")).toBe("");
  });

  it("warns only once however many slugs need correcting", () => {
    normalizeSlug("First Slug");
    normalizeSlug("Second Slug");

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain('"First Slug"');
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain('"first-slug"');
  });
});
