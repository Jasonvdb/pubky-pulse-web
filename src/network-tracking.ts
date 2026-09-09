import { nowMs } from "./clock";
import type { PulseLogLevel } from "./types";

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
  /** Called once per tracked request with the level and reserved attributes. */
  onRequest(level: PulseLogLevel, attributes: Record<string, string>): void;
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

/** Observe only data properties: fetch must be the sole caller of init getters. */
function requestMethod(input: RequestInfo | URL, init?: RequestInit): string | undefined {
  let cursor: object | null = init == null ? null : Object(init);
  for (let depth = 0; cursor !== null && depth < 32; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, "method");
    if (descriptor) {
      if (!("value" in descriptor)) return undefined;
      const method: unknown = descriptor.value;
      if (method !== undefined) return typeof method === "string" ? method.toUpperCase() : undefined;
      break;
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  return isRequest(input) ? input.method : "GET";
}

/**
 * Distinguish an unavailable header adapter from an application conversion
 * failure. Once a header initializer has been inspected, replaying it could
 * invoke getters twice or consume a one-shot iterable again.
 */
function sessionHeaders(value: unknown, sessionId: string): unknown {
  let inspected = false;
  let initializer = value;
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    initializer = new Proxy({}, {
      get(_target, key) {
        inspected = true;
        const member: unknown = Reflect.get(value, key, value);
        if (key === Symbol.iterator && typeof member === "function") {
          return (...args: unknown[]) => Reflect.apply(member, value, args);
        }
        return member;
      },
      ownKeys() {
        inspected = true;
        return Reflect.ownKeys(value);
      },
      getOwnPropertyDescriptor(_target, key) {
        inspected = true;
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        return descriptor ? { ...descriptor, configurable: true } : undefined;
      },
    });
  }
  let headers: Headers;
  try {
    headers = new Headers(initializer as HeadersInit | undefined);
  } catch (error) {
    if (inspected) throw error;
    // No caller header state was consumed, so native fetch can own conversion.
    return value;
  }
  try {
    headers.set(SESSION_HEADER, sessionId);
  } catch { /* Preserve successfully converted application headers without annotation. */ }
  return headers;
}

/**
 * Override just the native dictionary's headers read. A fresh proxy target
 * avoids invariants on frozen init objects; forwarding with the original
 * receiver preserves inherited fields, accessor ordering and getter `this`.
 * No Request is constructed, cloned or consumed by instrumentation.
 */
function withSessionHeader(input: RequestInfo | URL, init: RequestInit | undefined, sessionId: string): RequestInit {
  const sourceInit = init ?? {};
  const overrides: RequestInit = {};
  return new Proxy(overrides, {
    get(target, key) {
      const source = Object.prototype.hasOwnProperty.call(target, key) ? target : sourceInit;
      const value: unknown = Reflect.get(source, key, source);
      if (key !== "headers") return value;
      const originalHeaders = value === undefined && isRequest(input) ? input.headers : value;
      return sessionHeaders(originalHeaders, sessionId);
    },
    // Fetch wrappers often spread init before forwarding it. Keep all its own
    // fields visible, plus our header override, without eagerly reading getters.
    ownKeys(target) {
      return [...new Set([...Reflect.ownKeys(sourceInit), ...Reflect.ownKeys(target), "headers"])];
    },
    getOwnPropertyDescriptor(target, key) {
      const override = Reflect.getOwnPropertyDescriptor(target, key);
      if (override) return override;
      if (key === "headers") return { configurable: true, enumerable: true, writable: true };
      const descriptor = Reflect.getOwnPropertyDescriptor(sourceInit, key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
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
    if (!active) return Reflect.apply(original, this, args) as ReturnType<typeof fetch>;
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
          if (sessionId && (init == null || typeof init === "object" || typeof init === "function")) {
            nextArgs = [...args];
            nextArgs[1] = withSessionHeader(input, init, sessionId);
          }
        }
        if (options.trackRequests) {
          const url = raw === undefined ? undefined : sanitizeUrl(raw, absolute, options.urlMode ?? "path");
          attributes = {};
          const method = requestMethod(input, init);
          if (method !== undefined) attributes._http_method = method;
          if (url !== undefined) attributes._http_url = url;
          startedAt = nowMs();
        }
      }
    } catch {
      // The platform remains responsible for rejecting invalid request inputs.
    }

    const report = (status: number): void => {
      if (!active || !attributes) return;
      try {
        options.onRequest(status === 0 ? "error" : levelForStatus(status), {
          ...attributes,
          _http_status: String(status),
          _http_duration_ms: String(Math.round(nowMs() - startedAt)),
        });
      } catch {
        // Neither collector nor application hook failures may replace fetch results.
      }
    };

    let result: ReturnType<typeof fetch>;
    try {
      result = Reflect.apply(original, this, nextArgs) as ReturnType<typeof fetch>;
    } catch (error) {
      report(0);
      throw error;
    }
    if (!attributes) return result;
    // Return the observed promise so an unhandled rejection still reaches the
    // application's global handler. Observing and returning the original promise
    // would mark that original rejection handled, silently suppressing it.
    try {
      return result.then((response) => {
        try { report(response.status); } catch { /* Response metadata is optional. */ }
        return response;
      }, (error: unknown) => {
        report(0);
        throw error;
      });
    } catch {
      // Another fetch wrapper may return an unusual promise-like value.
      return result;
    }
  };

  target.fetch = wrapped as typeof fetch;

  return () => {
    active = false;
    if (target.fetch === (wrapped as typeof fetch)) target.fetch = original;
  };
}
