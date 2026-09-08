/**
 * Screen tracking for single-page apps. There is no navigation event for
 * `history.pushState`, so the History API is patched once and compared against
 * `location.pathname` before and after the call: that keeps hash-only changes
 * (in-page anchors) from looking like navigations.
 */

import { nowMs } from "./clock";

/** Set while the History API is patched, so a second install cannot stack. */
let originalPushState: History["pushState"] | null = null;
let originalReplaceState: History["replaceState"] | null = null;
/** The active tracker's navigation hook, swapped out on `restore()`. */
let navigationListener: (() => void) | null = null;

export interface ScreenCallbacks {
  /** A screen became visible. */
  onAppeared(screenName: string): void;
  /** The previous screen was left after `durationMs` on it. */
  onDisappeared(screenName: string, durationMs: number): void;
}

/** Path of the page currently shown, normalised to a leading slash. */
export function currentPath(): string {
  const loc = (globalThis as { location?: Location }).location;
  const path = loc?.pathname;
  return path ? path : "/";
}

function patchHistory(): void {
  const history = (globalThis as { history?: History }).history;
  if (!history || originalPushState) return;

  // Keep the originals unbound so `restore()` puts back the exact functions.
  const push = history.pushState;
  const replace = history.replaceState;
  originalPushState = push;
  originalReplaceState = replace;

  // The original runs first so the URL has already changed when we compare.
  history.pushState = function patchedPushState(
    this: History,
    ...args: Parameters<History["pushState"]>
  ): void {
    const before = currentPath();
    Reflect.apply(push, this ?? history, args);
    if (currentPath() !== before) navigationListener?.();
  };
  history.replaceState = function patchedReplaceState(
    this: History,
    ...args: Parameters<History["replaceState"]>
  ): void {
    const before = currentPath();
    Reflect.apply(replace, this ?? history, args);
    if (currentPath() !== before) navigationListener?.();
  };
}

function restoreHistory(): void {
  const history = (globalThis as { history?: History }).history;
  if (history && originalPushState && originalReplaceState) {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
  }
  originalPushState = null;
  originalReplaceState = null;
}

/**
 * Tracks which screen is showing and how long each one was on screen. The
 * current name is also the default `screen_name` for every other event, so a
 * tracker exists even when automatic page views are switched off — in that
 * case only `trackScreen()` moves it.
 */
export class PageTracker {
  private readonly callbacks: ScreenCallbacks;
  private readonly screenNameForPath?: (pathname: string) => string;
  private current: string | null = null;
  private enteredAt = 0;
  private popstateHandler: (() => void) | null = null;
  private installed = false;

  constructor(callbacks: ScreenCallbacks, screenNameForPath?: (pathname: string) => string) {
    this.callbacks = callbacks;
    this.screenNameForPath = screenNameForPath;
  }

  /** Screen stamped on events that do not name one themselves. */
  get screenName(): string | undefined {
    return this.current ?? undefined;
  }

  /**
   * Start automatic tracking: patch the History API, listen for back/forward
   * navigation, and report the page that is already open.
   */
  install(): void {
    if (this.installed) return;
    this.installed = true;

    patchHistory();
    navigationListener = () => {
      this.enterCurrentPath();
    };

    const win = (globalThis as { window?: Window }).window;
    if (win) {
      this.popstateHandler = () => {
        this.enterCurrentPath();
      };
      win.addEventListener("popstate", this.popstateHandler);
    }

    this.enterCurrentPath();
  }

  /** Report a screen change the SDK cannot see, e.g. a modal or a tab. */
  trackScreen(name: string): void {
    this.enter(name);
  }

  /** Undo `install()` and forget the current screen. */
  restore(): void {
    const win = (globalThis as { window?: Window }).window;
    if (win && this.popstateHandler) {
      win.removeEventListener("popstate", this.popstateHandler);
    }
    this.popstateHandler = null;

    if (this.installed) {
      navigationListener = null;
      restoreHistory();
      this.installed = false;
    }
    this.current = null;
    this.enteredAt = 0;
  }

  private enterCurrentPath(): void {
    const pathname = currentPath();
    if (!this.screenNameForPath) {
      this.enter(pathname);
      return;
    }

    let name: string | null = null;
    try {
      const mapped = this.screenNameForPath(pathname);
      if (typeof mapped === "string" && mapped.trim().length > 0) {
        name = mapped;
      } else {
        // Invalid async results must not leak mapper errors through unhandled capture.
        void Promise.resolve(mapped).catch(() => undefined);
      }
    } catch {
      // Mapping must not break navigation or expose a raw path on failure.
    }
    this.enter(name);
  }

  private enter(name: string | null): void {
    if (this.current === name) return;

    const at = nowMs();
    if (this.current !== null) {
      this.callbacks.onDisappeared(this.current, Math.max(0, Math.round(at - this.enteredAt)));
    }
    this.current = name;
    this.enteredAt = at;
    if (name !== null) this.callbacks.onAppeared(name);
  }
}
