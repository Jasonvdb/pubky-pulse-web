declare const __SDK_VERSION__: string;

export const SDK_NAME = "pubky-pulse-web" as const;
export const SDK_VERSION: string =
  typeof __SDK_VERSION__ !== "undefined" ? __SDK_VERSION__ : "0.0.0";

/** Every event is tagged with the browser environment server-side. */
export const ENVIRONMENT = "web" as const;

export type PulseLogLevel = "info" | "debug" | "warn" | "error";

/**
 * Caller-supplied attributes. Values are coerced to strings before they are
 * sent; `undefined` and `null` values are dropped.
 */
export type PulseAttributes = Record<string, unknown>;

/** File attached to a single event. Uploaded out of band. */
export interface PulseAttachment {
  data: Blob | Uint8Array;
  filename?: string;
  contentType?: string;
}

export interface PulseLogOptions {
  /** Override the screen name stamped on this event. */
  screenName?: string;
  /** Files to upload alongside this event. */
  attachments?: PulseAttachment[];
}

export interface PulseConfiguration {
  /**
   * Pubky Pulse server endpoint URL. A trailing slash is stripped. Optional:
   * omitting it uses Pubky's hosted ingest host,
   * `https://ingest.pubkypulse.com`. Self-hosters MUST set it — the fallback
   * is silent, so nothing warns when traffic goes to Pubky instead.
   */
  endpoint?: string;
  /** Client API key. Public and write-only; must start with `pulse_client_`. */
  apiKey: string;
  /** Optional legacy identifier. The client key alone identifies the Pulse app. */
  bundleId?: string;
  /** Application version reported with every event. */
  appVersion?: string;
  /**
   * Mark events as development traffic. Defaults to true when the page is
   * served from `localhost`, `127.0.0.1`, or a `file:` URL.
   */
  isDev?: boolean;
  /** Log SDK diagnostics to the console. Default: false. */
  debug?: boolean;
  /** Print logged events to the console. Default: true. */
  consoleLogging?: boolean;
  /** gzip request bodies when `CompressionStream` is available. Default: true. */
  compressionEnabled?: boolean;
  /** Capture `error` / `unhandledrejection` events. Default: true. */
  captureUnhandled?: boolean;
  /** Emit screen events for History API navigations. Default: true. */
  trackPageViews?: boolean;
  /**
   * Map automatic page-view pathnames to stable screen names. Defaults to the
   * raw pathname. Called synchronously on initial load and navigation; manual
   * screen names are unchanged. A thrown error or a blank/non-string result
   * ends the previous screen and clears default attribution until a valid
   * screen is entered, without falling back to the raw pathname.
   */
  screenNameForPath?: (pathname: string) => string;
  /**
   * Transform a fully enriched event before console output, buffering, or
   * attachment scheduling. Return the event (with valid required fields) or
   * null to drop it. Synchronous only: throws and invalid results drop silently.
   * Message and attribute strings are complete; length limits apply afterward.
   * Does not process previously queued events or attachment contents.
   */
  beforeSend?: (event: LogEvent) => LogEvent | null;
  /** Emit `sdk:network_request` events for `fetch` calls. Default: false. */
  networkTracking?: boolean;
  /**
   * URL prefixes that receive the `X-Pulse-Session-Id` header. Matching works
   * even when `networkTracking` is false.
   */
  propagateSessionTo?: string[];
  /** Milliseconds between automatic flushes. Default: 5000. */
  flushIntervalMs?: number;
  /** Buffered events that trigger an immediate flush. Default: 20. */
  flushThreshold?: number;
  /** Buffered events kept before the oldest are dropped. Default: 10000. */
  maxBufferSize?: number;
  /** Idle time after which a new session starts. Default: 30 minutes. */
  sessionTimeoutMs?: number;
  /**
   * The locales your app ships. Written through to the app record on the
   * server and used for localization-gap analysis. Default: not sent — set it
   * explicitly if you want it reported.
   */
  supportedLanguages?: string[];
}

export interface LogEvent {
  client_event_id: string;
  session_id: string;
  user_id?: string;
  level: PulseLogLevel;
  source_module?: string;
  message: string;
  screen_name?: string;
  custom_attributes?: Record<string, string>;
  environment: typeof ENVIRONMENT;
  os_version?: string;
  app_version?: string;
  sdk_name: string;
  sdk_version: string;
  device_model?: string;
  locale?: string;
  preferred_language?: string;
  supported_languages?: string[];
  is_dev: boolean;
  timestamp: string;
}

export interface IngestRequest {
  bundle_id?: string;
  events: LogEvent[];
}

/** Server-side cap on a feedback message, enforced client-side too. */
export const MAX_FEEDBACK_MESSAGE_LENGTH = 4000;

/** Optional contact details attached to a feedback submission. */
export interface PulseFeedbackOptions {
  name?: string;
  email?: string;
}

/** Body accepted by `POST /v1/feedback`. */
export interface FeedbackSubmission {
  bundle_id?: string;
  message: string;
  session_id?: string;
  user_id?: string;
  submitter_name?: string;
  submitter_email?: string;
  app_version?: string;
  sdk_name: string;
  sdk_version: string;
  environment: typeof ENVIRONMENT;
  device_model?: string;
  os_version?: string;
  is_dev: boolean;
}

/** What the caller gets back from `Pulse.sendFeedback`. */
export interface PulseFeedbackReceipt {
  id: string;
  createdAt: Date;
}
