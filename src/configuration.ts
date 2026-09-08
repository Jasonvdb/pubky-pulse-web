import type { PulseConfiguration } from "./types";

const CLIENT_KEY_PREFIX = "pulse_client_";
const DEV_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

/**
 * Pubky's own hosted ingest host, used when the caller omits `endpoint`.
 * The fallback is silent — nothing is logged when it is taken — so a
 * self-hoster must pass their own ingest host explicitly.
 */
export const DEFAULT_ENDPOINT = "https://ingest.pubkypulse.com";

export interface ValidatedConfig {
  endpoint: string;
  apiKey: string;
  bundleId?: string;
  appVersion?: string;
  isDev: boolean;
  debug: boolean;
  consoleLogging: boolean;
  compressionEnabled: boolean;
  captureUnhandled: boolean;
  trackPageViews: boolean;
  screenNameForPath?: (pathname: string) => string;
  beforeSend?: PulseConfiguration["beforeSend"];
  networkTracking: boolean;
  propagateSessionTo: string[];
  flushIntervalMs: number;
  flushThreshold: number;
  maxBufferSize: number;
  sessionTimeoutMs: number;
  supportedLanguages?: string[];
}

/**
 * True when the page looks like a local development build: served from
 * localhost / 127.0.0.1, or opened straight off disk. Used as the `isDev`
 * default so events from a dev machine never pollute production dashboards.
 */
export function defaultIsDev(): boolean {
  const loc = (globalThis as { location?: Location }).location;
  if (!loc) return true;
  if (loc.protocol === "file:") return true;
  return DEV_HOSTNAMES.has(loc.hostname);
}

function positiveInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  // Floor first: a fractional value like 5000.5 is accepted, but one that
  // floors below 1 (0.5, say) is not — it would silently become 0.
  if (typeof value !== "number" || !Number.isFinite(value) || Math.floor(value) < 1) {
    throw new Error(`Pubky Pulse: ${name} must be a positive number`);
  }
  return Math.floor(value);
}

function stringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Pubky Pulse: ${name} must be an array of strings`);
  }
  return value as string[];
}

export function validateConfiguration(config: PulseConfiguration): ValidatedConfig {
  if (!config || typeof config !== "object") {
    throw new Error("Pubky Pulse: configuration object is required");
  }

  // Only an absent `endpoint` falls back to the hosted default. Any other
  // unusable value still throws: an explicitly supplied empty one is almost
  // always an environment variable that failed to load, and silently
  // redirecting that traffic to Pubky's hosted instance would send a
  // self-hoster's data to the wrong company with nothing to tell them.
  const supplied = config.endpoint === undefined ? DEFAULT_ENDPOINT : config.endpoint;
  if (!supplied || typeof supplied !== "string") {
    throw new Error("Pubky Pulse: endpoint is required");
  }

  let endpoint = supplied.trim();
  while (endpoint.endsWith("/")) {
    endpoint = endpoint.slice(0, -1);
  }

  try {
    new URL(endpoint);
  } catch {
    throw new Error(`Pubky Pulse: invalid endpoint URL: ${endpoint}`);
  }

  if (!config.apiKey || typeof config.apiKey !== "string") {
    throw new Error("Pubky Pulse: apiKey is required");
  }

  if (!config.apiKey.startsWith(CLIENT_KEY_PREFIX)) {
    throw new Error(`Pubky Pulse: apiKey must start with "${CLIENT_KEY_PREFIX}"`);
  }

  if (config.bundleId !== undefined && (!config.bundleId || typeof config.bundleId !== "string")) {
    throw new Error("Pubky Pulse: bundleId must be a non-empty string when supplied");
  }

  if (config.screenNameForPath !== undefined && typeof config.screenNameForPath !== "function") {
    throw new Error("Pubky Pulse: screenNameForPath must be a function");
  }
  if (config.beforeSend !== undefined && typeof config.beforeSend !== "function") {
    throw new Error("Pubky Pulse: beforeSend must be a function");
  }

  const flushThreshold = positiveInteger(config.flushThreshold, "flushThreshold", 20);
  const maxBufferSize = positiveInteger(config.maxBufferSize, "maxBufferSize", 10000);
  if (flushThreshold > maxBufferSize) {
    throw new Error("Pubky Pulse: flushThreshold must not exceed maxBufferSize");
  }

  return {
    endpoint,
    apiKey: config.apiKey,
    bundleId: config.bundleId,
    appVersion: config.appVersion,
    isDev: config.isDev ?? defaultIsDev(),
    debug: config.debug ?? false,
    consoleLogging: config.consoleLogging ?? true,
    compressionEnabled: config.compressionEnabled ?? true,
    captureUnhandled: config.captureUnhandled ?? true,
    trackPageViews: config.trackPageViews ?? true,
    screenNameForPath: config.screenNameForPath,
    beforeSend: config.beforeSend,
    networkTracking: config.networkTracking ?? false,
    propagateSessionTo: stringArray(config.propagateSessionTo, "propagateSessionTo") ?? [],
    flushIntervalMs: positiveInteger(config.flushIntervalMs, "flushIntervalMs", 5000),
    flushThreshold,
    maxBufferSize,
    sessionTimeoutMs: positiveInteger(config.sessionTimeoutMs, "sessionTimeoutMs", 1_800_000),
    supportedLanguages: stringArray(config.supportedLanguages, "supportedLanguages"),
  };
}
