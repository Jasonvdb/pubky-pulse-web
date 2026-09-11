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

/** Read a Request's platform method without invoking an overridden instance getter. */
function defaultMethod(input: RequestInfo | URL): string | undefined {
  if (!isRequest(input)) return "GET";
  const getter = Object.getOwnPropertyDescriptor(Request.prototype, "method")?.get;
  return getter ? Reflect.apply(getter, input, []) as string : undefined;
}

/** Observe the exact read performed by fetch or a preceding fetch wrapper. */
function observeMethod(init: RequestInit, onMethod: (value: unknown) => void): RequestInit {
  const target = Object.create(null) as RequestInit;
  const synchronize = (): void => {
    for (const key of Reflect.ownKeys(init)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(init, key);
      if (descriptor) Reflect.defineProperty(target, key, descriptor);
    }
    Reflect.setPrototypeOf(target, Reflect.getPrototypeOf(init));
    Reflect.preventExtensions(target);
  };
  // An empty target matters: using a caller Proxy as the target would make
  // engine invariant checks execute its descriptor traps after every read.
  return new Proxy(target, {
    get(_target, key) {
      const value: unknown = Reflect.get(init, key, init);
      if (key === "method") {
        try { onMethod(value); } catch { /* Metadata cannot change request conversion. */ }
      }
      return value;
    },
    set(_target, key, value) { return Reflect.set(init, key, value, init); },
    has(_target, key) { return Reflect.has(init, key); },
    deleteProperty(_target, key) {
      if (!Reflect.deleteProperty(init, key)) return false;
      return Reflect.deleteProperty(target, key);
    },
    ownKeys() { return Reflect.ownKeys(init); },
    getOwnPropertyDescriptor(_target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(init, key);
      if (!descriptor) return undefined;
      const existing = Reflect.getOwnPropertyDescriptor(target, key);
      return existing?.configurable === false || !Reflect.isExtensible(target)
        ? descriptor : { ...descriptor, configurable: true };
    },
    defineProperty(_target, key, descriptor) {
      if (!Reflect.defineProperty(init, key, descriptor)) return false;
      const actual = Reflect.getOwnPropertyDescriptor(init, key);
      return actual !== undefined && Reflect.defineProperty(target, key, actual);
    },
    getPrototypeOf() { return Reflect.getPrototypeOf(init); },
    setPrototypeOf(_target, prototype) {
      return Reflect.setPrototypeOf(init, prototype) && Reflect.setPrototypeOf(target, prototype);
    },
    isExtensible() {
      const extensible = Reflect.isExtensible(init);
      if (!extensible && Reflect.isExtensible(target)) synchronize();
      return extensible;
    },
    preventExtensions() {
      if (!Reflect.preventExtensions(init)) return false;
      synchronize();
      return true;
    },
  });
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
  const overrides = Object.create(null) as RequestInit;
  const deleted = new Set<PropertyKey>();
  let detached = false;
  let annotate = true;

  const sourceDescriptor = (key: PropertyKey): PropertyDescriptor | undefined => {
    if (deleted.has(key)) return undefined;
    const descriptor = Reflect.getOwnPropertyDescriptor(sourceInit, key);
    if (!descriptor) return undefined;
    if ("value" in descriptor) return { ...descriptor, configurable: true };
    return {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get ? () => Reflect.apply(descriptor.get!, sourceInit, []) : undefined,
      set: descriptor.set ? (value: unknown) => Reflect.apply(descriptor.set!, sourceInit, [value]) : undefined,
    };
  };
  const keys = (): Array<string | symbol> => detached
    ? Reflect.ownKeys(overrides)
    : [...new Set([
      ...Reflect.ownKeys(sourceInit).filter((key) => !deleted.has(key)),
      ...Reflect.ownKeys(overrides),
      ...(annotate ? ["headers"] : []),
    ])];
  const descriptor = (key: PropertyKey): PropertyDescriptor | undefined => {
    const own = Reflect.getOwnPropertyDescriptor(overrides, key);
    if (own || detached) return own;
    return sourceDescriptor(key) ?? (key === "headers" && annotate
      ? { configurable: true, enumerable: true, writable: true, value: undefined }
      : undefined);
  };
  const detach = (): void => {
    if (detached) return;
    // Explicit freezing/reflection is a caller action, so materialize descriptors
    // here rather than inspecting caller proxies before fetch starts reading.
    for (const key of keys()) {
      if (!Object.hasOwn(overrides, key)) {
        const property = descriptor(key);
        if (property) Reflect.defineProperty(overrides, key, property);
      }
    }
    Reflect.setPrototypeOf(overrides, Reflect.getPrototypeOf(sourceInit));
    detached = true;
    // A frozen data property must return its exact value. Header propagation is
    // optional, so keep the original headers when a wrapper freezes the facade.
    annotate = false;
  };

  return new Proxy(overrides, {
    get(target, key, receiver) {
      let value: unknown;
      if (Object.hasOwn(target, key)) value = Reflect.get(target, key, receiver);
      else if (detached) value = Reflect.get(target, key, sourceInit);
      else if (deleted.has(key)) {
        const prototype = Reflect.getPrototypeOf(sourceInit);
        value = prototype === null ? undefined : Reflect.get(prototype, key, sourceInit);
      } else value = Reflect.get(sourceInit, key, sourceInit);
      if (key !== "headers" || !annotate) return value;
      const own = Reflect.getOwnPropertyDescriptor(target, key);
      if (own?.configurable === false && ("value" in own ? !own.writable : !own.get)) return value;
      const originalHeaders = value === undefined && isRequest(input) ? input.headers : value;
      return sessionHeaders(originalHeaders, sessionId);
    },
    has(target, key) {
      if (detached) return Reflect.has(target, key);
      if (Object.hasOwn(target, key) || (key === "headers" && annotate)) return true;
      if (!deleted.has(key)) return Reflect.has(sourceInit, key);
      const prototype = Reflect.getPrototypeOf(sourceInit);
      return prototype !== null && Reflect.has(prototype, key);
    },
    set(target, key, value) {
      if (detached || Object.hasOwn(target, key)) return Reflect.set(target, key, value, target);
      const original = sourceDescriptor(key);
      return Reflect.defineProperty(target, key, {
        configurable: true, enumerable: original?.enumerable ?? true, writable: true, value,
      });
    },
    deleteProperty(target, key) {
      if (!Reflect.deleteProperty(target, key)) return false;
      if (!detached) deleted.add(key);
      if (key === "headers") annotate = false;
      return true;
    },
    ownKeys: keys,
    getOwnPropertyDescriptor(_target, key) { return descriptor(key); },
    getPrototypeOf(target) { return detached ? Reflect.getPrototypeOf(target) : Reflect.getPrototypeOf(sourceInit); },
    setPrototypeOf(target, prototype) {
      detach();
      return Reflect.setPrototypeOf(target, prototype);
    },
    preventExtensions(target) {
      detach();
      return Reflect.preventExtensions(target);
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
          if (init == null) {
            const method = defaultMethod(input);
            if (method !== undefined) attributes._http_method = method;
          }
          if (url !== undefined) attributes._http_url = url;
          startedAt = nowMs();
          const effectiveInit = nextArgs[1];
          if (effectiveInit !== null && (typeof effectiveInit === "object" || typeof effectiveInit === "function")) {
            nextArgs = [...nextArgs];
            nextArgs[1] = observeMethod(effectiveInit, (value) => {
              const method = typeof value === "string" ? value.toUpperCase()
                : value === undefined ? defaultMethod(input) : undefined;
              if (method === undefined) delete attributes!._http_method;
              else attributes!._http_method = method;
            });
          }
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
    try {
      return result.then((response) => {
        try { report(response.status); } catch { /* Response metadata is optional. */ }
        return response;
      }, (error: unknown) => {
        report(0, { originalException: error });
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
