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
  /** Current session id, or undefined before the session starts. */
  sessionId(): string | undefined;
  /** Called once per tracked request with the level and reserved attributes. */
  onRequest(level: PulseLogLevel, attributes: Record<string, string>): void;
}

function isRequest(input: unknown): input is Request {
  return typeof Request !== "undefined" && input instanceof Request;
}

function requestUrl(input: RequestInfo | URL): string {
  if (isRequest(input)) return input.url;
  return String(input);
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

function matchesPrefix(candidates: string[], prefixes: string[]): boolean {
  return prefixes.some((prefix) => prefix !== "" && candidates.some((c) => c.startsWith(prefix)));
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

  const call = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    Reflect.apply(original, target, [input, init]) as Promise<Response>;

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = requestUrl(input);
    const absolute = absoluteUrl(raw);
    const candidates = absolute && absolute !== raw ? [raw, absolute] : [raw];

    if (matchesPrefix(candidates, [options.endpoint])) return call(input, init);

    let nextInit = init;
    if (matchesPrefix(candidates, options.propagateSessionTo)) {
      const sessionId = options.sessionId();
      if (sessionId) {
        // Passing the Request through as `input` keeps its method and body;
        // only the headers are replaced.
        const headers = new Headers(init?.headers ?? (isRequest(input) ? input.headers : undefined));
        headers.set(SESSION_HEADER, sessionId);
        nextInit = { ...init, headers };
      }
    }

    if (!options.trackRequests) return call(input, nextInit);

    const method = requestMethod(input, init);
    const url = stripQuery(absolute ?? raw);
    const startedAt = nowMs();

    try {
      const response = await call(input, nextInit);
      options.onRequest(levelForStatus(response.status), {
        _http_method: method,
        _http_url: url,
        _http_status: String(response.status),
        _http_duration_ms: String(Math.round(nowMs() - startedAt)),
      });
      return response;
    } catch (err) {
      options.onRequest("error", {
        _http_method: method,
        _http_url: url,
        _http_status: "0",
        _http_duration_ms: String(Math.round(nowMs() - startedAt)),
      });
      // The caller still owns this failure.
      throw err;
    }
  };

  target.fetch = wrapped as typeof fetch;

  return () => {
    if (target.fetch === (wrapped as typeof fetch)) target.fetch = original;
  };
}
