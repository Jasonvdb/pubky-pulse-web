import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateConfiguration } from "../src/configuration";
import { collectDeviceInfo } from "../src/device-info";
import {
  buildEvent,
  MAX_ATTRIBUTE_VALUE_LENGTH,
  MAX_EVENT_MESSAGE_LENGTH,
  normalizeAttributes,
  randomUuid,
  type EventContext,
} from "../src/event-builder";
import { SDK_NAME } from "../src/types";
import { resetTestEnvironment } from "./setup";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function context(overrides: Partial<EventContext> = {}): EventContext {
  return {
    config: validateConfiguration({
      endpoint: "https://pulse.example.com",
      apiKey: "pulse_client_abc",
      bundleId: "com.example.web",
      appVersion: "1.4.0",
      isDev: false,
    }),
    deviceInfo: collectDeviceInfo(),
    sessionId: "11111111-1111-4111-8111-111111111111",
    userId: "pulse_anon_22222222-2222-4222-8222-222222222222",
    ...overrides,
  };
}

describe("randomUuid", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("produces a v4 uuid", () => {
    expect(randomUuid()).toMatch(UUID_PATTERN);
  });

  it("falls back to getRandomValues without crypto.randomUUID", () => {
    // An insecure context exposes `crypto` but not `randomUUID`.
    vi.stubGlobal("crypto", {
      getRandomValues: (buffer: Uint8Array) => {
        buffer.fill(0xff);
        return buffer;
      },
    });

    // All-ones bytes still have to carry the version and variant nibbles.
    expect(randomUuid()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  it("falls back to Math.random without any crypto object", () => {
    vi.stubGlobal("crypto", undefined);

    const first = randomUuid();
    const second = randomUuid();

    expect(first).toMatch(UUID_PATTERN);
    expect(second).toMatch(UUID_PATTERN);
    expect(first).not.toBe(second);
  });
});

describe("normalizeAttributes", () => {
  it("drops undefined and null values", () => {
    expect(normalizeAttributes({ a: "1", b: undefined, c: null })).toEqual({ a: "1" });
  });

  it("returns undefined when nothing survives", () => {
    expect(normalizeAttributes({ a: undefined })).toBeUndefined();
    expect(normalizeAttributes(undefined)).toBeUndefined();
  });

  it("stringifies non-string values", () => {
    expect(normalizeAttributes({ n: 42, b: true })).toEqual({ n: "42", b: "true" });
  });

  it("trims values to the server limit", () => {
    const long = "x".repeat(500);
    expect(normalizeAttributes({ long })?.long).toHaveLength(MAX_ATTRIBUTE_VALUE_LENGTH);
  });

  it("allows a longer stack trace", () => {
    const stack = "x".repeat(20000);
    expect(normalizeAttributes({ _error_stack: stack })?._error_stack).toHaveLength(16000);
  });

  it("caps a value stored under a key inherited from Object.prototype", () => {
    const result = normalizeAttributes({ toString: "x".repeat(1000) });
    expect(result?.["toString"]).toHaveLength(MAX_ATTRIBUTE_VALUE_LENGTH);
  });

  it("keeps an attribute named __proto__ as an ordinary own key", () => {
    const result = normalizeAttributes({ ["__proto__"]: "v" });
    expect(Object.hasOwn(result!, "__proto__")).toBe(true);
    expect(result?.["__proto__"]).toBe("v");
  });
});

describe("buildEvent", () => {
  beforeEach(() => {
    resetTestEnvironment();
  });

  it("stamps the identity, environment and sdk fields", () => {
    const ctx = context();
    const event = buildEvent(ctx, "info", "signed_up", { plan: "pro" });

    expect(event.client_event_id).toMatch(UUID_PATTERN);
    expect(event.session_id).toBe(ctx.sessionId);
    expect(event.user_id).toBe(ctx.userId);
    expect(event.level).toBe("info");
    expect(event.message).toBe("signed_up");
    expect(event.environment).toBe("web");
    expect(event.sdk_name).toBe(SDK_NAME);
    expect(event.sdk_version).toBeTruthy();
    expect(event.app_version).toBe("1.4.0");
    expect(event.is_dev).toBe(false);
    expect(event.custom_attributes).toEqual({ plan: "pro" });
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("stamps the device and locale fields collected from the browser", () => {
    const event = buildEvent(context(), "info", "hello");
    expect(event.os_version).toBe("macOS 10.15.7");
    expect(event.device_model).toBe("Chrome 120");
    expect(event.locale).toBe("en-GB");
    expect(event.preferred_language).toBe("en-GB");
    expect(event.supported_languages).toBeUndefined();
  });

  it("stamps the supported languages only when the app configures them", () => {
    const ctx = context({ deviceInfo: collectDeviceInfo(["fr", "de"]) });
    expect(buildEvent(ctx, "info", "hello").supported_languages).toEqual(["fr", "de"]);
  });

  it("omits fields that have no value instead of sending null", () => {
    const ctx = context({
      config: validateConfiguration({
        endpoint: "https://pulse.example.com",
        apiKey: "pulse_client_abc",
        bundleId: "com.example.web",
      }),
    });
    delete (ctx as { userId?: string }).userId;
    const event = buildEvent(ctx, "info", "hello");

    expect(Object.keys(event)).not.toContain("app_version");
    expect(Object.keys(event)).not.toContain("user_id");
    expect(Object.keys(event)).not.toContain("screen_name");
    expect(Object.keys(event)).not.toContain("custom_attributes");
  });

  it("trims an over-long message", () => {
    const event = buildEvent(context(), "warn", "y".repeat(MAX_EVENT_MESSAGE_LENGTH + 500));
    expect(event.message).toHaveLength(MAX_EVENT_MESSAGE_LENGTH);
  });

  it("prefers an explicit screen name over the context default", () => {
    const ctx = context({ screenName: "Home" });
    expect(buildEvent(ctx, "info", "tap").screen_name).toBe("Home");
    expect(buildEvent(ctx, "info", "tap", undefined, "Settings").screen_name).toBe("Settings");
  });
});
