import { validateConfiguration, type ValidatedConfig } from "./configuration";
import { collectDeviceInfo, type DeviceInfo } from "./device-info";
import { extractErrorAttributes } from "./error-extraction";
import { buildEvent, type EventContext } from "./event-builder";
import { IdentityManager } from "./identity";
import { installLifecycle } from "./lifecycle";
import { metricMessage, stepMessage } from "./metrics";
import { installNetworkTracking } from "./network-tracking";
import { OfflineQueue } from "./offline-queue";
import { PulseOperation } from "./operation";
import { PageTracker, type ScreenCallbacks } from "./page-tracking";
import { SessionManager } from "./session";
import { localStore } from "./storage";
import { Transport } from "./transport";
import { installUnhandledCapture, type UnhandledKind } from "./unhandled-capture";
import type {
  PulseAttributes,
  PulseConfiguration,
  PulseLogLevel,
  PulseLogOptions,
} from "./types";

export { PulseOperation } from "./operation";
export type {
  LogEvent,
  PulseAttachment,
  PulseAttributes,
  PulseConfiguration,
  PulseLogLevel,
  PulseLogOptions,
} from "./types";

let config: ValidatedConfig | null = null;
let transport: Transport | null = null;
let offlineQueue: OfflineQueue | null = null;
let deviceInfo: DeviceInfo = {};
let session: SessionManager | null = null;
let identity: IdentityManager | null = null;
let unconfiguredWarningShown = false;
let pageTracker: PageTracker | null = null;
/** Uninstallers for everything `configure()` hooked into the page. */
const uninstallers: Array<() => void> = [];

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

/**
 * Build and buffer one event. `sessionIdOverride` exists for `sdk:session_ended`,
 * which belongs to the session that just expired rather than the new one.
 */
function recordEvent(
  level: PulseLogLevel,
  message: string,
  attributes?: PulseAttributes,
  options?: PulseLogOptions,
  sessionIdOverride?: string,
): void {
  const sessionId = sessionIdOverride ?? session?.id;
  if (!config || !identity || !sessionId || !transport) return;

  const ctx: EventContext = {
    config,
    deviceInfo,
    sessionId,
    userId: identity.currentId,
    screenName: pageTracker?.screenName,
  };

  try {
    const event = buildEvent(ctx, level, message, attributes, options?.screenName);
    printToConsole(level, event.message, event.custom_attributes);
    transport.enqueue(event);
  } catch (err) {
    debugLog("failed to record event", err);
  }
}

function log(
  level: PulseLogLevel,
  message: string,
  attributes?: PulseAttributes,
  options?: PulseLogOptions,
): void {
  if (!config || !session || !transport) {
    if (!unconfiguredWarningShown) {
      unconfiguredWarningShown = true;
      console.debug("Pubky Pulse: log call before configure() was ignored.");
    }
    return;
  }

  // Every call counts as activity, and may roll the session over first.
  session.touch();
  recordEvent(level, message, attributes, options);
}

/** Emits the session lifecycle events as the session manager rolls over. */
const sessionCallbacks = {
  onStarted(startedId: string, launchMs?: number): void {
    const attributes = launchMs === undefined ? undefined : { _launch_ms: String(launchMs) };
    recordEvent("info", "sdk:session_started", attributes, undefined, startedId);
  },
  onEnded(endedId: string): void {
    recordEvent("info", "sdk:session_ended", undefined, undefined, endedId);
  },
};

/** Screen changes are lifecycle chatter: debug level, suppressed in console. */
const screenCallbacks: ScreenCallbacks = {
  onAppeared(screenName: string): void {
    log("debug", "sdk:screen_appeared", undefined, { screenName });
  },
  onDisappeared(screenName: string, durationMs: number): void {
    log("debug", "sdk:screen_disappeared", { _duration_ms: String(durationMs) }, { screenName });
  },
};

/** Errors nobody caught, tagged with the hook that saw them. */
function recordUnhandled(value: unknown, kind: UnhandledKind): void {
  const { message, attributes } = extractErrorAttributes(value);
  log("error", message, { ...attributes, _unhandled: kind });
}

function installObservers(validated: ValidatedConfig): void {
  uninstallers.push(
    installLifecycle({
      onHidden(): void {
        transport?.flushOnUnload();
      },
      onVisible(): void {
        // A long stint in the background may have expired the session.
        session?.touch();
      },
    }),
  );

  // The tracker owns the default screen name, so it exists even when
  // automatic page views are off; then only `trackScreen()` moves it.
  pageTracker = new PageTracker(screenCallbacks);
  if (validated.trackPageViews) pageTracker.install();

  if (validated.captureUnhandled) {
    uninstallers.push(installUnhandledCapture(recordUnhandled));
  }

  // Session propagation needs the same wrapper as request tracking.
  if (validated.networkTracking || validated.propagateSessionTo.length > 0) {
    uninstallers.push(
      installNetworkTracking({
        endpoint: validated.endpoint,
        propagateSessionTo: validated.propagateSessionTo,
        trackRequests: validated.networkTracking,
        sessionId: () => session?.id ?? undefined,
        onRequest(level, attributes): void {
          log(level, "sdk:network_request", attributes);
        },
      }),
    );
  }
}

function uninstallObservers(): void {
  for (const uninstall of uninstallers.splice(0)) {
    try {
      uninstall();
    } catch (err) {
      debugLog("failed to uninstall a page hook", err);
    }
  }
  pageTracker?.restore();
  pageTracker = null;
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
  /**
   * Report a screen the SDK cannot see itself (a modal, a wizard step, a tab).
   * The name also becomes the default `screen_name` for later events.
   */
  trackScreen(name: string): void;
  /** Record one funnel step as `step:<name>`. */
  step(name: string, attributes?: PulseAttributes): void;
  /**
   * Start a tracked operation: emits `metric:<slug>:start` now and one
   * terminal event when the returned handle is completed, failed or cancelled.
   */
  startOperation(metric: string, attributes?: PulseAttributes): PulseOperation;
  /** Record a single-shot metric as `metric:<slug>:record`. */
  recordMetric(metric: string, attributes?: PulseAttributes): void;
  /**
   * Identify the person using the app. Buffered anonymous events are sent and
   * claimed server-side before the id switches, so nothing is orphaned.
   */
  setUser(identifier: string): Promise<void>;
  /** Forget the identified user; `newAnonymousId` also resets the anon id. */
  clearUser(options?: { newAnonymousId?: boolean }): void;
  /** Merge properties onto the current user. An empty value deletes a key. */
  setUserProperties(properties: Record<string, string>): Promise<void>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  /** Session id for the current page, or undefined before `configure`. */
  readonly sessionId: string | undefined;
  /**
   * The id stamped on outgoing events: the identifier from `setUser` when one
   * is set, otherwise this browser's anonymous id. Undefined before `configure`.
   */
  readonly currentUserId: string | undefined;
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
      uninstallObservers();
    }

    config = validated;
    deviceInfo = collectDeviceInfo(validated.supportedLanguages);
    offlineQueue = new OfflineQueue(localStore, (message) => {
      debugLog(message);
    });
    transport = new Transport(validated, offlineQueue, debugLog);
    unconfiguredWarningShown = false;

    // Identity first: the session events below must carry the right user id.
    // Its background re-claim needs the transport, which now exists.
    identity = new IdentityManager({
      claim: async (anonymousId, userId) => {
        await transport?.claimIdentity(anonymousId, userId);
      },
      onDebug: debugLog,
    });
    identity.load();

    session = new SessionManager(validated.sessionTimeoutMs, sessionCallbacks);
    session.start();

    installObservers(validated);
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

  trackScreen(name: string): void {
    if (!pageTracker) {
      debugLog("trackScreen called before configure()");
      return;
    }
    pageTracker.trackScreen(name);
  },

  step(name: string, attributes?: PulseAttributes): void {
    log("info", stepMessage(name), attributes);
  },

  startOperation(metric: string, attributes?: PulseAttributes): PulseOperation {
    return new PulseOperation(
      (level, message, operationAttributes) => {
        log(level, message, operationAttributes);
      },
      metric,
      attributes,
    );
  },

  recordMetric(metric: string, attributes?: PulseAttributes): void {
    log("info", metricMessage(metric, "record"), attributes);
  },

  async setUser(identifier: string): Promise<void> {
    if (!identity) {
      debugLog("setUser called before configure()");
      return;
    }
    await identity.setUser(identifier);
  },

  clearUser(options?: { newAnonymousId?: boolean }): void {
    if (!identity) {
      debugLog("clearUser called before configure()");
      return;
    }
    identity.clearUser(options);
  },

  async setUserProperties(properties: Record<string, string>): Promise<void> {
    if (!identity || !transport) {
      debugLog("setUserProperties called before configure()");
      return;
    }
    // Buffered events land under the same id the properties attach to.
    await transport.flush();
    await transport.setUserProperties(identity.currentId, properties);
  },

  async flush(): Promise<void> {
    await transport?.flush();
  },

  async shutdown(): Promise<void> {
    uninstallObservers();
    await transport?.shutdown();
    transport = null;
    offlineQueue = null;
    config = null;
    session = null;
    identity = null;
    deviceInfo = {};
  },

  get sessionId(): string | undefined {
    return session?.id ?? undefined;
  },

  get currentUserId(): string | undefined {
    return identity?.currentId;
  },
};

export default Pulse;
