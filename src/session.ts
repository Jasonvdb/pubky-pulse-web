import { randomUuid } from "./event-builder";
import { sessionStore } from "./storage";

/** Session id for the current tab. `sessionStorage` is per-tab by design. */
export const SESSION_ID_KEY = "session_id";
/** Epoch milliseconds of the last activity seen in this session. */
export const SESSION_ACTIVITY_KEY = "session_activity_at";

export interface SessionCallbacks {
  /**
   * A new session id is now active. `launchMs` is only present for the
   * session started by `configure()`, where it describes the page load.
   */
  onStarted(sessionId: string, launchMs?: number): void;
  /**
   * The previous session went idle. Only called for sessions this page
   * started, so a reload never invents an end for a session it inherited.
   */
  onEnded(sessionId: string): void;
}

/**
 * Milliseconds from navigation start to the page being loaded, for the
 * `_launch_ms` attribute. Navigation Timing is preferred; during an early
 * `configure()` the load marks are still zero, so the elapsed time since the
 * time origin is the honest answer.
 */
export function launchDurationMs(): number | undefined {
  const perf = (globalThis as { performance?: Performance }).performance;
  if (!perf) return undefined;

  try {
    const entries = perf.getEntriesByType?.("navigation") as
      | PerformanceNavigationTiming[]
      | undefined;
    const nav = entries?.[0];
    for (const mark of [nav?.loadEventEnd, nav?.domContentLoadedEventEnd, nav?.responseEnd]) {
      if (typeof mark === "number" && mark > 0) return Math.round(mark);
    }
  } catch {
    // Navigation Timing Level 2 is missing; fall through to the time origin.
  }

  return typeof perf.now === "function" ? Math.round(perf.now()) : undefined;
}

/**
 * Owns the session id and its idle expiry. A session survives reloads within
 * the same tab: the id and the last-activity stamp live in `sessionStorage`,
 * and `configure()` adopts them when the gap is under the timeout.
 */
export class SessionManager {
  private readonly timeoutMs: number;
  private readonly callbacks: SessionCallbacks;
  private currentId: string | null = null;
  /** Only sessions this page began may emit `sdk:session_ended`. */
  private startedHere = false;
  /** Reentrancy guard: the callbacks log events, which call `touch()`. */
  private rotating = false;

  constructor(timeoutMs: number, callbacks: SessionCallbacks) {
    this.timeoutMs = timeoutMs;
    this.callbacks = callbacks;
  }

  get id(): string | null {
    return this.currentId;
  }

  /** True when the active session was inherited from an earlier page load. */
  get isResumed(): boolean {
    return this.currentId !== null && !this.startedHere;
  }

  /**
   * Adopt the stored session when it is still fresh, otherwise begin a new
   * one. The inherited session is never ended here: whoever started it may
   * still be running in another tab, and we never saw its first event.
   */
  start(now: number = Date.now()): string {
    const existing = sessionStore.get(SESSION_ID_KEY);
    const lastActivity = this.readActivity();

    if (existing && lastActivity !== null && now - lastActivity < this.timeoutMs) {
      this.currentId = existing;
      this.startedHere = false;
      this.writeActivity(now);
      return existing;
    }

    return this.begin(now, launchDurationMs());
  }

  /**
   * Record activity and return the id the caller should stamp on its event.
   * Crossing the idle timeout rotates the session first, so the event lands
   * on the new session rather than reviving the expired one.
   */
  touch(now: number = Date.now()): string {
    if (this.currentId === null) return this.start(now);
    if (this.rotating) return this.currentId;

    const lastActivity = this.readActivity();
    if (lastActivity !== null && now - lastActivity >= this.timeoutMs) {
      return this.begin(now);
    }

    this.writeActivity(now);
    return this.currentId;
  }

  private begin(now: number, launchMs?: number): string {
    const previous = this.currentId;
    const previousStartedHere = this.startedHere;

    const created = randomUuid();
    this.currentId = created;
    this.startedHere = true;
    sessionStore.set(SESSION_ID_KEY, created);
    this.writeActivity(now);

    this.rotating = true;
    try {
      if (previous && previousStartedHere) this.callbacks.onEnded(previous);
      this.callbacks.onStarted(created, launchMs);
    } finally {
      this.rotating = false;
    }

    return created;
  }

  private readActivity(): number | null {
    const raw = sessionStore.get(SESSION_ACTIVITY_KEY);
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private writeActivity(now: number): void {
    sessionStore.set(SESSION_ACTIVITY_KEY, String(now));
  }
}
