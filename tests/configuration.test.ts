import { beforeEach, describe, expect, it } from "vitest";
import { defaultIsDev, validateConfiguration } from "../src/configuration";
import { resetTestEnvironment, testLocation } from "./setup";

const base = {
  endpoint: "https://pulse.example.com",
  apiKey: "pulse_client_abc",
  bundleId: "com.example.web",
};

describe("validateConfiguration", () => {
  beforeEach(() => {
    resetTestEnvironment();
  });

  it("rejects a missing endpoint", () => {
    expect(() => validateConfiguration({ ...base, endpoint: "" })).toThrow(
      "Pubky Pulse: endpoint is required",
    );
  });

  it("rejects an unparsable endpoint", () => {
    expect(() => validateConfiguration({ ...base, endpoint: "not a url" })).toThrow(
      /invalid endpoint URL/,
    );
  });

  it("strips every trailing slash from the endpoint", () => {
    expect(validateConfiguration({ ...base, endpoint: "https://pulse.example.com//" }).endpoint).toBe(
      "https://pulse.example.com",
    );
  });

  it("rejects a missing or wrongly prefixed api key", () => {
    expect(() => validateConfiguration({ ...base, apiKey: "" })).toThrow(
      "Pubky Pulse: apiKey is required",
    );
    expect(() => validateConfiguration({ ...base, apiKey: "pulse_server_abc" })).toThrow(
      /must start with "pulse_client_"/,
    );
  });

  it("rejects a missing bundle id", () => {
    expect(() => validateConfiguration({ ...base, bundleId: "" })).toThrow(
      "Pubky Pulse: bundleId is required",
    );
  });

  it("rejects non-positive numeric options", () => {
    expect(() => validateConfiguration({ ...base, flushIntervalMs: 0 })).toThrow(
      "Pubky Pulse: flushIntervalMs must be a positive number",
    );
    expect(() => validateConfiguration({ ...base, maxBufferSize: -1 })).toThrow(
      "Pubky Pulse: maxBufferSize must be a positive number",
    );
  });

  it("rejects a flush threshold larger than the buffer", () => {
    expect(() => validateConfiguration({ ...base, flushThreshold: 50, maxBufferSize: 10 })).toThrow(
      "Pubky Pulse: flushThreshold must not exceed maxBufferSize",
    );
  });

  it("rejects non string arrays", () => {
    expect(() =>
      validateConfiguration({ ...base, propagateSessionTo: [1] as unknown as string[] }),
    ).toThrow("Pubky Pulse: propagateSessionTo must be an array of strings");
  });

  it("applies the documented defaults", () => {
    const config = validateConfiguration(base);
    expect(config).toMatchObject({
      debug: false,
      consoleLogging: true,
      compressionEnabled: true,
      captureUnhandled: true,
      trackPageViews: true,
      networkTracking: false,
      propagateSessionTo: [],
      flushIntervalMs: 5000,
      flushThreshold: 20,
      maxBufferSize: 10000,
      sessionTimeoutMs: 1_800_000,
    });
    expect(config.supportedLanguages).toBeUndefined();
  });
});

describe("isDev default", () => {
  beforeEach(() => {
    resetTestEnvironment();
  });

  it("is false for a normal https origin", () => {
    expect(defaultIsDev()).toBe(false);
    expect(validateConfiguration(base).isDev).toBe(false);
  });

  it("is true on localhost and on the loopback address", () => {
    testLocation.hostname = "localhost";
    expect(defaultIsDev()).toBe(true);
    testLocation.hostname = "127.0.0.1";
    expect(defaultIsDev()).toBe(true);
  });

  it("is true for pages opened from disk", () => {
    testLocation.protocol = "file:";
    testLocation.hostname = "";
    expect(defaultIsDev()).toBe(true);
  });

  it("honours an explicit override", () => {
    testLocation.hostname = "localhost";
    expect(validateConfiguration({ ...base, isDev: false }).isDev).toBe(false);
  });
});
