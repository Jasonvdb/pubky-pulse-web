import type { ValidatedConfig } from "./configuration";
import type { DeviceInfo } from "./device-info";
import {
  ENVIRONMENT,
  SDK_NAME,
  SDK_VERSION,
  type LogEvent,
  type PulseAttributes,
  type PulseLogLevel,
} from "./types";

export const MAX_EVENT_MESSAGE_LENGTH = 2000;
export const MAX_ATTRIBUTE_VALUE_LENGTH = 200;
/** A stack trace is worthless once trimmed to 200 characters. */
export const MAX_ERROR_STACK_LENGTH = 16000;

/**
 * Per-key caps for trusted SDK-reserved attributes. Mirrors the server's
 * overrides so a stack trace survives the pre-transport trim.
 */
export const RESERVED_ATTRIBUTE_VALUE_LENGTH_OVERRIDES: Readonly<Record<string, number>> = {
  _error_stack: MAX_ERROR_STACK_LENGTH,
};

/** RFC 4122 v4 id, falling back to `getRandomValues` on older browsers. */
export function randomUuid(): string {
  const cryptoRef = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();

  const bytes = new Uint8Array(16);
  if (cryptoRef?.getRandomValues) {
    cryptoRef.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  // Set the version (4) and variant (10xx) bits.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex: string[] = [];
  for (const byte of bytes) hex.push(byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

/**
 * Coerce attribute values to strings and trim them to the server's limits.
 * `undefined` and `null` values are dropped rather than stringified.
 */
export function normalizeAttributes(
  attrs?: PulseAttributes,
): Record<string, string> | undefined {
  if (!attrs) return undefined;

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    const cap = RESERVED_ATTRIBUTE_VALUE_LENGTH_OVERRIDES[key] ?? MAX_ATTRIBUTE_VALUE_LENGTH;
    const str = typeof value === "string" ? value : String(value);
    result[key] = str.length > cap ? str.slice(0, cap) : str;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export interface EventContext {
  config: ValidatedConfig;
  deviceInfo: DeviceInfo;
  sessionId: string;
  userId?: string;
  /** Screen name stamped when the call site does not supply one. */
  screenName?: string;
}

/**
 * Build the wire representation of one event. Undefined fields are omitted so
 * the JSON body stays small and the server's optional-field checks pass.
 */
export function buildEvent(
  ctx: EventContext,
  level: PulseLogLevel,
  message: string,
  attributes?: PulseAttributes,
  screenNameOverride?: string,
): LogEvent {
  const trimmed =
    message.length > MAX_EVENT_MESSAGE_LENGTH
      ? message.slice(0, MAX_EVENT_MESSAGE_LENGTH)
      : message;
  const screenName = screenNameOverride ?? ctx.screenName;
  const custom = normalizeAttributes(attributes);
  const { config, deviceInfo } = ctx;

  const event: LogEvent = {
    client_event_id: randomUuid(),
    session_id: ctx.sessionId,
    level,
    message: trimmed,
    environment: ENVIRONMENT,
    sdk_name: SDK_NAME,
    sdk_version: SDK_VERSION,
    is_dev: config.isDev,
    timestamp: new Date().toISOString(),
  };

  if (ctx.userId) event.user_id = ctx.userId;
  if (screenName) event.screen_name = screenName;
  if (custom) event.custom_attributes = custom;
  if (deviceInfo.osVersion) event.os_version = deviceInfo.osVersion;
  if (config.appVersion) event.app_version = config.appVersion;
  if (deviceInfo.deviceModel) event.device_model = deviceInfo.deviceModel;
  if (deviceInfo.locale) event.locale = deviceInfo.locale;
  if (deviceInfo.preferredLanguage) event.preferred_language = deviceInfo.preferredLanguage;
  if (deviceInfo.supportedLanguages?.length) {
    event.supported_languages = deviceInfo.supportedLanguages;
  }

  return event;
}
