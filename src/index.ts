import { AttachmentUploader } from "./attachment-uploader";
import { validateConfiguration, type ValidatedConfig } from "./configuration";
import { collectDeviceInfo, type DeviceInfo } from "./device-info";
import { extractErrorAttributes } from "./error-extraction";
import { buildEvent, MAX_EVENT_MESSAGE_LENGTH, normalizeAttributes, type EventContext } from "./event-builder";
import { IdentityManager } from "./identity";
import { installLifecycle } from "./lifecycle";
import { metricMessage, stepMessage } from "./metrics";
import { installNetworkTracking } from "./network-tracking";
import { OfflineQueue } from "./offline-queue";
import { PulseOperation } from "./operation";
import { PageTracker, type ScreenCallbacks } from "./page-tracking";
import {
  dismissQuestionnaires as dismissQuestionnairesRequest,
  fetchQuestionnaire as fetchQuestionnaireRequest,
  PulseQuestionnaireError,
  saveQuestionnaireResponse as saveQuestionnaireResponseRequest,
  type PulseQuestionnaireAnswers,
  type PulseQuestionnaireFetchResult,
  type PulseQuestionnaireReceipt,
  type QuestionnaireContext,
} from "./questionnaires";
import { SessionManager } from "./session";
import { localStore } from "./storage";
import { Transport } from "./transport";
import { installUnhandledCapture, type UnhandledKind } from "./unhandled-capture";
import {
  ENVIRONMENT,
  MAX_FEEDBACK_MESSAGE_LENGTH,
  SDK_NAME,
  SDK_VERSION,
  type FeedbackSubmission,
  type LogEvent,
  type PulseAttributes,
  type PulseConfiguration,
  type PulseFeedbackOptions,
  type PulseFeedbackReceipt,
  type PulseLogLevel,
  type PulseLogOptions,
} from "./types";

export { DEFAULT_ENDPOINT } from "./configuration";
export { PulseOperation } from "./operation";
export {
  collected,
  createAnswerStore,
  firstUnansweredIndex,
  hasAllRequired,
  isAnswered,
  setAnswer,
} from "./questionnaire-answers";
export type { PulseQuestionnaireAnswerStore } from "./questionnaire-answers";
export { PulseQuestionnaireError } from "./questionnaires";
export type {
  PulseQuestionnaire,
  PulseQuestionnaireAnswers,
  PulseQuestionnaireAnswerValue,
  PulseQuestionnaireDraft,
  PulseQuestionnaireErrorReason,
  PulseQuestionnaireFetchResult,
  PulseQuestionnaireIneligibleReason,
  PulseQuestionnaireMultiChoiceQuestion,
  PulseQuestionnaireNpsQuestion,
  PulseQuestionnaireOption,
  PulseQuestionnaireQuestion,
  PulseQuestionnaireQuestionType,
  PulseQuestionnaireRatingQuestion,
  PulseQuestionnaireReceipt,
  PulseQuestionnaireSchema,
  PulseQuestionnaireSingleChoiceQuestion,
  PulseQuestionnaireTextQuestion,
} from "./questionnaires";
export type {
  LogEvent,
  PulseAttachment,
  PulseAttributes,
  PulseConfiguration,
  PulseFeedbackOptions,
  PulseFeedbackReceipt,
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
let attachments: AttachmentUploader | null = null;
let processingEvent = false;
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

/** A hook owns its result; keep a detached, valid wire snapshot for delivery. */
function processEvent(event: LogEvent): LogEvent | null {
  if (!config?.beforeSend) return event;
  if (processingEvent) return null;
  processingEvent = true;
  try {
    // The builder shares this array with device metadata, not with the hook.
    if (event.supported_languages) event.supported_languages = [...event.supported_languages];
    const result = config.beforeSend(event);
    if (!result || typeof result !== "object" || Array.isArray(result)) return null;
    if ("then" in result) {
      // Accidental async callbacks must not create recursive rejection events.
      void Promise.resolve(result).catch(() => undefined);
      return null;
    }
    for (const key of ["client_event_id", "session_id", "message", "sdk_name", "sdk_version", "timestamp"] as const) {
      if (typeof result[key] !== "string") return null;
    }
    if (!["info", "debug", "warn", "error"].includes(result.level) ||
        result.environment !== ENVIRONMENT || typeof result.is_dev !== "boolean") return null;

    const snapshot: LogEvent = {
      client_event_id: result.client_event_id,
      session_id: result.session_id,
      message: result.message.slice(0, MAX_EVENT_MESSAGE_LENGTH),
      level: result.level,
      environment: result.environment,
      sdk_name: result.sdk_name,
      sdk_version: result.sdk_version,
      is_dev: result.is_dev,
      timestamp: result.timestamp,
    };
    for (const key of ["user_id", "source_module", "screen_name", "os_version", "app_version", "device_model", "locale", "preferred_language"] as const) {
      const value = result[key];
      if (value === undefined) continue;
      if (typeof value !== "string") return null;
      snapshot[key] = value;
    }
    if (result.custom_attributes !== undefined) {
      const attributes = result.custom_attributes;
      if (!attributes || typeof attributes !== "object" || Array.isArray(attributes) ||
          Object.values(attributes).some((value) => typeof value !== "string")) return null;
      snapshot.custom_attributes = normalizeAttributes(attributes);
    }
    if (result.supported_languages !== undefined) {
      if (!Array.isArray(result.supported_languages) ||
          result.supported_languages.some((value) => typeof value !== "string")) return null;
      snapshot.supported_languages = [...result.supported_languages];
    }
    return snapshot;
  } catch {
    // Neither the original event nor the hook's error may escape to output.
    return null;
  } finally {
    processingEvent = false;
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
    const event = processEvent(buildEvent(ctx, level, message, attributes, options?.screenName));
    if (!event) return;
    printToConsole(event.level, event.message, event.custom_attributes);
    transport.enqueue(event);
    if (options?.attachments?.length) {
      attachments?.enqueue(event.client_event_id, event.user_id, options.attachments);
    }
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
  if (processingEvent) return;
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
  pageTracker = new PageTracker(screenCallbacks, validated.screenNameForPath);
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

/**
 * Snapshot of the configured state each questionnaire request needs. Throws
 * rather than failing quietly: these calls are awaited by the caller's UI.
 */
function questionnaireContext(): QuestionnaireContext {
  if (!config) {
    throw new PulseQuestionnaireError(
      "not_configured",
      "questionnaire calls require configure() first",
    );
  }
  const ctx: QuestionnaireContext = {
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    bundleId: config.bundleId,
    isDev: config.isDev,
  };
  if (identity?.currentId) ctx.userId = identity.currentId;
  if (session?.id) ctx.sessionId = session.id;
  if (config.appVersion) ctx.appVersion = config.appVersion;
  return ctx;
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
  /**
   * Submit user feedback. A single attempt: the caller is waiting on it, so a
   * failure throws instead of being retried in the background.
   */
  sendFeedback(message: string, options?: PulseFeedbackOptions): Promise<PulseFeedbackReceipt>;
  /**
   * Fetch a questionnaire and the current user's eligibility for it. An
   * ineligible questionnaire comes back as `ineligibleReason`, not an error;
   * an unknown slug or a failed request throws `PulseQuestionnaireError`.
   */
  fetchQuestionnaire(
    slug: string,
    options?: { force?: boolean },
  ): Promise<PulseQuestionnaireFetchResult>;
  /**
   * Save answers as a draft (`isComplete: false`) or submit them. Always pass
   * the full accumulated answer set — `collected()` produces it.
   */
  saveQuestionnaireResponse(
    slug: string,
    answers: PulseQuestionnaireAnswers,
    isComplete: boolean,
  ): Promise<PulseQuestionnaireReceipt>;
  /** Opt the current user out of every questionnaire. */
  dismissQuestionnaires(): Promise<Date>;
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
    attachments = new AttachmentUploader(validated, debugLog);
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
    await attachments?.flush();
  },

  async shutdown(): Promise<void> {
    uninstallObservers();
    await transport?.shutdown();
    await attachments?.flush();
    attachments = null;
    transport = null;
    offlineQueue = null;
    config = null;
    session = null;
    identity = null;
    deviceInfo = {};
  },

  async sendFeedback(
    message: string,
    options?: PulseFeedbackOptions,
  ): Promise<PulseFeedbackReceipt> {
    if (!config || !transport) {
      throw new Error("Pubky Pulse: sendFeedback called before configure()");
    }

    const trimmed = typeof message === "string" ? message.trim() : "";
    if (!trimmed) {
      throw new Error("Pubky Pulse: feedback message is required");
    }
    if (trimmed.length > MAX_FEEDBACK_MESSAGE_LENGTH) {
      throw new Error(
        `Pubky Pulse: feedback message must be at most ${MAX_FEEDBACK_MESSAGE_LENGTH} characters`,
      );
    }

    const name = options?.name?.trim() || undefined;
    const email = options?.email?.trim() || undefined;

    const body: FeedbackSubmission = {
      bundle_id: config.bundleId,
      message: trimmed,
      sdk_name: SDK_NAME,
      sdk_version: SDK_VERSION,
      environment: ENVIRONMENT,
      is_dev: config.isDev,
    };
    if (session?.id) body.session_id = session.id;
    if (identity?.currentId) body.user_id = identity.currentId;
    if (name) body.submitter_name = name;
    if (email) body.submitter_email = email;
    if (config.appVersion) body.app_version = config.appVersion;
    if (deviceInfo.deviceModel) body.device_model = deviceInfo.deviceModel;
    if (deviceInfo.osVersion) body.os_version = deviceInfo.osVersion;

    const receipt = await transport.submitFeedback(body);

    // The audit event is best effort: the receipt is what the caller waited for.
    log("info", "sdk:feedback_submitted", {
      has_email: email ? "true" : "false",
      has_name: name ? "true" : "false",
    });

    return receipt;
  },

  async fetchQuestionnaire(
    slug: string,
    options?: { force?: boolean },
  ): Promise<PulseQuestionnaireFetchResult> {
    return fetchQuestionnaireRequest(questionnaireContext(), slug, options);
  },

  async saveQuestionnaireResponse(
    slug: string,
    answers: PulseQuestionnaireAnswers,
    isComplete: boolean,
  ): Promise<PulseQuestionnaireReceipt> {
    return saveQuestionnaireResponseRequest(questionnaireContext(), slug, answers, isComplete);
  },

  async dismissQuestionnaires(): Promise<Date> {
    return dismissQuestionnairesRequest(questionnaireContext());
  },

  get sessionId(): string | undefined {
    return session?.id ?? undefined;
  },

  get currentUserId(): string | undefined {
    return identity?.currentId;
  },
};

export default Pulse;
