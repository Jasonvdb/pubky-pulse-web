import { validateConfiguration, type ValidatedConfig } from "./configuration";
import { collectDeviceInfo, type DeviceInfo } from "./device-info";
import { extractErrorAttributes } from "./error-extraction";
import { buildEvent, randomUuid, type EventContext } from "./event-builder";
import { OfflineQueue } from "./offline-queue";
import { localStore, sessionStore } from "./storage";
import { Transport } from "./transport";
import type {
  PulseAttributes,
  PulseConfiguration,
  PulseLogLevel,
  PulseLogOptions,
} from "./types";

export type {
  LogEvent,
  PulseAttachment,
  PulseAttributes,
  PulseConfiguration,
  PulseLogLevel,
  PulseLogOptions,
} from "./types";

const ANONYMOUS_ID_KEY = "anonymous_id";
const ANONYMOUS_ID_PREFIX = "pulse_anon_";
const SESSION_ID_KEY = "session_id";

let config: ValidatedConfig | null = null;
let transport: Transport | null = null;
let offlineQueue: OfflineQueue | null = null;
let deviceInfo: DeviceInfo = {};
let sessionId: string | null = null;
let activeUserId: string | undefined;
let unconfiguredWarningShown = false;
let unloadHandler: (() => void) | null = null;
let visibilityHandler: (() => void) | null = null;

function debugLog(message: string, detail?: unknown): void {
  if (!config?.debug) return;
  if (detail === undefined) {
    console.error(`Pubky Pulse: ${message}`);
  } else {
    console.error(`Pubky Pulse: ${message}`, detail);
  }
}

/**
 * Console mirror of an event. Lifecycle chatter and metric starts are
 * suppressed so the host app's console stays readable.
 */
function printToConsole(
  level: PulseLogLevel,
  message: string,
  attributes?: Record<string, string>,
): void {
  if (!config?.consoleLogging) return;
  if (message.startsWith("sdk:")) return;
  if (message.startsWith("metric:") && message.endsWith(":start")) return;

  let line = `[pulse] ${level.toUpperCase().padEnd(5)} ${message}`;
  if (attributes && Object.keys(attributes).length > 0) {
    const pairs = Object.entries(attributes)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
    line += ` {${pairs}}`;
  }

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function loadAnonymousId(): string {
  const existing = localStore.get(ANONYMOUS_ID_KEY);
  if (existing) return existing;
  const created = `${ANONYMOUS_ID_PREFIX}${randomUuid()}`;
  localStore.set(ANONYMOUS_ID_KEY, created);
  return created;
}

/**
 * Minimal session handling for the core pipeline: reuse the id already in
 * `sessionStorage`, otherwise mint one. Idle expiry, `sdk:session_started` /
 * `sdk:session_ended` and activity tracking arrive with the session manager.
 */
function loadSessionId(): string {
  const existing = sessionStore.get(SESSION_ID_KEY);
  if (existing) return existing;
  const created = randomUuid();
  sessionStore.set(SESSION_ID_KEY, created);
  return created;
}

function eventContext(): EventContext | null {
  if (!config || !sessionId) return null;
  return { config, deviceInfo, sessionId, userId: activeUserId };
}

function log(
  level: PulseLogLevel,
  message: string,
  attributes?: PulseAttributes,
  options?: PulseLogOptions,
): void {
  const ctx = eventContext();
  if (!ctx || !transport) {
    if (!unconfiguredWarningShown) {
      unconfiguredWarningShown = true;
      console.debug("Pubky Pulse: log call before configure() was ignored.");
    }
    return;
  }

  try {
    const event = buildEvent(ctx, level, message, attributes, options?.screenName);
    printToConsole(level, event.message, event.custom_attributes);
    transport.enqueue(event);
  } catch (err) {
    debugLog("failed to record event", err);
  }
}

function installUnloadHandlers(): void {
  const win = (globalThis as { window?: Window }).window;
  const doc = (globalThis as { document?: Document }).document;
  if (!win) return;

  unloadHandler = () => {
    transport?.flushOnUnload();
  };
  win.addEventListener("pagehide", unloadHandler);

  if (doc) {
    visibilityHandler = () => {
      if (doc.visibilityState === "hidden") transport?.flushOnUnload();
    };
    doc.addEventListener("visibilitychange", visibilityHandler);
  }
}

function removeUnloadHandlers(): void {
  const win = (globalThis as { window?: Window }).window;
  const doc = (globalThis as { document?: Document }).document;
  if (win && unloadHandler) win.removeEventListener("pagehide", unloadHandler);
  if (doc && visibilityHandler) doc.removeEventListener("visibilitychange", visibilityHandler);
  unloadHandler = null;
  visibilityHandler = null;
}

export interface PulseApi {
  configure(configuration: PulseConfiguration): void;
  info(message: string, attributes?: PulseAttributes, options?: PulseLogOptions): void;
  debug(message: string, attributes?: PulseAttributes, options?: PulseLogOptions): void;
  warn(message: string, attributes?: PulseAttributes, options?: PulseLogOptions): void;
  error(message: string, attributes?: PulseAttributes, options?: PulseLogOptions): void;
  error(
    error: unknown,
    message?: string,
    attributes?: PulseAttributes,
    options?: PulseLogOptions,
  ): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  /** Session id for the current page, or undefined before `configure`. */
  readonly sessionId: string | undefined;
}

export const Pulse: PulseApi = {
  configure(configuration: PulseConfiguration): void {
    const validated = validateConfiguration(configuration);

    if (typeof (globalThis as { window?: unknown }).window === "undefined") {
      if (validated.debug) {
        console.error("Pubky Pulse: no window available (SSR); configure() did nothing.");
      }
      return;
    }

    if (transport) {
      // Re-configuring replaces the pipeline; drain the old one first.
      void transport.shutdown();
      removeUnloadHandlers();
    }

    config = validated;
    deviceInfo = collectDeviceInfo(validated.supportedLanguages);
    sessionId = loadSessionId();
    activeUserId = loadAnonymousId();
    offlineQueue = new OfflineQueue(localStore, (message) => {
      debugLog(message);
    });
    transport = new Transport(validated, offlineQueue, debugLog);
    unconfiguredWarningShown = false;

    installUnloadHandlers();
    // Extension points for later phases: session lifecycle events, page-view
    // tracking, unhandled-error capture and fetch instrumentation hook in here.
  },

  info(message: string, attributes?: PulseAttributes, options?: PulseLogOptions): void {
    log("info", message, attributes, options);
  },

  debug(message: string, attributes?: PulseAttributes, options?: PulseLogOptions): void {
    log("debug", message, attributes, options);
  },

  warn(message: string, attributes?: PulseAttributes, options?: PulseLogOptions): void {
    log("warn", message, attributes, options);
  },

  error(first: unknown, second?: unknown, third?: unknown, fourth?: unknown): void {
    if (typeof first === "string") {
      log("error", first, second as PulseAttributes | undefined, third as PulseLogOptions | undefined);
      return;
    }

    const userMessage = typeof second === "string" ? second : undefined;
    const { message, attributes } = extractErrorAttributes(first, userMessage);
    // SDK-reserved keys win over caller keys so fingerprinting stays stable.
    const merged: PulseAttributes = { ...(third as PulseAttributes | undefined), ...attributes };
    log("error", message, merged, fourth as PulseLogOptions | undefined);
  },

  async flush(): Promise<void> {
    await transport?.flush();
  },

  async shutdown(): Promise<void> {
    removeUnloadHandlers();
    await transport?.shutdown();
    transport = null;
    offlineQueue = null;
    config = null;
    sessionId = null;
    activeUserId = undefined;
    deviceInfo = {};
  },

  get sessionId(): string | undefined {
    return sessionId ?? undefined;
  },
};

export default Pulse;
