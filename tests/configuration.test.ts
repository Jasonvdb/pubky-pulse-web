import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ENDPOINT, defaultIsDev, validateConfiguration } from "../src/configuration";
import { resetTestEnvironment, testLocation } from "./setup";

const base = {
  endpoint: "https://pulse.example.com",
  apiKey: "pulse_client_abc",
  bundleId: "com.example.web",
};

// The fallback tests need a config with no `endpoint` key at all, not a base
// whose endpoint every other test relies on.
const { endpoint: _configuredEndpoint, ...baseWithoutEndpoint } = base;

describe("validateConfiguration", () => {
  beforeEach(() => {
    resetTestEnvironment();
  });

  // An explicitly supplied empty value is almost always an environment
  // variable that failed to load; falling back to the hosted host there would
  // quietly send a self-hoster's data to Pubky.
  it("rejects an explicitly empty endpoint", () => {
    expect(() => validateConfiguration({ ...base, endpoint: "" })).toThrow(
      "Pubky Pulse: endpoint is required",
    );
    expect(() => validateConfiguration({ ...base, endpoint: null as unknown as string })).toThrow(
      "Pubky Pulse: endpoint is required",
    );
    expect(() => validateConfiguration({ ...base, endpoint: 1 as unknown as string })).toThrow(
      "Pubky Pulse: endpoint is required",
    );
    // Whitespace only is non-empty, so it reaches the URL parse as before.
    expect(() => validateConfiguration({ ...base, endpoint: "   " })).toThrow(
      /invalid endpoint URL/,
    );
  });

  it("falls back to the hosted ingest host when endpoint is omitted", () => {
    expect(validateConfiguration(baseWithoutEndpoint).endpoint).toBe(
      "https://ingest.pubkypulse.com",
    );
  });

  it("falls back to the hosted ingest host for an explicit undefined endpoint", () => {
    expect(validateConfiguration({ ...base, endpoint: undefined }).endpoint).toBe(
      "https://ingest.pubkypulse.com",
    );
  });

  it("prefers a supplied endpoint over the hosted default", () => {
    expect(validateConfiguration(base).endpoint).toBe("https://pulse.example.com");
  });

  it("exposes the hosted ingest host as DEFAULT_ENDPOINT", () => {
    expect(DEFAULT_ENDPOINT).toBe("https://ingest.pubkypulse.com");
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

  it("requires only the client key and does not invent a bundle id", () => {
    const config = validateConfiguration({ apiKey: base.apiKey });
    expect(config.endpoint).toBe(DEFAULT_ENDPOINT);
    expect(config.bundleId).toBeUndefined();
  });

  it("accepts an explicitly undefined bundle id", () => {
    expect(validateConfiguration({ ...base, bundleId: undefined }).bundleId).toBeUndefined();
  });

  it("preserves a supplied legacy bundle id", () => {
    expect(validateConfiguration(base).bundleId).toBe(base.bundleId);
  });

  it.each(["", null, 42])("rejects an invalid supplied bundle id: %s", (bundleId) => {
    expect(() =>
      validateConfiguration({ ...base, bundleId: bundleId as unknown as string }),
    ).toThrow("Pubky Pulse: bundleId must be a non-empty string when supplied");
  });

  it("rejects non-positive numeric options", () => {
    expect(() => validateConfiguration({ ...base, flushIntervalMs: 0 })).toThrow(
      "Pubky Pulse: flushIntervalMs must be a positive number",
    );
    expect(() => validateConfiguration({ ...base, maxBufferSize: -1 })).toThrow(
      "Pubky Pulse: maxBufferSize must be a positive number",
    );
    // Floors to 0, which would turn the flush interval into a hot loop and
    // make every event trip the threshold.
    expect(() => validateConfiguration({ ...base, flushIntervalMs: 0.5 })).toThrow(
      "Pubky Pulse: flushIntervalMs must be a positive number",
    );
    expect(() => validateConfiguration({ ...base, flushThreshold: 0.9 })).toThrow(
      "Pubky Pulse: flushThreshold must be a positive number",
    );
  });

  it("floors a fractional value that still lands on a positive integer", () => {
    expect(validateConfiguration({ ...base, flushIntervalMs: 5000.5 }).flushIntervalMs).toBe(5000);
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

  it("preserves a screen mapper without calling it during validation", () => {
    const screenNameForPath = () => {
      throw new Error("must only run during automatic tracking");
    };
    expect(validateConfiguration({ ...base, screenNameForPath }).screenNameForPath).toBe(
      screenNameForPath,
    );
  });

  it.each([null, false, 42, "profile", {}, []])("rejects a non-function screen mapper: %j", (value) => {
    expect(() =>
      validateConfiguration({
        ...base,
        screenNameForPath: value as unknown as (pathname: string) => string,
      }),
    ).toThrow("Pubky Pulse: screenNameForPath must be a function");
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
    expect(config.screenNameForPath).toBeUndefined();
    expect(config.beforeSend).toBeUndefined();
  });

  it("preserves beforeSend without invoking it during validation", () => {
    const beforeSend = () => { throw new Error("capture only"); };
    expect(validateConfiguration({ ...base, beforeSend }).beforeSend).toBe(beforeSend);
  });

  it.each([null, false, 42, "filter", {}, []])("rejects a non-function beforeSend: %j", (value) => {
    expect(() => validateConfiguration({ ...base, beforeSend: value as never })).toThrow(
      "Pubky Pulse: beforeSend must be a function",
    );
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
