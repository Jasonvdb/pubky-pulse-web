import { nowMs } from "./clock";
import type { PulseEventHint, PulseLogLevel } from "./types";

/** Header the app's own backend reads to join its logs to this session. */
export const SESSION_HEADER = "X-Pulse-Session-Id";

export interface NetworkTrackingOptions {
  /** SDK endpoint; requests to it are never tracked or annotated. */
  endpoint: string;
  /** URL prefixes that receive the session header. */
  propagateSessionTo: string[];
  /** Emit `sdk:network_request` events. False when only propagation is wanted. */
  trackRequests: boolean;
  /** URL privacy policy. The default preserves sanitized paths. */
  urlMode?: "path" | "origin";
  /** Current session id, or undefined before the session starts. */
  sessionId(): string | undefined;
  /**
   * Called once per tracked request with the level and reserved attributes.
   * A failed request supplies a hint carrying the original rejection or throw
   * as `originalException`, whatever its value; a response supplies no hint.
   */
  onRequest(level: PulseLogLevel, attributes: Record<string, string>, hint?: PulseEventHint): void;
}

function isRequest(input: unknown): input is Request {
  return typeof Request !== "undefined" && input instanceof Request;
}

function requestUrl(input: RequestInfo | URL): string | undefined {
  if (typeof input === "string") return input;
  if (isRequest(input)) return input.url;
  if (input instanceof URL) return input.href;
  // Do not coerce arbitrary inputs a second time: fetch owns their semantics.
  return undefined;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const method = init?.method ?? (isRequest(input) ? input.method : undefined);
  return (method ?? "GET").toUpperCase();
}

/** Absolute form of a request URL, or undefined when it cannot be resolved. */
function absoluteUrl(url: string): string | undefined {
  const base = (globalThis as { location?: Location }).location?.href;
  try {
    return new URL(url, base).href;
  } catch {
    return undefined;
  }
}

/** Query and fragment are dropped: they carry ids, tokens and search terms. */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** A prefix may only end at the url's end or at a `/`, `?` or `#` boundary. */
function boundedPrefix(candidate: string, prefix: string): boolean {
  if (!candidate.startsWith(prefix)) return false;
  const next = candidate.charAt(prefix.length);
  return next === "" || next === "/" || next === "?" || next === "#";
}

/**
 * Both sides are absolutised first, so a relative prefix such as `/api` keeps
 * working and `https://api.example.com` cannot match the look-alike host
 * `https://api.example.com.attacker.tld`.
 */
function matchesPrefix(raw: string, absolute: string | undefined, prefixes: string[]): boolean {
  return prefixes.some((prefix) => {
    if (prefix === "") return false;
    const resolvedPrefix = absoluteUrl(prefix);
    if (absolute === undefined || resolvedPrefix === undefined) return raw.startsWith(prefix);
    // `new URL("https://a.example").href` gains a trailing slash; drop it so
    // the boundary check, not the slash, decides the match.
    return boundedPrefix(absolute, resolvedPrefix.replace(/\/$/, ""));
  });
}

/**
 * Userinfo is stripped alongside the query: `https://user:token@host/path`
 * would otherwise ship the embedded credentials to the ingest endpoint.
 */
function sanitizeUrl(raw: string, absolute: string | undefined, mode: "path" | "origin"): string | undefined {
  try {
    const parsed = new URL(absolute ?? raw);
    if (mode === "origin") {
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
    }
    parsed.username = "";
    parsed.password = "";
    return stripQuery(parsed.href);
  } catch {
    return mode === "origin" ? undefined : stripQuery(absolute ?? raw);
  }
}

/** Debug for a healthy response, warn for anything the server refused. */
function levelForStatus(status: number): PulseLogLevel {
  return status >= 200 && status < 400 ? "debug" : "warn";
}

/**
 * A request the app cancelled itself rejects with an `AbortError`, the default
 * reason `controller.abort()` supplies, so it is a breadcrumb rather than a
 * failure. Anything else — a `TypeError` from the network, a `TimeoutError`
 * from `AbortSignal.timeout()`, a custom abort reason — is indistinguishable
 * from a real problem and stays an error. `signal.aborted` alone is not
 * evidence: the request may have failed before anyone aborted it.
 */
function levelForRejection(error: unknown): PulseLogLevel {
  const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === "AbortError" ? "debug" : "error";
}

/**
 * Wrap `fetch` to time requests and, where asked, forward the session id. The
 * SDK's own traffic is passed straight through so a failing ingest call cannot
 * generate the events that would be ingested next.
 */
export function installNetworkTracking(options: NetworkTrackingOptions): () => void {
  const target = globalThis as { fetch?: typeof fetch };
  const original = target.fetch;
  if (typeof original !== "function") return () => undefined;

  let active = true;
  const wrapped = function (this: unknown, ...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
    const [input, init] = args;
    let nextArgs = args;
    let attributes: Record<string, string> | undefined;
    let startedAt = 0;

    // Instrumentation failures must not prevent the original request.
    try {
      const raw = requestUrl(input);
      const absolute = raw === undefined ? undefined : absoluteUrl(raw);
      const excluded = raw !== undefined && matchesPrefix(raw, absolute, [options.endpoint]);
      if (active && !excluded) {
        if (raw !== undefined && matchesPrefix(raw, absolute, options.propagateSessionTo)) {
          const sessionId = options.sessionId();
          if (sessionId) {
            const headers = new Headers(init?.headers ?? (isRequest(input) ? input.headers : undefined));
            headers.set(SESSION_HEADER, sessionId);
            nextArgs = [...args];
            nextArgs[1] = { ...init, headers };
          }
        }
        if (options.trackRequests) {
          const url = raw === undefined ? undefined : sanitizeUrl(raw, absolute, options.urlMode ?? "path");
          attributes = { _http_method: requestMethod(input, init) };
          if (url !== undefined) attributes._http_url = url;
          startedAt = nowMs();
        }
      }
    } catch {
      // The platform remains responsible for rejecting invalid request inputs.
    }

    const report = (status: number, hint?: PulseEventHint): void => {
      if (!active || !attributes) return;
      try {
        options.onRequest(status === 0 ? levelForRejection(hint?.originalException) : levelForStatus(status), {
          ...attributes,
          _http_status: String(status),
          _http_duration_ms: String(Math.round(nowMs() - startedAt)),
        }, hint);
      } catch {
        // Neither collector nor application hook failures may replace fetch results.
      }
    };

    let result: ReturnType<typeof fetch>;
    try {
      result = Reflect.apply(original, this, nextArgs) as ReturnType<typeof fetch>;
    } catch (error) {
      report(0, { originalException: error });
      throw error;
    }
    if (!attributes) return result;
    // Return the observed promise so an unhandled rejection still reaches the
    // application's global handler. Observing and returning the original promise
    // would mark that original rejection handled, silently suppressing it.
    return result.then((response) => {
      report(response.status);
      return response;
    }, (error: unknown) => {
      report(0, { originalException: error });
      throw error;
    });
  };

  target.fetch = wrapped as typeof fetch;

  return () => {
    active = false;
    if (target.fetch === (wrapped as typeof fetch)) target.fetch = original;
  };
}
